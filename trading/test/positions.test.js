// Run with: npm test
// Position monitoring: exit conditions, alerts, and the desk's record of
// positions. The database part runs only when TEST_TRADING_DATABASE_URL points
// at a throw-away Postgres; it creates its own database ("trading_positions_test").
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createPositionMonitor, evaluatePosition, conditionKey } = require("../positions");
const { POSITIONS, MONITORING } = require("../config");
const { POLICY } = require("../policy");
const { createDb } = require("../db");
const notify = require("../notify");

const NOW = new Date("2099-11-16T15:07:00Z");
const fresh = (bid) => ({ bid, ask: bid + 0.1, asOf: "2099-11-16T15:05:00.000Z", fresh: true });
const stale = (bid) => ({ ...fresh(bid), asOf: "2099-11-13T21:00:00.000Z", fresh: false });
const pos = (exitConditions, openedAt = "2099-11-16T09:00:00.000Z") => ({ exitConditions, openedAt });
const stop = { type: "price_below", value: 95, description: "below the 50-day average" };
const keys = (v) => v.hits.map((h) => h.key);

// ---- the rule itself, with no database ---------------------------------------
test("exit conditions: a long position is judged on the BID, and only on a fresh price", () => {
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop]), rate: fresh(95.01), now: NOW })), []);
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop]), rate: fresh(95), now: NOW })), ["price_below:95"]);
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop]), rate: { ...fresh(94.95), ask: 95.2 }, now: NOW })), ["price_below:95"]); // bid below, ask above → reached
  // market closed: the last price is below the stop, but it is old → nothing is decided on it
  const closed = evaluatePosition({ position: pos([stop]), rate: stale(90), now: NOW });
  assert.deepStrictEqual(keys(closed), []);
  assert.match(closed.notChecked[0].why, /not fresh/);
  assert.match(evaluatePosition({ position: pos([stop]), rate: null, now: NOW }).notChecked[0].why, /no price is stored/);
  const target = { type: "price_above", value: 120, description: "target" };
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop, target]), rate: fresh(120), now: NOW })), ["price_above:120"]);
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop, target]), rate: fresh(110), now: NOW })), []);
});

test("exit conditions: dates and exact times, the 48-hour holding limit, a missing stop, and conditions code cannot check", () => {
  const until = (date) => ({ type: "date_after", date, description: "out before earnings" });
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop, until("2099-11-16")]), rate: fresh(100), now: NOW })), []);                    // the day itself is not "after"
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop, until("2099-11-15")]), rate: stale(100), now: NOW })), ["date_after:2099-11-15"]); // a date needs no price
  // an exact time (the planned holding period since 2026-11-26) is reached at that minute, with or without a price
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop, until("2099-11-16T15:07Z")]), rate: fresh(100), now: NOW })), []);             // not after it yet
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop, until("2099-11-16T15:06Z")]), rate: stale(100), now: NOW })), ["date_after:2099-11-16T15:06Z"]);
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop, until("2099-11-16T19:00+04:00")]), rate: fresh(100), now: NOW })), ["date_after:2099-11-16T19:00+04:00"]); // 15:00 UTC
  assert.match(evaluatePosition({ position: pos([stop, until("2099-11-16 15:00")]), rate: fresh(100), now: NOW }).notChecked[0].why, /no usable date or time/);
  // the desk's own limit applies whatever the proposal said
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop], "2099-11-14T15:06:00.000Z"), rate: fresh(100), now: NOW })), ["time_limit:48h"]);
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop], "2099-11-14T15:08:00.000Z"), rate: fresh(100), now: NOW })), []);              // one minute short of 48 hours
  assert.deepStrictEqual(keys(evaluatePosition({ position: pos([stop], "2099-11-12T15:00:00.000Z"), rate: fresh(100), now: NOW })), ["time_limit:48h"]); // a position from the 14-day days
  assert.strictEqual(POLICY.holdingHours.max, 48);
  // a position with no stop on record (e.g. opened by hand on eToro) is reported, once
  for (const none of [null, [], [{ type: "price_above", value: 120, description: "target" }]]) assert.deepStrictEqual(keys(evaluatePosition({ position: pos(none), rate: fresh(100), now: NOW })), ["no_stop_level"]);
  const words = evaluatePosition({ position: pos([stop, { type: "other", description: "if the CEO resigns" }]), rate: fresh(100), now: NOW });
  assert.deepStrictEqual([keys(words), words.notChecked[0].why], [[], "described in words only; code cannot check it"]);
  assert.strictEqual(conditionKey({ type: "other", description: "x" }), conditionKey({ type: "other", description: "x" }));
  assert.notStrictEqual(conditionKey({ type: "other", description: "x" }), conditionKey({ type: "other", description: "y" }));
});

