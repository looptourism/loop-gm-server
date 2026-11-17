// Run with: npm test
// Revisit watches: an analyst's "look again when ..." is kept and checked by
// plain code; when it is met, the owner is told and the agents analyse that
// instrument again — within the schedule switch, the budget and a daily cap.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { VALIDATE } = require("../agents/schemas");
const { createWatch, createWatchKeeper, describe } = require("../watches");
const { createDb } = require("../db");
const notify = require("../notify");

const hold = (revisit) => ({ recommendation: "hold", thesis: "t", evidence: [{ ref: "R1", claim: "a" }], entry_conditions: [], exit_conditions: [], suggested_amount_usd: null, holding_days: null, holding_period: "n/a", risks: ["r"], analytical_confidence: 0.6, assumptions: [], data_gaps: [], revisit });
const tags = { has: () => true };

test("the analyst may name one revisit trigger: a price level or a date, never with a buy; missing or null means none", () => {
  assert.deepStrictEqual(VALIDATE.analysis(hold(null), tags), []);
  assert.deepStrictEqual(VALIDATE.analysis(hold(undefined), tags), []);
  assert.deepStrictEqual(VALIDATE.analysis(hold({ type: "price_above", value: 40.41, description: "a close back above the range" }), tags), []);
  assert.deepStrictEqual(VALIDATE.analysis(hold({ type: "date_after", date: "2026-11-19", description: "after the investor day is absorbed" }), tags), []);
  for (const [bad, pattern] of [[{ type: "price_above", description: "x" }, /positive "value"/], [{ type: "date_after", date: "19 Nov", description: "x" }, /YYYY-MM-DD/], [{ type: "rsi_below", value: 30, description: "x" }, /needs a "type"/], [{ type: "price_below", value: 30 }, /needs a "type"/]]) {
    assert.ok(VALIDATE.analysis(hold(bad), tags).some((e) => pattern.test(e)), String(pattern));
  }
  assert.strictEqual(describe({ type: "price_above", value: 40.41 }), "price at or above 40.41");
});

test("the watch keeper cannot trade: no order, approval or eToro call in the file", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "watches.js"), "utf8");
  const required = [...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(required, ["./config", "./db/store", "./market-data", "./notify"]);
  for (const word of ["placeDemo", "gateway.", "decide(", "getDemo", "fetch("]) assert.ok(!src.includes(word), word);
});

const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, async () => {
  const dbName = `trading_w_${Math.random().toString(36).slice(2, 10)}`;
  const admin = createDb({ config: { databaseUrl: TEST_URL } });
  await admin.query(`create database ${dbName}`);
  const u = new URL(TEST_URL); u.pathname = `/${dbName}`;
  const db = createDb({ config: { databaseUrl: u.toString() } });
  try { await db.migrateAll(); await fn(await world(db)); }
  finally { await db.close(); await admin.query(`drop database ${dbName} with (force)`); await admin.close(); }
});

async function world(db) {
  const w = { db, clock: new Date("2099-11-17T12:30:00Z"), sent: [], runs: [], state: { ready: true, running: null }, budget: { available: true, reached: false } };
  await db.query("insert into trading.instruments (instrument_id, symbol, display_name, asset_class, raw, source, fetched_at) values (2002, 'NKE', 'Nike', 'stock', '{}', 't', now()), (100000, 'BTC', 'Bitcoin', 'crypto', '{}', 't', now())");
  w.rate = (id, bid, asOf = w.clock) => db.query("insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at) values ($1, 'rate', $2, $3, $4, 'realtime', '{}', 'eToro rates', $2)", [id, new Date(asOf).toISOString(), bid, bid * 1.001]);
  w.analysis = async (id, recommendation = "hold") => (await db.query("insert into trading.analyses (agent, instrument_id, recommendation, output, model) values ($1, $2, $3, '{}', 'm') returning id", [id === 100000 ? "crypto" : "stock", id, recommendation])).rows[0].id;
  w.watch = async (id, revisit, recommendation = "hold") => { const a = await w.analysis(id, recommendation); return db.withTransaction((tx) => createWatch(tx, { instrumentId: id, analysisId: a, recommendation, revisit, now: w.clock })); };
  w.config = { monitorEnabled: true, agentsScheduleEnabled: true };
  w.agents = { state: () => w.state, budget: { status: async () => w.budget }, run: (symbols, o) => { w.runs.push([symbols, o.trigger]); } };
  w.notifier = { send: async (h) => { w.sent.push(h); return true; } };
  w.keeper = createWatchKeeper({ config: w.config, db, agents: w.agents, notifier: w.notifier, now: () => w.clock, log: () => {} });
  w.rows = async () => (await db.query("select i.symbol, w.status, w.status_reason, w.run_started_at is not null as ran from trading.watches w join trading.instruments i using (instrument_id) order by w.created_at")).rows;
  return w;
}

