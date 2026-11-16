// Run with: npm test
// Stage 5: the risk engine, approvals and the execution gateway — with a test
// for every way a trade can be refused. eToro, Telegram and the order client
// are stand-ins; no network. The database tests run only when
// TEST_TRADING_DATABASE_URL points at a throw-away Postgres; each one gets
// its own fresh database.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { assess, ENGINE_VERSION } = require("../risk/engine");
const { POLICY } = require("../policy");
const { createOrderClient, buildOpenOrder, OrderError, DEMO_ORDER_PATH } = require("../execution/etoro-orders");
const { createGateway } = require("../execution/gateway");
const { createApprovals, inQuietHours } = require("../approvals");
const { saveDraftProposal } = require("../db/analyses");
const { createDb } = require("../db");
const { mount } = require("../index");
const notify = require("../notify");

const T = new Date("2099-11-16T15:10:00Z");
const DETAILS = () => ({ holding_days: 7, rationale: "pulled back to support", disagreements: [{ issue: "size" }], exit_conditions: [{ type: "price_below", value: 95, description: "stop" }, { type: "price_above", value: 110, description: "target" }] });

// ---- the risk engine: every check, one at a time --------------------------------
const good = () => ({
  phase: "pre_approval", now: T, policy: POLICY, tradingEnabled: true, halted: false, storedPriceMaxAgeSec: 1200, referenceAsk: null,
  proposal: { id: "p1", action: "open", instrumentId: 2002, symbol: "NKE", assetClass: "stock", direction: "buy", leverage: 1, orderType: "market", amountUsd: 400, expiresAt: "2099-11-17T12:00:00.000Z", details: DETAILS() },
  allowlist: { listed: true, active: true, verified: true, assetClass: "stock", cryptoCorrelated: false },
  account: { ok: true, fetchedAt: T.toISOString(), availableCashUsd: 99000, copyPortfolios: 0, positions: [{ instrumentId: 3000, amountUsd: 500, assetClass: "stock", cryptoCorrelated: false }] },
  commitments: [],
  dailyLoss: { ok: true, baselineEquityUsd: 100000, baselineAt: "2099-11-16T00:07:00.000Z", equityUsd: 99980, lossUsd: 20 },
  price: { ok: true, bid: 100, ask: 100.1, asOf: "2099-11-16T15:08:00.000Z", ageSec: 120, quoteType: "realtime", source: "eToro" },
  earnings: { nextDate: null },
});
const failing = (change) => { const i = good(); change(i); return assess(i).failed; };

test("risk engine: a sound proposal passes every check, and the verdict lists them all", () => {
  const v = assess(good());
  assert.deepStrictEqual([v.passed, v.failed, v.warnings, v.engineVersion], [true, [], [], ENGINE_VERSION]);
  assert.deepStrictEqual(v.checks.map((c) => c.name), ["kill_switch", "demo_only", "not_expired", "opens_a_position", "asset_class", "allowlisted", "long_only", "no_leverage", "market_order", "per_trade_limit",
    "account_readable", "available_cash", "total_exposure", "crypto_exposure", "open_positions", "no_duplicate_position", "no_duplicate_proposal", "daily_loss", "fresh_price", "holding_period", "stop_level", "loss_at_stop", "targets_above_price", "exit_dates_in_horizon"]);
  assert.ok(v.checks.every((c) => c.passed && c.message));
  assert.deepStrictEqual(assess(good()), assess(good()));                           // same facts, same verdict
});

test("risk engine: each limit and rule rejects on its own", () => {
  const cases = [
    ["kill_switch", (i) => { i.tradingEnabled = false; }],
    ["kill_switch", (i) => { i.tradingEnabled = "true"; }],                          // only the boolean true counts
    ["kill_switch", (i) => { i.halted = true; }],
    ["kill_switch", (i) => { i.halted = undefined; }],                               // an unknown stop state is a stop
    ["demo_only", (i) => { i.policy = { ...POLICY, environment: "real" }; }],
    ["not_expired", (i) => { i.proposal.expiresAt = "2099-11-16T15:10:00.000Z"; }],
    ["opens_a_position", (i) => { i.proposal.action = "close"; }],
    ["asset_class", (i) => { i.proposal.assetClass = "etf"; }],
    ["allowlisted", (i) => { i.allowlist = { listed: false }; }],
    ["allowlisted", (i) => { i.allowlist.active = false; }],
    ["allowlisted", (i) => { i.allowlist.verified = false; }],
    ["allowlisted", (i) => { i.allowlist.assetClass = "crypto"; }],
    ["long_only", (i) => { i.proposal.direction = "sell"; }],
    ["no_leverage", (i) => { i.proposal.leverage = 2; }],
    ["market_order", (i) => { i.proposal.orderType = "limit"; }],
    ["per_trade_limit", (i) => { i.proposal.amountUsd = 500.01; }],                  // stock limit $500
    ["per_trade_limit", (i) => { i.proposal.amountUsd = 0; }],
    ["available_cash", (i) => { i.account.availableCashUsd = 399.99; }],
    ["available_cash", (i) => { i.account.availableCashUsd = 500; i.commitments = [{ proposalId: "p2", instrumentId: 3001, amountUsd: 200, assetClass: "stock" }]; }], // money already spoken for
    ["total_exposure", (i) => { i.account.positions = [{ instrumentId: 3000, amountUsd: 4700, assetClass: "stock" }]; }],                // 4700 + 400 > 5000
    ["total_exposure", (i) => { i.account.positions = [{ instrumentId: 3000, amountUsd: 4000, assetClass: "stock" }]; i.commitments = [{ proposalId: "p2", instrumentId: 3001, amountUsd: 700, assetClass: "stock" }]; }],
    ["open_positions", (i) => { i.account.positions = Array.from({ length: 10 }, (_, k) => ({ instrumentId: 4000 + k, amountUsd: 10, assetClass: "stock" })); }],
    ["no_duplicate_position", (i) => { i.account.positions = [{ instrumentId: 2002, amountUsd: 100, assetClass: "stock" }]; }],
    ["no_duplicate_proposal", (i) => { i.commitments = [{ proposalId: "p2", instrumentId: 2002, amountUsd: 100, assetClass: "stock" }]; }],
    ["daily_loss", (i) => { i.dailyLoss.lossUsd = 100; }],                           // the limit itself is too much
    ["daily_loss", (i) => { i.dailyLoss = { ok: false, reason: "no account snapshot has been recorded today" }; }],
    ["fresh_price", (i) => { i.price.ageSec = 1201; }],
    ["fresh_price", (i) => { i.price.quoteType = "delayed"; }],
    ["fresh_price", (i) => { i.price.ageSec = -61; }],                               // a price dated in the future
    ["holding_period", (i) => { i.proposal.details.holding_days = 15; }],
    ["holding_period", (i) => { i.proposal.details.holding_days = 0; }],
    ["holding_period", (i) => { delete i.proposal.details.holding_days; }],
    ["stop_level", (i) => { i.proposal.details.exit_conditions = [{ type: "price_above", value: 110, description: "t" }]; }],
    ["stop_level", (i) => { i.proposal.details.exit_conditions[0].value = 100; }],   // stop at the bid: out the moment it opens
    ["loss_at_stop", (i) => { i.proposal.details.exit_conditions[0].value = 70; }],   // 400 × 30% = $120 > $100
    ["targets_above_price", (i) => { i.proposal.details.exit_conditions[1].value = 100.1; }],
    ["exit_dates_in_horizon", (i) => { i.proposal.details.exit_conditions.push({ type: "date_after", date: "2099-11-15", description: "past" }); }],
    ["exit_dates_in_horizon", (i) => { i.proposal.details.exit_conditions.push({ type: "date_after", date: "2099-12-01", description: "15 days out" }); }],
  ];
  for (const [name, change] of cases) assert.ok(failing(change).includes(name), `${name} should fail`);
  // boundaries that must pass
  for (const ok of [(i) => { i.proposal.amountUsd = 500; }, (i) => { i.dailyLoss.lossUsd = 99.99; }, (i) => { i.price.ageSec = 1200; }, (i) => { i.proposal.details.holding_days = 14; }, (i) => { i.proposal.details.holding_days = 1; },
    (i) => { i.proposal.details.exit_conditions.push({ type: "date_after", date: "2099-11-30", description: "day 14" }); }, (i) => { i.dailyLoss.lossUsd = -50; }]) assert.deepStrictEqual(failing(ok), []);
});

