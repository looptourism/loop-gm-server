// Run with: npm test
// Editing the allowlists from the Trading Desk page: an admin session, a
// strict eToro check before any add, every change and refused add in the
// audit log, and the risk engine's allowlist check following the change.
// The database tests run only when TEST_TRADING_DATABASE_URL points at a
// throw-away Postgres; each gets its own fresh database.
const test = require("node:test");
const assert = require("node:assert");
const { createAdmin, COOKIE } = require("../admin");
const { createDb } = require("../db");
const { mount } = require("../index");
const { loadAllowlist } = require("../risk/context");
const { readAllowlists } = require("../db/store");

// ---- the admin session ---------------------------------------------------------------
test("admin session: only the right password opens it, it expires, and only the cookie carries it", () => {
  let t = 1_000_000;
  const off = createAdmin({ password: "", now: () => t });
  assert.strictEqual(off.configured, false);
  assert.strictEqual(off.checkPassword("ip", "").ok, false);
  assert.strictEqual(off.verify(off.issue().token).ok, false, "no password on the server → no session, ever");

  const a = createAdmin({ password: "s3cret", now: () => t });
  assert.strictEqual(a.checkPassword("1.1.1.1", "s3cret").ok, true);
  const { token, expiresAt } = a.issue();
  assert.strictEqual(expiresAt, new Date(t + 15 * 60 * 1000).toISOString());
  const req = (headers) => ({ get: (h) => headers[h] ?? null, secure: true });
  assert.strictEqual(a.verify(a.tokenFrom(req({ Cookie: `other=1; ${COOKIE}=${token}` }))).ok, true);
  assert.strictEqual(a.tokenFrom(req({ Authorization: `Bearer ${token}` })), "", "a header does not count");
  assert.strictEqual(a.verify(token.replace(/.$/, (c) => (c === "A" ? "B" : "A"))).ok, false, "tampered signature");
  assert.strictEqual(a.verify(`${t + 999999999}.${token.split(".")[1]}`).ok, false, "a longer expiry with the old signature");
  assert.strictEqual(createAdmin({ password: "s3cret", now: () => t }).verify(token).ok, false, "another process (a restart) does not accept it");
  t += 15 * 60 * 1000 + 1;
  assert.strictEqual(a.verify(token).ok, false, "expired after 15 minutes");

  const cookie = a.cookie({ secure: true }, token, 900);
  for (const part of ["HttpOnly", "SameSite=Strict", "Path=/api/trading/desk", "Max-Age=900", "Secure"]) assert.ok(cookie.includes(part), part);
});

test("admin session: five wrong passwords lock that address out, others are unaffected", () => {
  let t = 0;
  const a = createAdmin({ password: "s3cret", now: () => t });
  for (let i = 0; i < 4; i++) assert.strictEqual(a.checkPassword("9.9.9.9", "nope").locked, false);
  const fifth = a.checkPassword("9.9.9.9", "nope");
  assert.deepStrictEqual([fifth.ok, fifth.locked], [false, true]);
  assert.strictEqual(a.checkPassword("9.9.9.9", "s3cret").ok, false, "even the right password while locked out");
  assert.strictEqual(a.checkPassword("8.8.8.8", "s3cret").ok, true, "another address");
  t += 15 * 60 * 1000 + 1;
  assert.strictEqual(a.checkPassword("9.9.9.9", "s3cret").ok, true, "after the lockout");
});

// ---- routes ---------------------------------------------------------------------------
function fakeApp() {
  const routes = { GET: {}, POST: {} };
  const call = (method) => async (p, { query = {}, body = {}, headers = {} } = {}) => {
    let done; const finished = new Promise((r) => { done = r; });
    const res = { statusCode: 200, body: null, headers: {}, set(k, v) { res.headers[k] = v; return res; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; done(); return res; }, type() { return res; }, send(b) { res.body = b; done(); return res; }, sendFile() { done(); } };
    const req = { query, body, ip: headers["x-ip"] || "7.7.7.7", secure: true, get: (h) => headers[h] ?? headers[h.toLowerCase()] ?? null };
    const run = (i) => routes[method][p][i] && routes[method][p][i](req, res, () => run(i + 1));
    run(0);
    await finished;
    return res;
  };
  return { get: (p, ...h) => { routes.GET[p] = h; }, post: (p, ...h) => { routes.POST[p] = h; }, GET: call("GET"), POST: call("POST") };
}
const quiet = { start: () => false, state: () => ({}) };
const PAGE = { "X-Trading-Desk": "1", Host: "x.onrender.com", Origin: "https://x.onrender.com" };

