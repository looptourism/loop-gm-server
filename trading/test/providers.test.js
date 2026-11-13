// Run with: npm test   (no network, no keys)
const test = require("node:test");
const assert = require("node:assert");
const { createFinnhub, ProviderError } = require("../providers/finnhub");
const { createProviders } = require("../providers");
const { createCoverage } = require("../providers/coverage");
const { createLimiter } = require("../rate-limiter");
const { readConfig, DATA_PROVIDERS } = require("../config");
const { mount } = require("../index");

const KEY = "FINNHUBKEY-123456";
const NOW = new Date("2026-11-13T12:00:00Z");

// A fake Finnhub: answers by path, records every request.
function fakeFetch(answers) {
  const calls = [];
  const impl = async (url, opts) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), path: u.pathname, query: Object.fromEntries(u.searchParams), opts });
    const a = answers[u.pathname.replace("/api/v1", "")];
    const { status = 200, body = {}, headers = {} } = typeof a === "function" ? a(u.searchParams.get("symbol")) : a || { status: 404 };
    return { ok: status >= 200 && status < 300, status, headers: { get: (n) => headers[n] ?? null }, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

const good = {
  "/stock/profile2": { body: { name: "Strategy Inc", ticker: "MSTR", exchange: "NASDAQ", country: "US", currency: "USD", finnhubIndustry: "Technology", ipo: "1998-06-11", marketCapitalization: 90000, shareOutstanding: 280 } },
  "/stock/metric": { body: { metric: { marketCapitalization: 90000, peTTM: 20, epsTTM: 15, psTTM: 100, grossMarginTTM: 70, netProfitMarginTTM: 30, revenueGrowthTTMYoy: 5, "totalDebt/totalEquityQuarterly": 0.3, "52WeekHigh": 500, "52WeekLow": 200 } } },
  "/stock/earnings": { body: [1, 2, 3, 4].map((q) => ({ period: `2026-0${q * 3 > 9 ? 9 : q * 3}-30`, year: 2026, quarter: q, actual: 1.2, estimate: 1.0, surprisePercent: 20, symbol: "MSTR" })) },
  "/calendar/earnings": { body: { earningsCalendar: [{ date: "2027-02-04", hour: "amc", symbol: "MSTR", year: 2026, quarter: 4, epsEstimate: 1.1, revenueEstimate: 120000000 }, { date: "2027-02-05", symbol: "OTHER" }] } },
  "/company-news": { body: [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, headline: `Headline ${i}`, summary: "s", url: "https://example.com/" + i, source: "Reuters", datetime: 1794398400 + i * 3600 })) },
};

test("Finnhub adapter: GET only, key in a header and never in the URL, only listed paths", async () => {
  const f = fakeFetch(good);
  const fh = createFinnhub({ apiKey: KEY, fetchImpl: f.impl, now: () => NOW });
  await fh.getProfile("mstr");
  await fh.getNews("MSTR", { days: 30 });
  for (const c of f.calls) {
    assert.strictEqual(c.opts.method, "GET");
    assert.strictEqual(c.opts.headers["X-Finnhub-Token"], KEY);
    assert.ok(!c.url.includes(KEY));
    assert.ok(c.url.startsWith("https://finnhub.io/api/v1/"));
    assert.strictEqual(c.opts.body, undefined);
  }
  assert.deepStrictEqual(f.calls[1].query, { symbol: "MSTR", from: "2026-10-14", to: "2026-11-13" });
  await assert.rejects(fh.getProfile("../quote"), /invalid symbol/);
});

test("Finnhub adapter: answers are normalized, carry source and time, and missing figures stay null", async () => {
  const f = fakeFetch(good);
  const fh = createFinnhub({ apiKey: KEY, fetchImpl: f.impl, now: () => NOW });
  const fund = await fh.getFundamentals("MSTR");
  assert.strictEqual(fund.data.peTtm, 20);
  assert.strictEqual(fund.data.debtToEquity, 0.3);
  assert.strictEqual(fund.data.beta, null);                       // not returned → null, not 0
  assert.strictEqual(fund.source, "Finnhub GET /api/v1/stock/metric");
  assert.strictEqual(fund.fetchedAt, "2026-11-13T12:00:00.000Z");
  const e = await fh.getEarnings("MSTR");
  assert.strictEqual(e.data.history.length, 4);
  assert.deepStrictEqual(e.data.upcoming.map((u) => u.date), ["2027-02-04"]); // another company's row is dropped
  const n = await fh.getNews("MSTR");
  assert.strictEqual(n.data.length, 6);
  assert.match(n.data[0].publishedAt, /Z$/);                      // Unix seconds → UTC
  assert.ok(n.data[0].publishedAt > n.data[5].publishedAt);       // newest first
  const unknown = createFinnhub({ apiKey: KEY, fetchImpl: fakeFetch({ "/stock/profile2": { body: {} }, "/stock/metric": { body: { metric: {} } } }).impl });
  assert.strictEqual((await unknown.getProfile("ZZZZ")).data, null);
  assert.strictEqual((await unknown.getFundamentals("ZZZZ")).data, null);
});