test("risk engine fails closed: with no account, or no price, every check that needs it fails", () => {
  const noAccount = failing((i) => { i.account = { ok: false, reason: "eToro 500" }; i.dailyLoss = { ok: false, reason: "the account could not be read" }; });
  assert.deepStrictEqual(noAccount, ["account_readable", "available_cash", "total_exposure", "open_positions", "no_duplicate_position", "daily_loss"]);
  assert.deepStrictEqual(failing((i) => { i.price = { ok: false, reason: "eToro answered 206" }; }), ["fresh_price", "stop_level", "loss_at_stop", "targets_above_price"]);
  assert.deepStrictEqual(failing((i) => { i.price = null; }), ["fresh_price", "stop_level", "loss_at_stop", "targets_above_price"]);
  assert.deepStrictEqual(failing((i) => { i.allowlist = null; }), ["allowlisted"]);
});

test("risk engine: crypto caps — coins $250 a trade, $1,500 in total, and MSTR counts as crypto", () => {
  const coin = (i) => { i.proposal = { ...i.proposal, instrumentId: 100000, symbol: "BTC", assetClass: "crypto", amountUsd: 250 }; i.allowlist = { listed: true, active: true, verified: true, assetClass: "crypto", cryptoCorrelated: false }; };
  assert.deepStrictEqual(failing(coin), []);
  assert.deepStrictEqual(failing((i) => { coin(i); i.proposal.amountUsd = 250.01; }), ["per_trade_limit"]);
  assert.deepStrictEqual(failing((i) => { coin(i); i.account.positions = [{ instrumentId: 100001, amountUsd: 1300, assetClass: "crypto" }]; }), ["crypto_exposure"]);       // 1300 + 250
  assert.deepStrictEqual(failing((i) => { coin(i); i.account.positions = [{ instrumentId: 2001, amountUsd: 1300, assetClass: "stock", cryptoCorrelated: true }]; }), ["crypto_exposure"]); // MSTR held
  assert.deepStrictEqual(failing((i) => { coin(i); i.account.positions = [{ instrumentId: 777, amountUsd: 1300, assetClass: "unknown" }]; }), ["crypto_exposure"]);        // unknown is not "safe"
  const mstr = (i) => { i.proposal.instrumentId = 2001; i.proposal.symbol = "MSTR"; i.allowlist.cryptoCorrelated = true; };
  assert.deepStrictEqual(failing((i) => { mstr(i); i.proposal.amountUsd = 500; }), []);                                           // still a stock for the per-trade limit
  assert.deepStrictEqual(failing((i) => { mstr(i); i.account.positions = [{ instrumentId: 100000, amountUsd: 1200, assetClass: "crypto" }]; }), ["crypto_exposure"]); // 1200 + 400
  assert.deepStrictEqual(failing((i) => { i.account.positions = [{ instrumentId: 100000, amountUsd: 1500, assetClass: "crypto" }]; }), []);  // an ordinary stock is not held back by the crypto cap
  assert.strictEqual(POLICY.cryptoCorrelatedCountsTowardCryptoCap, true);
});

test("risk engine before execution: a live price no older than 3 minutes, and no more than 3% away from the request", () => {
  const live = (change) => failing((i) => { i.phase = "pre_execution"; i.referenceAsk = 100; i.price.ageSec = 60; change(i); });
  assert.deepStrictEqual(live(() => {}), []);
  assert.deepStrictEqual(live((i) => { i.price.ageSec = 181; }), ["fresh_price"]);     // fresh enough to ask you, too old to trade on
  assert.deepStrictEqual(live((i) => { i.price.ask = 103.1; }), ["price_drift"]);
  assert.deepStrictEqual(live((i) => { i.price.bid = 96; i.price.ask = 96.9; }), ["price_drift"]); // down counts too
  assert.deepStrictEqual(live((i) => { i.referenceAsk = null; }), ["price_drift"]);    // nothing to compare with → no
  assert.deepStrictEqual(live((i) => { i.price.ask = 103; }), []);
  assert.ok(!assess(good()).checks.some((c) => c.name === "price_drift"));            // not part of the first phase
});

test("risk engine: earnings inside the holding window is a warning for you, not a rejection", () => {
  const v = assess({ ...good(), earnings: { nextDate: "2099-11-19" } });
  assert.deepStrictEqual([v.passed, v.warnings], [true, ["earnings are due on 2099-11-19, inside the planned 7-day holding period"]]);
  assert.deepStrictEqual(assess({ ...good(), earnings: { nextDate: "2099-12-10" } }).warnings, []);
});

// ---- the order client: the only code that can POST ------------------------------
const keys = { baseUrl: "https://public-api.etoro.com", apiKey: "PUBKEY-12345", userKey: "USERKEY-67890", hasKeys: true };
const KEY = "1c94300c-90aa-4303-9d00-dec376d74efb";
const BODY = () => buildOpenOrder({ action: "open", direction: "buy", leverage: 1, orderType: "market", instrumentId: 2002, amountUsd: 400 });
function net(status, body) {
  const calls = [];
  return { calls, impl: async (url, opts) => { calls.push({ url: String(url), opts }); if (status === "timeout") { const e = new Error("aborted"); e.name = "AbortError"; throw e; } if (status === "down") throw new Error(`socket hang up ${keys.userKey}`); return { ok: status === 200, status, text: async () => JSON.stringify(body) }; } };
}

test("order client: one fixed demo path, a body that can only be a long unleveraged market buy, and the idempotency key as request ID", async () => {
  assert.strictEqual(DEMO_ORDER_PATH, "/api/v2/trading/execution/demo/orders");
  assert.deepStrictEqual(BODY(), { action: "open", transaction: "buy", instrumentId: 2002, orderType: "mkt", leverage: 1, amount: 400, orderCurrency: "usd" });
  const n = net(200, { orderId: 13902598, referenceId: KEY, token: "t" });
  const out = await createOrderClient({ config: keys, fetchImpl: n.impl }).placeDemoOrder(BODY(), { idempotencyKey: KEY });
  assert.deepStrictEqual([out.accepted, out.orderId, out.referenceId], [true, 13902598, KEY]);
  const { url, opts } = n.calls[0];
  assert.strictEqual(url, "https://public-api.etoro.com/api/v2/trading/execution/demo/orders");
  assert.deepStrictEqual([opts.method, opts.headers["x-request-id"], JSON.parse(opts.body)], ["POST", KEY, BODY()]);
  // the source itself: exactly one path, and it is the demo one
  const src = fs.readFileSync(path.join(__dirname, "..", "execution", "etoro-orders.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.deepStrictEqual(src.match(/["'`]\/api\/[^"'`]+["'`]/g), ['"/api/v2/trading/execution/demo/orders"']);
  assert.ok(!/\/real\//.test(src));
});