test("routes: no admin password on the server → editing is off; foreign requests are refused before anything else", async () => {
  const app = fakeApp();
  mount(app, { authOn: true, config: { hasKeys: true }, client: { redact: (t) => t }, db: { configured: false, redact: (t) => t }, monitor: quiet, research: quiet, positions: quiet, agents: quiet, approvals: { start: () => false }, admin: createAdmin({ password: "" }) });
  const unlock = await app.POST("/api/trading/desk/admin/unlock", { headers: PAGE, body: { password: "x" } });
  assert.deepStrictEqual([unlock.statusCode, unlock.body.adminConfigured], [503, false]);
  assert.strictEqual((await app.POST("/api/trading/desk/admin/unlock", { headers: {}, body: { password: "x" } })).statusCode, 403, "no X-Trading-Desk header");
  assert.strictEqual((await app.POST("/api/trading/desk/admin/unlock", { headers: { ...PAGE, Origin: "https://evil.example" }, body: { password: "x" } })).statusCode, 403, "another site");
  // no database: the list routes say so before anything else
  assert.strictEqual((await app.POST("/api/trading/desk/allowlist/add", { headers: PAGE, body: { assetClass: "stock", symbol: "AAPL" } })).statusCode, 503);
  assert.strictEqual((await app.POST("/api/trading/desk/allowlist/remove", { headers: PAGE, body: { assetClass: "stock", symbol: "AAPL" } })).statusCode, 503);

  const closed = fakeApp();
  mount(closed, { authOn: false, config: { hasKeys: true }, client: { redact: (t) => t }, db: { configured: false, redact: (t) => t }, monitor: quiet, research: quiet, positions: quiet, agents: quiet, approvals: { start: () => false }, admin: createAdmin({ password: "s3cret" }) });
  assert.strictEqual((await closed.POST("/api/trading/desk/admin/unlock", { headers: PAGE, body: { password: "s3cret" } })).statusCode, 503, "console login off → desk closed");
});

// ---- against a real Postgres -------------------------------------------------------------
const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, async () => {
  const dbName = `trading_al_${Math.random().toString(36).slice(2, 10)}`;
  const root = createDb({ config: { databaseUrl: TEST_URL } });
  await root.query(`create database ${dbName}`);
  const u = new URL(TEST_URL); u.pathname = `/${dbName}`;
  const db = createDb({ config: { databaseUrl: u.toString() } });
  try { await db.migrateAll(); await fn(db); }
  finally { await db.close(); await root.query(`drop database ${dbName} with (force)`); await root.close(); }
});

// eToro's Market Data search, as recorded per symbol
const ITEMS = {
  AAPL: [{ instrumentId: 1001, internalSymbolFull: "AAPL", displayname: "Apple", internalAssetClassName: "Stocks", internalExchangeName: "NASDAQ" },
         { instrumentId: 9101, internalSymbolFull: "AAPL.L", displayname: "Apple (London)", internalAssetClassName: "Stocks" }],
  SPY: [{ instrumentId: 3000, internalSymbolFull: "SPY", displayname: "SPDR S&P 500", internalAssetClassName: "ETF" }],
  BTC: [{ instrumentId: 100000, internalSymbolFull: "BTC", displayname: "Bitcoin", internalAssetClassName: "Crypto" }],
  DUP: [{ instrumentId: 5001, internalSymbolFull: "DUP", internalAssetClassName: "Stocks" }, { instrumentId: 5002, internalSymbolFull: "DUP", internalAssetClassName: "Stocks" }],
  AAPLX: [{ instrumentId: 1001, internalSymbolFull: "AAPL", displayname: "Apple", internalAssetClassName: "Stocks" }],
  MSTR: [{ instrumentId: 2001, internalSymbolFull: "MSTR", displayname: "Strategy", internalAssetClassName: "Stocks" }],
};
function world(db) {
  const w = { db, searches: [], down: false };
  w.client = {
    redact: (x) => String(x ?? ""),
    searchInstruments: async (symbol) => {
      w.searches.push(symbol);
      if (w.down) { const e = new Error("eToro 503"); e.status = 503; throw e; }
      return { data: { items: ITEMS[symbol] || [] }, source: `GET /api/v1/market-data/search?internalSymbolFull=${symbol}`, fetchedAt: "2026-11-25T18:00:00.000Z" };
    },
  };
  let t = Date.now();
  w.tick = (ms) => { t += ms; };
  w.admin = createAdmin({ password: "s3cret", now: () => t });
  w.app = fakeApp();
  mount(w.app, { authOn: true, config: { hasKeys: true, tradingEnabled: false }, client: w.client, db, monitor: quiet, research: quiet, positions: quiet, agents: { ...quiet, state: () => ({}) }, approvals: { start: () => false }, admin: w.admin });
  w.cookie = null;
  w.post = (path, body, extra = {}) => w.app.POST(path, { headers: { ...PAGE, ...(w.cookie ? { Cookie: w.cookie } : {}), ...extra }, body });
  w.unlock = async (password = "s3cret") => {
    const r = await w.post("/api/trading/desk/admin/unlock", { password });
    if (r.statusCode === 200) w.cookie = r.headers["Set-Cookie"].split(";")[0];
    return r;
  };
  w.audit = async (type) => (await db.query("select event_type, actor, entity_id, data from trading.audit_log where event_type like $1 order by seq", [type])).rows;
  return w;
}
const settle = () => new Promise((r) => setTimeout(r, 120)); // mount prepares the database first

