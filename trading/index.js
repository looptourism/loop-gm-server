// ---------------------------------------------------------------------------
// Trading Desk — HTTP routes.
//   /api/trading/test/…   read-only checks against eToro DEMO (Stage 1 + 2)
//   /api/trading/admin/…  the Trading Desk's own database (Stage 2)
//   /api/trading/monitor/… Market Monitoring: status, run now, stored data (Stage 3)
//   /api/trading/providers/… news / fundamentals providers: status and coverage test
//   /api/trading/research/… scheduled collection of provider data: status, run now, stored data
//   /api/trading/agents/…  the four Claude agents: status, run, latest analysis, draft proposals (Stage 4)
//
// This is the module's only connection to the rest of the server: server.js
// calls mount(app, …) once. Nothing here is exposed to the GM, the
// department agents or the secretary, and nothing here can place an order.
//
// The routes sit under /api/, so the console login already covers them.
// They also refuse to run when the login is switched off (no
// CONSOLE_PASSWORD) — an open server must never expose account data.
// ---------------------------------------------------------------------------
const { readConfig, MONITORING } = require("./config");
const { createClient, EtoroError, CANDLE_INTERVALS } = require("./etoro-client");
const { summarizeDemoAccount, AccountDataError } = require("./account");
const { createDb, DbError } = require("./db");
const { seedAllowlist } = require("./allowlist");
const { verifyAllowlist, classify } = require("./verify-allowlist");
const { syncAllowlist, readAllowlists, addAllowlistSymbol, removeAllowlistSymbol, recordAllowlistRejection, currentAllowlistEntries, AllowlistError } = require("./db/store");
const { createAdmin } = require("./admin");
const { createMonitor } = require("./monitor");
const snapshots = require("./db/snapshots");
const { createProviders, ProviderError } = require("./providers");
const { createCoverage } = require("./providers/coverage");
const { createResearch } = require("./research");
const researchStore = require("./db/research");
const { createAgents } = require("./agents/pipeline");
const analysesStore = require("./db/analyses");
const { POLICY } = require("./policy");
const { AGENTS } = require("./config");
const notify = require("./notify");
const { createPositionMonitor } = require("./positions");
const { buildDesk } = require("./desk/data");
const path = require("path");
const DESK_PAGE = path.join(__dirname, "desk", "desk.html");
const { createOrderClient } = require("./execution/etoro-orders");
const { createGateway } = require("./execution/gateway");
const { createApprovals, readQuietHours } = require("./approvals");
const e2e = require("./e2e");
const { createWatchKeeper } = require("./watches");
const report = require("./report");
const { readHalted } = require("./risk/context");
const { appendAudit } = require("./db/store");
const { listMonitored } = require("./db/snapshots");
const { rateFreshness } = require("./market-data");

const STARTED_AT = new Date().toISOString(); // when this server process started

