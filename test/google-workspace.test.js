// google-workspace.js against an in-memory fake of Google's APIs: the token
// endpoint really verifies the JWT signature with the key's public half, the
// sheet keeps real tabs/rows, and Drive serves folders and files.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createWorkspace, parseServiceAccount, workspaceTools, signJwt } = require("../google-workspace");

const { fakeGoogle, KEY_JSON, EMAIL } = require("./helpers/fake-google");

const env = (extra = {}) => ({ GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON, GOOGLE_WORKSPACE_SHEET_ID: "sheet1", GOOGLE_PARTNERS_FOLDER_ID: "root", ...extra });

test("the service-account key is read however it was pasted", () => {
  const forms = {
    "as downloaded": KEY_JSON,
    "real line breaks inside the key": KEY_JSON.replace(/\\n/g, "\n"),
    "base64": Buffer.from(KEY_JSON).toString("base64"),
    "spaces around": `  ${KEY_JSON}\n`,
  };
  for (const [name, raw] of Object.entries(forms)) {
    const sa = parseServiceAccount(raw);
    assert.equal(sa?.email, EMAIL, name);
    assert.doesNotThrow(() => crypto.createPrivateKey(sa.privateKey), name);
  }
  assert.equal(parseServiceAccount('{"client_email":"x"}'), null);
  assert.equal(parseServiceAccount(""), null);
});

test("the signed token request is accepted by a signature check with the public key", async () => {
  const g = fakeGoogle();
  const ws = createWorkspace({ env: env(), fetchFn: g.fetchFn });
  assert.equal(await ws.accessToken(), "tok");
  await ws.accessToken();
  assert.equal(g.calls.filter((c) => c.includes("/token")).length, 1, "token is cached");
  const wrong = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const bad = createWorkspace({ env: env({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: EMAIL, private_key: wrong }) }), fetchFn: g.fetchFn });
  await assert.rejects(bad.accessToken(), /Google رفض المفتاح.*Invalid JWT Signature/);
  assert.match(signJwt(parseServiceAccount(KEY_JSON)), /^[\w-]+\.[\w-]+\.[\w-]+$/);
});

test("read, append (new and existing tab), update: what is written is what is read back", async () => {
  const g = fakeGoogle();
  const ws = createWorkspace({ env: env(), fetchFn: g.fetchFn });
  assert.match(await ws.sheetRead({}), /«باقات العمرة»: الباقة \| الليالي \| السعر/);
  assert.match(await ws.sheetRead({ tab: "باقات العمرة" }), /2\tاقتصادية\t4\t2999/);

  const a = await ws.sheetAppend({ tab: "باقات العمرة", rows: [["VIP", 5, 5499], ["رمضان", 7, 7999]] });
  assert.deepEqual([a.created, a.count, a.where], [false, 2, "A3:C4"]);
  const n = await ws.sheetAppend({ tab: "جورجيا", rows: [["الباقة", "السعر"], ["تبليسي", 3200]] });
  assert.equal(n.created, true);
  assert.deepEqual(g.tabs.get("جورجيا"), [["الباقة", "السعر"], ["تبليسي", 3200]]);

  const u = await ws.sheetUpdate({ tab: "باقات العمرة", range: "C3", rows: [[5299]] });
  assert.equal(u.cells, 1);
  const back = await ws.sheetRead({ tab: "باقات العمرة" });
  assert.match(back, /3\tVIP\t5\t5299/);
  assert.match(back, /4\tرمضان\t7\t7999/);
  assert.equal(g.tabs.get("باقات العمرة").length, 4, "nothing lost or duplicated");

  assert.match(await ws.sheetRead({ tab: "غير موجود" }), /ما فيه تبويب اسمه «غير موجود»/);
  await assert.rejects(ws.sheetUpdate({ tab: "غير موجود", range: "A1", rows: [[1]] }), /ما فيه تبويب/);
  await assert.rejects(ws.sheetAppend({ tab: "x", rows: [] }), /صف واحد على الأقل/);
});

test("partner documents: list by partner, read a PDF, a Google Doc; refuse what can't be read", async () => {
  const ws = createWorkspace({ env: env(), fetchFn: fakeGoogle().fetchFn });
  const all = await ws.partnerDocsList({});
  assert.match(all, /📁 فندق الصفوة:[\s\S]*عقد 2026\.pdf \(id: d1/);
  assert.match(await ws.partnerDocsList({ partner: "الصفوة" }), /شروط الإلغاء/);
  assert.match(await ws.partnerDocsList({ partner: "طيران" }), /ما لقيت مجلد شريك يطابق «طيران»/);
  const pdf = await ws.partnerDocContent("d1");
  assert.equal(pdf.block.type, "document");
  assert.equal(Buffer.from(pdf.block.source.data, "base64").toString(), "%PDF-fake");
  assert.equal((await ws.partnerDocContent("d2")).text, "الإلغاء قبل 14 يوم مجاني");
  await assert.rejects(ws.partnerDocContent("d3"), /غير مدعوم/);
});

test("not shared with the service account: the error says which email to share with", async () => {
  const ws = createWorkspace({ env: env(), fetchFn: fakeGoogle({ shared: false }).fetchFn });
  await assert.rejects(ws.sheetRead({}), new RegExp(`مشارَك مع ${EMAIL.replace(/\./g, "\\.")}`));
});

test("tools are only offered for what is configured", () => {
  const names = (e) => workspaceTools(createWorkspace({ env: e, fetchFn: async () => ({}) }).status).map((t) => t.name);
  assert.deepEqual(names({}), []);
  assert.deepEqual(names(env({ GOOGLE_PARTNERS_FOLDER_ID: "" })), ["sheet_read", "sheet_append_rows", "sheet_update_cells"]);
  assert.deepEqual(names(env()).slice(3), ["partner_docs_list", "partner_doc_read"]);
  assert.equal(createWorkspace({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: "garbage" } }).status.keyProblem !== null, true);
});
