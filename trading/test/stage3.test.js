// Run with: npm test
// The first part needs nothing. The database part runs only when
// TEST_TRADING_DATABASE_URL points at a throw-away Postgres; it creates its
// own database there ("trading_stage3_test") so it cannot collide with the
// Stage 2 tests.
const test = require("node:test");
const assert = require("node:assert");
const { parseUtc, normalizeRate, rateFreshness, normalizeCandles, candleRange, MarketDataError } = require("../market-data");
const { createLimiter } = require("../rate-limiter");
const { createMonitor } = require("../monitor");
const { readConfig, MONITORING } = require("../config");
const { createDb } = require("../db");
const snapshots = require("../db/snapshots");
const { mount } = require("../index");

// ---- timestamps ------------------------------------------------------------
test("a timestamp without a timezone is read as UTC, whatever the server's timezone", () => {
  const before = process.env.TZ;
  process.env.TZ = "Asia/Riyadh"; // UTC+3: local parsing would be 3 hours off
  try {
    assert.strictEqual(parseUtc("2026-11-13T05:41:23.053").toISOString(), "2026-11-13T05:41:23.053Z");
    assert.strictEqual(parseUtc("2026-11-13T05:41:23").toISOString(), "2026-11-13T05:41:23.000Z");
    assert.strictEqual(parseUtc("2026-11-13T05:41:23.0531234").toISOString(), "2026-11-13T05:41:23.053Z");
    assert.strictEqual(parseUtc("2026-11-13T05:41:23Z").toISOString(), "2026-11-13T05:41:23.000Z");
    assert.strictEqual(parseUtc("2026-11-13T08:41:23+03:00").toISOString(), "2026-11-13T05:41:23.000Z");
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
  for (const bad of [null, undefined, "", "yesterday", "2026-11-13", 1731476483, "2026-13-45T99:99:99"]) assert.strictEqual(parseUtc(bad), null);
});

// ---- rates -----------------------------------------------------------------
test("a rate is accepted only with bid, ask and eToro's own timestamp", () => {
  const ok = normalizeRate({ instrumentId: 1001, bid: 229.5, ask: 229.9, date: "2026-11-13T05:41:23.053", quoteType: "realtime" });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.rate.asOf, "2026-11-13T05:41:23.053Z");
  for (const bad of [
    { instrumentId: 1001, bid: null, ask: 229.9, date: "2026-11-13T05:41:23" },
    { instrumentId: 1001, bid: 229.5, ask: 229.9, date: null },
    { instrumentId: 1001, bid: 230, ask: 229.9, date: "2026-11-13T05:41:23" },
    { instrumentId: 1001, bid: 0, ask: 1, date: "2026-11-13T05:41:23" },
    { bid: 1, ask: 2, date: "2026-11-13T05:41:23" },
    null,
  ]) assert.strictEqual(normalizeRate(bad).ok, false);
});

test("freshness comes from the quote's own timestamp: 'realtime' with an old date is not fresh", () => {
  const now = new Date("2026-11-13T06:00:00Z");
  assert.deepStrictEqual(rateFreshness({ asOf: "2026-11-13T05:59:00Z", quoteType: "realtime" }, now, 1200), { ageSec: 60, fresh: true, reasons: [] });
  const closed = rateFreshness({ asOf: "2026-11-12T21:00:00Z", quoteType: "realtime" }, now, 1200); // US market closed
  assert.strictEqual(closed.fresh, false);
  assert.strictEqual(closed.ageSec, 9 * 3600);
  assert.strictEqual(rateFreshness({ asOf: "2026-11-13T05:59:00Z", quoteType: "delayed" }, now, 1200).fresh, false);
  assert.strictEqual(rateFreshness({ asOf: "2026-11-13T05:59:00Z", quoteType: null }, now, 1200).fresh, false);
  assert.strictEqual(rateFreshness({ asOf: "2026-11-13T06:10:00Z", quoteType: "realtime" }, now, 1200).fresh, false); // future
});