test("order client refuses, before the network, anything that is not exactly an allowed order", async () => {
  for (const bad of [{ direction: "sell" }, { direction: "sellShort" }, { leverage: 2 }, { orderType: "limit" }, { action: "close" }, { amountUsd: 0 }, { amountUsd: NaN }, { instrumentId: 0 }, { instrumentId: "2002" }]) {
    assert.throws(() => buildOpenOrder({ action: "open", direction: "buy", leverage: 1, orderType: "market", instrumentId: 2002, amountUsd: 400, ...bad }), (e) => e instanceof OrderError && e.sent === false);
  }
  const n = net(200, { orderId: 1 });
  const c = createOrderClient({ config: keys, fetchImpl: n.impl });
  const tampered = [{ ...BODY(), leverage: 5 }, { ...BODY(), transaction: "sellShort" }, { ...BODY(), stopLossRate: 1 }, { ...BODY(), symbol: "AAPL" }, { ...BODY(), settlementType: "cfd" }, { ...BODY(), orderType: "mit" }, null];
  for (const body of tampered) await assert.rejects(c.placeDemoOrder(body, { idempotencyKey: KEY }), (e) => e.sent === false);
  await assert.rejects(c.placeDemoOrder(BODY(), { idempotencyKey: "" }), (e) => e.code === "NoIdempotencyKey" && e.sent === false);
  await assert.rejects(c.placeDemoOrder(BODY(), {}), (e) => e.sent === false);
  await assert.rejects(createOrderClient({ config: { ...keys, hasKeys: false }, fetchImpl: n.impl }).placeDemoOrder(BODY(), { idempotencyKey: KEY }), (e) => e.code === "MissingKeys" && e.sent === false);
  assert.strictEqual(n.calls.length, 0);                                           // nothing ever left
});

test("order client: only a clear 'no' from eToro is final; every unclear answer leaves the result unknown", async () => {
  const place = (status, body) => createOrderClient({ config: keys, fetchImpl: net(status, body).impl }).placeDemoOrder(BODY(), { idempotencyKey: KEY });
  await assert.rejects(place(400, { detail: "amount below minimum" }), (e) => e.sent === false && e.code === "Rejected" && /amount below minimum/.test(e.message));
  await assert.rejects(place(404, {}), (e) => e.sent === false);
  for (const [status, body] of [[401, { title: "Unauthorized" }], [429, {}], [500, {}], [503, {}], [200, { token: "t" }], [200, null], ["timeout"], ["down"]]) {
    await assert.rejects(place(status, body), (e) => e instanceof OrderError && e.sent === true && !e.message.includes(keys.userKey), `status ${status}`);
  }
});

test("only the order client can send a write request, and only the gateway uses it", () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "test" ? [] : walk(path.join(dir, e.name))) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
  const root = path.join(__dirname, "..");
  const posting = walk(root).filter((f) => /method:\s*["'](POST|PUT|DELETE|PATCH)["']/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
  assert.deepStrictEqual(posting, [path.join("execution", "etoro-orders.js")]);
  const callers = walk(root).filter((f) => /placeDemoOrder\(/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(root, f)).sort();
  assert.deepStrictEqual(callers, [path.join("execution", "etoro-orders.js"), path.join("execution", "gateway.js")]);
  // no agent file can reach the gateway, the approvals or the order client
  for (const f of walk(path.join(root, "agents"))) assert.ok(!/gateway|approvals|etoro-orders|placeDemoOrder/.test(fs.readFileSync(f, "utf8")), f);
  // the read-only eToro client still cannot write
  assert.ok(!/POST/.test(fs.readFileSync(path.join(root, "etoro-client.js"), "utf8").replace(/\/\/.*$/gm, "")));
});

test("quiet hours: a window that crosses midnight, in the owner's time zone; none by default", () => {
  const q = { start: "23:00", end: "07:00", timeZone: "Asia/Dubai" };
  assert.strictEqual(inQuietHours(new Date("2026-11-16T19:30:00Z"), q), true);     // 23:30 in Dubai
  assert.strictEqual(inQuietHours(new Date("2026-11-17T02:59:00Z"), q), true);     // 06:59
  assert.strictEqual(inQuietHours(new Date("2026-11-17T03:00:00Z"), q), false);    // 07:00
  assert.strictEqual(inQuietHours(new Date("2026-11-16T12:00:00Z"), q), false);
  assert.strictEqual(inQuietHours(new Date("2026-11-16T12:00:00Z"), { start: "09:00", end: "17:00", timeZone: "UTC" }), true);
  assert.strictEqual(inQuietHours(T, null), false);
  assert.strictEqual(POLICY.quietHours, null);
});

test("Telegram texts for approvals and results are built by code and escape their content", () => {
  const proposal = { symbol: "NKE", amountUsd: 400, details: { ...DETAILS(), rationale: "a <b>bold</b> claim" } };
  const req = notify.approvalRequest({ proposal, verdict: assess(good()), price: good().price, account: good().account, expiresAt: new Date("2099-11-16T15:25:00Z") });
  for (const piece of ["Approve a BUY? — NKE", "(DEMO)", "$400.00", "bid 100 / ask 100.1 (120 s old)", "hold about 7 day(s) · stop 95 · target 110", "If the stop is reached: about -$20.38", "a &lt;b&gt;bold&lt;/b&gt; claim", "disagreed on 1 point(s): size", "all 24 checks passed", "Answer by 15:25 UTC"]) assert.ok(req.includes(piece), piece);
  assert.match(notify.executionResult({ status: "filled", proposal, positions: [{ positionId: 9001, amountUsd: 400, openRate: 100.1, exitConditions: [{ type: "price_below", value: 95 }, { type: "date_after", date: "2099-11-23" }] }] }), /Order filled — BUY NKE \$400\.00 \(DEMO\)[\s\S]*Position 9001 opened at 100\.1[\s\S]*stop 95 · until 2099-11-23[\s\S]*nothing is closed without you/);
  assert.match(notify.executionResult({ status: "refused", reason: "risk engine: fresh_price", proposal }), /No order was sent[\s\S]*A new proposal and a new approval are needed/);
  assert.match(notify.executionResult({ status: "unknown", reason: "timeout. It will NOT be sent again.", proposal }), /result unknown[\s\S]*NOT be sent again/);
  assert.match(notify.approvalClosed({ symbol: "NKE", amountUsd: 400, outcome: "expired" }), /Expired — nothing was sent/);
  assert.match(notify.riskRejected({ proposal, reasons: ["$600 against a limit of $500 per stock trade"] }), /stopped by the risk engine — NKE[\s\S]*not offered for approval[\s\S]*limit of \$500/);
});

// ---- everything together, against a real Postgres --------------------------------
const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, async () => {
  const dbName = `trading_s5_${Math.random().toString(36).slice(2, 10)}`;
  const admin = createDb({ config: { databaseUrl: TEST_URL } });
  await admin.query(`create database ${dbName}`);
  const u = new URL(TEST_URL); u.pathname = `/${dbName}`;
  const db = createDb({ config: { databaseUrl: u.toString() } });
  try { await db.migrateAll(); await fn(await world(db)); }
  finally { await db.close(); await admin.query(`drop database ${dbName} with (force)`); await admin.close(); }
});

