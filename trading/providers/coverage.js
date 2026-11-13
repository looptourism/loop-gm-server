// ---------------------------------------------------------------------------
// Coverage test: asks the configured provider for profile, fundamentals,
// earnings and news of every stock on the allowlist, and reports — per stock
// and per capability — what came back and what is missing.
//
// Read-only and saves nothing. It goes through the provider layer, so the
// same test measures whichever provider the config names.
//
// It is paced well below the provider's limit (Finnhub free: 60 calls per
// minute; this uses at most 40, at least 1.5 s apart). 22 stocks × 5 calls
// take about three minutes. A 429 or a rejected key stops the test and the
// remaining stocks are reported as not checked — never as "no data".
// ---------------------------------------------------------------------------
const { createLimiter } = require("../rate-limiter");

const CORE_FUNDAMENTALS = ["marketCapUsdMillions", "peTtm", "epsTtm", "priceToSalesTtm", "grossMarginTtmPct", "netMarginTtmPct", "revenueGrowthTtmYoyPct", "debtToEquity", "week52High", "week52Low"];

// Turns one answer into a verdict: "ok", "partial" or "gap", with the facts.
const JUDGE = {
  profile: (r) => (r.data
    ? { verdict: "ok", name: r.data.name, exchange: r.data.exchange, country: r.data.country }
    : { verdict: "gap", note: "the provider does not know this symbol" }),
  fundamentals: (r) => {
    if (!r.data) return { verdict: "gap", note: "no figures returned" };
    const missing = CORE_FUNDAMENTALS.filter((k) => r.data[k] === null);
    // A loss-making company has no P/E — that is not a gap in the data.
    const explained = missing.filter((k) => k === "peTtm" && typeof r.data.epsTtm === "number" && r.data.epsTtm <= 0);
    const real = missing.filter((k) => !explained.includes(k));
    return { verdict: real.length === 0 ? "ok" : real.length <= 3 ? "partial" : "gap", filled: CORE_FUNDAMENTALS.length - missing.length, of: CORE_FUNDAMENTALS.length, missing: real, noPeBecauseLossMaking: explained.length > 0, providerFieldCount: r.providerFieldCount ?? null };
  },
  earnings: (r) => {
    const h = r.data.history, u = r.data.upcoming;
    const withActual = h.filter((q) => q.epsActual !== null).length;
    return {
      verdict: withActual === 0 ? "gap" : u.length === 0 || withActual < 4 ? "partial" : "ok",
      pastQuarters: h.length, pastQuartersWithActual: withActual, latestPeriod: h.map((q) => q.period).sort().pop() || null,
      nextDate: u[0]?.date || null, note: u.length === 0 ? "no upcoming earnings date in the calendar window" : undefined,
    };
  },
  news: (r) => ({ verdict: r.data.length === 0 ? "gap" : r.data.length < 5 ? "partial" : "ok", articles: r.data.length, windowDays: r.windowDays, latest: r.data[0]?.publishedAt || null, publishers: [...new Set(r.data.map((n) => n.publisher).filter(Boolean))].slice(0, 5) }),
};

function createCoverage({ providers, symbols, assetClass = "stock", limiter = createLimiter({ perMinute: 40, minGapMs: 1500, reserve: 0 }), now = () => new Date() }) {
  let job = null; // the current or last run, kept in memory only

  async function checkOne(symbol, capability, { keepRaw = false } = {}) {
    const a = providers.get(assetClass, capability); // throws when not usable
    for (let i = 0; i < (a.callsPer?.[capability] || 1); i++) await limiter.take();
    const r = await a[providers.method(capability)](symbol);
    const out = { provider: r.provider, ...JUDGE[capability](r), source: r.source, fetchedAt: r.fetchedAt };
    if (keepRaw) { out.data = r.data; out.raw = r.raw; }
    return out;
  }

  async function run() {
    if (job?.running) return job;
    job = { running: true, startedAt: now().toISOString(), finishedAt: null, total: symbols.length, done: 0, stopped: null, results: [] };
    (async () => {
      for (const symbol of symbols) {
        const row = { symbol };
        for (const capability of providers.capabilities) {
          if (job.stopped) { row[capability] = { verdict: "not_checked", note: job.stopped }; continue; }
          try { row[capability] = await checkOne(symbol, capability); }
          catch (e) {
            const msg = providers.redact(e?.message || String(e));
            row[capability] = { verdict: e?.code === "NotInPlan" ? "gap" : "error", note: e?.code === "NotInPlan" ? `not available on this plan (${msg})` : msg };
            if (["RateLimited", "BadKey", "MissingKey", "NotConfigured", "UnknownProvider", "RateBudgetPaused"].includes(e?.code)) {
              if (e.code === "RateLimited") limiter.pause(5 * 60 * 1000);
              job.stopped = `stopped at ${symbol} ${capability}: ${msg}`;
            }
          }
        }
        job.results.push(row);
        job.done++;
      }
      job.running = false;
      job.finishedAt = now().toISOString();
    })();
    return job;
  }

  // The report: every stock, plus the list of gaps in plain words.
  function report() {
    if (!job) return { started: false };
    const gaps = [];
    for (const row of job.results) for (const c of providers.capabilities) {
      const v = row[c]?.verdict;
      if (v && v !== "ok") gaps.push(`${row.symbol} ${c}: ${v}${row[c].missing?.length ? ` (missing ${row[c].missing.join(", ")})` : row[c].note ? ` (${row[c].note})` : ""}`);
    }
    const fully = job.results.filter((row) => providers.capabilities.every((c) => row[c]?.verdict === "ok")).map((r) => r.symbol);
    return { started: true, running: job.running, startedAt: job.startedAt, finishedAt: job.finishedAt, progress: `${job.done} of ${job.total}`, stopped: job.stopped, fullyCovered: fully, gaps, results: job.results };
  }

  return { run, report, checkOne };
}

module.exports = { createCoverage, CORE_FUNDAMENTALS, JUDGE };