// ---- candles ---------------------------------------------------------------
// Shaped like the real `desc` answer: newest first, today's candle unfinished
// with a null volume, and rangeOpen / rangeClose reversed in time.
const dailyDesc = (id) => ({
  interval: "OneDay",
  candles: [{
    instrumentId: id,
    candles: [
      { instrumentID: id, fromDate: "2026-11-13T00:00:00Z", open: 104, high: 105, low: 103, close: 104.5, volume: null },
      { instrumentID: id, fromDate: "2026-11-12T00:00:00Z", open: 102, high: 106, low: 101, close: 104, volume: 5000 },
      { instrumentID: id, fromDate: "2026-11-11T00:00:00Z", open: 100, high: 103, low: 99, close: 102, volume: 5000 },
      { instrumentID: id, fromDate: "2026-11-10T00:00:00Z", open: 98, high: 101, low: 97, close: 100, volume: 5000 },
    ],
    rangeOpen: 104, rangeClose: 100, rangeHigh: 106, rangeLow: 97, volume: 15000,
  }],
});

test("today's unfinished candle is dropped, volume is not read, the rest comes back oldest first", () => {
  const n = normalizeCandles(dailyDesc(1001), { instrumentId: 1001, interval: "OneDay", now: new Date("2026-11-13T05:41:00Z") });
  assert.deepStrictEqual(n.candles.map((c) => c.asOf), ["2026-11-10T00:00:00.000Z", "2026-11-11T00:00:00.000Z", "2026-11-12T00:00:00.000Z"]);
  assert.deepStrictEqual(n.dropped, { unfinished: 1, invalid: 0, duplicate: 0 });
  assert.ok(n.candles.every((c) => !("volume" in c)));
  // one second before midnight the 12th is still forming; at midnight it is finished
  assert.strictEqual(normalizeCandles(dailyDesc(1001), { instrumentId: 1001, interval: "OneDay", now: new Date("2026-11-12T23:59:59Z") }).candles.length, 2);
  assert.strictEqual(normalizeCandles(dailyDesc(1001), { instrumentId: 1001, interval: "OneDay", now: new Date("2026-11-13T00:00:00Z") }).candles.length, 3);
});

test("ranges are computed from the candles, not from eToro's reversed rangeOpen / rangeClose", () => {
  const data = dailyDesc(1001);
  const n = normalizeCandles(data, { instrumentId: 1001, interval: "OneDay", now: new Date("2026-11-13T05:41:00Z") });
  const r = candleRange(n.candles);
  assert.deepStrictEqual(r, { count: 3, from: "2026-11-10T00:00:00.000Z", to: "2026-11-12T00:00:00.000Z", open: 98, close: 104, high: 106, low: 97, changePct: 6.1224 });
  assert.notStrictEqual(r.open, data.candles[0].rangeOpen);
  assert.deepStrictEqual(candleRange([...n.candles].reverse()), r); // input order does not matter
  assert.strictEqual(candleRange([]), null);
});

test("candles that do not add up are rejected, and a wrong answer is refused as a whole", () => {
  const data = dailyDesc(7);
  data.candles[0].candles.push(
    { instrumentID: 7, fromDate: "2026-11-09T00:00:00Z", open: 98, high: 97, low: 96, close: 97.5 },   // high below open
    { instrumentID: 7, fromDate: "2026-11-08T00:00:00Z", open: 98, high: 99, low: 96, close: null },   // no close
    { instrumentID: 7, fromDate: "not a date", open: 98, high: 99, low: 96, close: 97 },
    { instrumentID: 8, fromDate: "2026-11-07T00:00:00Z", open: 98, high: 99, low: 96, close: 97 },     // another instrument
    { instrumentID: 7, fromDate: "2026-11-10T00:00:00Z", open: 1, high: 2, low: 1, close: 2 },         // same day twice
  );
  const n = normalizeCandles(data, { instrumentId: 7, interval: "OneDay", now: new Date("2026-11-13T05:41:00Z") });
  assert.deepStrictEqual(n.dropped, { unfinished: 1, invalid: 4, duplicate: 1 });
  assert.strictEqual(n.candles.length, 3);
  const at = { instrumentId: 7, interval: "OneDay", now: new Date() };
  assert.throws(() => normalizeCandles({ interval: "OneHour", candles: data.candles }, at), MarketDataError);
  assert.throws(() => normalizeCandles({ interval: "OneDay", candles: [] }, at), MarketDataError);
  assert.throws(() => normalizeCandles({}, at), MarketDataError);
});