test("Finnhub adapter: failures throw with a code and never leak the key", async () => {
  await assert.rejects(createFinnhub({ apiKey: "" }).getProfile("MSTR"), (e) => e.code === "MissingKey");
  const codes = { 401: "BadKey", 403: "NotInPlan", 429: "RateLimited", 500: "HttpError" };
  for (const [status, code] of Object.entries(codes)) {
    const fh = createFinnhub({ apiKey: KEY, fetchImpl: fakeFetch({ "/stock/profile2": { status: Number(status), body: { error: `bad ${KEY}` } } }).impl });
    await assert.rejects(fh.getProfile("MSTR"), (e) => e instanceof ProviderError && e.code === code && !e.message.includes(KEY));
  }
  const down = createFinnhub({ apiKey: KEY, fetchImpl: async () => { throw new Error(`connect failed token=${KEY}`); } });
  await assert.rejects(down.getProfile("MSTR"), (e) => e.code === "Network" && !e.message.includes(KEY));
});

test("provider layer: the config table alone decides who answers; switching is a table change", async () => {
  const config = { providerKeys: { finnhub: KEY, other: "OTHERKEY-123" } };
  const other = () => ({ name: "other", hasKey: true, getNews: async (s) => ({ provider: "other", capability: "news", symbol: s, data: [], source: "Other", fetchedAt: "x" }), redact: (t) => t });
  const adapters = { finnhub: (c) => createFinnhub({ apiKey: c.providerKeys.finnhub, fetchImpl: fakeFetch(good).impl }), other };
  const a = createProviders({ config, adapters, table: { stock: { news: "finnhub", profile: "finnhub" } } });
  assert.strictEqual((await a.get("stock", "news").getNews("MSTR")).provider, "finnhub");
  const b = createProviders({ config, adapters, table: { stock: { news: "other", profile: "finnhub" } } }); // one word changed
  assert.strictEqual((await b.get("stock", "news").getNews("MSTR")).provider, "other");
  assert.strictEqual(b.get("stock", "profile").name, "finnhub");
});

test("provider layer fails closed: unknown name, missing key, missing capability — and no fallback", () => {
  const adapters = { finnhub: (c) => createFinnhub({ apiKey: c.providerKeys.finnhub }) };
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return "no error"; };
  const p = createProviders({ config: { providerKeys: { finnhub: KEY } }, adapters, table: { stock: { news: "finnhub", profile: "fmp" }, crypto: {} } });
  assert.strictEqual(code(() => p.get("stock", "profile")), "UnknownProvider");
  assert.strictEqual(code(() => p.get("crypto", "news")), "NotConfigured");
  assert.strictEqual(code(() => p.get("stock", "fundamentals")), "NotConfigured");
  const noKey = createProviders({ config: { providerKeys: {} }, adapters, table: { stock: { news: "finnhub" } } });
  assert.strictEqual(code(() => noKey.get("stock", "news")), "MissingKey");
  assert.deepStrictEqual(noKey.status().stock.news, { provider: "finnhub", adapter: true, keySet: false, usable: false });
  assert.deepStrictEqual(p.status().stock.profile, { provider: "fmp", adapter: false, keySet: false, usable: false });
});

test("the shipped config is Option A for stocks, and the key comes only from FINNHUB_API_KEY", () => {
  assert.deepStrictEqual(DATA_PROVIDERS.stock, { profile: "finnhub", fundamentals: "finnhub", earnings: "finnhub", news: "finnhub" });
  assert.strictEqual(readConfig({}).providerKeys.finnhub, "");
  assert.strictEqual(readConfig({ FINNHUB_API_KEY: " abc " }).providerKeys.finnhub, "abc");
  assert.strictEqual(createProviders({ config: readConfig({ FINNHUB_API_KEY: KEY }) }).status().stock.news.usable, true);
});

const wait = async (cov) => { for (let i = 0; i < 200 && cov.report().running; i++) await new Promise((r) => setTimeout(r, 5)); return cov.report(); };
const fast = () => createLimiter({ perMinute: 100000, minGapMs: 0, reserve: 0 });