const INSTRUMENTS = { NKE: [2002, "stock"], MSTR: [2001, "stock"], ADBE: [2003, "stock"], BTC: [100000, "crypto"] };
async function world(db) {
  const w = { db, t: new Date(T), tradingEnabled: true, credit: 100000, held: [], live: { bid: 100, ask: 100.1, ageSec: 30, quoteType: "realtime", status: 200 }, placing: "accept", lookup: 3,
    sent: [], buttons: [], edits: [], answers: [], orderCalls: [], lookups: [], outcomes: [] };
  for (const [symbol, [id, cls]] of Object.entries(INSTRUMENTS)) {
    await db.query("insert into trading.instruments (instrument_id, symbol, asset_class, raw, source, fetched_at) values ($1, $2, $3, '{}', 'test', now())", [id, symbol, cls]);
    await db.query(`insert into trading.${cls}_allowlist (symbol, instrument_id, verified_at) values ($1, $2, now())`, [symbol, id]);
    await db.query("insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at) values ($1, 'rate', $2, 100, 100.1, 'realtime', '{}', 'eToro Public API GET /api/v2/market-data/rates', $2)", [id, "2099-11-16T15:08:00Z"]);
  }
  await db.query("update trading.stock_allowlist set crypto_correlated = true where symbol = 'MSTR'");
  await db.query("insert into trading.account_snapshots (taken_at, credit_usd, invested_usd, pending_orders_usd, unrealized_pnl_usd, equity_usd, open_positions, source) values ('2099-11-16T00:07:00Z', 100000, 0, 0, 0, 100000, 0, 'test')");
  w.config = { get tradingEnabled() { return w.tradingEnabled; }, hasKeys: true };
  w.client = {
    redact: (x) => String(x ?? ""),
    getDemoPnl: async () => ({ data: { clientPortfolio: { credit: w.credit, positions: w.held, ordersForOpen: [], orders: [], mirrors: [] } }, source: "eToro Public API GET /api/v1/trading/info/demo/pnl", fetchedAt: w.t.toISOString() }),
    getRates: async ([id]) => ({ status: w.live.status, source: "eToro Public API GET /api/v2/market-data/rates", fetchedAt: w.t.toISOString(), data: { results: w.live.missing ? [] : [{ instrumentId: id, bid: w.live.bid, ask: w.live.ask, quoteType: w.live.quoteType, date: new Date(w.t.getTime() - w.live.ageSec * 1000).toISOString().replace("Z", "") }] } }),
    getDemoOrder: async (q) => {
      w.lookups.push(q);
      if (w.lookup === 404) throw Object.assign(new Error("eToro 404"), { status: 404 });
      if (w.lookup === "down") throw Object.assign(new Error("eToro 503"), { status: 503 });
      return { data: { orderId: 555, status: { id: w.lookup, name: { 3: "Filled", 4: "Rejected", 11: "WaitingForMarket" }[w.lookup] || "?", errorCode: w.lookup === 4 ? 720 : 0, errorMessage: w.lookup === 4 ? "Market is closed" : null },
        positionExecutions: w.lookup === 3 ? [{ positionId: 9001, investedAmountCurrency: 400, remainingUnits: 3.99, openingData: { openTime: "2099-11-16T15:10:05Z", units: 3.99, avgPrice: 100.12 } }] : [] } };
    },
  };
  w.orders = { redact: (x) => String(x ?? ""), placeDemoOrder: async (body, { idempotencyKey }) => {
    w.orderCalls.push({ body, idempotencyKey });
    if (w.placing === "accept") return { accepted: true, orderId: 555, referenceId: idempotencyKey, response: { orderId: 555, referenceId: idempotencyKey }, fetchedAt: w.t.toISOString() };
    if (w.placing === "400") throw new OrderError("eToro 400: amount below minimum", { sent: false, status: 400, code: "Rejected", body: { detail: "amount below minimum" } });
    throw new OrderError("eToro did not answer within 20s", { sent: true, code: "Timeout" });
  } };
  let mid = 100;
  w.notifier = { enabled: true, send: async (h) => { w.sent.push(h); return true; }, sendButtons: async (h, k) => { if (w.telegramDown) return { ok: false }; w.buttons.push({ html: h, keyboard: k, messageId: ++mid }); return { ok: true, messageId: mid }; }, edit: async (id, h) => { w.edits.push({ id, html: h }); return true; }, answer: async (id, text) => { w.answers.push(text); return true; } };
  w.policy = POLICY;
  w.build = () => {
    w.gateway = createGateway({ config: w.config, db, client: w.client, orders: w.orders, policy: w.policy, now: () => w.t, onOutcome: (o) => w.outcomes.push(o), log: () => {} });
    w.approvals = createApprovals({ config: w.config, db, client: w.client, gateway: w.gateway, notifier: w.notifier, policy: w.policy, now: () => w.t, log: () => {} });
  };
  w.build();
  w.propose = async (symbol = "NKE", amountUsd = 400, details = DETAILS()) => db.withTransaction((tx) => saveDraftProposal(tx, { instrument: { symbol, instrumentId: INSTRUMENTS[symbol][0], assetClass: INSTRUMENTS[symbol][1] }, amountUsd, expiresAt: new Date(T.getTime() + 24 * 3600000), analysisId: null, details, actor: "test" }));
  w.status = async (id) => (await db.query("select status, status_reason from trading.proposals where id = $1", [id])).rows[0];
  w.count = async (sql) => Number((await db.query(sql)).rows[0].n);
  w.tap = (which, i = w.buttons.length - 1) => w.approvals.handleTelegramCallback({ id: `cq${Math.random()}`, data: w.buttons[i].keyboard[0][which === "approve" ? 0 : 1].callback_data, from: { id: 42 }, message: { message_id: w.buttons[i].messageId } });
  w.advance = (minutes) => { w.t = new Date(w.t.getTime() + minutes * 60000); };
  // ask for approval, and return the proposal's id
  w.offered = async (...args) => { const p = await w.propose(...args); const d = await w.approvals.dispatch(); assert.deepStrictEqual(d.sent, [args[0] || "NKE"], JSON.stringify(d)); return p.id; };
  w.flush = () => new Promise((r) => setTimeout(r, 15));
  return w;
}