// ---- request budget --------------------------------------------------------
// A clock that only moves when the limiter sleeps.
function fakeClock(start = Date.parse("2026-11-13T06:00:00Z")) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

test("the limiter never lets more than its ceiling through in any 60 seconds", async () => {
  const clock = fakeClock();
  const lim = createLimiter({ perMinute: 30, minGapMs: 2000, reserve: 40, now: clock.now, sleep: clock.sleep });
  const times = [];
  for (let i = 0; i < 200; i++) { await lim.take(); times.push(clock.now()); }
  for (let i = 0; i < times.length; i++) {
    const inWindow = times.filter((x) => x >= times[i] && x < times[i] + 60000).length;
    assert.ok(inWindow <= 30, `${inWindow} requests in one minute`);
    if (i) assert.ok(times[i] - times[i - 1] >= 2000);
  }
});

test("the limiter waits when eToro says little quota is left, and refuses after a 429", async () => {
  const clock = fakeClock();
  const lim = createLimiter({ perMinute: 30, minGapMs: 2000, reserve: 40, now: clock.now, sleep: clock.sleep });
  await lim.take();
  lim.observe({ remaining: 100, resetSec: 30 });
  const t0 = clock.now();
  await lim.take();
  assert.strictEqual(clock.now() - t0, 2000);
  lim.observe({ remaining: 39, resetSec: 45 }); // someone else is using the quota
  const t1 = clock.now();
  await lim.take();
  assert.strictEqual(clock.now() - t1, 45000);
  lim.pause(300000);
  await assert.rejects(lim.take(), /429/);
  clock.advance(300000);
  await lim.take();
});

test("the settings keep the job at a quarter of eToro's 120 per minute", () => {
  assert.ok(MONITORING.requestsPerMinute <= 30);
  assert.ok(MONITORING.minGapMs >= 60000 / MONITORING.requestsPerMinute);
  assert.strictEqual(readConfig({}).monitorEnabled, false);
  assert.strictEqual(readConfig({ TRADING_MONITOR_ENABLED: "TRUE" }).monitorEnabled, false);
  assert.strictEqual(readConfig({ TRADING_MONITOR_ENABLED: "true" }).monitorEnabled, true);
});

// ---- the job, against a fake eToro and a fake database ---------------------
const noDb = { configured: false, redact: (t) => String(t ?? "") };
const cfg = { baseUrl: "https://public-api.etoro.com", apiKey: "PUBKEY-123", userKey: "USERKEY-456", hasKeys: true, tradingEnabled: false, monitorEnabled: false, databaseUrl: "" };
const quiet = () => {};

test("the job stores nothing and says why when keys or database are missing", async () => {
  const client = { redact: (t) => String(t ?? ""), getRates() { throw new Error("must not be called"); } };
  const a = await createMonitor({ config: { ...cfg, hasKeys: false }, client, db: noDb, log: quiet }).tick();
  assert.match(a.skipped, /ETORO_API_KEY/);
  const b = await createMonitor({ config: cfg, client, db: noDb, log: quiet }).tick();
  assert.match(b.skipped, /TRADING_DATABASE_URL/);
  assert.strictEqual(a.ok, false);
  assert.strictEqual(createMonitor({ config: cfg, client, db: noDb, log: quiet }).start(), false); // schedule stays off
});

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

test("monitor routes are closed without a login or a database, and 'run' needs confirm=yes", async () => {
  const client = { redact: (t) => String(t ?? "") };
  const open = fakeApp();
  mount(open, { authOn: false, config: cfg, client, db: { ...noDb, configured: true } });
  for (const p of ["/api/trading/monitor/status", "/api/trading/monitor/run", "/api/trading/monitor/view"]) assert.strictEqual((await open.call(p, { confirm: "yes" })).statusCode, 503);
  const app = fakeApp();
  let ticks = 0;
  const monitor = { start: () => false, state: () => ({ running: null }), tick: async () => { ticks++; } };
  mount(app, { authOn: true, config: cfg, client, db: noDb, monitor });
  assert.strictEqual((await app.call("/api/trading/monitor/run", { confirm: "yes" })).statusCode, 503); // no database
  const app2 = fakeApp();
  mount(app2, { authOn: true, config: cfg, client, db: { ...noDb, configured: true }, monitor });
  assert.strictEqual((await app2.call("/api/trading/monitor/run")).statusCode, 400);
  assert.strictEqual(ticks, 0);
  assert.strictEqual((await app2.call("/api/trading/monitor/run", { confirm: "yes" })).body.started, true);
  assert.strictEqual(ticks, 1);
});

