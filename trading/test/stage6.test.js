// Run with: npm test
// Stage 6: closing positions through the desk, and limit warnings. eToro,
// Telegram and the order client are stand-ins; no network. The database
// tests run only when TEST_TRADING_DATABASE_URL points at a throw-away
// Postgres; each one gets its own fresh database.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { assess } = require("../risk/engine");
const { POLICY } = require("../policy");
const { createOrderClient, buildCloseOrder, OrderError, DEMO_CLOSE_PATH_PREFIX } = require("../execution/etoro-orders");
const { createClient, assertAllowedPath } = require("../etoro-client");
const { createGateway } = require("../execution/gateway");
const { createApprovals } = require("../approvals");
const { createPositionMonitor } = require("../positions");
const { saveCloseProposal } = require("../db/analyses");
const { createDb } = require("../db");
const { mount } = require("../index");
const notify = require("../notify");

const T = new Date("2099-11-17T15:10:00Z");

// ---- the risk engine for a close -------------------------------------------------
const closeInput = () => ({
  phase: "pre_approval", now: T, policy: POLICY, tradingEnabled: true, halted: false, storedPriceMaxAgeSec: 1200,
  proposal: { id: "c1", action: "close", instrumentId: 100000, symbol: "BTC", assetClass: "crypto", direction: "buy", leverage: 1, orderType: "market", amountUsd: 49.97, positionId: "row1", expiresAt: "2099-11-18T15:00:00.000Z", details: {} },
  position: { id: "row1", etoroPositionId: 3643444338, instrumentId: 100000, status: "open", amountUsd: 49.97, units: 0.000768, openRate: 65069.63 },
  account: { ok: true, fetchedAt: T.toISOString(), availableCashUsd: 0, positions: [{ positionId: 3643444338, instrumentId: 100000, amountUsd: 49.97, direction: "buy", leverage: 1, unrealizedPnlUsd: -0.26 }] },
  closeInFlight: { ok: true, count: 0 },
  price: { ok: true, bid: 64900, ask: 64950, ageSec: 60, quoteType: "realtime" },
});
const closeFails = (change) => { const i = closeInput(); change(i); return assess(i).failed; };

test("closing: a sound close passes, and the opening limits do not apply to it", () => {
  const v = assess(closeInput());
  assert.deepStrictEqual([v.passed, v.failed, v.engineVersion], [true, [], "risk-engine-2"]);
  assert.deepStrictEqual(v.checks.map((c) => c.name), ["kill_switch", "demo_only", "not_expired", "closes_a_position", "position_on_record", "account_readable", "position_open_at_etoro", "position_matches", "no_close_in_flight", "fresh_price"]);
  assert.deepStrictEqual(v.warnings, ["eToro shows a loss of $0.26 on this position now"]);
  // no cash, a day already over its loss limit, a price far from anything approved: a close is still allowed
  for (const ok of [(i) => { i.account.availableCashUsd = 0; }, (i) => { i.dailyLoss = { ok: true, lossUsd: 500 }; }, (i) => { i.phase = "pre_execution"; i.referenceAsk = 10; i.price.ageSec = 30; }]) assert.deepStrictEqual(closeFails(ok), []);
});