function mount(app, { authOn, config = readConfig(), client = createClient({ config }), db = createDb({ config }), monitor = createMonitor({ config, client, db }), providers = createProviders({ config }),
  research = createResearch({ config, providers, db }), telegram = null, notifier = notify.createNotifier({ telegram }),
  hooks = {}, agents = createAgents({ config, db, client, onFinished: (result) => hooks.afterRun(result) }),
  positions = createPositionMonitor({ config, client, db, notifier }),
  orders = createOrderClient({ config }),
  gateway = createGateway({ config, db, client, orders, onOutcome: (outcome) => notifier.send(notify.executionResult(outcome)) }),
  approvals = createApprovals({ config, db, client, gateway, notifier }),
  watches = createWatchKeeper({ config, db, agents, notifier }),
  reporter = report.createReporter({ config, db, notifier, agents }), retryMs = 5 * 60 * 1000,
  admin = createAdmin({ password: config.adminPassword }) } = {}) {
  // After every agent run: the summary first, then any new draft goes to the
  // risk engine at once (and, if it passes and trading is on, to the owner).
  hooks.afterRun = async (result) => {
    await notifier.send(notify.runSummary(result));
    if (result.proposals?.length && typeof approvals.tick === "function") await approvals.tick();
  };
  // ---- database readiness --------------------------------------------------
  // Pending migrations are applied here, at startup, before anything that
  // uses the database is allowed to run. If that fails, the Trading Desk
  // stays off — schedules are not started and database routes answer 503 —
  // and it tries again every few minutes. The rest of the server is not
  // affected.
  const dbState = { state: !db.configured ? "not_configured" : typeof db.migrateAll === "function" ? "starting" : "ok", applied: [], error: null, attempts: 0, checkedAt: null };
  let schedulesStarted = false;
  const startSchedules = () => {
    if (schedulesStarted) return;
    schedulesStarted = true;
    monitor.start();   // each does nothing unless its own switch is exactly "true"
    research.start();
    if (typeof agents.start === "function") agents.start();
    if (typeof positions.start === "function") positions.start();
    if (typeof watches.start === "function") watches.start();
    if (typeof reporter.start === "function") reporter.start();
    if (typeof approvals.start === "function") approvals.start(); // every minute: expire, offer for approval, settle orders
  };
  async function prepareDatabase() {
    dbState.attempts++;
    dbState.checkedAt = new Date().toISOString();
    try {
      const out = await db.migrateAll({ onApplied: (name) => console.log(`[trading/db] migration applied at startup: ${name}`) });
      const recovered = dbState.state === "failed";
      Object.assign(dbState, { state: "ok", error: null });
      dbState.applied.push(...out.applied);
      console.log(`[trading/db] database ready (${out.applied.length ? `applied: ${out.applied.join(", ")}` : "nothing to apply"})`);
      if (out.applied.length) notifier.send(`🗄 <b>Trading Desk database updated</b>\nApplied automatically at startup: ${out.applied.map(notify.esc).join(", ")}`);
      else if (recovered) notifier.send("✅ <b>Trading Desk database is reachable again</b> — the desk is back on.");
      startSchedules();
    } catch (e) {
      const message = db.redact(e?.message || String(e));
      const first = dbState.state !== "failed" || dbState.error !== message;
      Object.assign(dbState, { state: "failed", error: message });
      console.error(`[trading/db] database not ready (attempt ${dbState.attempts}): ${message}`);
      if (first) notifier.send(`⛔ <b>Trading Desk is off: its database could not be prepared</b>\n${notify.esc(message.slice(0, 300))}\nNo monitoring, research or agent run will start. It retries every ${Math.round(retryMs / 60000)} minutes.`);
      const t = setTimeout(prepareDatabase, retryMs);
      if (typeof t.unref === "function") t.unref();
    }
  }

  // One coverage test per asset class, over the lists as they are now (the
  // database once it has them, so symbols added on the page are covered too).
  const liveSymbols = (assetClass) => async () => {
    const seed = () => seedAllowlist().filter((s) => s.assetClass === assetClass).map((s) => s.symbol);
    if (!db.configured || dbState.state !== "ok") return seed();
    try { return (await currentAllowlistEntries(db, seedAllowlist)).filter((s) => s.assetClass === assetClass).map((s) => s.symbol); } catch { return seed(); }
  };
  const coverage = Object.fromEntries(["stock", "crypto"].map((assetClass) => [assetClass,
    createCoverage({ providers, assetClass, symbols: liveSymbols(assetClass) })]));
  const classOf = (req) => (req.query.class === "crypto" ? "crypto" : "stock");
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
    if (dbState.state === "starting") return res.status(503).json({ ok: false, error: "the Trading Desk database is being prepared; try again in a moment" });
    if (dbState.state === "failed") return res.status(503).json({ ok: false, error: `the Trading Desk is off: its database could not be prepared (${dbState.error})`, retrying: true });
    next();
  });

  const fail = (res, e) => {
    const known = e instanceof EtoroError || e instanceof AccountDataError || e instanceof DbError || e instanceof ProviderError;
    if (!known) console.error("[trading] unexpected error:", providers.redact(db.redact(client.redact(e?.message))));
    const refused = ["BadInput", "ConfirmMismatch", "NothingPending", "MigrationProblem", "MissingKey", "NotConfigured"].includes(e?.code) && known;
    res.status(refused ? 400 : 502).json({
      ok: false,
      error: known ? e.message : "unexpected error",
      code: e?.code || null,
      etoroStatus: e?.status ?? null,
      retryAfterSec: e?.retryAfterSec ?? null,
    });
  };

  const status = () => ({ environment: "demo", tradingEnabled: config.tradingEnabled, orderPlacement: config.tradingEnabled ? "DEMO orders only, each one after your approval" : "off — TRADING_ENABLED is not \"true\"" });

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

  // Searches eToro for every symbol on both allowlists (as stored in the
  // database; the seed until the database has any). Read-only: nothing is
  // saved. One search per symbol, so it takes a few seconds.
  app.get("/api/trading/test/verify-allowlist", guard, async (req, res) => {
    try {
      const entries = db.configured && dbState.state === "ok" ? await currentAllowlistEntries(db, seedAllowlist) : seedAllowlist();
      const v = await verifyAllowlist(client, entries);
      res.json({ ok: true, ...status(), ...v, results: v.results.map(({ raw, ...rest }) => rest) });
    } catch (e) { fail(res, e); }
  });

  // --- Stage 2: the Trading Desk database ----------------------------------

  // Connection check, applied / pending migrations, row counts. Read-only.
  app.get("/api/trading/admin/db-status", loginGuard, async (req, res) => {
    const s = await db.status();
    res.status(s.connected ? 200 : 503).json({ ok: s.connected, startup: dbState, ...s });
  });

  // Applies ONE migration, and only when it is named: ?confirm=001_initial
  app.get("/api/trading/admin/migrate", dbGuard, async (req, res) => {
    try {
      const out = await db.migrate(String(req.query.confirm || ""));
      console.log(`[trading/db] migration applied: ${out.applied}`);
      res.json({ ok: true, ...out, next: "open /api/trading/admin/db-status to see the tables" });
    } catch (e) { fail(res, e); }
  });

  // Re-verifies both allowlists on eToro and writes the result in one
  // transaction. Needs ?confirm=yes; without it nothing is written. It works
  // on the lists as stored (the seed only while the database has none), so a
  // sync never brings back a symbol removed on the page or drops one added there.
  app.get("/api/trading/admin/sync-allowlist", dbGuard, guard, async (req, res) => {
    try {
      if (req.query.confirm !== "yes") throw new EtoroError("nothing was written: add ?confirm=yes", { code: "BadInput" });
      const v = await verifyAllowlist(client, await currentAllowlistEntries(db, seedAllowlist));
      const saved = await syncAllowlist(db, v, { actor: "owner:console" });
      res.json({ ok: true, ...status(), verified: v.verified, total: v.total, problems: v.problems, saved });
    } catch (e) { fail(res, e); }
  });

  // The allowlists as stored in the database.
  app.get("/api/trading/admin/allowlist", dbGuard, async (req, res) => {
    try { res.json({ ok: true, ...(await readAllowlists(db)) }); } catch (e) { fail(res, e); }
  });

  // --- Stage 3: Market Monitoring ------------------------------------------

  // Is the schedule on, what is running, the last runs, and what is stored
  // per instrument (with each rate's age by eToro's own timestamp). Read-only.
  app.get("/api/trading/monitor/status", dbGuard, async (req, res) => {
    try {
      const [runs, stored] = await Promise.all([
        snapshots.recentRuns(db, 12),
        snapshots.coverage(db, { now: new Date(), rateFreshSec: MONITORING.rateFreshSec }),
      ]);
      res.json({ ok: true, ...status(), monitor: monitor.state(), settings: { rateFreshSec: MONITORING.rateFreshSec, candles: MONITORING.candles }, recentRuns: runs, stored });
    } catch (e) { fail(res, e); }
  });

  // Collects once, now — also while the schedule is off. Needs ?confirm=yes.
  // Add &candles=all to collect every candle interval even if it is not due.
  // It answers at once and works in the background (the first run takes a
  // few minutes); follow it on /api/trading/monitor/status.
  app.get("/api/trading/monitor/run", dbGuard, guard, (req, res) => {
    if (req.query.confirm !== "yes") return fail(res, new EtoroError("nothing was started: add ?confirm=yes", { code: "BadInput" }));
    const busy = monitor.state().running;
    if (busy) return res.status(409).json({ ok: false, error: "a run is already in progress", running: busy });
    monitor.tick("manual", { allCandles: req.query.candles === "all" });
    res.json({ ok: true, ...status(), started: true, next: "open /api/trading/monitor/status in a minute or two" });
  });

  // Exactly what an agent will be given for one instrument: stored snapshots
  // only, each with source and timestamp. ?symbol=BTC
  app.get("/api/trading/monitor/view", dbGuard, async (req, res) => {
    try {
      const view = await snapshots.readMarketView(db, req.query.symbol, { now: new Date(), rateFreshSec: MONITORING.rateFreshSec });
      res.status(view.ok ? 200 : 404).json(view);
    } catch (e) { fail(res, e); }
  });

  // --- News / fundamentals providers (chosen: Option A) --------------------
  // Read-only checks. Nothing is stored and no agent uses this yet.

  // Which provider is configured for what, and whether its key is set. No network.
  app.get("/api/trading/providers/status", loginGuard, (req, res) => {
    res.json({ ok: true, ...status(), providers: providers.status() });
  });

  // One instrument, every capability configured for its class, with the
  // provider's raw answers: ?symbol=MSTR  or  ?symbol=BTC&class=crypto
  // For crypto it also fetches the general crypto headlines.
  app.get("/api/trading/providers/test", loginGuard, async (req, res) => {
    try {
      const symbol = String(req.query.symbol || "").trim().toUpperCase();
      if (!symbol) throw new ProviderError("pass ?symbol=MSTR (or ?symbol=BTC&class=crypto)", { code: "BadInput" });
      const assetClass = classOf(req);
      const out = {};
      const attempt = async (c, fn) => {
        try { out[c] = await fn(); }
        catch (e) { if (!(e instanceof ProviderError)) throw e; out[c] = { verdict: "error", note: e.message, code: e.code }; }
      };
      for (const c of providers.capabilitiesFor(assetClass)) await attempt(c, () => coverage[assetClass].checkOne(symbol, c, { keepRaw: true }));
      for (const c of providers.capabilitiesFor(assetClass, { perClass: true })) {
        await attempt(c, async () => {
          const r = await providers.call(assetClass, c, assetClass);
          return { provider: r.provider, articles: r.data.length, latest: r.data[0]?.publishedAt || null, firstThree: r.data.slice(0, 3).map(({ raw, ...n }) => n), source: r.source, fetchedAt: r.fetchedAt, note: "general headlines, not per instrument" };
        });
      }
      res.json({ ok: true, symbol, assetClass, ...out });
    } catch (e) { fail(res, e); }
  });

  // Side by side for a few stocks: what the SEC has (filings by kind) and what
  // Finnhub has (fundamentals, quarterly earnings) — to see whether one fills
  // the other's gaps. ?symbols=BABA,NVO,GRAB,SE  (5 calls per symbol, no raw data)
  app.get("/api/trading/providers/compare", loginGuard, async (req, res) => {
    try {
      const symbols = String(req.query.symbols || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
      if (!symbols.length || symbols.length > 6) throw new ProviderError("pass ?symbols=BABA,NVO,GRAB,SE (1 to 6 symbols)", { code: "BadInput" });
      const results = [];
      for (const symbol of symbols) {
        const row = { symbol };
        for (const c of ["filings", "fundamentals", "earnings"]) {
          try { row[c] = await coverage.stock.checkOne(symbol, c); }
          catch (e) { if (!(e instanceof ProviderError)) throw e; row[c] = { verdict: "error", note: e.message, code: e.code }; }
        }
        const quarterlyAtSec = row.filings.quarterlyReports > 0;
        const quarterlyElsewhere = row.earnings.pastQuartersWithActual > 0 && row.fundamentals.verdict !== "gap" && row.fundamentals.verdict !== "error";
        row.summary = row.filings.verdict === "error" || row.earnings.verdict === "error" ? "could not be checked — see the errors"
          : quarterlyAtSec ? "the SEC has quarterly reports for this company"
          : quarterlyElsewhere ? `the SEC has no quarterly reports; ${row.earnings.provider} has ${row.earnings.pastQuartersWithActual} quarter(s) of earnings (latest ${row.earnings.latestPeriod}) and ${row.fundamentals.filled} of ${row.fundamentals.of} core figures`
          : "GAP: no quarterly reports at the SEC and no quarterly figures from the other provider";
        results.push(row);
      }
      res.json({ ok: true, results });
    } catch (e) { fail(res, e); }
  });

  // Coverage of every allowlisted stock (default) or coin (?class=crypto).
  // ?start=yes begins a run in the background; without it, shows progress / the report.
  app.get("/api/trading/providers/coverage", loginGuard, async (req, res) => {
    try {
      const cov = coverage[classOf(req)];
      if (req.query.start === "yes") {
        if (!cov.capabilities().some((c) => { try { providers.get(classOf(req), c); return true; } catch { return false; } })) {
          throw new ProviderError(`no provider for ${classOf(req)} is usable: check /api/trading/providers/status`, { code: "NotConfigured" });
        }
        await cov.run();
      }
      const r = cov.report();
      res.json({ ok: true, ...r, next: r.started ? (r.running ? "still running — reload in a minute" : "finished") : "add ?start=yes to begin" });
    } catch (e) { fail(res, e); }
  });

  // --- Research collection (stores what the providers return) --------------

  // Schedule state, the last runs, and what is stored per instrument. Read-only.
  app.get("/api/trading/research/status", dbGuard, async (req, res) => {
    try {
      const [runs, stored] = await Promise.all([
        db.query("select kind, trigger, status, started_at, finished_at, instruments, requests, rows_inserted, rows_unchanged, problems from trading.monitor_runs where kind in ('research', 'news') order by started_at desc limit 8"),
        researchStore.researchCoverage(db),
      ]);
      res.json({ ok: true, ...status(), research: research.state(), providers: providers.status(), recentRuns: runs.rows, stored });
    } catch (e) { fail(res, e); }
  });

  // Collects once, now — whatever is due; &all=yes collects everything.
  // Needs ?confirm=yes. Works in the background (a full run takes about 5 minutes).
  app.get("/api/trading/research/run", dbGuard, (req, res) => {
    if (req.query.confirm !== "yes") return fail(res, new ProviderError("nothing was started: add ?confirm=yes", { code: "BadInput" }));
    const busy = research.state().running;
    if (busy) return res.status(409).json({ ok: false, error: "a run is already in progress", running: busy });
    research.tick("manual", { all: req.query.all === "yes" });
    res.json({ ok: true, ...status(), started: true, next: "open /api/trading/research/status in a few minutes" });
  });

  // Exactly what an agent will be given for one instrument: ?symbol=MSTR
  app.get("/api/trading/research/view", dbGuard, async (req, res) => {
    try {
      const view = await researchStore.readResearchView(db, req.query.symbol);
      res.status(view.ok ? 200 : 404).json(view);
    } catch (e) { fail(res, e); }
  });

  // --- Stage 4: the agents -------------------------------------------------
  // They analyse stored data and save analyses and DRAFT proposals. Nothing
  // here can place an order, and no run starts by itself.

  // `recentRuns` comes from the database, so it survives a server restart;
  // `agents.lastResult` is this process's memory only.
  app.get("/api/trading/agents/status", loginGuard, async (req, res) => {
    let recentRuns = null, recentRunsError = null;
    if (db.configured && typeof agents.recentRuns === "function") {
      try { recentRuns = await agents.recentRuns(6); } catch (e) { recentRunsError = db.redact(e?.message); }
    }
    const budget = db.configured && agents.budget ? await agents.budget.status() : null;
    res.json({ ok: true, ...status(), serverStartedAt: STARTED_AT, agents: agents.state(), budget, recentRuns, ...(recentRunsError ? { recentRunsError } : {}), policy: POLICY });
  });

  // Starts one run. Always needs &confirm=yes, because it costs Claude API money.
  //   ?screened=yes                 the cheap model scores every instrument, the best few get the full analysis
  //   ?screened=yes&class=crypto    the same, coins only
  //   ?symbols=MSTR,BTC             full analysis of exactly these, no screen
  //   ?all=yes                      full analysis of EVERY instrument, no screen (expensive)
  // Works in the background; follow it on /agents/status.
  app.get("/api/trading/agents/run", dbGuard, (req, res) => {
    const screened = req.query.screened === "yes";
    const symbols = screened || req.query.all === "yes" ? "all" : String(req.query.symbols || req.query.symbol || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (req.query.confirm !== "yes" || (symbols !== "all" && symbols.length === 0)) return fail(res, new EtoroError("nothing was started: pass ?screened=yes&confirm=yes (or ?symbols=MSTR,BTC&confirm=yes)", { code: "BadInput" }));
    if (symbols !== "all" && symbols.length > AGENTS.maxSymbolsPerRun) return fail(res, new EtoroError(`at most ${AGENTS.maxSymbolsPerRun} symbols per run`, { code: "BadInput" }));
    const st = agents.state();
    if (!st.ready) return res.status(503).json({ ok: false, error: st.notReadyBecause });
    if (st.running) return res.status(409).json({ ok: false, error: "a run is already in progress", running: st.running });
    const options = { trigger: "manual", screened, scope: req.query.class === "crypto" ? "crypto" : "all" };
    agents.run(symbols, options);
    res.json({ ok: true, ...status(), started: true, symbols, mode: screened ? "screened" : "direct", scope: symbols === "all" ? options.scope : "named symbols", next: "open /api/trading/agents/status" });
  });

  // The newest analysis, risk review and Portfolio Manager decision for one symbol.
  app.get("/api/trading/agents/latest", dbGuard, async (req, res) => {
    try {
      const out = await analysesStore.latestForSymbol(db, req.query.symbol);
      res.status(out.ok ? 200 : 404).json(out);
    } catch (e) { fail(res, e); }
  });

  // Recent proposals with their status. Stage 4 creates drafts only.
  app.get("/api/trading/agents/proposals", dbGuard, async (req, res) => {
    try { res.json({ ok: true, ...status(), proposals: await analysesStore.listProposals(db, 20) }); } catch (e) { fail(res, e); }
  });

  // --- Position monitoring ---------------------------------------------------
  // The last check, the desk's record of positions, and the alerts sent. Read-only.
  // Add ?check=yes to run one check now.
  app.get("/api/trading/positions/status", dbGuard, async (req, res) => {
    try {
      const checkedNow = req.query.check === "yes" ? await positions.check("manual") : null;
      const [open, alerts] = await Promise.all([
        db.query("select p.etoro_position_id, i.symbol, p.amount_usd, p.open_rate, p.opened_at, p.status, p.exit_conditions, p.last_synced_at from trading.positions p join trading.instruments i using (instrument_id) order by p.status desc, p.opened_at desc nulls last limit 30"),
        db.query("select created_at, symbol, kind, condition_key, delivered from trading.position_alerts order by created_at desc limit 20"),
      ]);
      res.json({ ok: true, ...status(), monitor: positions.state(), ...(checkedNow ? { checkedNow } : {}), positions: open.rows, recentAlerts: alerts.rows });
    } catch (e) { fail(res, e); }
  });

  // --- Stage 5: risk engine, approvals, execution -------------------------------
  // What is waiting, the latest approvals and orders, and the latest verdicts
  // of the risk engine with every check. Read-only.
  app.get("/api/trading/orders/status", dbGuard, async (req, res) => {
    try {
      const [proposals, approvalRows, orderRows, verdicts] = await Promise.all([
        analysesStore.listProposals(db, 15),
        db.query("select a.id, i.symbol, a.requested_at, a.expires_at, a.decision, a.decided_at, a.channel, a.consumed_at from trading.approvals a join trading.proposals p on p.id = a.proposal_id join trading.instruments i on i.instrument_id = p.instrument_id order by a.requested_at desc limit 15"),
        db.query("select o.id, i.symbol, o.status, o.etoro_order_id, o.error, o.request, o.response, o.verification, o.created_at, o.submitted_at, o.verified_at from trading.orders o join trading.proposals p on p.id = o.proposal_id join trading.instruments i on i.instrument_id = p.instrument_id order by o.created_at desc limit 15"),
        db.query("select r.created_at, i.symbol, r.phase, r.passed, r.checks, r.engine_version from trading.risk_assessments r join trading.proposals p on p.id = r.proposal_id join trading.instruments i on i.instrument_id = p.instrument_id order by r.created_at desc limit 10"),
      ]);
      res.json({
        ok: true, ...status(), stopped: await readHalted(db), summary: await approvals.summary(),
        proposals: proposals.map(({ details, ...p }) => p), approvals: approvalRows.rows, orders: orderRows.rows,
        riskVerdicts: verdicts.rows.map((v) => ({ at: v.created_at, symbol: v.symbol, phase: v.phase, passed: v.passed, engine: v.engine_version, failed: v.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message}`), checks: req.query.all === "yes" ? v.checks : undefined })),
      });
    } catch (e) { fail(res, e); }
  });

  // --- Stage 7: the Trading Desk page in the console ------------------------
  // The page itself. The console shows it in a frame (its "التداول" tab), the
  // same way it shows the Office page; it can also be opened on its own.
  app.get("/trading-desk", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Content-Security-Policy", "frame-ancestors 'self'");
    if (!authOn) return res.status(503).type("text/plain; charset=utf-8").send("Trading Desk is closed: CONSOLE_PASSWORD is not set on the server");
    res.sendFile(DESK_PAGE);
  });

  // Everything the page shows, read-only. No call to eToro or Claude.
  app.get("/api/trading/desk", dbGuard, async (req, res) => {
    try { res.json({ ...(await buildDesk({ db, config, agents, positions, approvals, watches })), admin: admin.status(req) }); } catch (e) { fail(res, e); }
  });

  // Approve / Reject from the page. Only for a request that is already waiting;
  // it goes through the same decision and the same gateway as Telegram.
  // Requests from other sites are refused: the browser sends the custom header
  // only from this origin (the server's CORS rules do not allow it from
  // elsewhere), and the Origin header, when present, must be this server.
  const post = typeof app.post === "function" ? app.post.bind(app) : () => {};
  const fromDeskPage = (req) => {
    const origin = req.get ? req.get("Origin") : null;
    const host = req.get ? req.get("Host") : null;
    let sameHost = true;
    try { sameHost = !(origin && host && new URL(origin).host !== host); } catch { sameHost = false; }
    return (req.get && req.get("X-Trading-Desk")) === "1" && sameHost;
  };
  const refuseForeign = (req, res, next) => (fromDeskPage(req) ? next() : res.status(403).json({ ok: false, error: "refused: not sent from the Trading Desk page" }));
  post("/api/trading/desk/decide", dbGuard, async (req, res) => {
    if (!fromDeskPage(req)) return res.status(403).json({ ok: false, error: "refused: not sent from the Trading Desk page" });
    const decision = req.body?.decision;
    if (!["approve", "reject"].includes(decision)) return res.status(400).json({ ok: false, error: "decision must be approve or reject" });
    try {
      const r = await approvals.decideFromDashboard(String(req.body?.approvalId || ""), decision === "approve");
      const x = r.execution;
      const message = r.outcome === "rejected" ? "رُفض. لم يُرسل أي أمر."
        : r.outcome === "approved" ? (!x ? "اعتُمد." : x.status === "filled" ? "اعتُمد ونُفّذ الأمر على الحساب التجريبي." : x.status === "closed" ? "اعتُمد وأُغلق المركز." : x.status === "submitted" ? "اعتُمد وقبله eToro، ولم يُنفَّذ بعد." : x.status === "unknown" ? "اعتُمد، لكن نتيجة الأمر غير معروفة بعد. سيُتحقق منها ولن يُرسل مرة ثانية." : x.status === "rejected" ? `اعتُمد، لكن eToro رفضه: ${x.reason}` : `اعتُمد، لكن لم يُرسل أي أمر: ${x.reason}`)
        : r.outcome === "expired" ? "انتهت صلاحية الطلب. لم يُرسل أي أمر."
        : r.outcome === "already_decided" ? "سبق البتّ في هذا الطلب. لم يتغيّر شيء."
        : r.outcome === "mismatch" ? "الطلب لا يطابق معطيات المقترح، فلم يُنفَّذ شيء. يلزم مقترح جديد."
        : r.outcome === "not_pending" ? "المقترح لم يعد بانتظار قرار. لم يُنفَّذ شيء."
        : r.outcome === "unknown" ? "هذا الطلب غير موجود في السجل. لم يُنفَّذ شيء."
        : r.outcome === "error" ? "تعذّر تسجيل القرار، فلم يُنفَّذ شيء."
        : r.message;
      res.json({ ok: r.outcome === "approved" || r.outcome === "rejected", outcome: r.outcome, execution: x ? { status: x.status, reason: x.reason ?? null } : null, message });
    } catch (e) { fail(res, e); }
  });

  // --- Editing the allowlists (admin only) -----------------------------------
  // The console login shows the desk; changing a list also needs an admin
  // session (TRADING_ADMIN_PASSWORD, 15 minutes, see admin.js). Every add,
  // refused add and removal is written to the audit log.
  const ADMIN_ACTOR = "owner:console:admin";
  // for events that are not a list change (unlock attempts, eToro unreachable): logged when the database is up
  const auditQuietly = async (entry) => {
    if (!db.configured || dbState.state !== "ok") return;
    try { await appendAudit(db, entry); } catch (e) { console.error("[trading] audit write failed:", db.redact(e.message)); }
  };
  const adminConfigured = (req, res, next) => (admin.configured ? next() : res.status(503).json({ ok: false, error: "editing the allowlists is off: TRADING_ADMIN_PASSWORD is not set on the server", adminConfigured: false }));
  const adminGuard = (req, res, next) => (admin.verify(admin.tokenFrom(req)).ok ? next() : res.status(403).json({ ok: false, error: "an admin session is needed to change the allowlists", adminRequired: true }));
  const normSymbol = (x) => String(x || "").trim().toUpperCase();
  const SYMBOL_RE = /^[A-Z0-9._-]{1,20}$/;
  const AR_CLASS = { stock: "سهم", crypto: "عملة رقمية" };
  // db.withTransaction re-wraps errors as DbError but keeps their code, so
  // the store's refusals are recognised by code, not by class.
  const LIST_REFUSALS = new Set(["AlreadyListed", "SameInstrument", "NotListed", "NotVerified"]);
  const refusal = (e) => (e instanceof AllowlistError || LIST_REFUSALS.has(e?.code) ? e.code : null);
  const whyNot = (r, assetClass, symbol) => {
    const names = (r.candidates || []).slice(0, 5).map((c) => c.symbol).filter(Boolean);
    if (r.status === "no_match") return `ما لقيت على eToro أداة رمزها ${symbol} بالضبط${names.length ? ` (أقرب النتائج: ${names.join("، ")})` : ""}.`;
    if (r.status === "ambiguous") return `eToro رجّع أكثر من أداة بالرمز ${symbol}، فما أضفته عشان ما نختار غلط.`;
    if (r.status === "wrong_asset_class") return `${symbol} على eToro مصنّف «${r.match?.etoroAssetClass || "غير معروف"}»، مو ${AR_CLASS[assetClass]}، فما ينضاف لهالقائمة.`;
    return "رد eToro ما كان واضح، فما أضفته.";
  };

  post("/api/trading/desk/admin/unlock", loginGuard, refuseForeign, adminConfigured, async (req, res) => {
    const r = admin.checkPassword(req.ip || "?", req.body?.password);
    if (!r.ok) {
      await auditQuietly({ eventType: "admin.unlock_failed", entityType: "admin_session", actor: "owner:console", data: { locked: !!r.locked } });
      return res.status(r.locked ? 429 : 401).json({ ok: false, error: r.locked ? `محاولات كثيرة. جرّب بعد ${Math.ceil(r.retryAfterSec / 60)} دقيقة.` : "كلمة مرور المدير غلط.", attemptsLeft: r.attemptsLeft ?? 0 });
    }
    const { token, expiresAt } = admin.issue();
    res.set("Set-Cookie", admin.cookie(req, token, Math.round(admin.ttlMs / 1000)));
    await auditQuietly({ eventType: "admin.unlocked", entityType: "admin_session", actor: ADMIN_ACTOR, data: { expiresAt } });
    res.json({ ok: true, expiresAt });
  });

  post("/api/trading/desk/admin/lock", loginGuard, refuseForeign, (req, res) => {
    res.set("Set-Cookie", admin.cookie(req, "", 0));
    res.json({ ok: true });
  });

  post("/api/trading/desk/allowlist/add", dbGuard, refuseForeign, adminConfigured, adminGuard, async (req, res) => {
    const assetClass = req.body?.assetClass, symbol = normSymbol(req.body?.symbol);
    if (!["stock", "crypto"].includes(assetClass)) return res.status(400).json({ ok: false, error: "assetClass must be stock or crypto" });
    if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ ok: false, error: "الرمز لازم يكون حروف إنجليزية وأرقام بس، مثل AAPL أو BTC." });
    if (!config.hasKeys) return res.status(503).json({ ok: false, error: "ETORO_API_KEY / ETORO_USER_KEY are not set on the server, so the symbol cannot be checked on eToro" });
    const lists = await readAllowlists(db).catch(() => null);
    const listed = lists && lists[assetClass === "stock" ? "stocks" : "crypto"].find((x) => x.symbol === symbol);
    if (listed && listed.active && listed.instrument_id !== null) return res.status(409).json({ ok: false, error: `${symbol} موجود في القائمة من قبل.` });
    let search;
    try { search = await client.searchInstruments(symbol); }
    catch (e) {
      // fail closed: nothing is added when eToro could not answer
      await auditQuietly({ eventType: "allowlist.add_rejected", entityType: `${assetClass}_allowlist`, entityId: symbol, actor: ADMIN_ACTOR, data: { symbol, assetClass, status: "error", reason: client.redact(e.message) } });
      return res.status(502).json({ ok: false, error: `تعذّر التحقق من eToro، فما انضاف شي: ${client.redact(e.message)}`, etoroStatus: e?.status ?? null });
    }
    const items = Array.isArray(search?.data?.items) ? search.data.items : null;
    const result = items ? classify({ symbol, assetClass }, items) : { status: "bad_response", candidates: [] };
    if (result.status !== "verified") {
      const reason = whyNot(result, assetClass, symbol);
      const candidates = (result.candidates || (result.match ? [result.match] : [])).map((c) => ({ symbol: c.symbol, displayName: c.displayName, etoroAssetClass: c.etoroAssetClass }));
      const auditSeq = await recordAllowlistRejection(db, { assetClass, symbol, status: result.status, reason, candidates, source: search?.source ?? null, fetchedAt: search?.fetchedAt ?? null, actor: ADMIN_ACTOR }).catch(() => null);
      return res.status(422).json({ ok: false, error: reason, status: result.status, candidates, auditSeq });
    }
    try {
      const saved = await addAllowlistSymbol(db, { assetClass, symbol, cryptoCorrelated: assetClass === "stock" && req.body?.cryptoCorrelated === true,
        found: { ...result, source: search.source, fetchedAt: search.fetchedAt }, actor: ADMIN_ACTOR });
      res.json({ ok: true, ...saved, message: `انضاف ${symbol}${saved.displayName ? ` (${saved.displayName})` : ""} لقائمة ${assetClass === "stock" ? "الأسهم" : "العملات"} بعد التحقق من eToro.` });
    } catch (e) {
      const code = refusal(e);
      if (code === "AlreadyListed") return res.status(409).json({ ok: false, error: `${symbol} موجود في القائمة من قبل.`, code });
      if (code === "SameInstrument") return res.status(409).json({ ok: false, error: `نفس أداة eToro موجودة في القائمة برمز ثاني، فما أضفت ${symbol}.`, code });
      if (code) return res.status(400).json({ ok: false, error: "only an eToro-verified symbol can be added", code });
      fail(res, e);
    }
  });

  post("/api/trading/desk/allowlist/remove", dbGuard, refuseForeign, adminConfigured, adminGuard, async (req, res) => {
    const assetClass = req.body?.assetClass, symbol = normSymbol(req.body?.symbol);
    if (!["stock", "crypto"].includes(assetClass)) return res.status(400).json({ ok: false, error: "assetClass must be stock or crypto" });
    if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ ok: false, error: "invalid symbol" });
    try {
      const r = await removeAllowlistSymbol(db, { assetClass, symbol, actor: ADMIN_ACTOR });
      const notes = [];
      if (r.openPositions) notes.push(`عندك ${r.openPositions} مركز مفتوح فيه، وإغلاقه يشتغل عادي`);
      if (r.inFlightProposals) notes.push(`${r.inFlightProposals} طلب شراء قيد الانتظار بيرفضه فحص المخاطر`);
      res.json({ ok: true, ...r, message: `انشال ${symbol} من القائمة. أي شراء جديد له بينرفض.${notes.length ? " " + notes.join("، ") + "." : ""}` });
    } catch (e) {
      const code = refusal(e);
      if (code === "NotListed") return res.status(404).json({ ok: false, error: `${symbol} مو موجود في القائمة.`, code });
      if (code) return res.status(400).json({ ok: false, error: "refused", code });
      fail(res, e);
    }
  });

  // --- Stage 8: the end-to-end checklist -------------------------------------
  // Which steps of the live DEMO run are on record. Read-only.
  app.get("/api/trading/e2e", dbGuard, async (req, res) => {
    try {
      const since = await e2e.readSince(db);
      if (!since) return res.json({ ok: true, environment: "demo", started: false, next: "send /trade_e2e in Telegram to start the run" });
      res.json(await e2e.buildE2E({ db, since }));
    } catch (e) { fail(res, e); }
  });

  // --- The weekly report and the agents' track record (read-only) ------------
  app.get("/api/trading/report", dbGuard, async (req, res) => {
    try { res.json({ ok: true, environment: "demo", ...(await reporter.build()) }); } catch (e) { fail(res, e); }
  });

  // --- Telegram commands (the server's existing bot) -----------------------
  // server.js hands exactly these commands to this function, before anything
  // goes to the GM agent. Plain code: no Claude call decides or writes here.
  const telegramCommands = new Set(notify.COMMANDS.map((c) => c.command));
  async function handleTelegramCommand(command, text = "") {
    if (!telegramCommands.has(command)) return false;
    const offBecause = !db.configured ? "TRADING_DATABASE_URL is not set" : dbState.state !== "ok" ? `the database is ${dbState.state}${dbState.error ? ` (${dbState.error})` : ""}` : null;
    if (command === "trade_status") {
      let budget = null, lastRun = null;
      if (!offBecause) {
        budget = await agents.budget.status();
        // While a run is in progress its own "started" record is the newest
        // entry; "last run" means the one before it.
        try {
          const recent = await agents.recentRuns(3);
          lastRun = (agents.state().running && recent[0]?.event === "started" ? recent.slice(1) : recent)[0] || null;
        } catch { /* shown as none */ }
      }
      let trading = null;
      if (!offBecause && typeof approvals.summary === "function") { try { trading = await approvals.summary(); } catch { /* left out */ } }
      let watching = null;
      if (!offBecause && typeof watches.list === "function") { try { watching = (await watches.list(10)).filter((w) => w.status === "open"); } catch { /* left out */ } }
      await notifier.send(notify.statusText({ agents: agents.state(), budget, lastRun, dbState, positions: typeof positions.state === "function" ? positions.state() : null, trading, watching }));
      return true;
    }
    // The runtime stop. It can only make the desk stricter: trading needs
    // TRADING_ENABLED = "true" AND not stopped here. Stopping never needs the
    // database to be healthy to take effect — an unreadable stop state counts as stopped.
    if (command === "trade_stop" || command === "trade_resume") {
      const halted = command === "trade_stop";
      try {
        await db.withTransaction(async (tx) => {
          await tx.query("insert into trading.desk_state (key, value, updated_by) values ('trading_halted', $1, 'owner:telegram') on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()", [JSON.stringify({ halted, at: new Date().toISOString() })]);
          await appendAudit(tx, { eventType: halted ? "trading.stopped" : "trading.resumed", entityType: "desk", actor: "owner:telegram", data: { envSwitch: config.tradingEnabled } });
        });
      } catch (e) {
        await notifier.send(halted ? `⚠️ The stop could not be saved (${notify.esc(db.redact(e?.message))}). While the stop state cannot be read, no order is sent anyway.` : `⚠️ Trading was NOT resumed: ${notify.esc(db.redact(e?.message))}`);
        return true;
      }
      await notifier.send(halted
        ? "⛔ <b>Trading stopped</b> (DEMO)\nNo approval request will be sent and no order can be placed — including ones you already approved. Open positions stay open and are still watched. /trade_resume to allow trading again."
        : config.tradingEnabled ? "🟢 <b>Trading resumed</b> (DEMO)\nEvery order still needs your approval." : "ℹ️ The stop was lifted, but trading is still off: TRADING_ENABLED is not \"true\" in Render.");
      return true;
    }
    // trade_test SYMBOL AMOUNT — the owner's own small test trade. It only
    // creates a DRAFT proposal; the risk engine, the approval request and the
    // gateway then treat it exactly like an agent's proposal.
    if (command === "trade_test") {
      const rule = POLICY.testTrade;
      const m = /^\/\w+(?:@\w+)?\s+([A-Za-z0-9.]{1,12})\s+\$?(\d+(?:\.\d{1,2})?)\s*$/.exec(text.trim());
      const say = async (t) => { await notifier.send(t); return true; };
      if (offBecause) return say(`⛔ Not created: ${notify.esc(offBecause)}`);
      if (!m) return say(`Usage: /trade_test SYMBOL AMOUNT — for example <code>/trade_test BTC ${rule.maxUsd}</code>. At most $${rule.maxUsd}.`);
      const symbol = m[1].toUpperCase(), amountUsd = Number(m[2]);
      if (!(amountUsd > 0 && amountUsd <= rule.maxUsd)) return say(`⛔ Not created: a test trade is at most $${rule.maxUsd}.`);
      const trading = await approvals.summary();
      if (trading.tradingOff) return say(`⛔ Not created: trading is off (${notify.esc(trading.tradingOff)}), so it could not be offered to you for approval.`);
      const instrument = (await listMonitored(db)).find((i) => i.symbol === symbol);
      if (!instrument) return say(`⛔ Not created: ${notify.esc(symbol)} is not an allowlisted, verified instrument.`);
      const r = (await db.query("select bid, as_of, quote_type from trading.market_snapshots where kind = 'rate' and instrument_id = $1 order by as_of desc limit 1", [instrument.instrumentId])).rows[0];
      const at = new Date();
      if (!r || !rateFreshness({ asOf: r.as_of, quoteType: r.quote_type }, at, MONITORING.rateFreshSec).fresh) return say(`⛔ Not created: there is no fresh price for ${notify.esc(symbol)} right now (market closed or data delayed). A stop level cannot be set without one.`);
      const bid = Number(r.bid);
      const stop = Number((bid * (1 - rule.stopPctBelowBid / 100)).toPrecision(6));
      const details = {
        source: "owner test (/trade_test)", symbol, decision: "propose_buy", amount_usd: amountUsd, holding_hours: rule.holdingHours, holding_period: `${rule.holdingHours} hours (fixed rule for test trades)`,
        rationale: "Test trade started by you with /trade_test. No agent analysed it; it exists to prove the path from proposal to position.",
        disagreements: [], entry_conditions: ["at the market price when approved"], risks: ["not analysed by any agent"], evidence: [], assumptions: [],
        exit_conditions: [{ type: "price_below", value: stop, description: `fixed rule for test trades: ${rule.stopPctBelowBid}% below the bid of ${bid} when it was created` }],
      };
      await db.withTransaction((tx) => analysesStore.saveDraftProposal(tx, { instrument, amountUsd, expiresAt: new Date(at.getTime() + POLICY.proposalValidHours * 3600000), analysisId: null, details, actor: "owner:telegram" }));
      await notifier.send(`🧪 <b>Test proposal created — BUY ${notify.esc(symbol)} $${amountUsd.toFixed(2)}</b> (DEMO)\nStop ${stop} (${rule.stopPctBelowBid}% below the bid), planned holding ${rule.holdingHours} hours.\nIt now goes to the risk engine like any other proposal. If it passes you will get the Approve / Reject request.`);
      if (typeof approvals.tick === "function") await approvals.tick();
      return true;
    }
    // trade_close SYMBOL — propose closing the desk's open position in SYMBOL.
    // Creates a DRAFT close proposal only; the risk engine and the owner's
    // Approve decide whether it is sent.
    if (command === "trade_close") {
      const say = async (t) => { await notifier.send(t); return true; };
      if (offBecause) return say(`⛔ Not created: ${notify.esc(offBecause)}`);
      const m = /^\/\w+(?:@\w+)?\s+([A-Za-z0-9.]{1,12})\s*$/.exec(text.trim());
      if (!m) return say("Usage: /trade_close SYMBOL — for example <code>/trade_close BTC</code>. The whole position is proposed for closing.");
      const symbol = m[1].toUpperCase();
      const open = (await db.query("select p.id from trading.positions p join trading.instruments i on i.instrument_id = p.instrument_id where i.symbol = $1 and p.status = 'open' order by p.opened_at", [symbol])).rows;
      if (!open.length) return say(`⛔ Not created: the desk has no open position in ${notify.esc(symbol)} on record. (A position opened by hand on eToro outside the desk's rules cannot be closed from here.)`);
      const made = await db.withTransaction((tx) => analysesStore.saveCloseProposal(tx, { positionRowId: open[0].id, expiresAt: new Date(Date.now() + POLICY.proposalValidHours * 3600000), details: { source: "owner (/trade_close)", reason: "you asked to close it with /trade_close" }, actor: "owner:telegram" }));
      if (!made) return say(`ℹ️ A close for ${notify.esc(symbol)} is already proposed or in progress.`);
      const trading = await approvals.summary();
      await say(`🔴 <b>Close proposed — ${notify.esc(symbol)}</b> (DEMO)\nPosition ${made.etoroPositionId}, $${made.amountUsd.toFixed(2)} invested.\n${trading.tradingOff ? `Trading is off (${notify.esc(trading.tradingOff)}): it will be offered to you when trading is back on.` : "It now goes to the risk engine; if it passes you get the Approve / Reject request."}`);
      if (!trading.tradingOff && typeof approvals.tick === "function") await approvals.tick();
      return true;
    }
    // trade_report — this week's report now (it is also sent every Saturday).
    if (command === "trade_report") {
      if (offBecause) { await notifier.send(`⛔ ${notify.esc(offBecause)}`); return true; }
      await notifier.send(report.weeklyText(await reporter.build()));
      return true;
    }
    // trade_e2e — the Stage 8 checklist. The first use starts the run;
    // "/trade_e2e restart" starts it again from now.
    if (command === "trade_e2e") {
      if (offBecause) { await notifier.send(`⛔ ${notify.esc(offBecause)}`); return true; }
      let since = await e2e.readSince(db);
      if (!since || /\brestart\b/i.test(text)) {
        since = await e2e.startRun(db, new Date());
        await appendAudit(db, { eventType: "e2e.started", entityType: "desk", actor: "owner:telegram", data: { since } });
      }
      await notifier.send(e2e.e2eText(await e2e.buildE2E({ db, since })));
      return true;
    }
    // trade_quiet 23:00-07:00 [Asia/Dubai] | off — quiet hours for approval
    // requests. Inside the window no request is sent; proposals wait and still
    // expire normally. Alerts are not held.
    if (command === "trade_quiet") {
      const say = async (t) => { await notifier.send(t); return true; };
      if (offBecause) return say(`⛔ ${notify.esc(offBecause)}`);
      const arg = text.trim().replace(/^\/\w+(?:@\w+)?\s*/, "");
      const describe = (q) => (q.hours ? `${q.hours.start}–${q.hours.end} (${q.hours.timeZone})` : "none");
      if (!arg) { const q = await readQuietHours(db); return say(`🌙 Quiet hours: ${notify.esc(describe(q))}${q.from === "policy" ? " (from policy.js)" : ""}.\nSet: <code>/trade_quiet 23:00-07:00</code> (Dubai time unless you add a zone). Remove: <code>/trade_quiet off</code>.`); }
      let value;
      if (/^off$/i.test(arg)) value = { off: true };
      else {
        const m = /^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)(?:\s+([A-Za-z_]+\/[A-Za-z_]+|UTC))?$/.exec(arg);
        if (!m) return say("Usage: <code>/trade_quiet 23:00-07:00</code>, <code>/trade_quiet 23:00-07:00 UTC</code> or <code>/trade_quiet off</code>.");
        const timeZone = m[5] || "Asia/Dubai";
        try { new Intl.DateTimeFormat("en-GB", { timeZone }); } catch { return say(`⛔ Unknown time zone: ${notify.esc(timeZone)}`); }
        if (`${m[1]}:${m[2]}` === `${m[3]}:${m[4]}`) return say("⛔ The start and end are the same.");
        value = { start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}`, timeZone };
      }
      await db.withTransaction(async (tx) => {
        await tx.query("insert into trading.desk_state (key, value, updated_by) values ('quiet_hours', $1, 'owner:telegram') on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()", [JSON.stringify(value)]);
        await appendAudit(tx, { eventType: "settings.quiet_hours", entityType: "desk", actor: "owner:telegram", data: value });
      });
      return say(value.off ? "🌙 Quiet hours removed. Approval requests are sent at any time." : `🌙 Quiet hours set: ${value.start}–${value.end} (${notify.esc(value.timeZone)}).\nInside this window no approval request is sent; proposals wait and still expire normally. Alerts are still sent.`);
    }
    // trade_drill_exit SYMBOL — Stage 8 drill. Adds a "price at or above"
    // exit condition 1% below the current stored bid to the desk's open
    // position, then runs one position check now. The real monitor then sees
    // the real price above it, sends its alert and creates the close proposal
    // the normal way. Nothing is closed without your Approve.
    if (command === "trade_drill_exit") {
      const say = async (t) => { await notifier.send(t); return true; };
      if (offBecause) return say(`⛔ Not done: ${notify.esc(offBecause)}`);
      const m = /^\/\w+(?:@\w+)?\s+([A-Za-z0-9.]{1,12})\s*$/.exec(text.trim());
      if (!m) return say("Usage: <code>/trade_drill_exit BTC</code> — tests the monitor's alert and close proposal on the desk's open position.");
      const symbol = m[1].toUpperCase();
      const pos = (await db.query("select p.id, p.instrument_id, p.etoro_position_id from trading.positions p join trading.instruments i on i.instrument_id = p.instrument_id where i.symbol = $1 and p.status = 'open' order by p.opened_at limit 1", [symbol])).rows[0];
      if (!pos) return say(`⛔ Not done: the desk has no open position in ${notify.esc(symbol)}.`);
      const r = (await db.query("select bid, as_of, quote_type from trading.market_snapshots where kind = 'rate' and instrument_id = $1 order by as_of desc limit 1", [pos.instrument_id])).rows[0];
      const at = new Date();
      if (!r || !rateFreshness({ asOf: r.as_of, quoteType: r.quote_type }, at, MONITORING.rateFreshSec).fresh) return say(`⛔ Not done: there is no fresh price for ${notify.esc(symbol)} right now (market closed or data delayed). Try again when it trades.`);
      const level = Number((Number(r.bid) * 0.99).toPrecision(6));
      const condition = { type: "price_above", value: level, description: `Stage 8 drill: set 1% below the bid of ${Number(r.bid)} (${new Date(r.as_of).toISOString().slice(0, 16)} UTC) to test the alert and close path` };
      await db.withTransaction(async (tx) => {
        await tx.query("update trading.positions set exit_conditions = coalesce(exit_conditions, '[]'::jsonb) || $2::jsonb, updated_at = now() where id = $1", [pos.id, JSON.stringify([condition])]);
        await appendAudit(tx, { eventType: "position.drill_exit", entityType: "position", entityId: String(pos.etoro_position_id), actor: "owner:telegram", data: { symbol, condition } });
      });
      await say(`🧪 <b>Drill exit added — ${notify.esc(symbol)}</b> (DEMO)\nCondition: price at or above ${level}. Checking the position now; the monitor's alert and close request follow if it is reached.`);
      if (typeof positions.check === "function") await positions.check("drill");
      if (typeof approvals.tick === "function") await approvals.tick();
      return true;
    }
    // trade_run: a SCREENED run only. "crypto" after the command = coins only.
    const st = agents.state();
    if (offBecause || !st.ready) { await notifier.send(`⛔ Not started: ${notify.esc(offBecause || st.notReadyBecause)}`); return true; }
    if (st.running) { await notifier.send(`⏳ A run is already in progress: ${notify.esc(st.running.step)}. I will send the summary when it finishes.`); return true; }
    // "/trade_run NKE BTC" — full analysis of exactly these (no screen), at most 4.
    const named = text.trim().split(/\s+/).slice(1).map((x) => x.toUpperCase()).filter((x) => x && x !== "CRYPTO");
    if (named.length) {
      if (named.length > 4 || !named.every((x) => /^[A-Z0-9.]{1,12}$/.test(x))) { await notifier.send("Usage: <code>/trade_run</code>, <code>/trade_run crypto</code>, or up to 4 symbols: <code>/trade_run NKE BTC</code>."); return true; }
      await notifier.send(`▶️ Full analysis started for ${notify.esc(named.join(", "))} (no screen). The summary follows when it finishes.`);
      agents.run(named, { trigger: "telegram" });
      return true;
    }
    const scope = /\bcrypto\b/i.test(text) ? "crypto" : "all";
    await notifier.send(`▶️ Screened run started (${scope === "crypto" ? "coins only" : "all instruments"}). The summary follows when it finishes, usually within 15 minutes.`);
    agents.run("all", { trigger: "telegram", screened: true, scope });
    return true;
  }

  if (dbState.state === "ok") startSchedules();
  else if (dbState.state === "starting") prepareDatabase();
  return { monitor, providers, coverage, research, agents, positions, approvals, gateway, ownsCallback: (data) => typeof approvals.ownsCallback === "function" && approvals.ownsCallback(data), handleTelegramCallback: (cq) => approvals.handleTelegramCallback(cq), dbState, telegramCommands, handleTelegramCommand, telegramCommandList: notify.COMMANDS };
}

module.exports = { mount };
