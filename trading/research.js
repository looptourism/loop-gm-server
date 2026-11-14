// ---------------------------------------------------------------------------
// Research collection — plain code, no AI.
//
// On a schedule it asks the configured providers for profile, fundamentals,
// earnings, filings and news of every allowlisted, verified instrument and
// stores the answers. It reads from providers and writes to the Trading Desk
// database; it has no connection to trading.
//
// Which provider answers what is decided by DATA_PROVIDERS in config.js; this
// file never names one. All calls go through the provider layer's limiters.
//
// Two groups, each collected only when due:
//   "research" — profile, fundamentals, earnings, filings: once a day
//   "news"     — company news per stock + general crypto headlines: every 6 hours
// A group counts as done for its slot once a run stored something, so a
// stock with a permanent gap does not cause hourly retries; a run that stored
// nothing at all is tried again the next hour.
//
// A provider that answers 429, rejects the key or has no key is dropped for
// the rest of the run; the other providers carry on. What could not be
// fetched is listed as a problem. Nothing is filled in.
// ---------------------------------------------------------------------------
const { RESEARCH } = require("./config");
const snapshots = require("./db/snapshots");
const store = require("./db/research");
const { STOPS } = require("./providers/coverage");

function createResearch({ config, providers, db, settings = RESEARCH, now = () => new Date(), log = (...a) => console.log("[trading/research]", ...a) } = {}) {
  let running = null, lastResult = null, scheduled = false;
  const clean = (e) => db.redact(providers.redact(e?.message || String(e)));
  const total = () => Object.values(providers.requests()).reduce((a, b) => a + b, 0);

  function newRun(kind, trigger, instruments) {
    return { kind, trigger, startedAt: now().toISOString(), instruments: instruments.length, requests: 0, inserted: 0, unchanged: 0, revised: 0, problems: [], saved: false, before: total(), stopped: {} };
  }
  async function finish(run) {
    run.finishedAt = now().toISOString();
    run.requests = total() - run.before;
    run.status = run.problems.length === 0 ? "ok" : run.saved ? "partial" : "failed";
    delete run.saved; delete run.before; delete run.stopped;
    try { await snapshots.recordRun(db, run); } catch (e) { run.notRecorded = clean(e); log("could not record the run:", run.notRecorded); }
    return run;
  }
  // Runs one provider call for one instrument; returns the answer or null (problem recorded).
  async function ask(run, assetClass, capability, i, arg, opts) {
    const provider = providers.providerOf(assetClass, capability);
    const who = { symbol: i?.symbol ?? null, instrumentId: i?.instrumentId ?? null };
    if (run.stopped[provider]) { run.problems.push({ ...who, problem: `${capability} not attempted: ${run.stopped[provider]}` }); return null; }
    if (running) running.step = `${capability}: ${i?.symbol || assetClass}`;
    try { return await providers.call(assetClass, capability, arg, opts); }
    catch (e) {
      run.problems.push({ ...who, problem: `${capability}: ${clean(e)}` });
      if (STOPS.includes(e?.code)) run.stopped[provider] = clean(e);
      return null;
    }
  }

  async function collectDaily(instruments, trigger) {
    const run = newRun("research", trigger, instruments);
    for (const i of instruments) {
      for (const capability of providers.capabilitiesFor(i.assetClass).filter((c) => c !== "news")) {
        const r = await ask(run, i.assetClass, capability, i, i.symbol);
        if (!r) continue;
        if (r.data === null || r.data === undefined) { run.problems.push({ symbol: i.symbol, instrumentId: i.instrumentId, problem: `${capability}: ${r.provider} has no data for this symbol` }); continue; }
        try {
          const what = await db.withTransaction((tx) => store.saveResearch(tx, { instrumentId: i.instrumentId, capability, provider: r.provider, data: r.data, raw: r.raw, source: r.source, fetchedAt: r.fetchedAt }));
          run[what]++; run.saved = true;
        } catch (e) { run.problems.push({ symbol: i.symbol, instrumentId: i.instrumentId, problem: `${capability}: ${clean(e)}` }); }
      }
    }
    return finish(run);
  }

  async function collectNews(instruments, trigger, firstTime) {
    const run = newRun("news", trigger, instruments);
    const days = firstTime ? settings.newsDaysFirstRun : settings.newsDays;
    const save = async (r, assetClass, i) => {
      try {
        const out = await db.withTransaction((tx) => store.saveNews(tx, { assetClass, instrumentId: i?.instrumentId ?? null, provider: r.provider, items: r.data, source: r.source, fetchedAt: r.fetchedAt }));
        run.inserted += out.inserted; run.unchanged += out.unchanged; run.saved = true;
      } catch (e) { run.problems.push({ symbol: i?.symbol ?? null, instrumentId: i?.instrumentId ?? null, problem: `news: ${clean(e)}` }); }
    };
    for (const i of instruments) {
      if (!providers.capabilitiesFor(i.assetClass).includes("news")) continue;
      const r = await ask(run, i.assetClass, "news", i, i.symbol, { days });
      if (r) await save(r, i.assetClass, i);
    }
    for (const assetClass of new Set(instruments.map((i) => i.assetClass))) {
      for (const capability of providers.capabilitiesFor(assetClass, { perClass: true })) {
        const r = await ask(run, assetClass, capability, null, assetClass);
        if (r) await save(r, assetClass, null);
      }
    }
    return finish(run);
  }

  async function isDue(kind, everyMs) {
    const slotStart = Math.floor(now().getTime() / everyMs) * everyMs;
    const last = await store.lastUsefulRun(db, kind);
    return { due: !last || last.getTime() < slotStart, first: !last };
  }

  // One pass. Never throws; never overlaps with itself.
  async function tick(trigger = "schedule", { all = false } = {}) {
    if (running) return { ok: false, skipped: "a run is already in progress", running };
    running = { trigger, startedAt: now().toISOString(), step: "starting" };
    const result = { ok: false, trigger, startedAt: running.startedAt, runs: [] };
    try {
      if (!db.configured) { result.skipped = "TRADING_DATABASE_URL is not set"; return result; }
      const instruments = await snapshots.listMonitored(db);
      if (!instruments.length) { result.skipped = "no allowlisted, verified instruments in the database"; return result; }
      const daily = await isDue("research", settings.dailyEveryMs);
      if (all || daily.due) result.runs.push(await collectDaily(instruments, trigger));
      const news = await isDue("news", settings.newsEveryMs);
      if (all || news.due) result.runs.push(await collectNews(instruments, trigger, news.first));
      result.ok = result.runs.every((r) => r.status === "ok");
      if (!result.runs.length) result.skipped = "nothing is due yet";
    } catch (e) {
      result.error = clean(e);
    } finally {
      result.finishedAt = now().toISOString();
      log(result.skipped ? `skipped: ${result.skipped}` : result.error ? `failed: ${result.error}` : result.runs.map((r) => `${r.kind}: ${r.status}, ${r.requests} req, +${r.inserted}, ${r.problems.length} problem(s)`).join(" | "));
      lastResult = result;
      running = null;
    }
    return result;
  }

  // Same switch as price monitoring: only when TRADING_MONITOR_ENABLED is exactly "true".
  function start() {
    if (scheduled || !config.monitorEnabled) return false;
    require("node-cron").schedule(settings.cron, () => { tick("schedule"); }, { timezone: "UTC" });
    scheduled = true;
    log(`schedule on (${settings.cron} UTC)`);
    return true;
  }

  const state = () => ({ scheduleEnabled: config.monitorEnabled, scheduled, cronUtc: settings.cron, running, requestsSinceStart: providers.requests(), lastResult });
  return { tick, start, state, collectDaily, collectNews };
}

module.exports = { createResearch };
