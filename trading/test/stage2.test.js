// Run with: npm test
// The first part needs nothing. The database part runs only when
// TEST_TRADING_DATABASE_URL points at a throw-away Postgres (it creates and
// fills the "trading" schema there) — it is skipped otherwise.
const test = require("node:test");
const assert = require("node:assert");
const { verifyAllowlist } = require("../verify-allowlist");
const { seedAllowlist } = require("../allowlist");
const { createDb, parseDatabaseUrl, DbError } = require("../db");
const { syncAllowlist, readAllowlists, appendAudit } = require("../db/store");
const { readConfig } = require("../config");
const { mount } = require("../index");

const item = (id, symbol, cls, exchange = "NASDAQ") => ({ instrumentId: id, internalSymbolFull: symbol, displayname: `${symbol} name`, internalAssetClassName: cls, internalExchangeName: exchange });

// A stand-in for the eToro client: answers searches from a table.
function fakeClient(table) {
  const calls = [];
  return {
    calls,
    redact: (t) => String(t ?? ""),
    async searchInstruments(symbol) {
      calls.push(symbol);
      const answer = table[symbol];
      if (answer instanceof Error) throw answer;
      return { data: { items: answer || [] }, source: "eToro Public API GET /api/v1/market-data/search", fetchedAt: "2026-11-13T08:00:00.000Z" };
    },
  };
}

test("the seed holds the owner's 22 stocks and 9 coins, and only MSTR is crypto-correlated", () => {
  const seed = seedAllowlist();
  assert.strictEqual(seed.filter((s) => s.assetClass === "stock").length, 22);
  assert.strictEqual(seed.filter((s) => s.assetClass === "crypto").length, 9);
  assert.strictEqual(new Set(seed.map((s) => s.symbol)).size, 31);
  assert.deepStrictEqual(seed.filter((s) => s.cryptoCorrelated).map((s) => s.symbol), ["MSTR"]);
});

test("verification accepts only one exact match of the right asset class", async () => {
  const entries = [
    { symbol: "MSTR", assetClass: "stock", cryptoCorrelated: true },
    { symbol: "SE", assetClass: "stock", cryptoCorrelated: false },    // only look-alikes come back
    { symbol: "GRAB", assetClass: "stock", cryptoCorrelated: false },  // listed twice
    { symbol: "FET", assetClass: "stock", cryptoCorrelated: false },   // exists, but as crypto
    { symbol: "NKE", assetClass: "stock", cryptoCorrelated: false },   // the call fails
    { symbol: "BTC", assetClass: "crypto", cryptoCorrelated: false },
    { symbol: "VISN", assetClass: "stock", cryptoCorrelated: false },  // an ETF must not pass as a stock
  ];
  const client = fakeClient({
    MSTR: [item(2001, "MSTR", "Stocks"), item(2002, "MSTR.EXT", "Stocks")],
    SE: [item(3001, "SEDG", "Stocks"), item(3002, "SE.L", "Stocks")],
    GRAB: [item(4001, "GRAB", "Stocks"), item(4002, "GRAB", "Stocks", "LSE")],
    FET: [item(100050, "FET", "Crypto", "eToro")],
    NKE: new Error("eToro 500"),
    BTC: [item(100000, "BTC", "Crypto", "eToro")],
    VISN: [item(5001, "VISN", "ETF")],
  });
  const v = await verifyAllowlist(client, entries);
  const status = Object.fromEntries(v.results.map((r) => [r.symbol, r.status]));
  assert.deepStrictEqual(status, { MSTR: "verified", SE: "no_match", GRAB: "ambiguous", FET: "wrong_asset_class", NKE: "error", BTC: "verified", VISN: "wrong_asset_class" });
  assert.strictEqual(v.allVerified, false);
  assert.strictEqual(v.verified, 2);
  assert.strictEqual(v.results[0].match.instrumentId, 2001);
  assert.deepStrictEqual(v.results[1].candidates.map((c) => c.symbol), ["SEDG", "SE.L"]);
  assert.match(v.results[0].source, /market-data\/search/);
});