dbTest("the whole path: risk check → Telegram request → Approve → live re-check → ONE demo order → verified → position watched", async (w) => {
  const p = await w.propose();
  const d = await w.approvals.dispatch();
  assert.deepStrictEqual([d.sent, d.rejected, d.waiting], [["NKE"], [], []]);
  assert.deepStrictEqual((await w.status(p.id)).status, "pending_approval");
  assert.match(w.buttons[0].html, /Approve a BUY\? — NKE[\s\S]*\$400\.00[\s\S]*stop 95[\s\S]*all 24 checks passed[\s\S]*Answer by 15:25 UTC/);
  assert.deepStrictEqual(w.buttons[0].keyboard[0].map((b) => b.text), ["✅ Approve", "❌ Reject"]);
  assert.ok(w.buttons[0].keyboard[0].every((b) => Buffer.byteLength(b.callback_data) <= 64)); // Telegram's limit
  const a = (await w.db.query("select * from trading.approvals")).rows[0];
  assert.deepStrictEqual([a.params_hash, a.expires_at.toISOString(), a.decision, Number(a.telegram_message_id)], [p.paramsHash, "2099-11-16T15:25:00.000Z", null, 101]);
  assert.strictEqual(w.orderCalls.length, 0);                                      // nothing is sent on a request alone

  w.advance(3);
  await w.tap("approve");
  await w.flush();
  assert.strictEqual(w.orderCalls.length, 1);
  const idem = (await w.db.query("select idempotency_key from trading.proposals where id = $1", [p.id])).rows[0].idempotency_key;
  assert.deepStrictEqual(w.orderCalls[0], { body: { action: "open", transaction: "buy", instrumentId: 2002, orderType: "mkt", leverage: 1, amount: 400, orderCurrency: "usd" }, idempotencyKey: idem });
  assert.deepStrictEqual(w.lookups, [{ orderId: 555 }]);                           // the result was fetched from eToro, not assumed
  assert.deepStrictEqual((await w.status(p.id)).status, "executed");
  const o = (await w.db.query("select * from trading.orders")).rows[0];
  assert.deepStrictEqual([o.status, o.environment, Number(o.etoro_order_id), o.params_hash, o.idempotency_key, o.request.body.amount, o.verification.status.name], ["filled", "demo", 555, p.paramsHash, idem, 400, "Filled"]);
  const a2 = (await w.db.query("select decision, channel, actor, consumed_at, decided_at from trading.approvals")).rows[0];
  assert.deepStrictEqual([a2.decision, a2.channel, a2.actor, a2.consumed_at.toISOString(), a2.decided_at.toISOString()], ["approved", "telegram", "42", "2099-11-16T15:13:00.000Z", "2099-11-16T15:13:00.000Z"]);
  // the position, with what you approved as its exit conditions, plus the planned holding period
  const pos = (await w.db.query("select * from trading.positions")).rows[0];
  assert.deepStrictEqual([Number(pos.etoro_position_id), Number(pos.amount_usd), Number(pos.open_rate), pos.opened_by_order_id, pos.status], [9001, 400, 100.12, o.id, "open"]);
  assert.deepStrictEqual(pos.exit_conditions.map((c) => [c.type, c.value ?? c.date]), [["price_below", 95], ["price_above", 110], ["date_after", "2099-11-23"]]);
  // both verdicts are on record, with the limits used
  const v = (await w.db.query("select phase, passed, policy, inputs from trading.risk_assessments order by created_at")).rows;
  assert.deepStrictEqual(v.map((x) => [x.phase, x.passed, x.policy.maxPerTradeUsd.stock]), [["pre_approval", true, 500], ["pre_execution", true, 500]]);
  assert.match(v[1].inputs.price.source, /market-data\/rates/);
  assert.strictEqual(v[1].inputs.referenceAsk, 100.1);
  // what you saw
  assert.deepStrictEqual(w.answers, ["Approved — checking and sending"]);
  assert.match(w.edits[0].html, /✅ Approved<\/b> — BUY NKE \$400\.00 \(DEMO\)/);
  assert.deepStrictEqual(w.outcomes.map((x) => x.status), ["filled"]);
  const events = (await w.db.query("select event_type from trading.audit_log where proposal_id = $1 order by seq", [p.id])).rows.map((r) => r.event_type);
  assert.deepStrictEqual(events, ["proposal.created", "approval.requested", "approval.approved", "order.created", "order.submitted", "order.filled"]);
});

dbTest("a second tap does nothing: one decision, one order", async (w) => {
  const id = await w.offered();
  await w.tap("approve");
  await w.tap("approve");
  await w.tap("reject");
  await w.flush();
  assert.strictEqual(w.orderCalls.length, 1);
  assert.match(w.answers[1], /already approved/);
  assert.match(w.answers[2], /already approved/);
  assert.strictEqual(await w.count("select count(*) as n from trading.orders"), 1);
  assert.strictEqual((await w.status(id)).status, "executed");
  // even calling the gateway directly again changes nothing
  assert.deepStrictEqual([(await w.gateway.execute(id)).status, w.orderCalls.length], ["refused", 1]);
});

dbTest("two executions at the same instant: the row lock lets exactly one through", async (w) => {
  const id = await w.offered();
  const a = (await w.db.query("select id from trading.approvals")).rows[0];
  await w.db.query("update trading.approvals set decision = 'approved', decided_at = $2, channel = 'telegram', actor = 'x' where id = $1", [a.id, w.t.toISOString()]);
  await w.db.query("update trading.proposals set status = 'approved' where id = $1", [id]);
  const both = await Promise.all([w.gateway.execute(id), w.gateway.execute(id)]);
  assert.deepStrictEqual(both.map((x) => x.status).sort(), ["filled", "refused"]);
  assert.strictEqual(w.orderCalls.length, 1);
});

dbTest("Reject: nothing is sent, and the proposal cannot be approved afterwards", async (w) => {
  const id = await w.offered();
  await w.tap("reject");
  assert.deepStrictEqual([(await w.status(id)).status, w.orderCalls.length, w.answers], ["rejected", 0, ["Rejected"]]);
  assert.match(w.edits[0].html, /Rejected — nothing was sent/);
  await w.tap("approve");
  assert.match(w.answers[1], /already rejected/);
  assert.deepStrictEqual([(await w.gateway.execute(id)).status, w.orderCalls.length], ["refused", 0]);
});

dbTest("an approval tapped after 15 minutes is refused; an unanswered one expires by itself", async (w) => {
  const id = await w.offered();
  w.advance(15.1);
  await w.tap("approve");
  assert.match(w.answers[0], /expired at 2099-11-16T15:25:00/);
  assert.deepStrictEqual([(await w.status(id)).status, w.orderCalls.length], ["expired", 0]);
  // another proposal, never answered
  w.t = new Date(T);
  const id2 = (await w.propose("ADBE")).id;
  await w.approvals.dispatch();
  w.advance(16);
  const swept = await w.approvals.expireOld();
  assert.strictEqual(swept.approvals, 1);
  assert.strictEqual((await w.status(id2)).status, "expired");
  assert.match(w.edits[w.edits.length - 1].html, /Expired — nothing was sent<\/b> — BUY ADBE/);
  // the database itself refuses a late decision
  const late = (await w.db.query("select id from trading.approvals order by requested_at desc limit 1")).rows[0];
  await assert.rejects(w.db.query("update trading.approvals set decision = 'approved', decided_at = $2, channel = 'telegram' where id = $1", [late.id, w.t.toISOString()]), /approvals_check/);
});

dbTest("approved in time but the approval runs out before the order can be written: nothing is sent", async (w) => {
  const id = await w.offered();
  w.advance(14);
  const slow = w.client.getRates;
  w.client.getRates = async (ids) => { const answer = await slow(ids); w.advance(2); return answer; }; // the checks take until after the deadline
  await w.tap("approve");
  await w.flush();
  assert.strictEqual(w.orderCalls.length, 0);
  const s = await w.status(id);
  assert.deepStrictEqual(s.status, "failed");
  assert.match(s.status_reason, /approval expired .* while the checks were running/);
  assert.strictEqual(await w.count("select count(*) as n from trading.orders"), 0);
});

dbTest("kill switch off: no request is sent to you; switched off after approval: the order is not sent", async (w) => {
  w.tradingEnabled = false;
  const p = await w.propose();
  const d = await w.approvals.dispatch();
  assert.match(d.skipped, /trading is off: TRADING_ENABLED/);
  assert.deepStrictEqual([w.buttons.length, (await w.status(p.id)).status, await w.count("select count(*) as n from trading.risk_assessments")], [0, "draft", 0]);
  w.tradingEnabled = true;
  await w.approvals.dispatch();
  w.tradingEnabled = false;                                                        // flipped between the request and your tap
  await w.tap("approve");
  await w.flush();
  assert.strictEqual(w.orderCalls.length, 0);
  assert.match((await w.status(p.id)).status_reason, /trading is switched off/);
  assert.strictEqual((await w.status(p.id)).status, "failed");
  assert.match(notify.executionResult(w.approvals && { status: "refused", reason: (await w.status(p.id)).status_reason, proposal: { symbol: "NKE", amountUsd: 400 } }), /No order was sent/);
});

