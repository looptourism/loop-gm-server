// Google Sheets + Drive for the GM and the departments, through a service
// account (no googleapis package: a signed JWT is exchanged for a token).
//
//   GOOGLE_SERVICE_ACCOUNT_JSON  the key file's contents, pasted into Render
//   GOOGLE_WORKSPACE_SHEET_ID    the sheet they read and write ("بيانات الباقات")
//   GOOGLE_PARTNERS_FOLDER_ID    the partner-documents folder (read only)
//
// Both the sheet and the folder must be shared with the service account's
// email. The pricing sheet the Instagram automation reads is NOT this sheet,
// and nothing here can write to Drive.

const crypto = require("crypto");

const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly";
const MAX_READ_ROWS = 200;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

// Pasting JSON into a dashboard often mangles it (real line breaks inside the
// key, escaped quotes…). Pull the two fields we need out of the text instead
// of trusting JSON.parse.
function parseServiceAccount(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  if (!text.startsWith("{")) {
    try { text = Buffer.from(text, "base64").toString("utf8"); } catch { /* not base64 */ }
  }
  const email = (text.match(/"client_email"\s*:\s*"([^"]+)"/) || [])[1];
  const keyMatch = text.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/);
  if (!email || !keyMatch) return null;
  const privateKey = keyMatch[0].replace(/\\n/g, "\n").replace(/\r/g, "");
  return { email, privateKey };
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function signJwt(sa, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.email, scope: SCOPES, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

function createWorkspace({ env = process.env, fetchFn, timeoutFetch } = {}) {
  const doFetch = timeoutFetch || ((url, opts) => (fetchFn || fetch)(url, opts));
  const sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const sheetId = (env.GOOGLE_WORKSPACE_SHEET_ID || "").trim();
  const folderId = (env.GOOGLE_PARTNERS_FOLDER_ID || "").trim();
  let token = null; // { value, exp }

  const status = {
    serviceAccount: !!sa,
    serviceAccountEmail: sa?.email || null,
    sheet: !!(sa && sheetId),
    partners: !!(sa && folderId),
    keyProblem: env.GOOGLE_SERVICE_ACCOUNT_JSON && !sa ? "تعذّرت قراءة مفتاح حساب الخدمة — تأكد إنك لصقت محتوى ملف JSON كاملًا" : null,
  };

  async function accessToken() {
    if (!sa) throw new Error("حساب خدمة Google غير مربوط بعد.");
    if (token && Date.now() < token.exp) return token.value;
    const res = await doFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(sa) }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`Google رفض المفتاح (${res.status}${data.error_description ? ": " + data.error_description : data.error ? ": " + data.error : ""})`);
    token = { value: data.access_token, exp: Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000 };
    return token.value;
  }

  async function gapi(url, opts = {}, as = "json") {
    const res = await doFetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${await accessToken()}` } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.error?.message || `HTTP ${res.status}`;
      if (res.status === 403 || res.status === 404) throw new Error(`${msg} — تأكد إن الملف مشارَك مع ${sa.email}`);
      throw new Error(msg);
    }
    if (as === "buffer") return Buffer.from(await res.arrayBuffer());
    if (as === "text") return res.text();
    return res.json();
  }

  // ---- Sheets ------------------------------------------------------------
  const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
  const quoteTab = (tab) => `'${String(tab).replace(/'/g, "''")}'`;
  const enc = encodeURIComponent;

  async function tabs() {
    const data = await gapi(`${SHEETS}/${sheetId}?fields=sheets.properties(title,gridProperties(rowCount,columnCount))`);
    return (data.sheets || []).map((s) => s.properties.title);
  }

  async function ensureTab(tab) {
    if ((await tabs()).includes(tab)) return false;
    await gapi(`${SHEETS}/${sheetId}:batchUpdate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
    });
    return true;
  }

  const rowsToText = (values, firstRow = 1) =>
    values.map((r, i) => `${firstRow + i}\t${r.map((c) => String(c ?? "").replace(/[\t\n]/g, " ")).join("\t")}`).join("\n");

  async function sheetRead({ tab, range } = {}) {
    if (!sheetId) throw new Error("شيت بيانات الباقات غير مربوط بعد.");
    const all = await tabs();
    if (!tab) {
      if (!all.length) return "الشيت فاضي، ما فيه أي تبويب.";
      const heads = await Promise.all(all.map(async (t) => {
        const v = await gapi(`${SHEETS}/${sheetId}/values/${enc(`${quoteTab(t)}!1:1`)}`).catch(() => ({}));
        return `- «${t}»: ${(v.values?.[0] || []).join(" | ") || "(بدون عناوين)"}`;
      }));
      return `التبويبات في شيت بيانات الباقات:\n${heads.join("\n")}`;
    }
    if (!all.includes(tab)) return `ما فيه تبويب اسمه «${tab}». الموجود: ${all.map((t) => `«${t}»`).join("، ") || "لا شيء"}.`;
    const a1 = range ? `${quoteTab(tab)}!${range}` : `${quoteTab(tab)}!A1:ZZ${MAX_READ_ROWS}`;
    const v = await gapi(`${SHEETS}/${sheetId}/values/${enc(a1)}`);
    const values = v.values || [];
    if (!values.length) return `تبويب «${tab}» فاضي${range ? ` في النطاق ${range}` : ""}.`;
    const startRow = Number((String(v.range || "").match(/![A-Z]+(\d+)/) || [])[1] || 1);
    return `«${tab}» (العمود الأول رقم الصف في الشيت):\n${rowsToText(values, startRow)}${values.length >= MAX_READ_ROWS ? `\n(عُرض أول ${MAX_READ_ROWS} صف فقط — حدّد نطاقًا لقراءة الباقي)` : ""}`;
  }

  async function sheetAppend({ tab, rows }) {
    if (!sheetId) throw new Error("شيت بيانات الباقات غير مربوط بعد.");
    if (!tab || !Array.isArray(rows) || !rows.length) throw new Error("يلزم اسم التبويب وصف واحد على الأقل.");
    const created = await ensureTab(tab);
    const r = await gapi(`${SHEETS}/${sheetId}/values/${enc(`${quoteTab(tab)}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: rows }),
    });
    const where = r.updates?.updatedRange ? String(r.updates.updatedRange).split("!")[1] : "";
    return { created, count: rows.length, where };
  }

  async function sheetUpdate({ tab, range, rows }) {
    if (!sheetId) throw new Error("شيت بيانات الباقات غير مربوط بعد.");
    if (!tab || !range || !Array.isArray(rows) || !rows.length) throw new Error("يلزم اسم التبويب والنطاق والقيم.");
    if (!(await tabs()).includes(tab)) throw new Error(`ما فيه تبويب اسمه «${tab}».`);
    const r = await gapi(`${SHEETS}/${sheetId}/values/${enc(`${quoteTab(tab)}!${range}`)}?valueInputOption=USER_ENTERED`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: rows }),
    });
    return { cells: r.updatedCells || 0, where: String(r.updatedRange || range).split("!").pop() };
  }

  // ---- Drive (partner documents, read only) -------------------------------
  const DRIVE = "https://www.googleapis.com/drive/v3/files";
  const FOLDER = "application/vnd.google-apps.folder";

  async function listChildren(id) {
    const q = enc(`'${id}' in parents and trashed=false`);
    const d = await gapi(`${DRIVE}?q=${q}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=200&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    return d.files || [];
  }

  async function partnerDocsList({ partner } = {}) {
    if (!folderId) throw new Error("مجلد مستندات الشركاء غير مربوط بعد.");
    const top = await listChildren(folderId);
    const folders = top.filter((f) => f.mimeType === FOLDER);
    const looseFiles = top.filter((f) => f.mimeType !== FOLDER);
    const line = (f) => `  - ${f.name} (id: ${f.id}، آخر تعديل ${String(f.modifiedTime || "").slice(0, 10)})`;
    if (partner) {
      const want = partner.trim().toLowerCase();
      const hits = folders.filter((f) => f.name.toLowerCase().includes(want));
      if (!hits.length) return `ما لقيت مجلد شريك يطابق «${partner}». الشركاء الموجودون: ${folders.map((f) => f.name).join("، ") || "لا أحد"}.`;
      const parts = await Promise.all(hits.map(async (h) => {
        const files = (await listChildren(h.id)).filter((f) => f.mimeType !== FOLDER);
        return `📁 ${h.name}:\n${files.map(line).join("\n") || "  (فاضي)"}`;
      }));
      return parts.join("\n\n");
    }
    const parts = await Promise.all(folders.map(async (h) => {
      const files = (await listChildren(h.id)).filter((f) => f.mimeType !== FOLDER);
      return `📁 ${h.name}:\n${files.map(line).join("\n") || "  (فاضي)"}`;
    }));
    if (looseFiles.length) parts.push(`📄 ملفات بدون مجلد شريك:\n${looseFiles.map(line).join("\n")}`);
    return parts.join("\n\n") || "مجلد مستندات الشركاء فاضي.";
  }

  // Returns what Claude needs to read the file: text, or a document/image block.
  async function partnerDocContent(fileId) {
    if (!folderId) throw new Error("مجلد مستندات الشركاء غير مربوط بعد.");
    const meta = await gapi(`${DRIVE}/${enc(fileId)}?fields=id,name,mimeType,size&supportsAllDrives=true`);
    const m = meta.mimeType;
    if (m === "application/vnd.google-apps.document" || m === "application/vnd.google-apps.presentation")
      return { name: meta.name, text: await gapi(`${DRIVE}/${enc(fileId)}/export?mimeType=text/plain`, {}, "text") };
    if (m === "application/vnd.google-apps.spreadsheet")
      return { name: meta.name, text: await gapi(`${DRIVE}/${enc(fileId)}/export?mimeType=text/csv`, {}, "text") };
    if (Number(meta.size || 0) > MAX_FILE_BYTES) throw new Error(`الملف «${meta.name}» أكبر من 15MB.`);
    const supported = { "application/pdf": "document", "image/jpeg": "image", "image/png": "image", "image/webp": "image", "image/gif": "image" };
    if (m.startsWith("text/") || m === "application/json" || m === "text/csv") {
      return { name: meta.name, text: await gapi(`${DRIVE}/${enc(fileId)}?alt=media&supportsAllDrives=true`, {}, "text") };
    }
    if (!supported[m]) throw new Error(`نوع الملف «${meta.name}» (${m}) غير مدعوم — احفظه PDF أو Google Doc.`);
    const data = (await gapi(`${DRIVE}/${enc(fileId)}?alt=media&supportsAllDrives=true`, {}, "buffer")).toString("base64");
    return { name: meta.name, block: supported[m] === "document"
      ? { type: "document", source: { type: "base64", media_type: m, data } }
      : { type: "image", source: { type: "base64", media_type: m, data } } };
  }

  return { status, sheetRead, sheetAppend, sheetUpdate, partnerDocsList, partnerDocContent, accessToken };
}

// Tool definitions handed to the GM and the departments when configured.
function workspaceTools(status) {
  const t = [];
  if (status.sheet) t.push(
    {
      name: "sheet_read",
      description: "قراءة شيت «بيانات الباقات» المشترك بين المدير العام والأقسام. بدون tab: يعرض التبويبات وعناوين أعمدتها. مع tab: يعرض الصفوف (العمود الأول رقم الصف). اقرأ قبل أن تكتب لتعرف الأعمدة ولا تكرر صفًا موجودًا.",
      input_schema: { type: "object", properties: {
        tab: { type: "string", description: "اسم التبويب، مثل «باقات العمرة»." },
        range: { type: "string", description: "نطاق اختياري بصيغة A1 داخل التبويب، مثل A1:H50." },
      } },
    },
    {
      name: "sheet_append_rows",
      description: "إضافة صفوف جديدة في آخر تبويب من شيت «بيانات الباقات». إن لم يوجد التبويب يُنشأ، وحينها اجعل الصف الأول عناوين الأعمدة. التزم بترتيب الأعمدة الموجود. لا تكتب أرقامًا مخمّنة.",
      input_schema: { type: "object", properties: {
        tab: { type: "string" },
        rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean"] } }, description: "كل عنصر صف، وكل صف قائمة خلايا بترتيب الأعمدة." },
      }, required: ["tab", "rows"] },
    },
    {
      name: "sheet_update_cells",
      description: "تعديل خلايا موجودة في شيت «بيانات الباقات» (مثلًا تحديث سعر باقة). اقرأ التبويب أولًا لتعرف رقم الصف والعمود الصحيح.",
      input_schema: { type: "object", properties: {
        tab: { type: "string" },
        range: { type: "string", description: "النطاق بصيغة A1، مثل E7 أو B3:D3." },
        rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean"] } }, description: "القيم الجديدة بنفس شكل النطاق." },
      }, required: ["tab", "range", "rows"] },
    },
  );
  if (status.partners) t.push(
    {
      name: "partner_docs_list",
      description: "عرض مستندات الشركاء في Google Drive (مجلد لكل شريك: فنادق، شركات طيران، موردون…). مع partner: ملفات ذلك الشريك فقط.",
      input_schema: { type: "object", properties: { partner: { type: "string", description: "اسم الشريك أو جزء منه (اختياري)." } } },
    },
    {
      name: "partner_doc_read",
      description: "قراءة مستند شريك محدد (PDF، صورة، Google Doc أو Sheet) والإجابة عن سؤال منه — مثل بنود العقد، الأسعار، الصلاحية، شروط الإلغاء. خذ file_id من partner_docs_list.",
      input_schema: { type: "object", properties: {
        file_id: { type: "string" },
        question: { type: "string", description: "ما المطلوب من المستند." },
      }, required: ["file_id", "question"] },
    },
  );
  return t;
}

const WORKSPACE_TOOL_NAMES = new Set(["sheet_read", "sheet_append_rows", "sheet_update_cells", "partner_docs_list", "partner_doc_read"]);

module.exports = { createWorkspace, workspaceTools, parseServiceAccount, signJwt, WORKSPACE_TOOL_NAMES };
