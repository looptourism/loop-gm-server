// ---------------------------------------------------------------------------
// Trading Desk — HTTP routes.
//   /api/trading/test/…   read-only checks against eToro DEMO (Stage 1 + 2)
//   /api/trading/admin/…  the Trading Desk's own database (Stage 2)
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
const { createDb, DbError } = require("./db");
const { seedAllowlist } = require("./allowlist");
const { verifyAllowlist } = require("./verify-allowlist");
const { syncAllowlist, readAllowlists } = require("./db/store");

function mount(app, { authOn, config = readConfig(), client = createClient({ config }), db = createDb({ config }) } = {}) {
  // Every Trading Desk route: never cached, and closed when the console
  // login is off.
  const loginGuard = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!authOn) return res.status(503).json({ ok: false, error: "Trading Desk is closed: CONSOLE_PASSWORD is not set on the server" });
    next();
  };
  const guard = (req, res, next) => loginGuard(req, res, () => {
    if (!config.hasKeys) return res.status(503).json({ ok: false, error: "ETORO_API_KEY / ETORO_USER_KEY are not set on the server" });
    next();
  });
  const dbGuard = (req, res, next) => loginGuard(req, res, () => {
    if (!db.configured) return res.status(503).json({ ok: false, error: "TRADING_DATABASE_URL is not set on the server" });
    next();
  });

  const fail = (res, e) => {
    const known = e instanceof EtoroError || e instanceof AccountDataError || e instanceof DbError;
    if (!known) console.error("[trading] unexpected error:", db.redact(client.redact(e?.message)));
    const refused = ["BadInput", "ConfirmMismatch", "NothingPending", "MigrationProblem"].includes(e?.code) && known;
    res.status(refused ? 400 : 502).json({
      ok: false,
      error: known ? e.message : "unexpected error",
      code: e?.code || null,
      etoroStatus: e?.status ?? null,
      retryAfterSec: e?.retryAfterSec ?? null,
    });
  };

  const status = () => ({ environment: "demo", tradingEnabled: config.tradingEnabled, orderPlacement: "not implemented (read-only so far)" });

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

  // --- Stage 2: the two endpoints Stage 1 could only check on paper --------

  // eToro's untouched answer from GET /api/v1/trading/info/demo/portfolio.
  app.get("/api/trading/test/demo-portfolio", guard, async (req, res) => {
    try {
      const r = await client.getDemoPortfolio();
      const p = r.data?.clientPortfolio;
      const count = (v) => (Array.isArray(v) ? v.length : null); // null = the field is not in the response
      res.json({
        ok: true, ...status(),
        topLevelKeys: Object.keys(r.data),
        portfolioKeys: p && typeof p === "object" ? Object.keys(p) : null,
        counts: p ? { positions: count(p.positions), ordersForOpen: count(p.ordersForOpen), orders: count(p.orders), mirrors: count(p.mirrors) } : null,
        raw: r.data, source: r.source, fetchedAt: r.fetchedAt, httpStatus: r.status, rateLimit: r.rateLimit,
      });
    } catch (e) { fail(res, e); }
  });

  // eToro's untouched answer from GET /api/v2/market-data/instruments.
  // ?ids=1001,100000 (those two are AAPL and BTC, confirmed in Stage 1).
  app.get("/api/trading/test/instrument", guard, async (req, res) => {
    try {
      const ids = String(req.query.ids || req.query.id || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!ids.length) throw new EtoroError("pass ?ids=1001,100000", { code: "BadInput" });
      const r = await client.getInstruments(ids);
      res.json({ ok: true, ...status(), requestedIds: ids.map(Number), topLevelKeys: Object.keys(r.data), raw: r.data, source: r.source, fetchedAt: r.fetchedAt, httpStatus: r.status, rateLimit: r.rateLimit });
    } catch (e) { fail(res, e); }
  });

  // Searches eToro for every symbol on both allowlists. Read-only: nothing
  // is saved. One search per symbol, so it takes a few seconds.
  app.get("/api/trading/test/verify-allowlist", guard, async (req, res) => {
    try {
      const v = await verifyAllowlist(client, seedAllowlist());
      res.json({ ok: true, ...status(), ...v, results: v.results.map(({ raw, ...rest }) => rest) });
    } catch (e) { fail(res, e); }
  });

  // --- Stage 2: the Trading Desk database ----------------------------------

  // Connection check, applied / pending migrations, row counts. Read-only.
  app.get("/api/trading/admin/db-status", loginGuard, async (req, res) => {
    const s = await db.status();
    res.status(s.connected ? 200 : 503).json({ ok: s.connected, ...s });
  });

  // Applies ONE migration, and only when it is named: ?confirm=001_initial
  app.get("/api/trading/admin/migrate", dbGuard, async (req, res) => {
    try {
      const out = await db.migrate(String(req.query.confirm || ""));
      console.log(`[trading/db] migration applied: ${out.applied}`);
      res.json({ ok: true, ...out, next: "open /api/trading/admin/db-status to see the tables" });
    } catch (e) { fail(res, e); }
  });

  // Verifies both allowlists on eToro and writes the result to the database
  // in one transaction. Needs ?confirm=yes; without it nothing is written.
  app.get("/api/trading/admin/sync-allowlist", dbGuard, guard, async (req, res) => {
    try {
      if (req.query.confirm !== "yes") throw new EtoroError("nothing was written: add ?confirm=yes", { code: "BadInput" });
      const v = await verifyAllowlist(client, seedAllowlist());
      const saved = await syncAllowlist(db, v, { actor: "owner:console" });
      res.json({ ok: true, ...status(), verified: v.verified, total: v.total, problems: v.problems, saved });
    } catch (e) { fail(res, e); }
  });

  // The allowlists as stored in the database.
  app.get("/api/trading/admin/allowlist", dbGuard, async (req, res) => {
    try { res.json({ ok: true, ...(await readAllowlists(db)) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
