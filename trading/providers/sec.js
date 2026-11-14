// ---------------------------------------------------------------------------
// SEC EDGAR adapter — READ-ONLY. Stocks: the company's recent official
// filings (annual, quarterly and current reports), each with its date and a
// link to the document on sec.gov. No news, no ratios, no crypto.
//
// NOT YET CONFIRMED BY A REAL CALL. sec.gov could not be opened from the
// coding session; the two URLs and the field names are the publicly known
// ones and must be proven by /api/trading/providers/test on the Render server.
//
// EDGAR needs no key, but requires every caller to say who they are in the
// User-Agent header. That text comes from SEC_USER_AGENT and is never
// invented here; without it nothing is sent.
// ---------------------------------------------------------------------------
const { ProviderError } = require("./finnhub");

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUBMISSIONS_URL = (cik10) => `https://data.sec.gov/submissions/CIK${cik10}.json`;
const TIMEOUT_MS = 20000;
const TICKER_MAP_TTL_MS = 24 * 60 * 60 * 1000;
// Annual / quarterly / current reports — US companies and foreign issuers.
const FORMS = new Set(["10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "8-K/A", "20-F", "20-F/A", "40-F", "6-K"]);

function createSec({ userAgent = "", fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const name = "sec";
  let tickerMap = null, tickerMapAt = 0;

  async function getJson(url) {
    if (!userAgent) throw new ProviderError("SEC_USER_AGENT is not set", { provider: name, code: "MissingKey" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res, body;
    try {
      res = await fetchImpl(url, { method: "GET", headers: { "User-Agent": userAgent, Accept: "application/json" }, signal: controller.signal });
      body = await res.text();
    } catch (e) {
      throw new ProviderError(e.name === "AbortError" ? `SEC did not answer within ${TIMEOUT_MS / 1000}s` : `network error: ${e.message}`, { provider: name, code: e.name === "AbortError" ? "Timeout" : "Network" });
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new ProviderError(`SEC ${res.status}`, { provider: name, status: res.status, code: res.status === 429 ? "RateLimited" : res.status === 403 ? "BadKey" : "HttpError" });
    try { return JSON.parse(body); } catch { throw new ProviderError("SEC returned a response that is not JSON", { provider: name, status: res.status, code: "BadResponse" }); }
  }

  // Ticker → CIK (the SEC's company number), from the SEC's own list. Cached for a day.
  async function cikFor(symbol) {
    if (!tickerMap || now().getTime() - tickerMapAt > TICKER_MAP_TTL_MS) {
      const json = await getJson(TICKERS_URL);
      const map = new Map();
      for (const row of Object.values(json || {})) {
        if (row && typeof row.ticker === "string" && Number.isInteger(row.cik_str)) map.set(row.ticker.toUpperCase(), row.cik_str);
      }
      if (map.size === 0) throw new ProviderError("the SEC's ticker list came back empty", { provider: name, code: "BadResponse" });
      tickerMap = map; tickerMapAt = now().getTime();
    }
    return tickerMap.get(symbol) ?? null;
  }

  async function getFilings(symbol, { limit = 20 } = {}) {
    const s = String(symbol || "").trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,12}$/.test(s)) throw new ProviderError("invalid symbol", { provider: name, code: "BadInput" });
    const cik = await cikFor(s);
    const base = { provider: name, capability: "filings", symbol: s, source: "SEC EDGAR GET data.sec.gov/submissions", fetchedAt: now().toISOString() };
    if (cik === null) return { ...base, data: null, raw: { note: "ticker not in the SEC's list" } };
    const cik10 = String(cik).padStart(10, "0");
    const j = await getJson(SUBMISSIONS_URL(cik10));
    const tickers = Array.isArray(j.tickers) ? j.tickers.map((t) => String(t).toUpperCase()) : [];
    if (!tickers.includes(s)) throw new ProviderError(`SEC company ${cik} does not list ticker ${s}`, { provider: name, code: "WrongCompany" });
    const r = j.filings?.recent;
    if (!r || !Array.isArray(r.form) || !Array.isArray(r.filingDate) || !Array.isArray(r.accessionNumber)) throw new ProviderError("the SEC answer has no recent filings list", { provider: name, code: "BadResponse" });
    const filings = [];
    for (let i = 0; i < r.form.length && filings.length < limit; i++) {
      if (!FORMS.has(r.form[i]) || !/^\d{4}-\d{2}-\d{2}$/.test(r.filingDate[i] || "")) continue;
      const acc = String(r.accessionNumber[i] || "");
      const doc = Array.isArray(r.primaryDocument) ? r.primaryDocument[i] : null;
      filings.push({
        form: r.form[i], filedOn: r.filingDate[i], periodEnd: (Array.isArray(r.reportDate) && r.reportDate[i]) || null, accessionNumber: acc,
        url: acc && doc ? `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${doc}` : null,
      });
    }
    return { ...base, fetchedAt: now().toISOString(), data: { cik, companyName: typeof j.name === "string" ? j.name : null, filings }, raw: { cik, name: j.name ?? null, tickers, recentCount: r.form.length } };
  }

  return { name, hasKey: !!userAgent, callsPer: { filings: 2 }, getFilings, redact: (t) => String(t ?? "") };
}

module.exports = { createSec, FORMS };