test("verification stops asking after a 429 and says which symbols were not checked", async () => {
  const limited = Object.assign(new Error("eToro 429"), { status: 429 });
  const client = fakeClient({ A: [item(1, "A", "Stocks")], B: limited, C: [item(3, "C", "Stocks")] });
  const v = await verifyAllowlist(client, ["A", "B", "C"].map((symbol) => ({ symbol, assetClass: "stock", cryptoCorrelated: false })));
  assert.deepStrictEqual(v.results.map((r) => r.status), ["verified", "error", "not_checked"]);
  assert.deepStrictEqual(client.calls, ["A", "B"]);
});

test("database URL: TLS is verified for any remote host and cannot be switched off by the string", () => {
  const p = parseDatabaseUrl("postgresql://postgres.abcd:p%40ss@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=disable");
  assert.strictEqual(p.options.ssl.rejectUnauthorized, true);
  assert.match(p.options.ssl.ca, /BEGIN CERTIFICATE/);
  assert.strictEqual(p.options.user, "postgres.abcd");
  assert.strictEqual(p.options.password, "p@ss");
  assert.deepStrictEqual(p.warnings, []);
  assert.strictEqual(parseDatabaseUrl("postgresql://u:p@localhost:5432/x").options.ssl, false);
  assert.match(parseDatabaseUrl("postgresql://postgres:p@db.abcd.supabase.co:5432/postgres").warnings[0], /IPv6/);
  assert.throws(() => parseDatabaseUrl("https://example.com"), DbError);
  assert.throws(() => parseDatabaseUrl("postgresql://postgres.abcd:[YOUR-PASSWORD]@h:5432/postgres"), /placeholder/);
});

test("config reads the database URL only from TRADING_DATABASE_URL", () => {
  assert.strictEqual(readConfig({ DATABASE_URL: "postgresql://a:b@c/d" }).databaseUrl, "");
  assert.strictEqual(readConfig({ TRADING_DATABASE_URL: " postgresql://a:b@c/d " }).databaseUrl, "postgresql://a:b@c/d");
});

