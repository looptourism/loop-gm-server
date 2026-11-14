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
const CORE_FUNDAMENTALS = ["marketCapUsdMillions", "peTtm", "epsTtm", "priceToSalesTtm", "grossMarginTtmPct", "netMarginTtmPct", "revenueGrowthTtmYoyPct", "debtToEquity", "week52High", "week52Low"];

// Turns one answer into a verdict: "ok", "partial" or "gap", with the facts.
const JUDGE = {
  profile: (r) => (r.data
    ? { verdict: "ok", name: r.data.name, exchange: r.data.exchange, country: r.data.country }
    : { verdict: "gap", note: "the provider does not know this symbol" }),
  fundamentals: (r, core = CORE_FUNDAMENTALS) => {
    if (!r.data) return { verdict: "gap", note: "no figures returned" };
    const missing = core.filter((k) => r.data[k] === null || r.data[k] === undefined);
    // A loss-making company has no P/E — that is not a gap in the data.
    const explained = missing.filter((k) => k === "peTtm" && typeof r.data.epsTtm === "number" && r.data.epsTtm <= 0);
    const real = missing.filter((k) => !explained.includes(k));
    const out = { verdict: real.length === 0 ? "ok" : real.length <= core.length * 0.3 ? "partial" : "gap", filled: core.length - missing.length, of: core.length, missing: real };
    if (core === CORE_FUNDAMENTALS) { out.noPeBecauseLossMaking = explained.length > 0; out.providerFieldCount = r.providerFieldCount ?? null; }
    else out.name = r.data.name ?? null;
    return out;
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
  filings: (r) => {
    if (!r.data) return { verdict: "gap", note: "the SEC's ticker list does not have this symbol" };
    const f = r.data.filings;
    const newest = (kind) => { const x = f.find((y) => y.kind === kind); return x ? `${x.form} filed ${x.filedOn}${x.periodEnd ? ` (period ${x.periodEnd})` : ""}` : null; };
    const count = (kind) => f.filter((x) => x.kind === kind).length;
    const out = {
      verdict: f.length === 0 ? "gap" : count("annual") === 0 ? "partial" : "ok",
      company: r.data.companyName, filings: f.length, forms: [...new Set(f.map((x) => x.form))],
      annualReports: count("annual"), quarterlyReports: count("quarterly"), currentReports: count("current"),
      latestAnnual: newest("annual"), latestQuarterly: newest("quarterly"), latestCurrent: newest("current"),
    };
    if (f.length && count("annual") === 0) out.note = "no annual report among the SEC's recent filings";
    // Foreign companies file a yearly 20-F and occasional 6-Ks; they do not file quarterly reports with the SEC.
    else if (count("quarterly") === 0 && f.some((x) => x.form.startsWith("20-F") || x.form === "6-K" || x.form === "40-F")) out.foreignIssuer = "files 20-F / 6-K: no quarterly reports exist at the SEC — quarterly figures must come from another provider";
    return out;
  },
  marketNews: (r) => ({ verdict: r.data.length === 0 ? "gap" : "ok", articles: r.data.length, latest: r.data[0]?.publishedAt || null, publishers: [...new Set(r.data.map((n) => n.publisher).filter(Boolean))].slice(0, 5), note: "general headlines for the asset class, not per instrument" }),
};

const STOPS = ["RateLimited", "BadKey", "MissingKey", "NotConfigured", "UnknownProvider", "RateBudgetPaused", "NotOffered"];

function createCoverage({ providers, symbols, assetClass = "stock", now = () => new Date() }) {
  let job = null; // the current or last run, kept in memory only
  const capabilities = () => providers.capabilitiesFor(assetClass);

  async function checkOne(symbol, capability, { keepRaw = false } = {}) {
    const r = await providers.call(assetClass, capability, symbol); // throws when not usable
    const core = capability === "fundamentals" ? providers.coreFundamentals(assetClass) || CORE_FUNDAMENTALS : undefined;
    const out = { provider: r.provider, ...JUDGE[capability](r, core), source: r.source, fetchedAt: r.fetchedAt };
    if (keepRaw) { out.data = r.data; out.raw = r.raw; }
    return out;
  }

  async function run() {
    if (job?.running) return job;
    job = { running: true, startedAt: now().toISOString(), finishedAt: null, total: symbols.length, done: 0, stopped: {}, results: [] };
    (async () => {
      for (const symbol of symbols) {
        const row = { symbol };
        for (const capability of capabilities()) {
          const provider = providers.providerOf(assetClass, capability);
          if (job.stopped[provider]) { row[capability] = { verdict: "not_checked", note: job.stopped[provider] }; continue; }
          try { row[capability] = await checkOne(symbol, capability); }
          catch (e) {
            const msg = providers.redact(e?.message || String(e));
            row[capability] = { verdict: e?.code === "NotInPlan" ? "gap" : "error", note: e?.code === "NotInPlan" ? `not available on this plan (${msg})` : msg };
            // One provider failing stops only that provider; the others carry on.
            if (STOPS.includes(e?.code)) job.stopped[provider] = `stopped at ${symbol} ${capability}: ${msg}`;
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

  // The report: every instrument, plus the list of gaps in plain words.
  function report() {
    if (!job) return { started: false, assetClass };
    const caps = capabilities();
    const gaps = [];
    for (const row of job.results) for (const c of caps) {
      const v = row[c]?.verdict;
      if (v && v !== "ok") gaps.push(`${row.symbol} ${c}: ${v}${row[c].missing?.length ? ` (missing ${row[c].missing.join(", ")})` : row[c].note ? ` (${row[c].note})` : ""}`);
    }
    const fully = job.results.filter((row) => caps.every((c) => row[c]?.verdict === "ok")).map((r) => r.symbol);
    const stopped = Object.values(job.stopped);
    return { started: true, assetClass, running: job.running, startedAt: job.startedAt, finishedAt: job.finishedAt, progress: `${job.done} of ${job.total}`, stopped: stopped.length ? stopped : null, fullyCovered: fully, gaps, results: job.results };
  }

  return { run, report, checkOne, capabilities };
}

module.exports = { createCoverage, CORE_FUNDAMENTALS, JUDGE, STOPS };