dbTest("/trade_stop: a runtime stop that survives a restart, blocks an approved order, and /trade_resume lifts it", async (w) => {
  const id = await w.offered();
  const desk = mount({ get() {} }, { authOn: true, config: w.config, client: w.client, db: w.db, notifier: w.notifier, approvals: { ...w.approvals, start: () => false }, gateway: w.gateway, orders: w.orders,
    monitor: { start: () => false, state: () => ({}) }, research: { start: () => false, state: () => ({}) }, positions: { start: () => false, state: () => ({ scheduled: false }) }, agents: { start: () => false, state: () => ({ ready: true, running: null, schedule: { running: false, runs: [] } }), recentRuns: async () => [], budget: { status: async () => null } } });
  await new Promise((r) => setTimeout(r, 100));                                    // startup migration check
  assert.ok(["trade_stop", "trade_resume"].every((c) => desk.telegramCommands.has(c)));
  await desk.handleTelegramCommand("trade_stop", "/trade_stop");
  assert.match(w.sent[w.sent.length - 1], /Trading stopped/);
  assert.deepStrictEqual((await w.db.query("select value->>'halted' as h, updated_by from trading.desk_state")).rows, [{ h: "true", updated_by: "owner:telegram" }]);
  await w.tap("approve");
  await w.flush();
  assert.strictEqual(w.orderCalls.length, 0);
  assert.match((await w.status(id)).status_reason, /trading was stopped \(\/trade_stop\)/);
  const next = await w.propose("ADBE");
  assert.match((await w.approvals.dispatch()).skipped, /stopped with \/trade_stop/);
  await desk.handleTelegramCommand("trade_status", "/trade_status");
  assert.match(w.sent[w.sent.length - 1], /Trading: OFF — trading was stopped with \/trade_stop/);
  await desk.handleTelegramCommand("trade_resume", "/trade_resume");
  assert.match(w.sent[w.sent.length - 1], /Trading resumed/);
  assert.deepStrictEqual((await w.approvals.dispatch()).sent, ["ADBE"]);
  assert.strictEqual((await w.status(next.id)).status, "pending_approval");
  assert.strictEqual(await w.count("select count(*) as n from trading.audit_log where event_type in ('trading.stopped', 'trading.resumed')"), 2);
  // server.js routes exactly these buttons to the desk
  assert.deepStrictEqual([desk.ownsCallback(w.buttons[0].keyboard[0][0].callback_data), desk.ownsCallback("ap:ok:123"), desk.ownsCallback("td:ok:nope")], [true, false, false]);
});

dbTest("stopped by the risk engine before you are asked: you are told why, and there is nothing to approve", async (w) => {
  const over = await w.propose("NKE", 600);                                        // above $500 per stock trade
  const noStop = await w.propose("ADBE", 300, { ...DETAILS(), exit_conditions: [{ type: "price_above", value: 110, description: "target" }] });
  const d = await w.approvals.dispatch();
  assert.deepStrictEqual(d.rejected, [{ symbol: "NKE", failed: ["per_trade_limit", "loss_at_stop"].filter((x) => x === "per_trade_limit") }, { symbol: "ADBE", failed: ["stop_level", "loss_at_stop"] }]);
  assert.deepStrictEqual([(await w.status(over.id)).status, (await w.status(noStop.id)).status, w.buttons.length], ["risk_rejected", "risk_rejected", 0]);
  assert.match((await w.status(over.id)).status_reason, /\$600 against a limit of \$500 per stock trade/);
  assert.match(w.sent[0], /stopped by the risk engine — NKE[\s\S]*limit of \$500/);
  assert.strictEqual(await w.count("select count(*) as n from trading.approvals"), 0);
  assert.strictEqual(await w.count("select count(*) as n from trading.risk_assessments where not passed"), 2);
  assert.deepStrictEqual([(await w.gateway.execute(over.id)).status, w.orderCalls.length], ["refused", 0]);
});

dbTest("limits are counted across trades in flight: coins, MSTR as crypto, a held instrument, the daily loss", async (w) => {
  // $1,300 of BTC already held: a $250 MSTR buy would take crypto exposure to $1,550
  w.held = [{ positionID: 1, instrumentID: 100000, mirrorID: 0, isBuy: true, amount: 1300, leverage: 1, unrealizedPnL: { pnL: 0 } }];
  await w.propose("MSTR", 250);
  let d = await w.approvals.dispatch();
  assert.deepStrictEqual(d.rejected, [{ symbol: "MSTR", failed: ["crypto_exposure"] }]);
  // a second position in an instrument that is already held
  await w.propose("BTC", 100);
  d = await w.approvals.dispatch();
  assert.deepStrictEqual(d.rejected, [{ symbol: "BTC", failed: ["no_duplicate_position"] }]);
  // the account is down $100.50 since the first snapshot of the day
  w.held = []; w.credit = 99899.5;
  await w.propose("NKE");
  d = await w.approvals.dispatch();
  assert.deepStrictEqual(d.rejected, [{ symbol: "NKE", failed: ["daily_loss"] }]);
  assert.match(w.sent[w.sent.length - 1], /down \$100\.5 today[\s\S]*daily loss limit of \$100/);
  assert.strictEqual(w.buttons.length, 0);
});

dbTest("no account snapshot today: the daily loss cannot be checked, so nothing is offered", async (w) => {
  await w.db.query("alter table trading.account_snapshots disable trigger account_snapshots_append_only");
  await w.db.query("delete from trading.account_snapshots");
  await w.propose();
  const d = await w.approvals.dispatch();
  assert.deepStrictEqual(d.rejected, [{ symbol: "NKE", failed: ["daily_loss"] }]);
  assert.match(w.sent[0], /no account snapshot has been recorded today/);
});

dbTest("a stock outside market hours waits — it is not judged and not rejected — and goes out when its price is fresh", async (w) => {
  await w.db.query("delete from trading.market_snapshots where instrument_id = 2002");
  await w.db.query("insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at) values (2002, 'rate', '2099-11-13T21:00:00Z', 100, 100.1, 'realtime', '{}', 'x', '2099-11-13T21:00:00Z')");
  const p = await w.propose();
  let d = await w.approvals.dispatch();
  assert.deepStrictEqual([d.waiting, d.sent, d.rejected], [["NKE"], [], []]);
  assert.deepStrictEqual(await w.status(p.id), { status: "draft", status_reason: "waiting for a fresh price (market closed or data delayed)" });
  assert.strictEqual(await w.count("select count(*) as n from trading.risk_assessments"), 0);
  await w.db.query("insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at) values (2002, 'rate', '2099-11-16T15:09:00Z', 100, 100.1, 'realtime', '{}', 'x', '2099-11-16T15:09:00Z')");
  d = await w.approvals.dispatch();
  assert.deepStrictEqual(d.sent, ["NKE"]);
  // a draft that is never offered expires with its proposal
  const stale = await w.propose("ADBE");
  await w.db.query("delete from trading.market_snapshots where instrument_id = 2003");
  w.advance(24 * 60 + 1);
  assert.strictEqual((await w.approvals.expireOld()).drafts, 1);
  assert.strictEqual((await w.status(stale.id)).status, "expired");
});

