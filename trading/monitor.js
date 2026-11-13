// ---------------------------------------------------------------------------
// Market Monitoring (Stage 3) — plain code, no AI.
//
// On a schedule it asks eToro for the current rates and the finished candles
// of every allowlisted, verified instrument and stores them as timestamped
// snapshots. That is all it does: it reads market data and writes to the
// Trading Desk database. It cannot place, change or close an order — the
// client it uses has no such call.
//
// Fail closed, quietly: if the keys, the database or eToro are not there, the
// run stores nothing and says why. A missing figure stays missing.
// ---------------------------------------------------------------------------
const { MONITORING } = require("./config");
const { createLimiter } = require("./rate-limiter");
const { INTERVAL_MS, normalizeRate, normalizeCandles } = require("./market-data");
const snapshots = require("./db/snapshots");

function createMonitor({
  config, client, db, settings = MONITORING,
  now = () => new Date(),
  limiter = createLimiter({ perMinute: settings.requestsPerMinute, minGapMs: settings.minGapMs, reserve: settings.reserveRemaining }),
  log = (...a) => console.log("[trading/monitor]", ...a),
} = {}) {
  let running = null;      // { trigger, startedAt, step }
  let lastResult = null;
  let scheduled = false;

  const clean = (e) => db.redact(client.redact(e?.message || String(e)));

  // One eToro call, through the limiter. A 429 pauses everything.
  async function call(fn) {
    await limiter.take();
    try {
      const r = await fn();
      limiter.observe(r.rateLimit);
      return r;
    } catch (e) {
      if (e?.status === 429) limiter.pause(Math.max(settings.pauseAfter429Ms, (e.retryAfterSec || 0) * 1000));
      throw e;
    }
  }
  const stops = (e) => e?.status === 429 || e?.code === "RateBudgetPaused" || e?.code === "MissingKeys";

  async function finish(run) {
    run.finishedAt = now().toISOString();
    run.status = run.problems.length === 0 ? "ok" : run.saved ? "partial" : "failed";
    delete run.saved;
    try { await snapshots.recordRun(db, run); } catch (e) { run.notRecorded = clean(e); log("could not record the run:", run.notRecorded); }
    return run;
  }
  const newRun = (kind, trigger, instruments, interval) => ({ kind, interval, trigger, startedAt: now().toISOString(), instruments: instruments.length, requests: 0, inserted: 0, unchanged: 0, revised: 0, problems: [], saved: false });

  // One request for all instruments (eToro allows 1000 IDs per call).
  async function collectRates(instruments, trigger) {
    const run = newRun("rates", trigger, instruments);
    try {
      run.requests++;
      const r = await call(() => client.getRates(instruments.map((i) => i.instrumentId)));
      const items = Array.isArray(r.data?.results) ? r.data.results : null;
      if (!items) throw new Error("eToro's answer has no results list");
      const byId = new Map(items.map((x) => [x?.instrumentId, x]));
      const good = [];
      for (const i of instruments) {
        const item = byId.get(i.instrumentId);
        const n = item ? normalizeRate(item) : { ok: false, reason: r.status === 206 ? "eToro returned no rate (partial answer, HTTP 206)" : "eToro returned no rate" };
        if (n.ok) good.push(n.rate); else run.problems.push({ symbol: i.symbol, instrumentId: i.instrumentId, problem: n.reason });
      }
      const saved = await db.withTransaction((tx) => snapshots.saveRates(tx, good, { source: r.source, fetchedAt: r.fetchedAt }));
      run.inserted = saved.inserted; run.unchanged = saved.unchanged; run.saved = good.length > 0;
    } catch (e) {
      run.problems.push({ symbol: null, instrumentId: null, problem: clean(e) });
    }
    return finish(run);
  }

  // One request per instrument. Asks only for what is missing: everything
  // since the newest stored candle, plus a small overlap to catch revisions.
  async function collectCandles(instruments, spec, trigger) {
    const run = newRun("candles", trigger, instruments, spec.interval);
    let latest;
    try { latest = await snapshots.latestCandleTimes(db, spec.interval); }
    catch (e) { run.problems.push({ symbol: null, instrumentId: null, problem: clean(e) }); return finish(run); }
    let stopped = null;
    for (const i of instruments) {
      if (stopped) { run.problems.push({ symbol: i.symbol, instrumentId: i.instrumentId, problem: `not attempted: ${stopped}` }); continue; }
      if (running) running.step = `${spec.interval} candles: ${i.symbol}`;
      try {
        const last = latest.get(i.instrumentId);
        const count = last
          ? Math.min(spec.backfill, Math.max(5, Math.ceil((now().getTime() - last.getTime()) / INTERVAL_MS[spec.interval]) + settings.candleOverlap))
          : spec.backfill;
        run.requests++;
        const r = await call(() => client.getCandles(i.instrumentId, { interval: spec.interval, count, direction: "desc" }));
        const n = normalizeCandles(r.data, { instrumentId: i.instrumentId, interval: spec.interval, now: new Date(r.fetchedAt) });
        if (n.dropped.invalid) run.problems.push({ symbol: i.symbol, instrumentId: i.instrumentId, problem: `${n.dropped.invalid} candle(s) rejected as invalid` });
        if (!last && n.candles.length === 0) run.problems.push({ symbol: i.symbol, instrumentId: i.instrumentId, problem: "eToro returned no finished candles" });
        const saved = await db.withTransaction((tx) => snapshots.saveCandles(tx, { instrumentId: i.instrumentId, symbol: i.symbol, interval: spec.interval }, n.candles, { source: r.source, fetchedAt: r.fetchedAt }));
        run.inserted += saved.inserted; run.unchanged += saved.unchanged; run.revised += saved.revised;
        run.saved = true;
      } catch (e) {
        if (e?.code === "RateBudgetPaused") run.requests--; // nothing was sent
        run.problems.push({ symbol: i.symbol, instrumentId: i.instrumentId, problem: clean(e) });
        if (stops(e)) stopped = clean(e);
      }
    }
    return finish(run);
  }

  // A candle interval is due when no fully successful run has started in the
  // current slot (e.g. the current hour for OneHour). Kept in the database,
  // so a restart or a deploy neither skips nor repeats a collection.
  async function isDue(spec) {
    const slotStart = Math.floor(now().getTime() / spec.refreshEveryMs) * spec.refreshEveryMs;
    const last = await snapshots.lastOkRun(db, "candles", spec.interval);
    return !last || last.getTime() < slotStart;
  }

  // One full pass. Never throws; never overlaps with itself.
  async function tick(trigger = "schedule", { allCandles = false } = {}) {
    if (running) return { ok: false, skipped: "a run is already in progress", running };
    running = { trigger, startedAt: now().toISOString(), step: "starting" };
    const result = { ok: false, trigger, startedAt: running.startedAt, runs: [] };
    try {
      if (!config.hasKeys) { result.skipped = "ETORO_API_KEY / ETORO_USER_KEY are not set"; return result; }
      if (!db.configured) { result.skipped = "TRADING_DATABASE_URL is not set"; return result; }
      const instruments = await snapshots.listMonitored(db);
      if (!instruments.length) { result.skipped = "no allowlisted, verified instruments in the database (run sync-allowlist first)"; return result; }
      running.step = "rates";
      result.runs.push(await collectRates(instruments, trigger));
      for (const spec of settings.candles) {
        if (allCandles || await isDue(spec)) {
          running.step = `${spec.interval} candles`;
          result.runs.push(await collectCandles(instruments, spec, trigger));
        }
      }
      result.ok = result.runs.every((r) => r.status === "ok");
    } catch (e) {
      result.error = clean(e);
    } finally {
      result.finishedAt = now().toISOString();
      const brief = result.runs.map((r) => `${r.kind}${r.interval ? " " + r.interval : ""}: ${r.status}, ${r.requests} req, +${r.inserted}`).join(" | ");
      log(result.skipped ? `skipped: ${result.skipped}` : result.error ? `failed: ${result.error}` : brief);
      lastResult = result;
      running = null;
    }
    return result;
  }

  // Starts the schedule — only when TRADING_MONITOR_ENABLED is exactly "true".
  function start() {
    if (scheduled || !config.monitorEnabled) return false;
    require("node-cron").schedule(settings.cron, () => { tick("schedule"); }, { timezone: "UTC" });
    scheduled = true;
    log(`schedule on (${settings.cron} UTC), at most ${settings.requestsPerMinute} requests per minute`);
    return true;
  }

  const state = () => ({
    scheduleEnabled: config.monitorEnabled, scheduled, cronUtc: settings.cron,
    running, requestBudget: { etoroQuotaPerMinute: 120, ...limiter.state() },
    lastResult,
  });

  return { tick, start, state, collectRates, collectCandles, isDue };
}

module.exports = { createMonitor };