// A tiny stand-in for Express, enough to call the mounted routes.
function fakeApp() {
  const routes = {};
  return {
    get: (path, ...handlers) => { routes[path] = handlers; },
    async call(path, query = {}) {
      const res = { statusCode: 200, body: null, set() { return res; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
      const run = async (i) => { if (routes[path][i]) await routes[path][i]({ query }, res, () => run(i + 1)); };
      await run(0);
      return res;
    },
  };
}
const cfg = { baseUrl: "https://public-api.etoro.com", apiKey: "PUBKEY-123", userKey: "USERKEY-456", hasKeys: true, tradingEnabled: false, databaseUrl: "" };

test("database routes are closed without a login and without TRADING_DATABASE_URL, and write nothing unasked", async () => {
  const open = fakeApp();
  mount(open, { authOn: false, config: cfg, client: fakeClient({}) });
  for (const p of ["/api/trading/admin/db-status", "/api/trading/admin/migrate", "/api/trading/admin/sync-allowlist", "/api/trading/test/verify-allowlist", "/api/trading/test/demo-portfolio", "/api/trading/test/instrument"]) {
    assert.strictEqual((await open.call(p)).statusCode, 503, p);
  }
  const app = fakeApp();
  mount(app, { authOn: true, config: cfg, client: fakeClient({}) });
  assert.strictEqual((await app.call("/api/trading/admin/migrate", { confirm: "001_initial" })).statusCode, 503);
  const s = await app.call("/api/trading/admin/db-status");
  assert.strictEqual(s.body.configured, false);
  assert.deepStrictEqual(s.body.migrationFiles, ["001_initial"]);
});

test("the two new test routes return eToro's raw answer with source and time", async () => {
  const app = fakeApp();
  const seen = [];
  const client = {
    redact: (t) => String(t ?? ""),
    getDemoPortfolio: async () => ({ data: { clientPortfolio: { positions: [], orders: [], mirrors: [] } }, source: "eToro Public API GET /api/v1/trading/info/demo/portfolio", fetchedAt: "t", status: 200, rateLimit: {} }),
    getInstruments: async (ids) => { seen.push(ids); return { data: { instrumentDisplayDatas: [] }, source: "eToro Public API GET /api/v2/market-data/instruments", fetchedAt: "t", status: 200, rateLimit: {} }; },
  };
  mount(app, { authOn: true, config: cfg, client });
  const p = await app.call("/api/trading/test/demo-portfolio");
  assert.deepStrictEqual(p.body.counts, { positions: 0, ordersForOpen: null, orders: 0, mirrors: 0 });
  assert.match(p.body.source, /demo\/portfolio/);
  const i = await app.call("/api/trading/test/instrument", { ids: "1001, 100000" });
  assert.deepStrictEqual(seen, [["1001", "100000"]]);
  assert.deepStrictEqual(i.body.topLevelKeys, ["instrumentDisplayDatas"]);
  assert.strictEqual((await app.call("/api/trading/test/instrument")).statusCode, 400);
});

// ---------------------------------------------------------------------------
// Database tests — against a real Postgres.
// ---------------------------------------------------------------------------
const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, fn);
const db = TEST_URL ? createDb({ config: { databaseUrl: TEST_URL } }) : null;
const HASH = "a".repeat(64);
const rejects = (promise, pattern) => assert.rejects(promise, (e) => { assert.match(e.message, pattern); return true; });

if (TEST_URL) {
  test.before(async () => { await db.query("drop schema if exists trading cascade"); });
  test.after(async () => { await db.close(); });
}

dbTest("migration: nothing exists until it is named exactly, then all 11 tables exist", async () => {
  let s = await db.status();
  assert.strictEqual(s.connected, true);
  assert.deepStrictEqual(s.migrations.pending, ["001_initial"]);
  await rejects(db.migrate(""), /confirm=001_initial/);
  await rejects(db.migrate("002_other"), /confirm=001_initial/);
  assert.deepStrictEqual((await db.status()).tables, {});
  assert.deepStrictEqual(await db.migrate("001_initial"), { applied: "001_initial", remaining: [] });
  s = await db.status();
  assert.deepStrictEqual(s.migrations.pending, []);
  assert.deepStrictEqual(Object.keys(s.tables), ["analyses", "approvals", "audit_log", "crypto_allowlist", "instruments", "market_snapshots", "orders", "positions", "proposals", "risk_assessments", "schema_migrations", "stock_allowlist"]);
  await rejects(db.migrate("001_initial"), /already applied/);
  const rls = await db.query("select count(*) as n from pg_tables where schemaname = 'trading' and not rowsecurity");
  assert.strictEqual(Number(rls.rows[0].n), 0);
});

dbTest("allowlist sync: verified symbols are linked, the rest are listed but not tradable", async () => {
  const entries = [
    { symbol: "MSTR", assetClass: "stock", cryptoCorrelated: true },
    { symbol: "NKE", assetClass: "stock", cryptoCorrelated: false },
    { symbol: "WYFI", assetClass: "stock", cryptoCorrelated: false },
    { symbol: "BTC", assetClass: "crypto", cryptoCorrelated: false },
  ];
  const table = { MSTR: [item(2001, "MSTR", "Stocks")], NKE: [item(2002, "NKE", "Stocks", "NYSE")], WYFI: [], BTC: [item(100000, "BTC", "Crypto", "eToro")] };
  const first = await syncAllowlist(db, await verifyAllowlist(fakeClient(table), entries), { actor: "test" });
  assert.deepStrictEqual(first.linked, ["MSTR", "NKE", "BTC"]);
  assert.deepStrictEqual(first.listedUnverified, ["WYFI (no_match)"]);
  let lists = await readAllowlists(db);
  const bySymbol = Object.fromEntries(lists.stocks.map((r) => [r.symbol, r]));
  assert.strictEqual(bySymbol.MSTR.crypto_correlated, true);
  assert.strictEqual(bySymbol.NKE.crypto_correlated, false);
  assert.strictEqual(bySymbol.MSTR.instrument_id, 2001);
  assert.strictEqual(bySymbol.WYFI.tradable, false);
  assert.strictEqual(lists.crypto[0].tradable, true);

  // Second run: NKE's search fails (earlier result is kept), WYFI is gone from the seed.
  const second = await syncAllowlist(db, await verifyAllowlist(fakeClient({ ...table, NKE: new Error("eToro 500") }), entries.filter((e) => e.symbol !== "WYFI")), { actor: "test" });
  assert.deepStrictEqual(second.keptEarlierVerification, ["NKE (error)"]);
  assert.deepStrictEqual(second.deactivated, ["WYFI"]);
  lists = await readAllowlists(db);
  assert.strictEqual(lists.stocks.find((r) => r.symbol === "NKE").tradable, true);
  assert.strictEqual(lists.stocks.find((r) => r.symbol === "WYFI").active, false);
  const audit = await db.query("select event_type, actor from trading.audit_log order by seq");
  assert.deepStrictEqual(audit.rows.map((r) => r.event_type), ["allowlist.synced", "allowlist.synced"]);
});

dbTest("a stock allowlist row cannot point at a crypto instrument, and a failed transaction leaves nothing behind", async () => {
  await rejects(db.query("insert into trading.stock_allowlist (symbol, instrument_id, verified_at) values ('BTC', 100000, now())"), /foreign key/);
  await rejects(db.query("insert into trading.instruments (instrument_id, symbol, asset_class, raw, source, fetched_at) values (9, 'SPY', 'etf', '{}', 's', now())"), /check constraint/);
  await rejects(db.withTransaction(async (tx) => {
    await appendAudit(tx, { eventType: "test.rollback", actor: "test" });
    await tx.query("select 1/0");
  }), /division by zero/);
  assert.strictEqual(Number((await db.query("select count(*) as n from trading.audit_log where event_type = 'test.rollback'")).rows[0].n), 0);
});

dbTest("the audit log can only grow", async () => {
  await rejects(db.query("update trading.audit_log set actor = 'x'"), /append-only/);
  await rejects(db.query("delete from trading.audit_log"), /append-only/);
  await rejects(db.query("truncate trading.audit_log"), /append-only/);
});

const newProposal = (extra = {}) => {
  const p = { action: "open", instrument_id: 2001, asset_class: "stock", direction: "buy", leverage: 1, order_type: "market", amount_usd: 100, expires_at: new Date(Date.now() + 10 * 60000).toISOString(), params_hash: HASH, ...extra };
  const cols = Object.keys(p);
  return db.query(`insert into trading.proposals (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(p));
};

dbTest("proposals: long only, leverage 1, the instrument's real asset class, frozen parameters, no live duplicate", async () => {
  await rejects(newProposal({ direction: "sell" }), /check constraint/);
  await rejects(newProposal({ leverage: 2 }), /check constraint/);
  await rejects(newProposal({ amount_usd: 0 }), /check constraint/);
  await rejects(newProposal({ asset_class: "crypto" }), /foreign key/);       // MSTR is a stock
  await rejects(newProposal({ action: "close" }), /check constraint/);        // a close must name a position
  const id = (await newProposal()).rows[0].id;
  await rejects(db.query("update trading.proposals set amount_usd = 499 where id = $1", [id]), /cannot be changed/);
  await rejects(db.query("update trading.proposals set expires_at = expires_at + interval '1 hour' where id = $1", [id]), /cannot be changed/);
  await db.query("update trading.proposals set status = 'pending_approval' where id = $1", [id]);
  const second = (await newProposal()).rows[0].id;
  await rejects(db.query("update trading.proposals set status = 'pending_approval' where id = $1", [second]), /proposals_one_live_open/);
  await db.query("update trading.proposals set status = 'cancelled' where id = $1", [id]);
});

dbTest("approvals: 15 minutes at most, same hash as the proposal, decided once, never after expiry", async () => {
  const id = (await newProposal()).rows[0].id;
  const ins = (expires, hash = HASH) => db.query(`insert into trading.approvals (proposal_id, params_hash, expires_at) values ($1, $2, now() + $3::interval) returning id`, [id, hash, expires]);
  await rejects(ins("16 minutes"), /check constraint/);
  await rejects(ins("15 minutes", "b".repeat(64)), /foreign key/);
  const a = (await ins("15 minutes")).rows[0].id;
  await rejects(ins("15 minutes"), /approvals_proposal_id_key/);                 // one request per proposal
  await rejects(db.query("update trading.approvals set decision = 'approved', decided_at = expires_at + interval '1 second', channel = 'telegram' where id = $1", [a]), /check constraint/);
  await rejects(db.query("update trading.approvals set expires_at = expires_at + interval '1 minute' where id = $1", [a]), /re-pointed or extended/);
  await db.query("update trading.approvals set decision = 'rejected', decided_at = now(), channel = 'telegram', actor = '1' where id = $1", [a]);
  await rejects(db.query("update trading.approvals set decision = 'approved' where id = $1", [a]), /final/);
  await rejects(db.query("update trading.approvals set consumed_at = now() where id = $1", [a]), /check constraint/);   // a rejection cannot be used
});

dbTest("orders: demo only, need an approved and consumed approval with the same hash, one order per approval", async () => {
  const pid = (await newProposal()).rows[0].id;
  const aid = (await db.query("insert into trading.approvals (proposal_id, params_hash, expires_at) values ($1, $2, now() + interval '15 minutes') returning id", [pid, HASH])).rows[0].id;
  const order = (extra = {}) => {
    const o = { proposal_id: pid, approval_id: aid, params_hash: HASH, idempotency_key: require("crypto").randomUUID(), request: "{}", ...extra };
    const cols = Object.keys(o);
    return db.query(`insert into trading.orders (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(o));
  };
  await rejects(order(), /order refused/);                                       // not decided yet
  await db.query("update trading.approvals set decision = 'approved', decided_at = now(), channel = 'telegram', actor = '1' where id = $1", [aid]);
  await rejects(order(), /order refused/);                                       // approved but not consumed
  await db.query("update trading.approvals set consumed_at = now() where id = $1", [aid]);
  await rejects(db.query("update trading.approvals set consumed_at = now() + interval '1 second' where id = $1", [aid]), /only once/);
  await rejects(order({ environment: "real" }), /check constraint/);
  await rejects(order({ params_hash: "c".repeat(64) }), /foreign key/);
  const oid = (await order()).rows[0].id;
  await rejects(order(), /orders_proposal_id_key|orders_approval_id_key/);       // the approval is spent
  await rejects(db.query("update trading.orders set request = '{\"amount\": 5000}' where id = $1", [oid]), /cannot be changed/);
  await db.query("update trading.orders set status = 'filled', etoro_order_id = 77 where id = $1", [oid]);
  await rejects(db.query("insert into trading.positions (etoro_position_id, instrument_id, direction, leverage, amount_usd, source, last_synced_at, environment) values (1, 2001, 'buy', 1, 100, 's', now(), 'real')"), /check constraint/);
  await rejects(db.query("insert into trading.positions (etoro_position_id, instrument_id, direction, leverage, amount_usd, source, last_synced_at) values (1, 2001, 'sell', 1, 100, 's', now())"), /check constraint/);
});
