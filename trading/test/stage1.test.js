// Run with: npm test   (Node's built-in test runner — no network, no keys)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createClient, EtoroError, assertAllowedPath } = require("../etoro-client");
const { summarizeDemoAccount, AccountDataError } = require("../account");
const { readConfig } = require("../config");
const { mount } = require("../index");

const config = { baseUrl: "https://public-api.etoro.com", apiKey: "PUBKEY-123", userKey: "USERKEY-456", hasKeys: true, tradingEnabled: false };

function fakeFetch(status, body, headers = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n) => headers[n] ?? null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { impl, calls };
}

const pnlBody = {
  clientPortfolio: {
    credit: 1000,
    positions: [
      { positionID: 1, instrumentID: 1001, mirrorID: 0, isBuy: true, amount: 200, leverage: 1, units: 1.5, openRate: 130, openDateTime: "2026-11-01T10:00:00Z", unrealizedPnL: { pnL: 50 } },
      { positionID: 2, instrumentID: 100000, mirrorID: 0, isBuy: true, amount: 100, leverage: 1, units: 0.001, openRate: 90000, openDateTime: "2026-11-02T10:00:00Z", unrealizedPnL: { pnL: -20 } },
    ],
    ordersForOpen: [{ mirrorID: 0, amount: 200 }, { mirrorID: 0, amount: 200 }, { mirrorID: 7, amount: 100 }],
    orders: [{ amount: 150 }],
    mirrors: [],
  },
};

test("sends GET with the three documented headers and a fresh UUID each time", async () => {
  const f = fakeFetch(200, pnlBody, { "RateLimit-Remaining": "59" });
  const client = createClient({ config, fetchImpl: f.impl });
  const a = await client.getDemoPnl();
  await client.getDemoPnl();
  const { url, opts } = f.calls[0];
  assert.strictEqual(url, "https://public-api.etoro.com/api/v1/trading/info/demo/pnl");
  assert.strictEqual(opts.method, "GET");
  assert.strictEqual(opts.headers["x-api-key"], "PUBKEY-123");
  assert.strictEqual(opts.headers["x-user-key"], "USERKEY-456");
  assert.match(opts.headers["x-request-id"], /^[0-9a-f-]{36}$/);
  assert.notStrictEqual(opts.headers["x-request-id"], f.calls[1].opts.headers["x-request-id"]);
  assert.strictEqual(opts.body, undefined);
  assert.strictEqual(a.rateLimit.remaining, 59);
  assert.match(a.source, /demo\/pnl/);
  assert.ok(!Number.isNaN(Date.parse(a.fetchedAt)));
});

test("path guard refuses live-account, order-placing and unknown paths", () => {
  for (const p of [
    "/api/v1/trading/info/real/pnl",
    "/api/v1/trading/info/pnl",
    "/api/v2/trading/execution/orders",
    "/api/v2/trading/execution/demo/orders",
    "/api/v3/trading/execution/demo/orders",
    "/api/v2/trading/info/orders:lookup",
    "/api/v1/balances",
    "/api/v1/me",
    "/api/v1/trading/info/demo/pnl/../../real/pnl",
    "",
    null,
  ]) {
    assert.throws(() => assertAllowedPath(p), EtoroError, String(p));
  }
  assert.doesNotThrow(() => assertAllowedPath("/api/v1/trading/info/demo/pnl"));
  assert.doesNotThrow(() => assertAllowedPath("/api/v1/market-data/instruments/1001/history/candles/desc/OneDay/5"));
});