// ---- the job, against a real Postgres --------------------------------------
const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, fn);
let db = null;

// A stand-in for the eToro client that counts every request.
function fakeEtoro({ rates, candles, status = 200, failCandles = {} }) {
  const calls = [];
  const meta = (path) => ({ source: `eToro Public API GET ${path}`, fetchedAt: "2026-11-13T06:05:10.000Z", status: 200, rateLimit: { limit: 120, remaining: 110, resetSec: 30 } });
  return {
    calls,
    redact: (t) => String(t ?? ""),
    async getRates(ids) { calls.push({ rates: ids }); return { data: { results: rates() }, ...meta("/api/v2/market-data/rates"), status }; },
    async getCandles(id, { interval, count }) {
      calls.push({ candles: id, interval, count });
      if (failCandles[id]) throw failCandles[id];
      return { data: candles(id, interval), ...meta(`/api/v1/market-data/instruments/${id}/history/candles/desc/${interval}/${count}`) };
    },
  };
}
const hourly = (id) => ({ interval: "OneHour", candles: [{ instrumentId: id, candles: [
  { instrumentID: id, fromDate: "2026-11-13T06:00:00Z", open: 104, high: 105, low: 103, close: 104.5 }, // still forming at 06:05
  { instrumentID: id, fromDate: "2026-11-13T05:00:00Z", open: 103, high: 105, low: 102, close: 104 },
  { instrumentID: id, fromDate: "2026-11-13T04:00:00Z", open: 102, high: 104, low: 101, close: 103 },
] }] });
const NOW = new Date("2026-11-13T06:05:00Z");
const fastLimiter = () => createLimiter({ perMinute: 1000, minGapMs: 0, reserve: 0 });
const rateItems = () => [
  { instrumentId: 2001, bid: 229.5, ask: 229.9, date: "2026-11-12T21:00:00.10", quoteType: "realtime" },  // US market closed
  { instrumentId: 100000, bid: 90000, ask: 90050, date: "2026-11-13T06:04:30.5", quoteType: "realtime" },
];

if (TEST_URL) {
  test.before(async () => {
    const admin = createDb({ config: { databaseUrl: TEST_URL } });
    await admin.query("drop database if exists trading_stage3_test");
    await admin.query("create database trading_stage3_test");
    await admin.close();
    const u = new URL(TEST_URL); u.pathname = "/trading_stage3_test";
    db = createDb({ config: { databaseUrl: u.toString() } });
    await db.migrate("001_initial");
    assert.deepStrictEqual(await db.migrate("002_monitoring"), { applied: "002_monitoring", remaining: [] });
    for (const [id, symbol, cls] of [[2001, "MSTR", "stock"], [2002, "NKE", "stock"], [100000, "BTC", "crypto"]]) {
      await db.query("insert into trading.instruments (instrument_id, symbol, asset_class, raw, source, fetched_at) values ($1, $2, $3, '{}', 'test', now())", [id, symbol, cls]);
    }
    await db.query("insert into trading.stock_allowlist (symbol, instrument_id, verified_at) values ('MSTR', 2001, now())");
    await db.query("insert into trading.stock_allowlist (symbol, instrument_id, verified_at, active) values ('NKE', 2002, now(), false)"); // switched off
    await db.query("insert into trading.stock_allowlist (symbol) values ('WYFI')");                                                       // never verified
    await db.query("insert into trading.crypto_allowlist (symbol, instrument_id, verified_at) values ('BTC', 100000, now())");
  });
  test.after(async () => { await db.close(); });
}

dbTest("migration 002: the new table is locked like the others", async () => {
  const rls = await db.query("select count(*) as n from pg_tables where schemaname = 'trading' and not rowsecurity");
  assert.strictEqual(Number(rls.rows[0].n), 0);
});

dbTest("only active, verified allowlist instruments are monitored", async () => {
  assert.deepStrictEqual((await snapshots.listMonitored(db)).map((i) => i.symbol), ["BTC", "MSTR"]);
});