dbTest("add: needs the admin session; verified on eToro, saved with its source, audited, and the risk engine accepts it", async (db) => {
  const w = world(db); await settle();
  const before = await w.post("/api/trading/desk/allowlist/add", { assetClass: "stock", symbol: "aapl" });
  assert.deepStrictEqual([before.statusCode, before.body.adminRequired], [403, true]);
  assert.strictEqual(w.searches.length, 0, "eToro is not even asked without an admin session");

  const wrong = await w.unlock("guess");
  assert.strictEqual(wrong.statusCode, 401);
  assert.strictEqual((await w.audit("admin.unlock_failed")).length, 1);
  const ok = await w.unlock();
  assert.strictEqual(ok.statusCode, 200);
  assert.match(ok.headers["Set-Cookie"], /HttpOnly; SameSite=Strict/);
  assert.strictEqual((await w.audit("admin.unlocked"))[0].actor, "owner:console:admin");

  const r = await w.post("/api/trading/desk/allowlist/add", { assetClass: "stock", symbol: " aapl ", cryptoCorrelated: false });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.symbol, r.body.instrumentId, r.body.previously], ["AAPL", 1001, "new"]);
  assert.deepStrictEqual(w.searches, ["AAPL"], "searched once, upper-cased");
  const row = (await db.query("select active, instrument_id, verified_at from trading.stock_allowlist where symbol = 'AAPL'")).rows[0];
  assert.deepStrictEqual([row.active, Number(row.instrument_id), row.verified_at.toISOString()], [true, 1001, "2026-11-25T18:00:00.000Z"]);
  const inst = (await db.query("select symbol, display_name, asset_class, source from trading.instruments where instrument_id = 1001")).rows[0];
  assert.deepStrictEqual([inst.symbol, inst.display_name, inst.asset_class], ["AAPL", "Apple", "stock"]);
  assert.match(inst.source, /market-data\/search\?internalSymbolFull=AAPL/);
  const [added] = await w.audit("allowlist.symbol_added");
  assert.deepStrictEqual([added.actor, added.entity_id, added.data.instrumentId, added.data.previously, added.data.fetchedAt], ["owner:console:admin", "AAPL", 1001, "new", "2026-11-25T18:00:00.000Z"]);
  assert.match(added.data.source, /market-data\/search/);
  // the risk engine reads the same row
  assert.deepStrictEqual(await loadAllowlist(db, { assetClass: "stock", instrumentId: 1001 }), { listed: true, active: true, verified: true, assetClass: "stock", cryptoCorrelated: false });
  // twice: refused, nothing new
  const again = await w.post("/api/trading/desk/allowlist/add", { assetClass: "stock", symbol: "AAPL" });
  assert.strictEqual(again.statusCode, 409);
  assert.strictEqual((await w.audit("allowlist.symbol_added")).length, 1);
  // the same eToro instrument under another symbol (refused inside the transaction): a clear 409, nothing written
  ITEMS.APPLE = [{ instrumentId: 1001, internalSymbolFull: "APPLE", displayname: "Apple", internalAssetClassName: "Stocks" }];
  const same = await w.post("/api/trading/desk/allowlist/add", { assetClass: "stock", symbol: "APPLE" });
  assert.deepStrictEqual([same.statusCode, same.body.code], [409, "SameInstrument"], JSON.stringify(same.body));
  assert.strictEqual((await db.query("select count(*)::int as n from trading.stock_allowlist where symbol = 'APPLE'")).rows[0].n, 0);
  assert.strictEqual((await db.query("select symbol from trading.instruments where instrument_id = 1001")).rows[0].symbol, "AAPL", "the transaction rolled back");
});