dbTest("quiet hours: no request is sent; if Telegram is down the request is tried again, never half-recorded", async (w) => {
  w.policy = { ...POLICY, quietHours: { start: "19:00", end: "07:00", timeZone: "Asia/Dubai" } }; // 15:10 UTC is 19:10 in Dubai
  w.build();
  const p = await w.propose();
  assert.strictEqual((await w.approvals.dispatch()).skipped, "quiet hours");
  assert.deepStrictEqual([w.buttons.length, (await w.status(p.id)).status], [0, "draft"]);
  w.policy = POLICY; w.build();
  w.telegramDown = true;
  const d = await w.approvals.dispatch();
  assert.match(d.waiting[0], /Telegram did not accept the request/);
  assert.deepStrictEqual([(await w.status(p.id)).status, await w.count("select count(*) as n from trading.approvals")], ["draft", 0]);
  w.telegramDown = false;
  assert.deepStrictEqual((await w.approvals.dispatch()).sent, ["NKE"]);
});

dbTest("after your approval, live facts are checked again — and each of these stops the order", async (w) => {
  const cases = [
    ["a live price older than 3 minutes", (x) => { x.live.ageSec = 200; }, /fresh_price: the price is 200 s old/],
    ["a delayed quote", (x) => { x.live.quoteType = "delayed"; }, /fresh_price: the price is delayed, not realtime/],
    ["a partial answer from eToro (206)", (x) => { x.live.status = 206; }, /fresh_price: no usable price: eToro answered 206/],
    ["no rate for the instrument", (x) => { x.live.missing = true; }, /fresh_price: no usable price/],
    ["the price ran away by more than 3%", (x) => { x.live.bid = 103.5; x.live.ask = 103.6; }, /price_drift: the price moved 3\.5% since the approval request/],
    ["the price fell through the stop", (x) => { x.live.bid = 94; x.live.ask = 94.1; x.policy = { ...POLICY, execution: { ...POLICY.execution, maxPriceDriftPct: 50 } }; x.build(); }, /stop_level: the stop at 95 is not below the current bid of 94/],
    ["the cash is gone", (x) => { x.credit = 300; }, /available_cash: needs \$400/],
    ["the account cannot be read", (x) => { x.client.getDemoPnl = async () => { throw new Error("eToro 503"); }; }, /account_readable: the demo account could not be read: eToro 503/],
    ["the daily loss limit was reached meanwhile", (x) => { x.credit = 99890; }, /daily_loss: the account is down \$110/],
    ["a position in it was opened meanwhile", (x) => { x.held = [{ positionID: 7, instrumentID: 2002, mirrorID: 0, isBuy: true, amount: 100, leverage: 1, unrealizedPnL: { pnL: 0 } }]; }, /no_duplicate_position: a position in this instrument is already open/],
    ["it was taken off the allowlist", async (x) => { await x.db.query("update trading.stock_allowlist set active = false where symbol = 'NKE'"); }, /allowlisted: the instrument is switched off on the allowlist/],
  ];
  for (const [what, breakIt, pattern] of cases) {
    // each case starts from a clean, approved-ready proposal in its own fresh state
    await w.db.query("update trading.proposals set status = 'cancelled' where status in ('pending_approval', 'approved', 'executing', 'draft')");
    await w.db.query("update trading.stock_allowlist set active = true");
    Object.assign(w, { t: new Date(T), credit: 100000, held: [], live: { bid: 100, ask: 100.1, ageSec: 30, quoteType: "realtime", status: 200 }, policy: POLICY });
    const world2 = await world.restore(w);
    const id = await world2.offered();
    await breakIt(world2);
    const before = world2.orderCalls.length;
    await world2.tap("approve");
    await world2.flush();
    assert.strictEqual(world2.orderCalls.length, before, `${what}: an order was sent`);
    const s = await world2.status(id);
    assert.strictEqual(s.status, "failed", what);
    assert.match(s.status_reason, pattern, what);
    assert.strictEqual(world2.outcomes.length, 0);
    assert.match(world2.edits[world2.edits.length - 1].html, /Approved/);            // your tap is acknowledged…
  }
  assert.strictEqual(await w.count("select count(*) as n from trading.orders"), 0);
  assert.strictEqual(await w.count("select count(*) as n from trading.risk_assessments where phase = 'pre_execution' and not passed"), cases.length);
  assert.strictEqual(await w.count("select count(*) as n from trading.audit_log where event_type = 'execution.refused'"), cases.length);
});
// Rebuilds the stand-ins on the same database (used by the loop above).
world.restore = async (w) => { w.client.getDemoPnl = async () => ({ data: { clientPortfolio: { credit: w.credit, positions: w.held, ordersForOpen: [], orders: [], mirrors: [] } }, source: "eToro Public API GET /api/v1/trading/info/demo/pnl", fetchedAt: w.t.toISOString() }); w.outcomes.length = 0; w.build(); return w; };

dbTest("eToro says no to the order (400): final, no position, a new approval is needed", async (w) => {
  const id = await w.offered();
  w.placing = "400";
  await w.tap("approve");
  await w.flush();
  const o = (await w.db.query("select status, error, response from trading.orders")).rows[0];
  assert.deepStrictEqual([o.status, o.error, o.response.detail], ["rejected", "eToro 400: amount below minimum", "amount below minimum"]);
  assert.deepStrictEqual([(await w.status(id)).status, w.lookups.length, w.outcomes[0].status], ["failed", 0, "not_placed"]);
  assert.strictEqual(await w.count("select count(*) as n from trading.positions"), 0);
  assert.match(notify.executionResult(w.outcomes[0]), /No order was sent[\s\S]*amount below minimum/);
});

dbTest("eToro's answer is lost (timeout): the order is never sent again — it is looked up until its fate is known", async (w) => {
  const id = await w.offered();
  w.placing = "timeout"; w.lookup = 404;
  await w.tap("approve");
  await w.flush();
  const idem = (await w.db.query("select idempotency_key from trading.proposals where id = $1", [id])).rows[0].idempotency_key;
  assert.deepStrictEqual([w.orderCalls.length, w.lookups], [1, [{ referenceId: idem }]]);  // looked up by our own request ID
  assert.deepStrictEqual([(await w.db.query("select status from trading.orders")).rows[0].status, (await w.status(id)).status, w.outcomes[0].status], ["unknown", "executing", "unknown"]);
  assert.match(w.outcomes[0].reason, /will NOT be sent again/);
  // minutes pass; eToro still has nothing; every tick looks, none resends
  for (let i = 0; i < 3; i++) { w.advance(2); await w.approvals.tick(); }
  assert.deepStrictEqual([w.orderCalls.length, (await w.db.query("select status from trading.orders")).rows[0].status], [1, "unknown"]);
  // …and it turns out eToro did take it
  w.lookup = 3;
  w.advance(1);
  await w.approvals.tick();
  await w.flush();
  assert.deepStrictEqual([(await w.db.query("select status from trading.orders")).rows[0].status, (await w.status(id)).status, w.orderCalls.length], ["filled", "executed", 1]);
  assert.deepStrictEqual(w.outcomes.map((x) => x.status), ["unknown", "filled"]);
  assert.strictEqual(await w.count("select count(*) as n from trading.positions where etoro_position_id = 9001"), 1);
});

dbTest("…or eToro never had it: after 10 minutes with no record it is marked not placed, still without a resend", async (w) => {
  const id = await w.offered();
  w.placing = "timeout"; w.lookup = 404;
  await w.tap("approve");
  w.advance(9);
  await w.approvals.tick();
  assert.strictEqual((await w.status(id)).status, "executing");
  w.lookup = "down";                                                               // a failed lookup proves nothing either
  w.advance(5);
  await w.approvals.tick();
  assert.strictEqual((await w.status(id)).status, "executing");
  w.lookup = 404;
  await w.approvals.tick();
  await w.flush();
  const o = (await w.db.query("select status, error from trading.orders")).rows[0];
  assert.deepStrictEqual([o.status, (await w.status(id)).status, w.orderCalls.length], ["failed", "failed", 1]);
  assert.match(o.error, /eToro has no record of the order \d+ minutes after it was sent: it was not placed/);
  assert.strictEqual(w.outcomes[w.outcomes.length - 1].status, "not_placed");
});