dbTest("a full run: one rates request, one candle request per instrument and interval, finished candles only", async () => {
  const etoro = fakeEtoro({ rates: rateItems, candles: (id, interval) => (interval === "OneDay" ? dailyDesc(id) : hourly(id)) });
  const monitor = createMonitor({ config: cfg, client: etoro, db, now: () => NOW, limiter: fastLimiter(), log: quiet });
  const out = await monitor.tick("manual");
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(etoro.calls.length, 5);                                   // 1 + 2 + 2
  assert.deepStrictEqual(etoro.calls[0], { rates: [100000, 2001] });
  assert.deepStrictEqual(etoro.calls.filter((c) => c.candles).map((c) => c.count), [400, 400, 240, 240]); // first time: backfill
  assert.deepStrictEqual(out.runs.map((r) => [r.kind, r.interval, r.status, r.requests, r.inserted]), [["rates", undefined, "ok", 1, 2], ["candles", "OneDay", "ok", 2, 6], ["candles", "OneHour", "ok", 2, 4]]);
  const rows = await db.query("select kind, candle_interval, count(*) as n, count(volume) as with_volume from trading.market_snapshots group by 1, 2 order by 1, 2");
  assert.deepStrictEqual(rows.rows.map((r) => [r.kind, r.candle_interval, Number(r.n), Number(r.with_volume)]), [["candle", "OneDay", 6, 0], ["candle", "OneHour", 4, 0], ["rate", null, 2, 0]]);
  const today = await db.query("select count(*) as n from trading.market_snapshots where kind = 'candle' and candle_interval = 'OneDay' and as_of >= '2026-11-13T00:00:00Z'");
  assert.strictEqual(Number(today.rows[0].n), 0);                              // today's candle was not stored
  const r = await db.query("select as_of from trading.market_snapshots where kind = 'rate' and instrument_id = 2001");
  assert.strictEqual(new Date(r.rows[0].as_of).toISOString(), "2026-11-12T21:00:00.100Z"); // eToro's timestamp, read as UTC
});

dbTest("the next run stores nothing twice, skips candles that are not due, and asks for few candles", async () => {
  const etoro = fakeEtoro({ rates: rateItems, candles: (id, interval) => (interval === "OneDay" ? dailyDesc(id) : hourly(id)) });
  const monitor = createMonitor({ config: cfg, client: etoro, db, now: () => new Date("2026-11-13T06:20:00Z"), limiter: fastLimiter(), log: quiet });
  const out = await monitor.tick("schedule");
  assert.strictEqual(etoro.calls.length, 1);                                   // same hour, same 6-hour slot: rates only
  assert.deepStrictEqual([out.runs[0].inserted, out.runs[0].unchanged], [0, 2]);
  const later = createMonitor({ config: cfg, client: etoro, db, now: () => new Date("2026-11-13T07:05:00Z"), limiter: fastLimiter(), log: quiet });
  const out2 = await later.tick("schedule");
  assert.deepStrictEqual(out2.runs.map((r) => r.interval), [undefined, "OneHour"]); // a new hour: hourly candles are due, daily are not
  assert.deepStrictEqual(etoro.calls.filter((c) => c.candles).map((c) => c.count), [6, 6]); // periods since the newest stored candle (rounded up) + overlap of 3
  assert.deepStrictEqual([out2.runs[1].inserted, out2.runs[1].unchanged], [0, 4]);
  assert.strictEqual(Number((await db.query("select count(*) as n from trading.market_snapshots")).rows[0].n), 12);
});

