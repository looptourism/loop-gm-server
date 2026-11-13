// ---------------------------------------------------------------------------
// Trading Desk — HTTP routes. Stage 1: read-only checks against eToro DEMO.
//
// This is the module's only connection to the rest of the server: server.js
// calls mount(app, …) once. Nothing here is exposed to the GM, the
// department agents or the secretary, and nothing here can place an order.
//
// The routes sit under /api/, so the console login already covers them.
// They also refuse to run when the login is switched off (no
// CONSOLE_PASSWORD) — an open server must never expose account data.
// ---------------------------------------------------------------------------
const { readConfig } = require("./config");
const { createClient, EtoroError, CANDLE_INTERVALS } = require("./etoro-client");
const { summarizeDemoAccount, AccountDataError } = require("./account");

function mount(app, { authOn, config = readConfig(), client = createClient({ config }) } = {}) {
  const guard = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!authOn) return res.status(503).json({ ok: false, error: "Trading Desk is closed: CONSOLE_PASSWORD is not set on the server" });
    if (!config.hasKeys) return res.status(503).json({ ok: false, error: "ETORO_API_KEY / ETORO_USER_KEY are not set on the server" });
    next();
  };

  const fail = (res, e) => {
    const known = e instanceof EtoroError || e instanceof AccountDataError;
    if (!known) console.error("[trading] unexpected error:", client.redact(e?.message));
    res.status(e instanceof EtoroError && e.code === "BadInput" ? 400 : 502).json({
      ok: false,
      error: known ? e.message : "unexpected error",
      code: e?.code || null,
      etoroStatus: e?.status ?? null,
      retryAfterSec: e?.retryAfterSec ?? null,
    });
  };

  const status = () => ({ environment: "demo", tradingEnabled: config.tradingEnabled, orderPlacement: "not implemented (Stage 1 is read-only)" });

  // Demo balance + portfolio. Add ?raw=1 to see eToro's untouched response.
  app.get("/api/trading/test/demo-account", guard, async (req, res) => {
    try {
      const pnl = await client.getDemoPnl();
      const out = { ok: true, ...status(), account: summarizeDemoAccount(pnl), rateLimit: pnl.rateLimit };
      if (req.query.raw === "1") out.raw = pnl.data;
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // Instrument search + current rate + recent candles for one ticker,
  // e.g. ?symbol=AAPL or ?symbol=BTC&interval=OneHour&count=5
  app.get("/api/trading/test/market-data", guard, async (req, res) => {
    try {
      const symbol = String(req.query.symbol || "").trim().toUpperCase();
      const interval = String(req.query.interval || "OneDay");
      const count = Math.min(Number(req.query.count) || 5, 50);
      if (!CANDLE_INTERVALS.has(interval)) throw new EtoroError("invalid interval", { code: "BadInput" });

      const search = await client.searchInstruments(symbol);
      const items = Array.isArray(search.data.items) ? search.data.items : [];
      const match = items.find((i) => i.internalSymbolFull === symbol);
      if (!match) {
        return res.status(404).json({ ok: false, error: `no exact match for ${symbol} on eToro`, candidates: items.map((i) => i.internalSymbolFull), source: search.source, fetchedAt: search.fetchedAt });
      }
      const [rates, candles] = await Promise.all([
        client.getRates([match.instrumentId]),
        client.getCandles(match.instrumentId, { interval, count }),
      ]);
      res.json({
        ok: true,
        ...status(),
        instrument: { data: match, source: search.source, fetchedAt: search.fetchedAt },
        rate: { data: (rates.data.results || [])[0] || null, source: rates.source, fetchedAt: rates.fetchedAt },
        candles: { data: candles.data, source: candles.source, fetchedAt: candles.fetchedAt },
        rateLimit: candles.rateLimit,
      });
    } catch (e) { fail(res, e); }
  });

  // Status of a demo order: ?orderId=123 or ?referenceId=<uuid>
  app.get("/api/trading/test/order-status", guard, async (req, res) => {
    try {
      const { orderId, referenceId } = req.query;
      const r = await client.getDemoOrder({ orderId: orderId || undefined, referenceId: referenceId || undefined });
      res.json({ ok: true, ...status(), order: r.data, source: r.source, fetchedAt: r.fetchedAt });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