dbTest("NKE: 'a close back above 40.41' is watched on fresh stored prices, then the owner is told and NKE is analysed again — once", async (w) => {
  await w.rate(2002, 37.9);
  assert.deepStrictEqual(await w.watch(2002, { type: "price_above", value: 40.41, description: "a close back above the top of the range" }, "buy"), null);  // a buy keeps none
  const made = await w.watch(2002, { type: "price_above", value: 40.41, description: "a close back above the top of the range" });
  assert.strictEqual(made.status, "open");
  // below the level: nothing
  w.clock = new Date("2099-11-17T15:00:00Z");
  await w.rate(2002, 39.5);
  assert.deepStrictEqual((await w.keeper.check()).triggered, []);
  // above it, but the stored price is stale: nothing — a stale price proves nothing
  w.clock = new Date("2099-11-18T15:00:00Z");
  await w.rate(2002, 41, "2099-11-18T13:00:00Z");
  assert.deepStrictEqual((await w.keeper.check()).triggered, []);
  // above it on a fresh price: told, and analysed again
  await w.rate(2002, 40.6, "2099-11-18T14:59:30Z");
  const out = await w.keeper.check();
  assert.deepStrictEqual([out.triggered, out.started, w.runs], [["NKE"], ["NKE"], [[["NKE"], "revisit"]]]);
  assert.match(w.sent[0], /Revisit — NKE<\/b> \(DEMO\)[\s\S]*price at or above 40\.41[\s\S]*Now: bid 40\.6 at 14:59 UTC[\s\S]*Starting a new full analysis[\s\S]*your Approve/);
  assert.deepStrictEqual((await w.rows()).map((r) => [r.status, r.ran]), [["done", true]]);
  // never twice
  await w.keeper.check();
  assert.deepStrictEqual([w.runs.length, w.sent.length], [1, 1]);
  assert.deepStrictEqual((await w.db.query("select event_type from trading.audit_log where event_type like 'watch.%' order by seq")).rows.map((r) => r.event_type), ["watch.created", "watch.triggered"]);
});

dbTest("a date trigger; agents busy = wait for the next check; schedule off, budget reached or daily cap = told, not run", async (w) => {
  await w.rate(2002, 37.9); await w.rate(100000, 64000);
  await w.watch(2002, { type: "date_after", date: "2099-11-19", description: "after the investor day is absorbed" });
  await w.watch(100000, { type: "price_below", value: 62000, description: "a retest of support" });
  w.clock = new Date("2099-11-19T00:10:00Z");
  await w.rate(100000, 61900, "2099-11-19T00:09:50Z");
  w.state.running = { step: "screening" };
  let out = await w.keeper.check();
  assert.deepStrictEqual([out.triggered.sort(), out.waiting.sort(), w.runs.length, w.sent.length], [["BTC", "NKE"], ["BTC", "NKE"], 0, 0]);
  w.state.running = null;
  out = await w.keeper.check();                         // one run at a time
  assert.deepStrictEqual([out.started, w.runs.length], [["NKE"], 1]);
  w.state.running = { step: "analysing NKE" };
  await w.keeper.check();
  w.state.running = null;
  w.config.agentsScheduleEnabled = false;               // the schedule switch also covers these runs
  await w.keeper.check();
  assert.strictEqual(w.runs.length, 1);
  assert.match(w.sent.at(-1), /Revisit — BTC[\s\S]*Not analysed again automatically: the agents' schedule is off[\s\S]*\/trade_run BTC/);
  // the daily cap
  w.config.agentsScheduleEnabled = true;
  for (let k = 0; k < 3; k++) { await w.rate(2002, 30, new Date(w.clock.getTime() - (k + 1) * 1000)); await w.watch(2002, { type: "date_after", date: "2099-11-19", description: `again ${k}` }); await w.keeper.check(); }
  assert.strictEqual(w.runs.length, 3);
  assert.match(w.sent.at(-1), /already 3 revisit runs today/);
  // the budget
  w.clock = new Date("2099-11-20T09:00:00Z");
  w.budget = { available: true, reached: true };
  await w.watch(2002, { type: "date_after", date: "2099-11-20", description: "budget case" });
  await w.keeper.check();
  assert.match(w.sent.at(-1), /budget is reached/);
  assert.strictEqual(w.runs.length, 3);
});

dbTest("limits on what is kept: at most 14 days, a date too far is not kept, an unmet watch expires; /trade_status and the desk list open ones", async (w) => {
  await w.rate(2002, 37.9);
  const far = await w.watch(2002, { type: "date_after", date: "2099-12-25", description: "x" });
  assert.deepStrictEqual([far.status, far.reason], ["skipped", "the date is more than 14 days away"]);
  await w.watch(2002, { type: "price_above", value: 45, description: "a breakout" });
  const listed = await w.keeper.list();
  assert.deepStrictEqual(listed.map((x) => [x.symbol, x.status, x.text]), [["NKE", "open", "price at or above 45"], ["NKE", "skipped", "on or after 2099-12-25"]]);
  assert.match(notify.statusText({ agents: { ready: true, running: null, schedule: { running: false, runs: [] } }, budget: null, lastRun: null, dbState: { state: "ok" }, watching: listed.filter((x) => x.status === "open") }), /👀 Watching to look again: NKE price at or above 45/);
  w.clock = new Date("2099-12-02T00:00:00Z");
  const out = await w.keeper.check();
  assert.deepStrictEqual([out.expired, (await w.rows()).map((r) => r.status)], [1, ["skipped", "expired"]]);
  assert.deepStrictEqual(w.runs, []);
  // started only under the monitoring switch, without keeping the process alive
  assert.strictEqual(createWatchKeeper({ config: { monitorEnabled: false }, db: w.db, agents: w.agents, notifier: w.notifier }).start(), false);
});