test("coverage: reports gaps per stock and capability, and explains a missing P/E for a loss-maker", async () => {
  const answers = {
    "/stock/profile2": (s) => ({ body: s === "WYFI" ? {} : good["/stock/profile2"].body }),
    "/stock/metric": (s) => ({ body: s === "OPTT" ? { metric: { marketCapitalization: 50, epsTTM: -1, psTTM: 9, grossMarginTTM: -5, netProfitMarginTTM: -300, revenueGrowthTTMYoy: 10, "totalDebt/totalEquityQuarterly": 0.1, "52WeekHigh": 2, "52WeekLow": 1 } } : s === "WYFI" ? { metric: {} } : good["/stock/metric"].body }),
    "/stock/earnings": (s) => ({ body: s === "WYFI" ? [] : good["/stock/earnings"].body }),
    "/calendar/earnings": (s) => ({ body: { earningsCalendar: s === "MSTR" ? good["/calendar/earnings"].body.earningsCalendar : [] } }),
    "/company-news": (s) => (s === "BABA" ? { status: 403, body: { error: "You don't have access to this resource." } } : { body: s === "WYFI" ? [] : good["/company-news"].body }),
  };
  const f = fakeFetch(answers);
  const providers = createProviders({ config: { providerKeys: { finnhub: KEY } }, adapters: { finnhub: (c) => createFinnhub({ apiKey: c.providerKeys.finnhub, fetchImpl: f.impl, now: () => NOW }) }, table: DATA_PROVIDERS });
  const cov = createCoverage({ providers, symbols: ["MSTR", "OPTT", "WYFI", "BABA"], limiter: fast() });
  await cov.run();
  const r = await wait(cov);
  assert.strictEqual(f.calls.length, 20);                         // 4 stocks × 5 calls
  assert.deepStrictEqual(r.fullyCovered, ["MSTR"]);
  const by = Object.fromEntries(r.results.map((x) => [x.symbol, x]));
  assert.strictEqual(by.OPTT.fundamentals.verdict, "ok");         // no P/E, but it is loss-making
  assert.strictEqual(by.OPTT.fundamentals.noPeBecauseLossMaking, true);
  assert.strictEqual(by.OPTT.earnings.verdict, "partial");        // no upcoming date
  assert.deepStrictEqual(["profile", "fundamentals", "earnings", "news"].map((c) => by.WYFI[c].verdict), ["gap", "gap", "gap", "gap"]);
  assert.strictEqual(by.BABA.news.verdict, "gap");
  assert.match(by.BABA.news.note, /not available on this plan/);
  assert.ok(r.gaps.includes("WYFI profile: gap (the provider does not know this symbol)"));
  assert.ok(r.results.every((row) => !JSON.stringify(row).includes(KEY)));
});

test("coverage: a 429 stops the test and the rest is 'not checked', never 'no data'", async () => {
  let n = 0;
  const impl = async () => { n++; return n > 2 ? { ok: false, status: 429, headers: { get: () => "60" }, text: async () => "{}" } : { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(n === 1 ? good["/stock/profile2"].body : good["/stock/metric"].body) }; };
  const providers = createProviders({ config: { providerKeys: { finnhub: KEY } }, adapters: { finnhub: (c) => createFinnhub({ apiKey: c.providerKeys.finnhub, fetchImpl: impl }) }, table: DATA_PROVIDERS });
  const cov = createCoverage({ providers, symbols: ["MSTR", "NKE"], limiter: fast() });
  await cov.run();
  const r = await wait(cov);
  assert.strictEqual(n, 3);                                       // nothing was sent after the 429
  assert.match(r.stopped, /MSTR earnings/);
  assert.strictEqual(r.results[0].news.verdict, "not_checked");
  assert.deepStrictEqual(Object.values(r.results[1]).slice(1).map((x) => x.verdict), ["not_checked", "not_checked", "not_checked", "not_checked"]);
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

test("provider routes: closed without a login, refuse clearly without a key, and are not wired to anything else", async () => {
  const cfg = { ...readConfig({}), hasKeys: false };
  const stubs = { client: { redact: (t) => String(t ?? "") }, db: { configured: false, redact: (t) => String(t ?? "") }, monitor: { start: () => false, state: () => ({}) } };
  const open = fakeApp();
  mount(open, { authOn: false, config: cfg, ...stubs });
  for (const p of ["/api/trading/providers/status", "/api/trading/providers/test", "/api/trading/providers/coverage"]) assert.strictEqual((await open.call(p, { start: "yes", symbol: "MSTR" })).statusCode, 503);
  const app = fakeApp();
  mount(app, { authOn: true, config: cfg, ...stubs });
  assert.strictEqual((await app.call("/api/trading/providers/status")).body.providers.stock.news.keySet, false);
  const start = await app.call("/api/trading/providers/coverage", { start: "yes" });
  assert.strictEqual(start.statusCode, 400);
  assert.match(start.body.error, /key for "finnhub" is not set/);
  assert.strictEqual((await app.call("/api/trading/providers/coverage")).body.started, false);
  const one = await app.call("/api/trading/providers/test", { symbol: "MSTR" });
  for (let i = 0; i < 100 && !one.body; i++) await new Promise((r) => setTimeout(r, 5)); // the handler answers asynchronously
  assert.strictEqual(one.body.news.code, "MissingKey");
});
