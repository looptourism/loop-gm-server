// Run with: npm test
// The weekly report and the agents' track record: plain code over stored
// records, no eToro or Claude call, nothing that can trade.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const report = require("../report");
const { createDb } = require("../db");

test("the report file cannot trade and makes no outside call", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "report.js"), "utf8");
  assert.deepStrictEqual([...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]), ["./notify"]);
  for (const word of ["placeDemo", "gateway", "decide(", "fetch(", "anthropic"]) assert.ok(!src.includes(word), word);
});

const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, async () => {
  const dbName = `trading_rep_${Math.random().toString(36).slice(2, 10)}`;
  const admin = createDb({ config: { databaseUrl: TEST_URL } });
  await admin.query(`create database ${dbName}`);
  const u = new URL(TEST_URL); u.pathname = `/${dbName}`;
  const db = createDb({ config: { databaseUrl: u.toString() } });
  try { await db.migrateAll(); await fn(db); }
  finally { await db.close(); await admin.query(`drop database ${dbName} with (force)`); await admin.close(); }
});

const NOW = new Date("2099-12-05T05:00:00Z"); // a Saturday
async function seed(db) {
  await db.query("insert into trading.instruments (instrument_id, symbol, display_name, asset_class, raw, source, fetched_at) values (2002, 'NKE', 'Nike', 'stock', '{}', 't', now()), (100000, 'BTC', 'Bitcoin', 'crypto', '{}', 't', now())");
  const rate = async (id, at, bid) => (await db.query("insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at) values ($1, 'rate', $2, $3, $3, 'realtime', '{}', 'eToro rates', $2) returning id", [id, at, bid])).rows[0].id;
  // NKE held at 37.86 on 11-17; 40.0 a day later, 41.0 after 5 days; after 14 days only a Friday price (weekend gap)
  const s = await rate(2002, "2099-11-17T12:18:00Z", 37.86);
  await rate(2002, "2099-11-18T12:00:00Z", 40.0);
  await rate(2002, "2099-11-22T12:00:00Z", 41.0);
  await rate(2002, "2099-11-29T20:00:00Z", 36.0);
  await db.query("insert into trading.analyses (agent, instrument_id, recommendation, output, snapshot_ids, model, created_at) values ('stock', 2002, 'hold', '{}', $1, 'm', '2099-11-17T12:29:00Z')", [[s]]);
  // BTC avoided on 12-03: too early for 5 and 14 days; no price a day later stored -> null, not invented
  await rate(100000, "2099-12-03T10:00:00Z", 64000);
  await db.query("insert into trading.analyses (agent, instrument_id, recommendation, output, model, created_at) values ('crypto', 100000, 'avoid', '{}', 'm', '2099-12-03T10:05:00Z')");
  // the week's activity
  await db.query("insert into trading.account_snapshots (taken_at, credit_usd, invested_usd, pending_orders_usd, unrealized_pnl_usd, equity_usd, open_positions, source) values ('2099-11-28T06:00:00Z', 100000, 0, 0, 0, 100000, 0, 't'), ('2099-12-05T04:00:00Z', 99990, 0, 0, 0, 99990, 0, 't')");
  await db.query("insert into trading.api_usage (occurred_at, purpose, model, input_tokens, output_tokens, estimated_cost_usd) values ('2099-12-03T10:05:00Z', 'crypto', 'm', 1, 1, 0.70), ('2099-11-01T10:00:00Z', 'stock', 'm', 1, 1, 9)");
  await db.query("insert into trading.audit_log (event_type, actor, data, created_at) values ('agents.run_finished', 'system', '{}', '2099-12-03T10:06:00Z')");
}

dbTest("track record: the stored bid at the call vs 1, 5 and 14 days later — only real stored prices, never guessed", async (db) => {
  await seed(db);
  const r = await report.trackRecord(db, { now: NOW, days: 30 });
  const nke = r.items.find((x) => x.symbol === "NKE");
  assert.deepStrictEqual([nke.start.bid, nke.after[1].pct, nke.after[5].pct, nke.after[14].pct], [37.86, 5.65, 8.29, -4.91]);
  assert.strictEqual(nke.after[14].at, "2099-11-29T20:00:00.000Z");                      // the last price before day 14, within 3 days
  const btc = r.items.find((x) => x.symbol === "BTC");
  assert.deepStrictEqual([btc.start.bid, btc.after[1], btc.after[5], btc.after[14]], [64000, null, null, null]);
  assert.deepStrictEqual(r.summary.hold, { count: 1, after1d: { avgPct: 5.65, n: 1, up: 1 }, after5d: { avgPct: 8.29, n: 1, up: 1 }, after14d: { avgPct: -4.91, n: 1, up: 0 } });
  assert.deepStrictEqual([r.summary.avoid.count, r.summary.avoid.after5d, r.summary.buy.count], [1, null, 0]);
});

dbTest("the weekly report: trades, account, agents, Claude spend, what was passed on and the track record — by code", async (db) => {
  await seed(db);
  const w = await report.weekly(db, { now: NOW, budget: { available: true, spentUsd: 9.7, budgetUsd: 75, month: "2099-12" } });
  assert.deepStrictEqual([w.agents.runs, w.agents.analyses, w.agents.avoid, w.agents.spendUsd, w.passedOn.map((x) => x.symbol)], [1, 1, 1, 0.7, ["BTC"]]);
  const text = report.weeklyText(w);
  assert.match(text, /the week<\/b> \(DEMO\)\n11-28 to 12-05/);
  assert.match(text, /Proposals: 0[\s\S]*Opened: none[\s\S]*Closed: none[\s\S]*Account: \$100000\.00 → \$99990\.00 \(-10\.00\)/);
  assert.match(text, /Claude: about \$0\.70 this week · \$9\.70 of \$75\.00 in 2099-12/);
  assert.match(text, /Passed on this week[\s\S]*BTC avoid 12-03: too early to tell/);
  assert.match(text, /hold: 1 call — 5d \+8\.29% \(1\/1 up\), 14d -4\.91% \(0\/1 up\)/);
  assert.match(text, /avoid: 1 call — too early to tell/);
});

dbTest("sent once a week, Saturday from 04:00 UTC, and not again after a restart", async (db) => {
  await seed(db);
  const sent = [];
  let t = new Date("2099-12-05T03:30:00Z");
  const make = () => report.createReporter({ config: { monitorEnabled: true }, db, notifier: { send: async (h) => { sent.push(h); return true; } }, agents: null, now: () => t, log: () => {} });
  let r = make();
  assert.deepStrictEqual(await r.tick(), { sent: false });                                  // before 04:00
  t = new Date("2099-12-05T04:10:00Z");
  assert.deepStrictEqual(await r.tick(), { sent: true });
  r = make();                                                                               // a restart
  assert.deepStrictEqual(await r.tick(), { sent: false, already: true });
  t = new Date("2099-12-06T04:10:00Z");                                                     // Sunday
  assert.deepStrictEqual(await r.tick(), { sent: false });
  t = new Date("2099-12-12T04:10:00Z");                                                     // next Saturday
  assert.deepStrictEqual(await r.tick(), { sent: true });
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(report.createReporter({ config: { monitorEnabled: false }, db, notifier: {} }).start(), false);
});