dbTest("add refused unless eToro gives exactly one instrument with that symbol and the right class — each refusal audited, nothing saved", async (db) => {
  const w = world(db); await settle(); await w.unlock();
  const add = (assetClass, symbol) => w.post("/api/trading/desk/allowlist/add", { assetClass, symbol });
  const cases = [
    ["stock", "AAPLX", "no_match", /ما لقيت على eToro أداة رمزها AAPLX بالضبط \(أقرب النتائج: AAPL\)/],
    ["stock", "SPY", "wrong_asset_class", /مصنّف «ETF»، مو سهم/],
    ["stock", "BTC", "wrong_asset_class", /مصنّف «Crypto»، مو سهم/],
    ["crypto", "AAPL", "wrong_asset_class", /مو عملة رقمية/],
    ["stock", "DUP", "ambiguous", /أكثر من أداة/],
    ["stock", "NOPE", "no_match", /ما لقيت/],
  ];
  for (const [cls, sym, status, msg] of cases) {
    const r = await add(cls, sym);
    assert.deepStrictEqual([r.statusCode, r.body.ok, r.body.status], [422, false, status], `${cls} ${sym}`);
    assert.match(r.body.error, msg, `${cls} ${sym}`);
  }
  const rejected = await w.audit("allowlist.add_rejected");
  assert.deepStrictEqual(rejected.map((x) => [x.data.assetClass, x.entity_id, x.data.status]), cases.map(([c, s, st]) => [c, s, st]));
  assert.ok(rejected.every((x) => x.actor === "owner:console:admin" && x.data.reason && x.data.source));
  // eToro unreachable: fail closed
  w.down = true;
  const down = await add("stock", "MSTR");
  assert.strictEqual(down.statusCode, 502);
  assert.match(down.body.error, /تعذّر التحقق من eToro، فما انضاف شي/);
  assert.strictEqual((await w.audit("allowlist.add_rejected")).at(-1).data.status, "error");
  // bad input never reaches eToro
  const n = w.searches.length;
  assert.strictEqual((await add("stock", "<script>")).statusCode, 400);
  assert.strictEqual((await add("etf", "SPY")).statusCode, 400);
  assert.strictEqual(w.searches.length, n);
  // nothing was saved by any of it
  assert.strictEqual(Number((await db.query("select count(*) as n from trading.stock_allowlist")).rows[0].n) + Number((await db.query("select count(*) as n from trading.crypto_allowlist")).rows[0].n), 0);
  assert.strictEqual((await w.audit("allowlist.symbol_added")).length, 0);
});

