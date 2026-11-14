// ---------------------------------------------------------------------------
// The provider layer: one interface, any provider behind it.
//
// Callers never name a provider. They ask
//     providers.get("stock", "news").getNews("MSTR")
// and the table DATA_PROVIDERS in trading/config.js decides who answers.
//
// The interface every adapter implements (a provider may offer only some):
//   getProfile(symbol)       → data: { name, exchange, country, currency, industry, ipoDate, … } | null
//   getFundamentals(symbol)  → data: { peTtm, epsTtm, netMarginTtmPct, … } | null
//   getEarnings(symbol)      → data: { history: [...], upcoming: [...] }
//   getNews(symbol, {days})  → data: [{ headline, summary, url, publisher, publishedAt }]
//   getFilings(symbol)       → data: { companyName, filings: [{ form, filedOn, url }] } | null
//   getMarketNews(class)     → data: [news items] — general headlines, not per instrument
// Each answer: { provider, capability, symbol, data, source, fetchedAt, raw }.
//
// Adding a provider (e.g. Financial Modeling Prep for Option B) = one adapter
// file with these functions + one line in ADAPTERS below. After that, moving
// a capability to it is a one-word change in DATA_PROVIDERS. Nothing that
// uses the layer changes.
//
// Every call goes through call(), which applies the provider's request
// ceiling (PROVIDER_LIMITS) — one limiter per provider, shared by the
// collection job, the coverage test and the test routes.
//
// Fail closed: an unknown provider name, a missing key or a capability the
// adapter does not have makes get() throw. There is no automatic fallback to
// another provider — a silent switch of data source would break "every
// figure carries its source".
// ---------------------------------------------------------------------------
const { DATA_PROVIDERS, PROVIDER_LIMITS, readConfig } = require("../config");
const { createLimiter } = require("../rate-limiter");
const { createFinnhub, ProviderError } = require("./finnhub");
const { createCoinGecko } = require("./coingecko");
const { createSec } = require("./sec");

const ADAPTERS = {
  finnhub: (config, deps) => createFinnhub({ apiKey: config.providerKeys?.finnhub || "", ...deps }),
  coingecko: (config, deps) => createCoinGecko({ apiKey: config.providerKeys?.coingecko || "", ...deps }),
  sec: (config, deps) => createSec({ userAgent: config.providerKeys?.sec || "", ...deps }),
};

const METHOD = { profile: "getProfile", fundamentals: "getFundamentals", earnings: "getEarnings", news: "getNews", filings: "getFilings", marketNews: "getMarketNews" };
const PER_CLASS = new Set(["marketNews"]); // asked once per asset class, not once per instrument
const DEFAULT_LIMIT = { perMinute: 10, minGapMs: 3000 };

function createProviders({ config = readConfig(), table = DATA_PROVIDERS, adapters = ADAPTERS, deps = {}, limits = PROVIDER_LIMITS,
  limiterFor = (name) => createLimiter({ ...(limits[name] || DEFAULT_LIMIT), reserve: 0 }) } = {}) {
  const built = new Map();
  const limiters = new Map();
  const sent = {};
  const adapter = (name) => {
    if (!built.has(name)) built.set(name, adapters[name] ? adapters[name](config, deps) : null);
    return built.get(name);
  };
  const limiter = (name) => { if (!limiters.has(name)) limiters.set(name, limiterFor(name)); return limiters.get(name); };

  function get(assetClass, capability) {
    const name = table[assetClass]?.[capability];
    if (!name) throw new ProviderError(`no provider is configured for ${assetClass} ${capability}`, { code: "NotConfigured" });
    const a = adapter(name);
    if (!a) throw new ProviderError(`provider "${name}" is named in the config but has no adapter`, { provider: name, code: "UnknownProvider" });
    if (typeof a[METHOD[capability]] !== "function") throw new ProviderError(`provider "${name}" does not offer ${capability}`, { provider: name, code: "NotOffered" });
    if (!a.hasKey) throw new ProviderError(`the API key for "${name}" is not set on the server`, { provider: name, code: "MissingKey" });
    return a;
  }

  // The one way to ask a provider something: waits for that provider's
  // limiter, counts the requests, and pauses the provider after a 429.
  async function call(assetClass, capability, arg, opts) {
    const a = get(assetClass, capability);
    const lim = limiter(a.name);
    const n = a.callsPer?.[capability] || 1;
    for (let i = 0; i < n; i++) await lim.take();
    sent[a.name] = (sent[a.name] || 0) + n;
    try { return await a[METHOD[capability]](arg, opts); }
    catch (e) { if (e?.code === "RateLimited") lim.pause(Math.max(5 * 60 * 1000, (e.retryAfterSec || 0) * 1000)); throw e; }
  }

  // The capabilities configured for an asset class: per instrument, or per class.
  const capabilitiesFor = (assetClass, { perClass = false } = {}) => Object.keys(table[assetClass] || {}).filter((c) => METHOD[c] && PER_CLASS.has(c) === perClass);
  const providerOf = (assetClass, capability) => table[assetClass]?.[capability] || null;

  // What is configured, and whether it can be used. No network.
  function status() {
    const out = {};
    for (const [assetClass, caps] of Object.entries(table)) {
      out[assetClass] = {};
      for (const [capability, name] of Object.entries(caps)) {
        const a = adapter(name);
        out[assetClass][capability] = { provider: name, adapter: !!a, keySet: !!a?.hasKey, usable: !!a && a.hasKey && typeof a[METHOD[capability]] === "function" };
      }
    }
    return out;
  }

  const redact = (t) => { let out = String(t ?? ""); for (const a of built.values()) if (a?.redact) out = a.redact(out); return out; };
  const requests = () => ({ ...sent });
  const coreFundamentals = (assetClass) => { const n = providerOf(assetClass, "fundamentals"); return (n && adapter(n)?.coreFundamentals) || null; };

  return { get, call, status, redact, capabilitiesFor, providerOf, requests, coreFundamentals };
}

module.exports = { createProviders, ProviderError, ADAPTERS };