dbTest("a candle eToro later changed is corrected, and the old figures go to the audit log", async () => {
  const changed = (id, interval) => { const d = dailyDesc(id); if (id === 2001) d.candles[0].candles[1].close = 105; return interval === "OneDay" ? d : hourly(id); };
  const etoro = fakeEtoro({ rates: rateItems, candles: changed });
  const monitor = createMonitor({ config: cfg, client: etoro, db, now: () => NOW, limiter: fastLimiter(), log: quiet });
  const run = await monitor.collectCandles(await snapshots.listMonitored(db), MONITORING.candles[0], "manual");
  assert.deepStrictEqual([run.status, run.inserted, run.revised, run.unchanged], ["ok", 0, 1, 5]);
  const row = await db.query("select close, revised_at from trading.market_snapshots where instrument_id = 2001 and candle_interval = 'OneDay' and as_of = '2026-11-12T00:00:00Z'");
  assert.strictEqual(Number(row.rows[0].close), 105);
  assert.ok(row.rows[0].revised_at);
  const audit = await db.query("select data from trading.audit_log where event_type = 'market.candle_revised'");
  assert.strictEqual(audit.rows.length, 1);
  assert.deepStrictEqual([audit.rows[0].data.candles[0].was.close, audit.rows[0].data.candles[0].now.close], [104, 105]);
});

dbTest("a partial answer (206) and a bad rate are reported, the good rates are still stored", async () => {
  const etoro = fakeEtoro({ status: 206, rates: () => [{ instrumentId: 100000, bid: 90010, ask: 90060, date: "2026-11-13T06:19:30", quoteType: "realtime" }], candles: () => ({}) });
  const monitor = createMonitor({ config: cfg, client: etoro, db, now: () => NOW, limiter: fastLimiter(), log: quiet });
  const run = await monitor.collectRates(await snapshots.listMonitored(db), "manual");
  assert.strictEqual(run.status, "partial");
  assert.strictEqual(run.inserted, 1);
  assert.deepStrictEqual(run.problems.map((p) => p.symbol), ["MSTR"]);
  assert.match(run.problems[0].problem, /206/);
});

dbTest("a 429 stops the run at once: the rest is not attempted and the next request is refused", async () => {
  const limited = Object.assign(new Error("eToro 429"), { status: 429, retryAfterSec: 60 });
  const etoro = fakeEtoro({ rates: rateItems, candles: (id) => dailyDesc(id), failCandles: { 100000: limited } });
  const limiter = fastLimiter();
  const monitor = createMonitor({ config: cfg, client: etoro, db, now: () => NOW, limiter, log: quiet });
  const run = await monitor.collectCandles(await snapshots.listMonitored(db), MONITORING.candles[0], "manual");
  assert.strictEqual(run.status, "failed");
  assert.strictEqual(etoro.calls.length, 1);                                   // BTC failed, MSTR was never asked
  assert.match(run.problems[1].problem, /not attempted/);
  await assert.rejects(limiter.take(), /429/);
  assert.ok(limiter.state().pausedUntil);
});

dbTest("what an agent reads: stored figures only, with source, timestamps and honest freshness", async () => {
  const view = await snapshots.readMarketView(db, "mstr", { now: new Date("2026-11-13T06:21:00Z"), rateFreshSec: 1200 });
  assert.strictEqual(view.ok, true);
  assert.strictEqual(view.rate.fresh, false);                                  // marked realtime, but 9 hours old
  assert.match(view.rate.notFreshBecause[0], /old/);
  assert.match(view.rate.source, /market-data\/rates/);
  assert.match(view.rate.snapshotId, /^[0-9a-f-]{36}$/);
  assert.deepStrictEqual([view.daily.range.open, view.daily.range.close, view.daily.range.high, view.daily.range.low], [98, 105, 106, 97]);
  assert.strictEqual(view.daily.candles.length, 3);
  assert.ok(view.daily.candles.every((c) => c.source && c.fetchedAt && !("volume" in c)));
  const btc = await snapshots.readMarketView(db, "BTC", { now: new Date("2026-11-13T06:21:00Z"), rateFreshSec: 1200 });
  assert.strictEqual(btc.rate.fresh, true);
  assert.strictEqual(btc.rate.asOf, "2026-11-13T06:19:30.000Z");
  for (const s of ["NKE", "WYFI", "AAPL", ""]) assert.strictEqual((await snapshots.readMarketView(db, s, { rateFreshSec: 1200 })).ok, false); // off, unverified, not listed
  const cov = await snapshots.coverage(db, { now: new Date("2026-11-13T06:21:00Z"), rateFreshSec: 1200 });
  assert.deepStrictEqual(cov.map((c) => [c.symbol, c.rate.fresh, c.candles.OneDay.count]), [["BTC", true, 3], ["MSTR", false, 3]]);
  assert.ok((await snapshots.recentRuns(db)).length >= 5);
});