test("the trading module contains no order-placing or live-account code", () => {
  const dir = path.join(__dirname, "..");
  for (const file of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(!/method:\s*["'`](POST|PUT|PATCH|DELETE)/i.test(src), `${file}: non-GET request`);
    assert.ok(!src.includes("/real/"), `${file}: live-account path`);
    assert.ok(!src.includes("/trading/execution"), `${file}: execution path`);
  }
});

test("nothing is sent when keys are missing", async () => {
  const f = fakeFetch(200, pnlBody);
  const client = createClient({ config: { ...config, apiKey: "", hasKeys: false }, fetchImpl: f.impl });
  await assert.rejects(client.getDemoPnl(), (e) => e.code === "MissingKeys");
  assert.strictEqual(f.calls.length, 0);
});

test("HTTP errors throw, carry eToro's code, and never leak the keys", async () => {
  const f = fakeFetch(401, { errorCode: "Unauthorized", errorMessage: "bad key USERKEY-456" });
  const client = createClient({ config, fetchImpl: f.impl });
  await assert.rejects(client.getDemoPnl(), (e) => e.status === 401 && e.code === "Unauthorized" && !e.message.includes("USERKEY-456"));
});

test("429 throws with Retry-After", async () => {
  const f = fakeFetch(429, "", { "Retry-After": "60" });
  const client = createClient({ config, fetchImpl: f.impl });
  await assert.rejects(client.getDemoPnl(), (e) => e.code === "RateLimited" && e.retryAfterSec === 60);
});

test("a non-JSON 200 is an error, not empty data", async () => {
  const client = createClient({ config, fetchImpl: fakeFetch(200, "<html>").impl });
  await assert.rejects(client.getDemoPnl(), (e) => e.code === "BadResponse");
});

test("input validation: symbols, ids, candles, order lookup", async () => {
  const f = fakeFetch(200, {});
  const client = createClient({ config, fetchImpl: f.impl });
  assert.throws(() => client.searchInstruments("AAPL/../x"), EtoroError);
  assert.throws(() => client.getRates(["1; drop"]), EtoroError);
  assert.throws(() => client.getCandles(1001, { count: 1001 }), EtoroError);
  assert.throws(() => client.getCandles(1001, { interval: "TwoDays" }), EtoroError);
  assert.throws(() => client.getDemoOrder({}), EtoroError);
  assert.throws(() => client.getDemoOrder({ orderId: 1, referenceId: "x" }), EtoroError);
  assert.strictEqual(f.calls.length, 0);
  await client.getRates([1001, 100000]);
  await client.getDemoOrder({ orderId: 13902598 });
  await client.searchInstruments("btc");
  assert.match(f.calls[0].url, /\/api\/v2\/market-data\/rates\?instrumentIds=1001%2C100000$/);
  assert.match(f.calls[1].url, /\/api\/v2\/trading\/info\/demo\/orders:lookup\?orderId=13902598$/);
  assert.match(f.calls[2].url, /internalSymbolFull=BTC&fields=/);
});

test("account summary follows eToro's published formulas", () => {
  const s = summarizeDemoAccount({ data: pnlBody, source: "src", fetchedAt: "2026-11-12T00:00:00.000Z" });
  assert.strictEqual(s.creditUsd, 1000);
  assert.strictEqual(s.pendingOrdersUsd, 550);    // 200 + 200 + 150; the mirrored 100 is excluded
  assert.strictEqual(s.availableCashUsd, 450);    // eToro's own worked example
  assert.strictEqual(s.unrealizedPnlUsd, 30);
  assert.strictEqual(s.investedUsd, 300);
  assert.strictEqual(s.openPositions, 2);
  assert.strictEqual(s.source, "src");
  assert.strictEqual(s.fetchedAt, "2026-11-12T00:00:00.000Z");
});

test("account summary fails closed on missing or malformed figures", () => {
  const broken = (edit) => { const b = JSON.parse(JSON.stringify(pnlBody)); edit(b.clientPortfolio); return { data: b }; };
  assert.throws(() => summarizeDemoAccount({ data: {} }), AccountDataError);
  assert.throws(() => summarizeDemoAccount(broken((p) => { delete p.credit; })), AccountDataError);
  assert.throws(() => summarizeDemoAccount(broken((p) => { p.credit = "1000"; })), AccountDataError);
  assert.throws(() => summarizeDemoAccount(broken((p) => { delete p.positions; })), AccountDataError);
  assert.throws(() => summarizeDemoAccount(broken((p) => { delete p.positions[0].unrealizedPnL; })), AccountDataError);
  assert.throws(() => summarizeDemoAccount(broken((p) => { p.orders[0].amount = null; })), AccountDataError);
});

test("kill switch: only the exact string \"true\" enables trading", () => {
  for (const v of [undefined, "", "false", "TRUE", "True", "1", "yes", " true"]) {
    assert.strictEqual(readConfig({ TRADING_ENABLED: v }).tradingEnabled, false, String(v));
  }
  assert.strictEqual(readConfig({ TRADING_ENABLED: "true" }).tradingEnabled, true);
});

// --- routes -----------------------------------------------------------------
function fakeApp() {
  const routes = {};
  return { routes, get: (p, ...handlers) => { routes[p] = handlers; } };
}
async function call(app, p, query = {}) {
  const res = { statusCode: 200, body: null, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const handlers = app.routes[p];
  let i = 0;
  const next = async () => { const h = handlers[i++]; if (h) await h({ query }, res, next); };
  await next();
  return res;
}

test("routes are closed when the console login is off or keys are missing", async () => {
  const f = fakeFetch(200, pnlBody);
  const client = createClient({ config, fetchImpl: f.impl });
  const open = fakeApp(); mount(open, { authOn: false, config, client });
  assert.strictEqual((await call(open, "/api/trading/test/demo-account")).statusCode, 503);
  const noKeys = fakeApp(); mount(noKeys, { authOn: true, config: { ...config, hasKeys: false }, client });
  assert.strictEqual((await call(noKeys, "/api/trading/test/demo-account")).statusCode, 503);
  assert.strictEqual(f.calls.length, 0);
});

test("demo-account route returns the summary; errors become 502 without data", async () => {
  const ok = fakeApp(); mount(ok, { authOn: true, config, client: createClient({ config, fetchImpl: fakeFetch(200, pnlBody).impl }) });
  const r = await call(ok, "/api/trading/test/demo-account");
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.environment, "demo");
  assert.strictEqual(r.body.account.availableCashUsd, 450);
  assert.strictEqual(r.body.raw, undefined);
  assert.strictEqual(r.headers["Cache-Control"], "no-store");

  const bad = fakeApp(); mount(bad, { authOn: true, config, client: createClient({ config, fetchImpl: fakeFetch(401, { errorCode: "Unauthorized" }).impl }) });
  const e = await call(bad, "/api/trading/test/demo-account");
  assert.strictEqual(e.statusCode, 502);
  assert.strictEqual(e.body.ok, false);
  assert.strictEqual(e.body.account, undefined);
  assert.strictEqual(e.body.etoroStatus, 401);
});

test("every mounted route is a read-only GET under /api/trading/", () => {
  const app = fakeApp();
  for (const m of ["post", "put", "patch", "delete", "use"]) app[m] = () => { throw new Error(`trading mounted a ${m} route`); };
  mount(app, { authOn: true, config, client: createClient({ config, fetchImpl: fakeFetch(200, {}).impl }) });
  assert.ok(Object.keys(app.routes).length >= 1);
  for (const p of Object.keys(app.routes)) assert.ok(p.startsWith("/api/trading/"), p);
});
