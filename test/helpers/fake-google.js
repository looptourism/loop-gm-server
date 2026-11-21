// In-memory fake of Google's token, Sheets and Drive APIs for tests. The token
// endpoint really verifies the JWT signature with the key's public half.
const crypto = require("crypto");

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const EMAIL = "loop-gm-server@loop-gm.iam.gserviceaccount.com";
const KEY_JSON = JSON.stringify({ type: "service_account", client_email: EMAIL, private_key: PEM });

function fakeGoogle({ shared = true } = {}) {
  const tabs = new Map([["باقات العمرة", [["الباقة", "الليالي", "السعر"], ["اقتصادية", "4", "2999"]]]]);
  const files = {
    root: { id: "root", name: "مستندات الشركاء", mimeType: "application/vnd.google-apps.folder" },
    f1: { id: "f1", name: "فندق الصفوة", mimeType: "application/vnd.google-apps.folder", parent: "root" },
    d1: { id: "d1", name: "عقد 2026.pdf", mimeType: "application/pdf", parent: "f1", size: "11", body: "%PDF-fake" },
    d2: { id: "d2", name: "شروط الإلغاء", mimeType: "application/vnd.google-apps.document", parent: "f1", text: "الإلغاء قبل 14 يوم مجاني" },
    d3: { id: "d3", name: "عرض.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parent: "f1", size: "5" },
  };
  const calls = [];
  const json = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data), arrayBuffer: async () => Buffer.from(JSON.stringify(data)) });
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url); calls.push(`${opts.method || "GET"} ${u.pathname}`);
    if (u.host === "oauth2.googleapis.com") {
      const jwt = new URLSearchParams(opts.body).get("assertion").split(".");
      const ok = crypto.createVerify("RSA-SHA256").update(`${jwt[0]}.${jwt[1]}`).verify(publicKey, Buffer.from(jwt[2], "base64url"));
      const claims = JSON.parse(Buffer.from(jwt[1], "base64url"));
      if (!ok || claims.iss !== EMAIL || !claims.scope.includes("spreadsheets") || !claims.scope.includes("drive.readonly")) return json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      return json(200, { access_token: "tok", expires_in: 3600 });
    }
    if ((opts.headers || {}).Authorization !== "Bearer tok") return json(401, { error: { message: "no auth" } });
    if (!shared) return json(404, { error: { message: "Requested entity was not found." } });
    const p = decodeURIComponent(u.pathname);
    if (u.host === "sheets.googleapis.com") {
      if (p.endsWith(":batchUpdate")) { tabs.set(JSON.parse(opts.body).requests[0].addSheet.properties.title, []); return json(200, {}); }
      const m = p.match(/\/values\/'(.+?)'!(.*?)(:append)?$/);
      if (!m) return json(200, { sheets: [...tabs.keys()].map((title) => ({ properties: { title } })) });
      const [, tab, rng, append] = m; const rows = tabs.get(tab);
      if (!rows) return json(400, { error: { message: "Unable to parse range" } });
      if (append) { const start = rows.length + 1; rows.push(...JSON.parse(opts.body).values); return json(200, { updates: { updatedRange: `'${tab}'!A${start}:C${rows.length}` } }); }
      if (opts.method === "PUT") { const [col, row] = [rng.charCodeAt(0) - 65, Number(rng.match(/\d+/)[0])]; const v = JSON.parse(opts.body).values; v.forEach((r, i) => r.forEach((c, j) => { (rows[row - 1 + i] ||= [])[col + j] = String(c); })); return json(200, { updatedCells: v.flat().length, updatedRange: `'${tab}'!${rng}` }); }
      if (rng === "1:1") return json(200, { values: rows.slice(0, 1) });
      return json(200, { range: `'${tab}'!A1:ZZ200`, values: rows });
    }
    if (u.host === "www.googleapis.com") {
      const q = u.searchParams.get("q");
      if (q) { const parent = q.match(/'([^']+)' in parents/)[1]; return json(200, { files: Object.values(files).filter((f) => f.parent === parent) }); }
      const id = p.split("/")[4]; const f = files[id];
      if (!f) return json(404, { error: { message: "File not found" } });
      if (p.endsWith("/export")) return { ok: true, status: 200, text: async () => f.text };
      if (u.searchParams.get("alt") === "media") return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(f.body), text: async () => f.body };
      return json(200, f);
    }
    return json(404, {});
  };
  return { fetchFn, tabs, calls };
}
module.exports = { fakeGoogle, KEY_JSON, EMAIL, PEM };