dbTest("remove: switched off, audited with what it affects, refused for new buys, re-added only after a new eToro check", async (db) => {
  const w = world(db); await settle(); await w.unlock();
  assert.strictEqual((await w.post("/api/trading/desk/allowlist/add", { assetClass: "stock", symbol: "MSTR", cryptoCorrelated: true })).statusCode, 200);
  assert.strictEqual((await w.post("/api/trading/desk/allowlist/add", { assetClass: "crypto", symbol: "BTC" })).statusCode, 200);
  // a held MSTR position and a buy waiting for approval
  await db.query(`insert into trading.positions (etoro_position_id, instrument_id, direction, leverage, amount_usd, units, open_rate, opened_at, exit_conditions, source, last_synced_at)
                  values (11, 2001, 'buy', 1, 200, 1, 200, now(), '[]', 't', now())`);
  await db.query(`insert into trading.proposals (action, instrument_id, asset_class, direction, leverage, order_type, amount_usd, expires_at, params_hash, status)
                  values ('open', 2001, 'stock', 'buy', 1, 'market', 100, now() + interval '1 hour', repeat('a', 64), 'pending_approval')`);

  const r = await w.post("/api/trading/desk/allowlist/remove", { assetClass: "stock", symbol: "mstr" });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.openPositions, r.body.inFlightProposals], [1, 1]);
  assert.match(r.body.message, /انشال MSTR[\s\S]*مركز مفتوح فيه، وإغلاقه يشتغل عادي[\s\S]*طلب شراء قيد الانتظار بيرفضه فحص المخاطر/);
  const [removed] = await w.audit("allowlist.symbol_removed");
  assert.deepStrictEqual([removed.actor, removed.entity_id, removed.data.instrumentId, removed.data.openPositions, removed.data.inFlightProposals], ["owner:console:admin", "MSTR", 2001, 1, 1]);
  // the risk engine now refuses new MSTR buys; the row and its eToro link stay for the record
  assert.deepStrictEqual(await loadAllowlist(db, { assetClass: "stock", instrumentId: 2001 }), { listed: true, active: false, verified: true, assetClass: "stock", cryptoCorrelated: true });
  // BTC is untouched
  assert.strictEqual((await loadAllowlist(db, { assetClass: "crypto", instrumentId: 100000 })).active, true);
  // twice, or something never listed
  assert.strictEqual((await w.post("/api/trading/desk/allowlist/remove", { assetClass: "stock", symbol: "MSTR" })).statusCode, 404);
  assert.strictEqual((await w.post("/api/trading/desk/allowlist/remove", { assetClass: "crypto", symbol: "MSTR" })).statusCode, 404);
  assert.strictEqual((await w.audit("allowlist.symbol_removed")).length, 1);

  // re-adding asks eToro again
  const n = w.searches.length;
  const back = await w.post("/api/trading/desk/allowlist/add", { assetClass: "stock", symbol: "MSTR", cryptoCorrelated: true });
  assert.deepStrictEqual([back.statusCode, back.body.previously, w.searches.length], [200, "removed_earlier", n + 1]);
  assert.strictEqual((await loadAllowlist(db, { assetClass: "stock", instrumentId: 2001 })).active, true);
});

dbTest("an expired admin session can't change anything; locking ends it at once", async (db) => {
  const w = world(db); await settle(); await w.unlock();
  w.tick(15 * 60 * 1000 + 1);
  const late = await w.post("/api/trading/desk/allowlist/add", { assetClass: "crypto", symbol: "BTC" });
  assert.deepStrictEqual([late.statusCode, late.body.adminRequired, w.searches.length], [403, true, 0]);
  await w.unlock();
  const lock = await w.post("/api/trading/desk/admin/lock", {});
  assert.match(lock.headers["Set-Cookie"], /^loop_desk_admin=; [^]*Max-Age=0/);
  w.cookie = lock.headers["Set-Cookie"].split(";")[0];
  assert.strictEqual((await w.post("/api/trading/desk/allowlist/remove", { assetClass: "crypto", symbol: "BTC" })).statusCode, 403);
  // the page is told whether the session is on
  const desk = await w.app.GET("/api/trading/desk", { headers: {} });
  assert.deepStrictEqual(desk.body.admin, { configured: true, active: false, expiresAt: null });
});

dbTest("a later eToro sync works on the lists as edited: it neither brings back a removed symbol nor drops an added one", async (db) => {
  const w = world(db); await settle(); await w.unlock();
  for (const [cls, sym] of [["stock", "AAPL"], ["stock", "MSTR"], ["crypto", "BTC"]]) assert.strictEqual((await w.post("/api/trading/desk/allowlist/add", { assetClass: cls, symbol: sym })).statusCode, 200);
  assert.strictEqual((await w.post("/api/trading/desk/allowlist/remove", { assetClass: "stock", symbol: "MSTR" })).statusCode, 200);
  w.searches.length = 0;
  const s = await w.app.GET("/api/trading/admin/sync-allowlist", { query: { confirm: "yes" } });
  assert.strictEqual(s.statusCode, 200, JSON.stringify(s.body));
  assert.deepStrictEqual(w.searches.sort(), ["AAPL", "BTC"], "only the active rows are re-checked — not the 31-symbol seed");
  const lists = await readAllowlists(db);
  const state = (rows) => Object.fromEntries(rows.map((x) => [x.symbol, x.active]));
  assert.deepStrictEqual(state(lists.stocks), { AAPL: true, MSTR: false });
  assert.deepStrictEqual(state(lists.crypto), { BTC: true });
});