dbTest("accepted but not executed yet, then rejected by eToro: you are told both times, and no position is recorded", async (w) => {
  const id = await w.offered();
  w.lookup = 11;                                                                   // WaitingForMarket
  await w.tap("approve");
  await w.flush();
  assert.deepStrictEqual([(await w.db.query("select status from trading.orders")).rows[0].status, (await w.status(id)).status, w.outcomes[0].status], ["submitted", "executing", "submitted"]);
  assert.match(notify.executionResult(w.outcomes[0]), /accepted, not executed yet[\s\S]*WaitingForMarket/);
  w.advance(2); await w.approvals.tick();
  assert.strictEqual(w.outcomes.length, 1);                                        // nothing new to report
  w.lookup = 4;
  w.advance(2); await w.approvals.tick(); await w.flush();
  const o = (await w.db.query("select status, error from trading.orders")).rows[0];
  assert.deepStrictEqual([o.status, o.error, (await w.status(id)).status, w.orderCalls.length], ["rejected", "eToro rejected the order: Market is closed (code 720)", "failed", 1]);
  assert.strictEqual(await w.count("select count(*) as n from trading.positions"), 0);
  assert.match(notify.executionResult(w.outcomes[1]), /rejected by eToro[\s\S]*Market is closed[\s\S]*No position was opened/);
});

dbTest("the database is the last line: no order without a used, unexpired approval; parameters cannot be changed", async (w) => {
  const id = await w.offered();
  const a = (await w.db.query("select id, params_hash from trading.approvals")).rows[0];
  const order = (approvalId = a.id) => w.db.query("insert into trading.orders (proposal_id, approval_id, params_hash, idempotency_key, request) values ($1, $2, $3, gen_random_uuid(), '{}')", [id, approvalId, a.params_hash]);
  await assert.rejects(order(), /no valid, unexpired, consumed approval/);         // not approved yet
  await w.db.query("update trading.approvals set decision = 'approved', decided_at = $2, channel = 'telegram' where id = $1", [a.id, w.t.toISOString()]);
  await assert.rejects(order(), /no valid, unexpired, consumed approval/);         // approved but not marked used
  await assert.rejects(w.db.query("update trading.proposals set amount_usd = 5000 where id = $1", [id]), /trade parameters cannot be changed/);
  await assert.rejects(w.db.query("update trading.proposals set instrument_id = 2001 where id = $1", [id]), /cannot be changed/);
  await assert.rejects(w.db.query("update trading.approvals set params_hash = $2 where id = $1", [a.id, "b".repeat(64)]), /cannot be re-pointed or extended|foreign key/);
  await assert.rejects(w.db.query("update trading.approvals set expires_at = expires_at + interval '1 hour' where id = $1", [a.id]), /cannot be re-pointed or extended/);
  await assert.rejects(w.db.query("update trading.approvals set decision = 'rejected' where id = $1", [a.id]), /decision is final/);
  await w.db.query("update trading.approvals set consumed_at = $2 where id = $1", [a.id, w.t.toISOString()]);
  await order();
  await assert.rejects(order(), /orders_proposal_id_key|orders_approval_id_key/);    // one order per proposal and per approval
  await assert.rejects(w.db.query("update trading.orders set environment = 'real'"), /orders_environment_check|cannot be changed/);
  await assert.rejects(w.db.query("update trading.approvals set consumed_at = now() where id = $1", [a.id]), /used only once/);
  // the hash the gateway recomputes covers every parameter
  const p = { action: "open", instrumentId: 2002, direction: "buy", leverage: 1, orderType: "market", limitRate: null, amountUsd: 400, positionId: null, expiresAt: "2099-11-17T15:10:00.000Z" };
  for (const change of [{ amountUsd: 401 }, { instrumentId: 2001 }, { expiresAt: "2099-11-17T15:11:00.000Z" }]) assert.notStrictEqual(w.gateway.hashOf({ ...p, ...change }), w.gateway.hashOf(p));
});

dbTest("/trade_test: a small trade you start by hand goes through the same engine, approval and gateway — and is refused the same ways", async (w) => {
  const desk = mount({ get() {} }, { authOn: true, config: w.config, client: w.client, db: w.db, notifier: w.notifier, approvals: { ...w.approvals, start: () => false }, gateway: w.gateway, orders: w.orders,
    monitor: { start: () => false, state: () => ({}) }, research: { start: () => false, state: () => ({}) }, positions: { start: () => false, state: () => ({ scheduled: false }) }, agents: { start: () => false, state: () => ({ ready: true, running: null, schedule: { running: false, runs: [] } }), recentRuns: async () => [], budget: { status: async () => null } } });
  await new Promise((r) => setTimeout(r, 100));
  const last = () => w.sent[w.sent.length - 1];
  const proposals = () => w.count("select count(*) as n from trading.proposals");
  // this command uses the real clock, so give NKE and BTC a price that is fresh right now
  const stamp = new Date(Date.now() - 60000).toISOString();
  await w.db.query("update trading.market_snapshots set as_of = '2020-01-01T00:00:00Z'");
  for (const id of [2002, 100000]) await w.db.query("insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at) values ($1, 'rate', $2, 200, 200.2, 'realtime', '{}', 'x', $2)", [id, stamp]);
  for (const [text, pattern] of [["/trade_test", /Usage: \/trade_test SYMBOL AMOUNT/], ["/trade_test BTC", /Usage/], ["/trade_test BTC lots", /Usage/], ["/trade_test BTC 50.01", /at most \$50/], ["/trade_test BTC 0", /at most \$50/], ["/trade_test AAPL 20", /AAPL is not an allowlisted, verified instrument/], ["/trade_test ADBE 20", /no fresh price for ADBE/]]) {
    await desk.handleTelegramCommand("trade_test", text);
    assert.match(last(), pattern, text);
  }
  assert.strictEqual(await proposals(), 0);
  w.tradingEnabled = false;
  await desk.handleTelegramCommand("trade_test", "/trade_test BTC 50");
  assert.match(last(), /Not created: trading is off/);
  assert.strictEqual(await proposals(), 0);
  w.tradingEnabled = true;
  await desk.handleTelegramCommand("trade_test", "/trade_test btc $40");
  const p = (await w.db.query("select p.*, i.symbol from trading.proposals p join trading.instruments i using (instrument_id)")).rows[0];
  assert.deepStrictEqual([p.symbol, Number(p.amount_usd), p.direction, p.leverage, p.order_type, p.analysis_id], ["BTC", 40, "buy", 1, "market", null]);
  assert.deepStrictEqual([p.details.source, p.details.holding_days, p.details.exit_conditions], ["owner test (/trade_test)", 3, [{ type: "price_below", value: 190, description: "fixed rule for test trades: 5% below the bid of 200 when it was created" }]]);
  assert.ok(w.sent.some((m) => /Test proposal created — BUY BTC \$40\.00[\s\S]*Stop 190[\s\S]*risk engine like any other proposal/.test(m)));
  assert.strictEqual(w.orderCalls.length, 0);                                      // creating it sends nothing
  assert.strictEqual((await w.db.query("select actor from trading.audit_log where event_type = 'proposal.created'")).rows[0].actor, "owner:telegram");
  assert.deepStrictEqual([POLICY.testTrade.maxUsd, POLICY.testTrade.stopPctBelowBid, POLICY.testTrade.holdingDays], [50, 5, 3]);
});