test("closing: each check refuses on its own, and unknowns refuse", () => {
  const cases = [
    ["kill_switch", (i) => { i.tradingEnabled = false; }],
    ["kill_switch", (i) => { i.halted = true; }],
    ["kill_switch", (i) => { i.halted = undefined; }],
    ["not_expired", (i) => { i.proposal.expiresAt = T.toISOString(); }],
    ["closes_a_position", (i) => { i.proposal.leverage = 2; }],
    ["position_on_record", (i) => { i.position = null; }],
    ["position_on_record", (i) => { i.position.status = "closed"; }],
    ["position_on_record", (i) => { i.position.instrumentId = 2001; }],
    ["account_readable", (i) => { i.account = { ok: false, reason: "eToro 503" }; }],
    ["position_open_at_etoro", (i) => { i.account.positions = []; }],
    ["position_matches", (i) => { i.account.positions[0].direction = "sell"; }],
    ["position_matches", (i) => { i.account.positions[0].leverage = 2; }],
    ["position_matches", (i) => { i.account.positions[0].instrumentId = 1; }],
    ["no_close_in_flight", (i) => { i.closeInFlight = { ok: true, count: 1 }; }],
    ["no_close_in_flight", (i) => { i.closeInFlight = { ok: false, reason: "db down" }; }],
    ["fresh_price", (i) => { i.price = { ok: false, reason: "no price is stored" }; }],
    ["fresh_price", (i) => { i.price.ageSec = 1201; }],
    ["fresh_price", (i) => { i.phase = "pre_execution"; i.price.ageSec = 181; }],
    ["fresh_price", (i) => { i.price.quoteType = "delayed"; }],
  ];
  for (const [name, change] of cases) assert.ok(closeFails(change).includes(name), `${name} should fail`);
  const unreadable = closeFails((i) => { i.account = { ok: false, reason: "x" }; });
  assert.deepStrictEqual(unreadable, ["account_readable", "position_open_at_etoro", "position_matches"]);
});

// ---- the order client and the read client ------------------------------------------
const keys = { baseUrl: "https://public-api.etoro.com", apiKey: "PUBKEY-12345", userKey: "USERKEY-67890", hasKeys: true };
const KEY = "1c94300c-90aa-4303-9d00-dec376d74efb";
const net = (status, body) => { const calls = []; return { calls, impl: async (url, opts) => { calls.push({ url: String(url), opts }); if (status === "timeout") { const e = new Error("x"); e.name = "AbortError"; throw e; } return { ok: status === 200, status, text: async () => JSON.stringify(body) }; } }; };

test("closing order client: one demo close path, a body that can only close the whole position", async () => {
  assert.strictEqual(DEMO_CLOSE_PATH_PREFIX, "/api/v1/trading/execution/demo/market-close-orders/positions/");
  assert.deepStrictEqual(buildCloseOrder({ etoroPositionId: 3643444338, instrumentId: 100000 }), { InstrumentID: 100000, UnitsToDeduct: null });
  const n = net(200, { orderForClose: { positionID: 3643444338, instrumentID: 100000, orderID: 13904638, statusID: 1 }, token: "t" });
  const out = await createOrderClient({ config: keys, fetchImpl: n.impl }).placeDemoClose(3643444338, { InstrumentID: 100000, UnitsToDeduct: null }, { idempotencyKey: KEY });
  assert.deepStrictEqual([out.accepted, out.orderId, out.statusId], [true, 13904638, 1]);
  assert.strictEqual(n.calls[0].url, "https://public-api.etoro.com/api/v1/trading/execution/demo/market-close-orders/positions/3643444338");
  assert.deepStrictEqual([n.calls[0].opts.method, n.calls[0].opts.headers["x-request-id"], JSON.parse(n.calls[0].opts.body)], ["POST", KEY, { InstrumentID: 100000, UnitsToDeduct: null }]);
  const c = createOrderClient({ config: keys, fetchImpl: n.impl });
  const bad = [[3643444338, { InstrumentID: 100000, UnitsToDeduct: 0.0001 }], [3643444338, { InstrumentID: 100000 }], [3643444338, { InstrumentId: 100000, UnitsToDeduct: null }], [0, { InstrumentID: 100000, UnitsToDeduct: null }], ["3643444338/../../orders", { InstrumentID: 100000, UnitsToDeduct: null }], [3643444338, null]];
  for (const [pid, body] of bad) await assert.rejects(c.placeDemoClose(pid, body, { idempotencyKey: KEY }), (e) => e instanceof OrderError && e.sent === false);
  await assert.rejects(c.placeDemoClose(3643444338, { InstrumentID: 100000, UnitsToDeduct: null }, { idempotencyKey: "" }), (e) => e.sent === false);
  assert.strictEqual(n.calls.length, 1);                                           // nothing else left
  const place = (s, b) => createOrderClient({ config: keys, fetchImpl: net(s, b).impl }).placeDemoClose(3643444338, { InstrumentID: 100000, UnitsToDeduct: null }, { idempotencyKey: KEY });
  await assert.rejects(place(400, { detail: "position not found" }), (e) => e.sent === false && /position not found/.test(e.message));
  for (const [s, b] of [[401, {}], [500, {}], [200, { token: "t" }], ["timeout"]]) await assert.rejects(place(s, b), (e) => e.sent === true, String(s));
});