test("checks run every 15 minutes just after prices are collected, under the monitoring switch, and the file cannot trade", () => {
  assert.strictEqual(POSITIONS.cron, "7,22,37,52 * * * *");
  const minutes = (c) => c.split(" ")[0].split(",").map(Number);
  assert.deepStrictEqual(minutes(POSITIONS.cron).map((m, i) => m - minutes(MONITORING.cron)[i]), [2, 2, 2, 2]); // two minutes after each price run
  assert.ok(MONITORING.rateFreshSec > 15 * 60);                                    // a price from the last run still counts as fresh
  const jobs = [];
  const cron = { schedule: (expr, fn, o) => jobs.push([expr, o.timezone]) };
  const base = { client: { redact: (t) => t }, db: { configured: true, redact: (t) => t }, notifier: { send: async () => true }, cron, log: () => {} };
  assert.strictEqual(createPositionMonitor({ ...base, config: { monitorEnabled: false } }).start(), false);
  const on = createPositionMonitor({ ...base, config: { monitorEnabled: true } });
  assert.deepStrictEqual([on.start(), on.start(), jobs], [true, false, [["7,22,37,52 * * * *", "UTC"]]]);
  const src = fs.readFileSync(path.join(__dirname, "..", "positions.js"), "utf8");
  assert.ok(!/method:\s*["'](POST|PUT|DELETE)/.test(src) && !/getDemoOrder|execution/.test(src.replace(/\/\/.*$/gm, "")));
  assert.ok(!/anthropic|messages\.create/i.test(src));                             // plain code: no Claude call
});

test("a position alert reads clearly and escapes text", () => {
  const t = notify.positionAlert({ title: "Exit condition reached", symbol: "MSTR", lines: ["Condition: price at or below 95 — <stop>", "Nothing was closed. The position stays open until you act."], figures: { amountUsd: 300, openRate: 101.5, openedAt: "2099-11-12T15:00:00Z", unrealizedPnlUsd: -21.4 } });
  assert.strictEqual(t, "🚨 <b>Exit condition reached — MSTR</b> (DEMO)\nCondition: price at or below 95 — &lt;stop&gt;\nNothing was closed. The position stays open until you act.\nPosition: $300.00 invested, opened at 101.5, on 2099-11-12, profit/loss -$21.40");
});

// ---- against a real Postgres ---------------------------------------------------
const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, fn);
let db = null;
const cfg = { hasKeys: true, monitorEnabled: false };
const P = (id, instrumentID, extra = {}) => ({ positionID: id, instrumentID, mirrorID: 0, isBuy: true, amount: 300, leverage: 1, units: 3, openRate: 101.5, openDateTime: "2099-11-16T09:00:00", unrealizedPnL: { pnL: -21.4 }, ...extra });
function world(positions) {
  const w = { positions, sent: [], deliver: true, etoroFails: null, calls: 0 };
  w.client = { redact: (t) => String(t ?? ""), getDemoPnl: async () => { w.calls++; if (w.etoroFails) throw new Error(w.etoroFails); return { data: { clientPortfolio: { credit: 99000, positions: w.positions, ordersForOpen: [], orders: [], mirrors: [] } }, source: "eToro Public API GET /api/v1/trading/info/demo/pnl", fetchedAt: NOW.toISOString() }; } };
  w.notifier = { send: async (html) => { if (!w.deliver) return false; w.sent.push(html); return true; } };
  w.monitor = createPositionMonitor({ config: cfg, client: w.client, db, notifier: w.notifier, now: () => NOW, log: () => {} });
  return w;
}
const setRate = (id, bid, asOf) => db.query("insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at) values ($1, 'rate', $2, $3, $4, 'realtime', '{}', 'eToro Public API GET /api/v2/market-data/rates', $2)", [id, asOf, bid, bid + 0.1]);
const count = async (sql) => Number((await db.query(sql)).rows[0].n);

if (TEST_URL) {
  test.before(async () => {
    const admin = createDb({ config: { databaseUrl: TEST_URL } });
    await admin.query("drop database if exists trading_positions_test");
    await admin.query("create database trading_positions_test");
    await admin.close();
    const u = new URL(TEST_URL); u.pathname = "/trading_positions_test";
    db = createDb({ config: { databaseUrl: u.toString() } });
    await db.migrateAll();
    for (const [id, symbol, cls] of [[2001, "MSTR", "stock"], [100000, "BTC", "crypto"]]) {
      await db.query("insert into trading.instruments (instrument_id, symbol, asset_class, raw, source, fetched_at) values ($1, $2, $3, '{}', 'test', now())", [id, symbol, cls]);
    }
    await setRate(2001, 100, "2099-11-16T15:05:00Z");
    await setRate(100000, 64000, "2099-11-16T15:05:00Z");
  });
  test.after(async () => { await db.close(); });
}

dbTest("a new position is recorded; one with no stop on record is reported once, not every 15 minutes", async () => {
  const w = world([P(501, 2001)]);
  const first = await w.monitor.check();
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.deepStrictEqual(first.positions, [{ symbol: "MSTR", etoroPositionId: 501, priceFresh: true, reached: ["no_stop_level"], notChecked: 0 }]);
  assert.strictEqual(w.sent.length, 1);
  assert.match(w.sent[0], /Position has no stop level — MSTR[\s\S]*Nothing was closed/);
  const row = (await db.query("select status, direction, leverage, amount_usd, opened_at, source from trading.positions where etoro_position_id = 501")).rows[0];
  assert.deepStrictEqual([row.status, row.direction, row.leverage, Number(row.amount_usd), row.opened_at.toISOString()], ["open", "buy", 1, 300, "2099-11-16T09:00:00.000Z"]); // eToro's time read as UTC
  assert.match(row.source, /demo\/pnl/);
  await w.monitor.check(); await w.monitor.check();
  assert.strictEqual(w.sent.length, 1);                                            // still one alert
  assert.strictEqual(w.calls, 3);                                                  // one eToro request per check
  assert.strictEqual(await count("select count(*) as n from trading.monitor_runs where kind = 'positions' and status = 'ok'"), 3);
});

dbTest("when the price reaches the stop an alert is sent once — and an undelivered alert is tried again", async () => {
  await db.query("update trading.positions set exit_conditions = $1 where etoro_position_id = 501", [JSON.stringify([{ type: "price_below", value: 95, description: "below the 50-day average" }, { type: "price_above", value: 120, description: "target" }])]);
  const w = world([P(501, 2001)]);
  assert.deepStrictEqual((await w.monitor.check()).positions[0].reached, []);      // bid 100: nothing reached
  await setRate(2001, 94.8, "2099-11-16T15:06:00Z");
  w.deliver = false;                                                               // Telegram is down
  const undelivered = await w.monitor.check();
  assert.deepStrictEqual([undelivered.positions[0].reached, undelivered.alertsSent, undelivered.ok], [["price_below:95"], 0, false]);
  assert.match(undelivered.problems[0], /could not be delivered to Telegram; it will be tried again/);
  w.deliver = true;
  const delivered = await w.monitor.check();
  assert.strictEqual(delivered.alertsSent, 1);
  assert.match(w.sent[0], /Exit condition reached — MSTR[\s\S]*price at or below 95 — below the 50-day average[\s\S]*bid 94\.8 at 2099-11-16 15:06 UTC \(fresh\)[\s\S]*Nothing was closed[\s\S]*profit\/loss -\$21\.40/);
  await w.monitor.check();
  assert.strictEqual(w.sent.length, 1);                                            // not repeated
  const a = (await db.query("select kind, condition_key, facts from trading.position_alerts where condition_key = 'price_below:95'")).rows[0];
  assert.deepStrictEqual([a.kind, a.facts.rate.bid, a.facts.rate.source], ["exit_condition", 94.8, "eToro Public API GET /api/v2/market-data/rates"]);
  await assert.rejects(db.query("delete from trading.position_alerts"), /append-only/);
  assert.strictEqual(await count("select count(*) as n from trading.orders"), 0);  // an alert never becomes an order…
  // …it becomes ONE draft close proposal, which needs the risk engine and your approval (Stage 6)
  const close = (await db.query("select action, status, amount_usd, details from trading.proposals")).rows;
  assert.deepStrictEqual(close.map((c) => [c.action, c.status, Number(c.amount_usd), c.details.etoroPositionId, c.details.source]), [["close", "draft", 300, 501, "position monitor"]]);
  assert.match(close[0].details.reason, /exit condition reached: price at or below 95/);
  // the proposal was created on the first (undelivered) attempt; the alert that got through says so
  assert.match(w.sent[0], /A close for this position is already proposed or in progress/);
  assert.match(w.sent[0], /Nothing was closed\. The position stays open until you approve a close/);
});

dbTest("a stale price triggers nothing, however far below the stop it is", async () => {
  await db.query("insert into trading.instruments (instrument_id, symbol, asset_class, raw, source, fetched_at) values (2002, 'NKE', 'stock', '{}', 'test', now())");
  await setRate(2002, 50, "2099-11-13T21:00:00Z");                                  // Friday's close, read on Monday before the open
  const w = world([P(501, 2001), P(502, 2002)]);
  await w.monitor.check();
  await db.query("update trading.positions set exit_conditions = $1 where etoro_position_id = 502", [JSON.stringify([{ type: "price_below", value: 60, description: "stop" }])]);
  w.sent.length = 0;
  const out = await w.monitor.check();
  const nke = out.positions.find((p) => p.symbol === "NKE");
  assert.deepStrictEqual([nke.priceFresh, nke.reached, nke.notChecked], [false, [], 1]);
  assert.deepStrictEqual(w.sent, []);
});

dbTest("positions outside the desk's rules are reported, never recorded; one closed elsewhere is marked closed", async () => {
  const w = world([P(501, 2001), P(601, 100000, { leverage: 2 }), P(602, 2001, { isBuy: false }), P(603, 777)]);
  const out = await w.monitor.check();
  assert.deepStrictEqual(out.positions.filter((p) => p.outsideRules).map((p) => [p.symbol, p.outsideRules[0]]), [["BTC", "it uses leverage 2"], ["MSTR", "it is not a buy (long) position"], ["instrument 777", "its instrument is not on your allowlists"]]);
  assert.strictEqual(w.sent.filter((m) => /outside the desk's rules/.test(m)).length, 3);
  assert.strictEqual(await count("select count(*) as n from trading.positions where etoro_position_id in (601, 602, 603)"), 0);
  await w.monitor.check();
  assert.strictEqual(w.sent.filter((m) => /outside the desk's rules/.test(m)).length, 3); // once each
  // 502 (NKE) is no longer listed by eToro
  assert.ok(w.sent.some((m) => /no longer open on eToro — NKE/.test(m)));
  const nke = (await db.query("select status, closed_at from trading.positions where etoro_position_id = 502")).rows[0];
  assert.deepStrictEqual([nke.status, nke.closed_at.toISOString()], ["closed", NOW.toISOString()]);
});

dbTest("if the watch itself fails, nothing is guessed: no alert about positions, a warning after two failures, and a note when it is back", async () => {
  const w = world([P(501, 2001)]);
  w.etoroFails = "eToro 401: Unauthorized";
  const a = await w.monitor.check();
  assert.deepStrictEqual([a.ok, a.error, w.sent.length], [false, "eToro 401: Unauthorized", 0]);  // one failure: no noise (eToro has answered a stray 401 before)
  await w.monitor.check();
  assert.match(w.sent[0], /Position monitoring is not working[\s\S]*eToro 401[\s\S]*NOT being checked/);
  await w.monitor.check();
  assert.strictEqual(w.sent.length, 1);                                            // not repeated on every failure
  assert.strictEqual((await db.query("select status from trading.positions where etoro_position_id = 501")).rows[0].status, "open"); // not marked closed on a failed read
  w.etoroFails = null;
  await w.monitor.check();
  assert.match(w.sent[1], /working again/);
  assert.strictEqual(w.monitor.state().consecutiveFailures, 0);
  // an unusable answer from eToro is a failure too, not "no positions"
  const bad = world([]);
  bad.client.getDemoPnl = async () => ({ data: { clientPortfolio: { positions: [] } }, source: "x", fetchedAt: NOW.toISOString() });
  assert.match((await bad.monitor.check()).error, /missing a usable "credit"/);
  assert.strictEqual((await db.query("select status from trading.positions where etoro_position_id = 501")).rows[0].status, "open");
});
