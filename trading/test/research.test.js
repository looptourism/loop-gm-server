// Run with: npm test
// The database part runs only when TEST_TRADING_DATABASE_URL points at a
// throw-away Postgres; it creates its own database ("trading_research_test").
const test = require("node:test");
const assert = require("node:assert");
const { createDb } = require("../db");
const { createProviders } = require("../providers");
const { createResearch } = require("../research");
const { createLimiter } = require("../rate-limiter");
const store = require("../db/research");
const { RESEARCH, PROVIDER_LIMITS } = require("../config");
const { mount } = require("../index");

test("research settings: every provider ceiling is below the provider's own limit", () => {
  assert.ok(PROVIDER_LIMITS.finnhub.perMinute <= 40);   // Finnhub free: 60/minute
  assert.ok(PROVIDER_LIMITS.coingecko.perMinute <= 10);
  assert.ok(PROVIDER_LIMITS.sec.perMinute <= 60);       // SEC: 10/second
  assert.strictEqual(RESEARCH.dailyEveryMs, 86400000);
});

test("the same answer always hashes the same, whatever the key order", () => {
  assert.strictEqual(store.hashOf({ a: 1, b: [1, { c: 2, d: null }] }), store.hashOf({ b: [1, { d: null, c: 2 }], a: 1 }));
  assert.notStrictEqual(store.hashOf({ a: 1 }), store.hashOf({ a: 2 }));
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

test("research routes: closed without a login or a database; 'run' needs confirm=yes; the schedule is off by default", async () => {
  const cfg = { hasKeys: false, tradingEnabled: false, monitorEnabled: false, databaseUrl: "", providerKeys: {} };
  let ticks = 0;
  const stubs = { client: { redact: (t) => String(t ?? "") }, monitor: { start: () => false, state: () => ({}) }, research: { start: () => false, state: () => ({ running: null }), tick: async () => { ticks++; } } };
  const none = { configured: false, redact: (t) => String(t ?? "") };
  const open = fakeApp();
  mount(open, { authOn: false, config: cfg, db: { ...none, configured: true }, ...stubs });
  for (const p of ["/api/trading/research/status", "/api/trading/research/run", "/api/trading/research/view"]) assert.strictEqual((await open.call(p, { confirm: "yes" })).statusCode, 503);
  const noDb = fakeApp();
  mount(noDb, { authOn: true, config: cfg, db: none, ...stubs });
  assert.strictEqual((await noDb.call("/api/trading/research/run", { confirm: "yes" })).statusCode, 503);
  const app = fakeApp();
  mount(app, { authOn: true, config: cfg, db: { ...none, configured: true }, ...stubs });
  assert.strictEqual((await app.call("/api/trading/research/run")).statusCode, 400);
  assert.strictEqual(ticks, 0);
  assert.strictEqual((await app.call("/api/trading/research/run", { confirm: "yes" })).body.started, true);
  assert.strictEqual(ticks, 1);
  const real = createResearch({ config: cfg, providers: createProviders({ config: cfg }), db: none, log: () => {} });
  assert.strictEqual(real.start(), false);
  assert.match((await real.tick()).skipped, /TRADING_DATABASE_URL/);
});

// ---- against a real Postgres -------------------------------------------------
const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, fn);
let db = null;
const cfg = { monitorEnabled: false, providerKeys: {} };
const T0 = "2026-11-14T09:40:00.000Z";

// Fake adapters behind the real provider layer. `state` lets a test change the answers.
function fakeProviders(state) {
  const meta = (provider, capability, symbol, data) => ({ provider, capability, symbol, data, source: `${provider} test`, fetchedAt: state.at, raw: { big: "x" } });
  const fail = (code) => Object.assign(new Error(`${code} from provider`), { code });
  const article = (id, s) => ({ id, headline: `${s} headline ${id}`, summary: "s", url: `https://example.com/${s}/${id}`, publisher: "Reuters", publishedAt: "2026-11-14T08:00:00.000Z", raw: { id } });
  const adapters = {
    finnhub: () => ({
      name: "finnhub", hasKey: true, redact: (t) => t, callsPer: { earnings: 2 },
      getProfile: async (s) => meta("finnhub", "profile", s, s === "WYFI" ? null : { name: `${s} Inc` }),
      getFundamentals: async (s) => meta("finnhub", "fundamentals", s, { peTtm: state.pe }),
      getEarnings: async (s) => meta("finnhub", "earnings", s, { history: [], upcoming: [] }),
      getNews: async (s, { days }) => { state.newsDays.push(days); return meta("finnhub", "news", s, state.articles.map((id) => article(id, s))); },
      getMarketNews: async (c) => meta("finnhub", "marketNews", null, [article(900, c), article(901, c)]),
    }),
    sec: () => ({ name: "sec", hasKey: true, redact: (t) => t, getFilings: async (s) => { if (state.secFails) throw fail(state.secFails); return meta("sec", "filings", s, { filings: [{ form: "10-Q", filedOn: "2026-10-30" }] }); } }),
    coingecko: () => ({ name: "coingecko", hasKey: true, redact: (t) => t, getFundamentals: async (s) => meta("coingecko", "fundamentals", s, { marketCapRank: 1 }) }),
  };
  return createProviders({ config: cfg, adapters, limiterFor: () => createLimiter({ perMinute: 100000, minGapMs: 0, reserve: 0 }) });
}

if (TEST_URL) {
  test.before(async () => {
    const admin = createDb({ config: { databaseUrl: TEST_URL } });
    await admin.query("drop database if exists trading_research_test");
    await admin.query("create database trading_research_test");
    await admin.close();
    const u = new URL(TEST_URL); u.pathname = "/trading_research_test";
    db = createDb({ config: { databaseUrl: u.toString() } });
    await db.migrate("001_initial"); await db.migrate("002_monitoring");
    assert.deepStrictEqual(await db.migrate("003_research"), { applied: "003_research", remaining: [] });
    for (const [id, symbol, cls] of [[2001, "MSTR", "stock"], [2003, "WYFI", "stock"], [100000, "BTC", "crypto"]]) {
      await db.query("insert into trading.instruments (instrument_id, symbol, asset_class, raw, source, fetched_at) values ($1, $2, $3, '{}', 'test', now())", [id, symbol, cls]);
      await db.query(`insert into trading.${cls}_allowlist (symbol, instrument_id, verified_at) values ($1, $2, now())`, [symbol, id]);
    }
  });
  test.after(async () => { await db.close(); });
}

dbTest("migration 003: new tables are locked, and the run log accepts research runs", async () => {
  const rls = await db.query("select count(*) as n from pg_tables where schemaname = 'trading' and not rowsecurity");
  assert.strictEqual(Number(rls.rows[0].n), 0);
});

dbTest("first run: stores every answer with provider and source; a symbol the provider does not know is a problem, not a row", async () => {
  const state = { at: T0, pe: 20, articles: [1, 2, 3], newsDays: [] };
  const providers = fakeProviders(state);
  const job = createResearch({ config: cfg, providers, db, now: () => new Date(T0), log: () => {} });
  const out = await job.tick("manual");
  assert.deepStrictEqual(out.runs.map((r) => [r.kind, r.status]), [["research", "partial"], ["news", "ok"]]);
  assert.deepStrictEqual(out.runs[0].problems.map((p) => [p.symbol, p.problem]), [["WYFI", "profile: finnhub has no data for this symbol"]]);
  assert.strictEqual(out.runs[0].inserted, 8);                    // MSTR 4 + WYFI 3 + BTC 1
  assert.strictEqual(out.runs[0].requests, 11);                   // earnings counts as 2 calls
  assert.deepStrictEqual([out.runs[1].inserted, out.runs[1].requests], [8, 3]); // 3 + 3 company articles, 2 crypto headlines
  assert.deepStrictEqual(state.newsDays, [30, 30]);               // first time: 30 days back
  const rows = await db.query("select i.symbol, s.capability, s.provider, s.source from trading.research_snapshots s join trading.instruments i using (instrument_id) order by 1, 2");
  assert.deepStrictEqual(rows.rows.map((r) => `${r.symbol} ${r.capability} ${r.provider}`), ["BTC fundamentals coingecko", "MSTR earnings finnhub", "MSTR filings sec", "MSTR fundamentals finnhub", "MSTR profile finnhub", "WYFI earnings finnhub", "WYFI filings sec", "WYFI fundamentals finnhub"]);
  assert.ok(rows.rows.every((r) => r.source));
});

dbTest("nothing is due in the same slot; later, unchanged answers add no rows and changed ones keep history", async () => {
  const state = { at: "2026-11-14T10:40:00.000Z", pe: 20, articles: [1, 2, 3], newsDays: [] };
  const sameDay = createResearch({ config: cfg, providers: fakeProviders(state), db, now: () => new Date(state.at), log: () => {} });
  assert.strictEqual((await sameDay.tick()).skipped, "nothing is due yet");
  state.at = "2026-11-14T12:40:00.000Z";                          // next 6-hour slot: news only
  state.articles = [2, 3, 4];
  const news = await sameDay.tick();
  assert.deepStrictEqual(news.runs.map((r) => [r.kind, r.inserted, r.unchanged]), [["news", 2, 6]]);
  assert.deepStrictEqual(state.newsDays, [3, 3]);
  state.at = "2026-11-15T00:40:00.000Z";                          // next day
  state.pe = 21;
  const next = await sameDay.tick();
  assert.deepStrictEqual([next.runs[0].kind, next.runs[0].inserted, next.runs[0].unchanged], ["research", 2, 6]); // only the two P/E answers changed
  const hist = await db.query("select data->>'peTtm' as pe, fetched_at, last_confirmed_at from trading.research_snapshots where instrument_id = 2001 and capability = 'fundamentals' order by fetched_at");
  assert.deepStrictEqual(hist.rows.map((r) => r.pe), ["20", "21"]);
  const prof = await db.query("select fetched_at, last_confirmed_at from trading.research_snapshots where instrument_id = 2001 and capability = 'profile'");
  assert.strictEqual(prof.rows.length, 1);
  assert.deepStrictEqual([prof.rows[0].fetched_at.toISOString(), prof.rows[0].last_confirmed_at.toISOString()], [T0, "2026-11-15T00:40:00.000Z"]);
});

dbTest("a provider that rejects the key is dropped for the run; the other providers still deliver", async () => {
  const state = { at: "2026-11-16T00:40:00.000Z", pe: 21, articles: [], newsDays: [], secFails: "BadKey" };
  const providers = fakeProviders(state);
  const job = createResearch({ config: cfg, providers, db, now: () => new Date(state.at), log: () => {} });
  const run = await job.collectDaily(await require("../db/snapshots").listMonitored(db), "manual");
  assert.strictEqual(run.status, "partial");
  assert.strictEqual(providers.requests().sec, 1);                // asked once, then not again
  assert.match(run.problems.find((p) => p.symbol === "WYFI" && /filings/.test(p.problem)).problem, /not attempted/);
  assert.strictEqual(run.unchanged, 6);                           // Finnhub and CoinGecko answers were still confirmed
});

dbTest("what an agent reads: stored research only, each block with provider, source and time", async () => {
  const v = await store.readResearchView(db, "mstr");
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual([v.fundamentals.provider, v.fundamentals.data.peTtm, v.filings.provider], ["finnhub", 21, "sec"]);
  assert.ok(v.fundamentals.source && v.fundamentals.fetchedAt && v.fundamentals.snapshotId);
  assert.strictEqual(v.news.length, 4);
  assert.ok(v.news.every((n) => n.source && n.publishedAt && n.provider === "finnhub"));
  assert.deepStrictEqual(v.missing, []);
  const wyfi = await store.readResearchView(db, "WYFI");
  assert.strictEqual(wyfi.profile, null);
  assert.deepStrictEqual(wyfi.missing, ["profile: nothing stored"]);
  const btc = await store.readResearchView(db, "BTC");
  assert.deepStrictEqual([btc.fundamentals.provider, btc.news.length, btc.generalNews.items.length], ["coingecko", 0, 2]);
  assert.match(btc.generalNews.note, /not specific to BTC/);
  assert.strictEqual((await store.readResearchView(db, "AAPL")).ok, false);
  const cov = await store.researchCoverage(db);
  assert.deepStrictEqual(cov.generalNews, { crypto: { articles: 2, newest: "2026-11-14T08:00:00.000Z" } });
  assert.strictEqual(cov.instruments.find((i) => i.symbol === "MSTR").news.articles, 4);
});