test("the read-only client can look up a demo close order, and still cannot write", async () => {
  assert.doesNotThrow(() => assertAllowedPath("/api/v1/trading/info/demo/close-orders/13904638"));
  assert.throws(() => assertAllowedPath("/api/v1/trading/info/real/close-orders/13904638"));
  assert.throws(() => assertAllowedPath("/api/v1/trading/info/demo/close-orders/1/../x"));
  const calls = [];
  const c = createClient({ config: keys, fetchImpl: async (url, opts) => { calls.push({ url: String(url), method: opts.method }); return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" }; } });
  await c.getDemoCloseOrder(13904638);
  assert.deepStrictEqual(calls, [{ url: "https://public-api.etoro.com/api/v1/trading/info/demo/close-orders/13904638", method: "GET" }]);
  assert.throws(() => c.getDemoCloseOrder("13904638; drop"));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "test" ? [] : walk(path.join(dir, e.name))) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
  const root = path.join(__dirname, "..");
  const callers = walk(root).filter((f) => /placeDemoClose\(/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(root, f)).sort();
  assert.deepStrictEqual(callers, [path.join("execution", "etoro-orders.js"), path.join("execution", "gateway.js")]);
});

test("Telegram texts for closing and for limits", () => {
  const proposal = { action: "close", symbol: "BTC", amountUsd: 49.97, details: { etoroPositionId: 3643444338, openRate: 65069.63, openedAt: "2099-11-16T20:11:25Z", reason: "exit condition reached: price at or below 61740.3" } };
  const req = notify.approvalRequest({ proposal, verdict: assess(closeInput()), price: { bid: 61700, ageSec: 40 }, account: closeInput().account, expiresAt: new Date("2099-11-17T15:25:00Z") });
  for (const piece of ["Approve a CLOSE? — BTC", "(DEMO)", "Position 3643444338: $49.97 invested, opened at 65069.63 on 2099-11-16", "Profit/loss now: -$0.26", "bid 61700 (40 s old)", "exit condition reached", "whole position is closed", "Answer by 15:25 UTC", "Reject keeps it open"]) assert.ok(req.includes(piece), piece);
  assert.match(notify.executionResult({ status: "closed", proposal, etoroPositionId: 3643444338, closeRate: 61700, pnlUsd: -2.59, proceedsUsd: 47.38 }), /Position closed — BTC[\s\S]*closed at 61700[\s\S]*about -\$2\.59[\s\S]*fees not included[\s\S]*proceeds of \$47\.38/);
  assert.match(notify.executionResult({ status: "rejected", reason: "eToro did not close the position", proposal }), /Close rejected by eToro — CLOSE BTC[\s\S]*still open and watched/);
  assert.match(notify.approvalClosed({ symbol: "BTC", amountUsd: 49.97, action: "close", outcome: "rejected" }), /Rejected — nothing was sent<\/b> — CLOSE BTC/);
  assert.match(notify.limitAlert({ level: 80, limits: [{ label: "Crypto exposure (MSTR counts)", unit: "$", value: 1250, limit: 1500, pct: 83 }] }), /Limit approached[\s\S]*Crypto exposure \(MSTR counts\): \$1250\.00 of \$1500\.00 \(83%\)[\s\S]*will be refused/);
  assert.match(notify.limitAlert({ level: 100, limits: [{ label: "Open positions", unit: "", value: 10, limit: 10, pct: 100 }] }), /Limit reached[\s\S]*Open positions: 10 of 10 \(100%\)[\s\S]*Closing is not affected/);
});

// ---- against a real Postgres ----------------------------------------------------------
const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, async () => {
  const dbName = `trading_s6_${Math.random().toString(36).slice(2, 10)}`;
  const admin = createDb({ config: { databaseUrl: TEST_URL } });
  await admin.query(`create database ${dbName}`);
  const u = new URL(TEST_URL); u.pathname = `/${dbName}`;
  const db = createDb({ config: { databaseUrl: u.toString() } });
  try { await db.migrateAll(); await fn(await world(db)); }
  finally { await db.close(); await admin.query(`drop database ${dbName} with (force)`); await admin.close(); }
});

const POS = 3643444338;
async function world(db) {
  const w = { db, t: new Date(T), tradingEnabled: true, held: null, closeLookup: { statusID: 3 }, placing: "accept", sent: [], buttons: [], edits: [], answers: [], closeCalls: [], lookups: [], outcomes: [] };
  for (const [symbol, id, cls] of [["BTC", 100000, "crypto"], ["MSTR", 2001, "stock"], ["NKE", 2002, "stock"]]) {
    await db.query("insert into trading.instruments (instrument_id, symbol, asset_class, raw, source, fetched_at) values ($1, $2, $3, '{}', 'test', now())", [id, symbol, cls]);
    await db.query(`insert into trading.${cls}_allowlist (symbol, instrument_id, verified_at) values ($1, $2, now())`, [symbol, id]);
    await db.query("insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at) values ($1, 'rate', $2, 61700, 61750, 'realtime', '{}', 'eToro Public API GET /api/v2/market-data/rates', $2)", [id, "2099-11-17T15:08:00Z"]);
  }
  await db.query("update trading.stock_allowlist set crypto_correlated = true where symbol = 'MSTR'");
  w.row = (await db.query(`insert into trading.positions (etoro_position_id, instrument_id, direction, leverage, amount_usd, units, open_rate, opened_at, exit_conditions, source, last_synced_at)
    values ($1, 100000, 'buy', 1, 49.97, 0.000768, 65069.63, '2099-11-16T20:11:25Z', $2, 'test', now()) returning id`, [POS, JSON.stringify([{ type: "price_below", value: 61740.3, description: "stop" }, { type: "date_after", date: "2099-11-19", description: "planned holding period" }])])).rows[0].id;
  w.held = [{ positionID: POS, instrumentID: 100000, mirrorID: 0, isBuy: true, amount: 49.97, units: 0.000768, leverage: 1, openRate: 65069.63, openDateTime: "2099-11-16T20:11:25Z", unrealizedPnL: { pnL: -2.6 } }];
  w.credit = 99950;
  w.config = { get tradingEnabled() { return w.tradingEnabled; }, hasKeys: true, monitorEnabled: false };
  w.client = {
    redact: (x) => String(x ?? ""),
    getDemoPnl: async () => { if (w.pnlDown) throw new Error("eToro 503"); return { data: { clientPortfolio: { credit: w.credit, positions: w.held, ordersForOpen: [], orders: [], mirrors: [] } }, source: "eToro Public API GET /api/v1/trading/info/demo/pnl", fetchedAt: w.t.toISOString() }; },
    getRates: async ([id]) => ({ status: 200, source: "eToro rates", fetchedAt: w.t.toISOString(), data: { results: [{ instrumentId: id, bid: 61700, ask: 61750, quoteType: "realtime", date: new Date(w.t.getTime() - 30000).toISOString().replace("Z", "") }] } }),
    getDemoCloseOrder: async (orderId) => { w.lookups.push(orderId); return { data: { orderID: orderId, statusID: w.closeLookup.statusID, errorCode: w.closeLookup.errorCode ?? null, errorMessage: w.closeLookup.errorMessage ?? null, proceeds: 47.38, positions: w.closeLookup.statusID === 3 ? [{ positionID: POS, occurred: "2099-11-17T15:10:02Z", rate: 61700, units: 0.000768, amount: 49.97 }] : [] } }; },
    getDemoOrder: async () => { throw new Error("an open-order lookup must not be used for a close"); },
  };
  w.orders = { redact: (x) => String(x ?? ""), placeDemoOrder: async () => { throw new Error("a buy must not be sent when closing"); },
    placeDemoClose: async (pid, body, { idempotencyKey }) => {
      w.closeCalls.push({ pid, body, idempotencyKey });
      const orderId = 13904638 + w.closeCalls.length - 1;                            // eToro gives each close order its own ID
      if (w.placing === "accept") return { accepted: true, orderId, statusId: 1, response: { orderForClose: { orderID: orderId, statusID: 1 } }, fetchedAt: w.t.toISOString() };
      if (w.placing === "400") throw new OrderError("eToro 400: position not found", { sent: false, status: 400, code: "Rejected" });
      throw new OrderError("eToro did not answer within 20s", { sent: true, code: "Timeout" });
    } };
  let mid = 100;
  w.notifier = { enabled: true, send: async (h) => { w.sent.push(h); return true; }, sendButtons: async (h, k) => { w.buttons.push({ html: h, keyboard: k, messageId: ++mid }); return { ok: true, messageId: mid }; }, edit: async (id, h) => { w.edits.push({ id, html: h }); return true; }, answer: async (id, text) => { w.answers.push(text); return true; } };
  w.gateway = createGateway({ config: w.config, db, client: w.client, orders: w.orders, now: () => w.t, onOutcome: (o) => w.outcomes.push(o), log: () => {} });
  w.approvals = createApprovals({ config: w.config, db, client: w.client, gateway: w.gateway, notifier: w.notifier, now: () => w.t, log: () => {} });
  w.monitor = createPositionMonitor({ config: w.config, client: w.client, db, notifier: w.notifier, now: () => w.t, log: () => {} });
  w.proposeClose = () => db.withTransaction((tx) => saveCloseProposal(tx, { positionRowId: w.row, expiresAt: new Date(w.t.getTime() + 24 * 3600000), details: { source: "test", reason: "you asked to close it" }, actor: "test" }));
  w.tap = (which, i = w.buttons.length - 1) => w.approvals.handleTelegramCallback({ id: "cq", data: w.buttons[i].keyboard[0][which === "approve" ? 0 : 1].callback_data, from: { id: 42 }, message: { message_id: w.buttons[i].messageId } });
  w.status = async (id) => (await db.query("select status, status_reason from trading.proposals where id = $1", [id])).rows[0];
  w.position = async () => (await db.query("select status, close_rate, realized_pnl_usd, closed_by_order_id, closed_at from trading.positions where id = $1", [w.row])).rows[0];
  w.flush = () => new Promise((r) => setTimeout(r, 15));
  w.advance = (m) => { w.t = new Date(w.t.getTime() + m * 60000); };
  return w;
}

dbTest("the whole close: proposal → risk check → Telegram → Approve → live re-check → ONE close order → verified → position closed", async (w) => {
  const p = await w.proposeClose();
  assert.deepStrictEqual([p.symbol, p.etoroPositionId, p.amountUsd], ["BTC", POS, 49.97]);
  assert.strictEqual(await w.proposeClose(), null);                                // one live close per position
  const d = await w.approvals.dispatch();
  assert.deepStrictEqual([d.sent, d.rejected], [["BTC"], []]);
  assert.match(w.buttons[0].html, /Approve a CLOSE\? — BTC[\s\S]*Position 3643444338: \$49\.97 invested, opened at 65069\.63[\s\S]*Profit\/loss now: -\$2\.60/);
  await w.tap("approve");
  await w.flush();
  const idem = (await w.db.query("select idempotency_key from trading.proposals where id = $1", [p.id])).rows[0].idempotency_key;
  assert.deepStrictEqual(w.closeCalls, [{ pid: POS, body: { InstrumentID: 100000, UnitsToDeduct: null }, idempotencyKey: idem }]);
  assert.deepStrictEqual(w.lookups, [13904638]);                                   // verified by eToro's close-order lookup
  const pos = await w.position();
  assert.deepStrictEqual([pos.status, Number(pos.close_rate), Number(pos.realized_pnl_usd), pos.closed_at.toISOString()], ["closed", 61700, -2.59, "2099-11-17T15:10:02.000Z"]);
  const o = (await w.db.query("select id, order_kind, status, etoro_order_id, request from trading.orders")).rows[0];
  assert.deepStrictEqual([o.order_kind, o.status, Number(o.etoro_order_id), o.request.path, pos.closed_by_order_id], ["close", "filled", 13904638, "POST /api/v1/trading/execution/demo/market-close-orders/positions/3643444338", o.id]);
  assert.strictEqual((await w.status(p.id)).status, "executed");
  assert.deepStrictEqual(w.outcomes.map((x) => [x.status, x.closeRate, x.pnlUsd]), [["closed", 61700, -2.59]]);
  assert.match(notify.executionResult(w.outcomes[0]), /Position closed — BTC/);
  const v = (await w.db.query("select phase, passed, engine_version from trading.risk_assessments order by created_at")).rows;
  assert.deepStrictEqual(v.map((x) => [x.phase, x.passed, x.engine_version]), [["pre_approval", true, "risk-engine-2"], ["pre_execution", true, "risk-engine-2"]]);
  // the monitor then sees it gone from eToro and does NOT call it "closed elsewhere"
  w.held = [];
  await w.monitor.check();
  assert.ok(!w.sent.some((m) => /closed outside the Trading Desk/.test(m)));
});

dbTest("Reject keeps the position open; a closed or vanished position, or trading off, sends nothing", async (w) => {
  const p = await w.proposeClose();
  await w.approvals.dispatch();
  await w.tap("reject");
  assert.deepStrictEqual([(await w.status(p.id)).status, w.closeCalls.length, (await w.position()).status], ["rejected", 0, "open"]);
  // eToro no longer lists the position by the time of the request
  const p2 = await w.proposeClose();
  w.held = [];
  const d = await w.approvals.dispatch();
  assert.deepStrictEqual(d.rejected, [{ symbol: "BTC", failed: ["position_open_at_etoro", "position_matches"] }]);
  assert.match(w.sent[w.sent.length - 1], /stopped by the risk engine — BTC[\s\S]*CLOSE \$49\.97 was not offered[\s\S]*eToro no longer lists position 3643444338/);
  assert.strictEqual((await w.status(p2.id)).status, "risk_rejected");
  // approved, then trading switched off before it is sent
  w.held = [{ positionID: POS, instrumentID: 100000, mirrorID: 0, isBuy: true, amount: 49.97, leverage: 1, unrealizedPnL: { pnL: 0 } }];
  const p3 = await w.proposeClose();
  await w.approvals.dispatch();
  w.tradingEnabled = false;
  await w.tap("approve");
  await w.flush();
  assert.deepStrictEqual([w.closeCalls.length, (await w.status(p3.id)).status], [0, "failed"]);
  assert.match((await w.status(p3.id)).status_reason, /trading is switched off/);
});

dbTest("eToro does not close it (rejected), or closes only part: the position stays open and watched", async (w) => {
  const p = await w.proposeClose();
  await w.approvals.dispatch();
  w.closeLookup = { statusID: 4, errorCode: 720, errorMessage: "Market is closed" };
  await w.tap("approve");
  await w.flush();
  assert.deepStrictEqual([(await w.status(p.id)).status, (await w.position()).status, w.outcomes[0].status], ["failed", "open", "rejected"]);
  assert.match(w.outcomes[0].reason, /eToro did not close the position: Market is closed \(code 720\)/);
  const p2 = await w.proposeClose();
  await w.approvals.dispatch();
  w.closeLookup = { statusID: 10, errorMessage: "insufficient liquidity" };
  await w.tap("approve");
  await w.flush();
  assert.match(w.outcomes[1].reason, /closed only part of the position[\s\S]*the desk will read its new size/);
  assert.deepStrictEqual([(await w.status(p2.id)).status, (await w.position()).status], ["failed", "open"]);
  // still in flight: nothing is decided yet
  const p3 = await w.proposeClose();
  await w.approvals.dispatch();
  w.closeLookup = { statusID: 11 };
  await w.tap("approve");
  await w.flush();
  assert.match(w.outcomes[2].reason, /waiting for the market to open/);
  assert.deepStrictEqual([(await w.status(p3.id)).status, (await w.position()).status], ["executing", "open"]);
  assert.strictEqual(await w.proposeClose(), null);                                // and no second close while it waits
  w.closeLookup = { statusID: 3 };
  w.advance(2); await w.approvals.tick(); await w.flush();
  assert.deepStrictEqual([(await w.status(p3.id)).status, (await w.position()).status, w.closeCalls.length], ["executed", "closed", 3]);
});

dbTest("eToro's answer to a close is lost: never resent — closed if the position disappears, failed if it is still there after 10 minutes", async (w) => {
  const p = await w.proposeClose();
  await w.approvals.dispatch();
  w.placing = "timeout";
  await w.tap("approve");
  await w.flush();
  assert.deepStrictEqual([w.closeCalls.length, w.outcomes[0].status, (await w.status(p.id)).status], [1, "unknown", "executing"]);
  assert.match(w.outcomes[0].reason, /will NOT be sent again/);
  w.advance(3); await w.approvals.tick();
  assert.strictEqual(w.closeCalls.length, 1);
  w.held = [];                                                                     // eToro no longer lists it
  w.advance(1); await w.approvals.tick(); await w.flush();
  const pos = await w.position();
  assert.deepStrictEqual([pos.status, pos.close_rate, (await w.status(p.id)).status, w.outcomes[1].status], ["closed", null, "executed", "closed"]);
  assert.match(notify.executionResult(w.outcomes[1]), /answer to the close request was lost[\s\S]*closing price is not known/);
  const v = (await w.db.query("select verification from trading.orders")).rows[0].verification;
  assert.match(v.method, /no longer listed/);
});

dbTest("…and if it is still listed 10 minutes later the close is marked not placed; the account being unreadable proves nothing", async (w) => {
  const p = await w.proposeClose();
  await w.approvals.dispatch();
  w.placing = "timeout";
  await w.tap("approve");
  w.advance(9); await w.approvals.tick();
  assert.strictEqual((await w.status(p.id)).status, "executing");
  w.pnlDown = true;
  w.advance(5); await w.approvals.tick();
  assert.strictEqual((await w.status(p.id)).status, "executing");
  w.pnlDown = false;
  await w.approvals.tick(); await w.flush();
  assert.deepStrictEqual([(await w.status(p.id)).status, (await w.position()).status, w.closeCalls.length], ["failed", "open", 1]);
  assert.match(w.outcomes[w.outcomes.length - 1].reason, /still open \d+ minutes after the close request/);
});

dbTest("the monitor proposes a close when the stop is reached — once — and the close then needs your approval", async (w) => {
  // BTC's stored bid 61700 is below the stop of 61740.3
  await w.monitor.check();
  const props = (await w.db.query("select action, status, details from trading.proposals")).rows;
  assert.deepStrictEqual(props.map((x) => [x.action, x.status, x.details.source]), [["close", "draft", "position monitor"]]);
  assert.match(w.sent.find((m) => /Exit condition reached — BTC/.test(m)), /A close proposal was created: it goes to the risk engine and then to you for Approve \/ Reject[\s\S]*until you approve a close/);
  await w.monitor.check();
  assert.strictEqual(Number((await w.db.query("select count(*) as n from trading.proposals")).rows[0].n), 1);
  assert.strictEqual(w.closeCalls.length, 0);                                      // nothing is closed by the monitor
  await w.approvals.dispatch();
  assert.match(w.buttons[0].html, /Approve a CLOSE\? — BTC[\s\S]*exit condition reached: price at or below 61740\.3/);
});

dbTest("limit warnings: at 80% and at 100%, once per limit and day, and /trade_status shows the limits", async (w) => {
  // $1,250 of crypto: BTC $1,000 plus MSTR $250 (MSTR counts as crypto)
  w.held = [
    { positionID: POS, instrumentID: 100000, mirrorID: 0, isBuy: true, amount: 1000, leverage: 1, unrealizedPnL: { pnL: 0 } },
    { positionID: 77, instrumentID: 2001, mirrorID: 0, isBuy: true, amount: 250, leverage: 1, unrealizedPnL: { pnL: 0 } },
  ];
  await w.db.query("update trading.positions set exit_conditions = $1", [JSON.stringify([{ type: "price_below", value: 1, description: "stop" }])]);
  await w.monitor.check();
  const warn = w.sent.filter((m) => /Limit approached/.test(m));
  assert.strictEqual(warn.length, 1);
  assert.match(warn[0], /Crypto exposure \(MSTR counts\): \$1250\.00 of \$1500\.00 \(83%\)/);
  w.advance(15);
  await w.monitor.check();
  assert.strictEqual(w.sent.filter((m) => /Limit approached/.test(m)).length, 1);  // not repeated the same day
  const limits = w.monitor.state().lastCheck.limits;
  assert.deepStrictEqual(limits.map((l) => [l.name, l.value, l.limit]), [["total_exposure", 1250, 5000], ["crypto_exposure", 1250, 1500], ["open_positions", 2, 10], ["daily_loss", 0, 100]]);
  // the day's loss reaches the limit: the positions are down $100 since the day's first snapshot
  w.held[0].unrealizedPnL.pnL = -100;
  w.advance(15);
  await w.monitor.check();
  const reached = w.sent.filter((m) => /Limit reached/.test(m));
  assert.ok(reached.some((m) => /Loss today: \$100\.00 of \$100\.00 \(100%\)[\s\S]*Closing is not affected/.test(m)), JSON.stringify([w.sent.slice(-3), w.monitor.state().lastCheck.limits]));
  // a new UTC day may warn again
  w.advance(24 * 60);
  await w.monitor.check();
  assert.strictEqual(w.sent.filter((m) => /Limit approached/.test(m)).length, 2);
  assert.match(notify.statusText({ agents: { ready: true, running: null, schedule: { running: false, runs: [] } }, budget: null, lastRun: null, dbState: { state: "ok" }, positions: w.monitor.state() }), /Limits: exposure \$1250\.00\/\$5000\.00 · crypto \$1250\.00\/\$1500\.00 · positions 2\/10/);
});

dbTest("/trade_close: proposes closing your open position in a symbol, through the same approval", async (w) => {
  const desk = mount({ get() {} }, { authOn: true, config: w.config, client: w.client, db: w.db, notifier: w.notifier, approvals: { ...w.approvals, start: () => false }, gateway: w.gateway, orders: w.orders,
    monitor: { start: () => false, state: () => ({}) }, research: { start: () => false, state: () => ({}) }, positions: { start: () => false, state: () => ({ scheduled: false }) }, agents: { start: () => false, state: () => ({ ready: true, running: null, schedule: { running: false, runs: [] } }), recentRuns: async () => [], budget: { status: async () => null } } });
  await new Promise((r) => setTimeout(r, 100));
  const last = () => w.sent[w.sent.length - 1];
  assert.ok(desk.telegramCommands.has("trade_close"));
  await desk.handleTelegramCommand("trade_close", "/trade_close");
  assert.match(last(), /Usage: \/trade_close SYMBOL/);
  await desk.handleTelegramCommand("trade_close", "/trade_close NKE");
  assert.match(last(), /no open position in NKE on record/);
  w.tradingEnabled = false;
  await desk.handleTelegramCommand("trade_close", "/trade_close btc");
  assert.match(last(), /Close proposed — BTC[\s\S]*Position 3643444338, \$49\.97 invested[\s\S]*Trading is off/);
  assert.strictEqual(w.buttons.length, 0);
  await desk.handleTelegramCommand("trade_close", "/trade_close BTC");
  assert.match(last(), /already proposed or in progress/);
  await w.db.query("update trading.proposals set status = 'cancelled'");
  w.tradingEnabled = true;
  // this command runs on the real clock: give BTC a price that is fresh now, and use the real clock here too
  const real = new Date();
  await w.db.query("insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at) values (100000, 'rate', $1, 61700, 61750, 'realtime', '{}', 'x', $1)", [new Date(real.getTime() - 60000).toISOString()]);
  await w.db.query("delete from trading.market_snapshots where as_of > now() + interval '1 day'");
  w.t = real;
  await desk.handleTelegramCommand("trade_close", "/trade_close BTC");
  assert.match(last(), /risk engine; if it passes you get the Approve \/ Reject request/);
  assert.match(w.buttons[0].html, /Approve a CLOSE\? — BTC[\s\S]*you asked to close it with \/trade_close/);
  assert.strictEqual(w.closeCalls.length, 0);
});
