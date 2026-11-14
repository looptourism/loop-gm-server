// ---------------------------------------------------------------------------
// Finnhub adapter — READ-ONLY. Stocks: profile, fundamentals, earnings, news.
//
// Confirmed by real calls from the Render server on 2026-11-14 (free key):
// all five paths and the field names below returned data for the 22
// allowlisted stocks. Finnhub's documentation itself could not be opened
// from the coding session, so anything beyond these five calls is unproven.
//
// Guards: GET only; only the paths listed in PATHS; only https://finnhub.io;
// the key travels in a header, never in the URL, and is stripped from every
// error message. A failed call throws — it never returns an empty answer
// that could be mistaken for "no news" or "no earnings".
//
// Every answer has the same shape as every other provider's:
//   { provider, capability, symbol, data, source, fetchedAt, raw }
// `data` holds only what Finnhub returned; a figure it did not return is
// null, never estimated.
// ---------------------------------------------------------------------------
const BASE_URL = "https://finnhub.io/api/v1";
const TIMEOUT_MS = 20000;
const PATHS = new Set(["/stock/profile2", "/stock/metric", "/stock/earnings", "/calendar/earnings", "/company-news", "/news"]);

class ProviderError extends Error {
  constructor(message, { provider = null, status = null, code = null, retryAfterSec = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const day = (d) => d.toISOString().slice(0, 10);

// Our field name → Finnhub's name in /stock/metric → metric{}.
const METRICS = {
  marketCapUsdMillions: "marketCapitalization",
  peTtm: "peTTM",
  epsTtm: "epsTTM",
  priceToSalesTtm: "psTTM",
  priceToBook: "pbQuarterly",
  grossMarginTtmPct: "grossMarginTTM",
  operatingMarginTtmPct: "operatingMarginTTM",
  netMarginTtmPct: "netProfitMarginTTM",
  revenueGrowthTtmYoyPct: "revenueGrowthTTMYoy",
  epsGrowthTtmYoyPct: "epsGrowthTTMYoy",
  returnOnEquityTtmPct: "roeTTM",
  debtToEquity: "totalDebt/totalEquityQuarterly",
  currentRatio: "currentRatioQuarterly",
  week52High: "52WeekHigh",
  week52Low: "52WeekLow",
  beta: "beta",
};

function createFinnhub({ apiKey = "", fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const name = "finnhub";
  const redact = (t) => { const out = String(t ?? ""); return apiKey.length >= 8 ? out.split(apiKey).join("[redacted]") : out; };

  async function get(path, query) {
    if (!PATHS.has(path)) throw new ProviderError("blocked: path is not on the Finnhub allowlist", { provider: name, code: "PathNotAllowed" });
    if (!apiKey) throw new ProviderError("FINNHUB_API_KEY is not set", { provider: name, code: "MissingKey" });
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res, body;
    try {
      res = await fetchImpl(url, { method: "GET", headers: { "X-Finnhub-Token": apiKey, Accept: "application/json" }, signal: controller.signal });
      body = await res.text();
    } catch (e) {
      throw new ProviderError(e.name === "AbortError" ? `Finnhub did not answer within ${TIMEOUT_MS / 1000}s` : redact(`network error: ${e.message}`), { provider: name, code: e.name === "AbortError" ? "Timeout" : "Network" });
    } finally { clearTimeout(timer); }
    let json;
    try { json = body ? JSON.parse(body) : undefined; } catch { json = undefined; }
    if (!res.ok) {
      const retry = Number(res.headers?.get?.("Retry-After"));
      const detail = json && typeof json.error === "string" ? `: ${json.error}` : "";
      // 403 is what Finnhub answers when an endpoint or symbol is not part of the plan.
      throw new ProviderError(redact(`Finnhub ${res.status}${detail}`), { provider: name, status: res.status, code: res.status === 429 ? "RateLimited" : res.status === 403 ? "NotInPlan" : res.status === 401 ? "BadKey" : "HttpError", retryAfterSec: Number.isFinite(retry) ? retry : null });
    }
    if (json === undefined || json === null || typeof json !== "object") throw new ProviderError("Finnhub returned a response that is not JSON", { provider: name, status: res.status, code: "BadResponse" });
    return { json, source: `Finnhub GET /api/v1${path}`, fetchedAt: now().toISOString() };
  }

  const sym = (symbol) => {
    const s = String(symbol || "").trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,12}$/.test(s)) throw new ProviderError("invalid symbol", { provider: name, code: "BadInput" });
    return s;
  };
  const wrap = (capability, symbol, r, data, extra = {}) => ({ provider: name, capability, symbol, data, source: r.source, fetchedAt: r.fetchedAt, raw: r.json, ...extra });

  // Who the company is. Finnhub answers {} for a symbol it does not know.
  async function getProfile(symbol) {
    const s = sym(symbol);
    const r = await get("/stock/profile2", { symbol: s });
    const j = r.json;
    const found = text(j.name) !== null;
    return wrap("profile", s, r, found ? {
      name: text(j.name), ticker: text(j.ticker), exchange: text(j.exchange), country: text(j.country), currency: text(j.currency),
      industry: text(j.finnhubIndustry), ipoDate: text(j.ipo), marketCapUsdMillions: finite(j.marketCapitalization), sharesOutstandingMillions: finite(j.shareOutstanding),
    } : null);
  }

  // Ratios and key figures as Finnhub computes them.
  async function getFundamentals(symbol) {
    const s = sym(symbol);
    const r = await get("/stock/metric", { symbol: s, metric: "all" });
    const m = r.json.metric && typeof r.json.metric === "object" ? r.json.metric : {};
    const data = {};
    for (const [ours, theirs] of Object.entries(METRICS)) data[ours] = finite(m[theirs]);
    // `raw` keeps Finnhub's metric block only; its long historical `series` is left out.
    return wrap("fundamentals", s, r, Object.keys(m).length ? data : null, { providerFieldCount: Object.keys(m).length, raw: { metric: m } });
  }

  // Past quarters (actual vs estimate) and the next announced date, if any.
  // Two calls. `daysAhead` is how far forward the calendar is searched.
  async function getEarnings(symbol, { daysAhead = 120 } = {}) {
    const s = sym(symbol);
    const hist = await get("/stock/earnings", { symbol: s });
    const today = now();
    const cal = await get("/calendar/earnings", { symbol: s, from: day(today), to: day(new Date(today.getTime() + daysAhead * 86400000)) });
    const history = (Array.isArray(hist.json) ? hist.json : []).map((q) => ({
      period: text(q.period), year: finite(q.year), quarter: finite(q.quarter),
      epsActual: finite(q.actual), epsEstimate: finite(q.estimate), surprisePct: finite(q.surprisePercent),
    })).filter((q) => q.period);
    const list = Array.isArray(cal.json.earningsCalendar) ? cal.json.earningsCalendar : [];
    const upcoming = list.filter((e) => e && e.symbol === s && text(e.date)).map((e) => ({
      date: text(e.date), hour: text(e.hour), year: finite(e.year), quarter: finite(e.quarter),
      epsEstimate: finite(e.epsEstimate), revenueEstimate: finite(e.revenueEstimate),
    })).sort((a, b) => a.date.localeCompare(b.date));
    return {
      provider: name, capability: "earnings", symbol: s, data: { history, upcoming },
      source: `${hist.source} + ${cal.source}`, fetchedAt: cal.fetchedAt, raw: { earnings: hist.json, calendar: cal.json },
    };
  }

  // Company news for the last `days` days, newest first. Finnhub's `datetime`
  // is a Unix time in seconds — converted to a UTC ISO string.
  async function getNews(symbol, { days = 30 } = {}) {
    const s = sym(symbol);
    const to = now();
    const r = await get("/company-news", { symbol: s, from: day(new Date(to.getTime() - days * 86400000)), to: day(to) });
    const items = (Array.isArray(r.json) ? r.json : []).map(newsItem).filter((n) => n.headline && n.publishedAt).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return wrap("news", s, r, items, { windowDays: days, raw: { count: Array.isArray(r.json) ? r.json.length : null } });
  }

  const newsItem = (n) => {
    const t = finite(n?.datetime);
    return { id: n?.id ?? null, headline: text(n?.headline), summary: text(n?.summary), url: text(n?.url), publisher: text(n?.source), publishedAt: t && t > 0 ? new Date(t * 1000).toISOString() : null, raw: n };
  };

  // General headlines for a whole asset class — NOT per coin. Only "crypto"
  // is offered. Confirmed by a real call on 2026-11-14 (92 articles).
  async function getMarketNews(assetClass) {
    if (assetClass !== "crypto") throw new ProviderError("Finnhub market news is only wired for crypto", { provider: name, code: "BadInput" });
    const r = await get("/news", { category: "crypto" });
    const items = (Array.isArray(r.json) ? r.json : []).map(newsItem).filter((n) => n.headline && n.publishedAt).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return { provider: name, capability: "marketNews", symbol: null, data: items, source: r.source, fetchedAt: r.fetchedAt, raw: { count: Array.isArray(r.json) ? r.json.length : null } };
  }

  return { name, hasKey: !!apiKey, callsPer: { profile: 1, fundamentals: 1, earnings: 2, news: 1, marketNews: 1 }, getProfile, getFundamentals, getEarnings, getNews, getMarketNews, redact };
}

module.exports = { createFinnhub, ProviderError, METRICS, PATHS };
