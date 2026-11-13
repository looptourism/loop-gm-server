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
// Each answer: { provider, capability, symbol, data, source, fetchedAt, raw }.
//
// Adding a provider (e.g. Financial Modeling Prep for Option B) = one adapter
// file with these functions + one line in ADAPTERS below. After that, moving
// a capability to it is a one-word change in DATA_PROVIDERS. Nothing that
// uses the layer changes.
//
// Fail closed: an unknown provider name, a missing key or a capability the
// adapter does not have makes get() throw. There is no automatic fallback to
// another provider — a silent switch of data source would break "every
// figure carries its source".
// ---------------------------------------------------------------------------
const { DATA_PROVIDERS, readConfig } = require("../config");
const { createFinnhub, ProviderError } = require("./finnhub");

const ADAPTERS = {
  finnhub: (config, deps) => createFinnhub({ apiKey: config.providerKeys?.finnhub || "", ...deps }),
};

const METHOD = { profile: "getProfile", fundamentals: "getFundamentals", earnings: "getEarnings", news: "getNews" };

function createProviders({ config = readConfig(), table = DATA_PROVIDERS, adapters = ADAPTERS, deps = {} } = {}) {
  const built = new Map();
  const adapter = (name) => {
    if (!built.has(name)) built.set(name, adapters[name] ? adapters[name](config, deps) : null);
    return built.get(name);
  };

  function get(assetClass, capability) {
    const name = table[assetClass]?.[capability];
    if (!name) throw new ProviderError(`no provider is configured for ${assetClass} ${capability}`, { code: "NotConfigured" });
    const a = adapter(name);
    if (!a) throw new ProviderError(`provider "${name}" is named in the config but has no adapter`, { provider: name, code: "UnknownProvider" });
    if (typeof a[METHOD[capability]] !== "function") throw new ProviderError(`provider "${name}" does not offer ${capability}`, { provider: name, code: "NotOffered" });
    if (!a.hasKey) throw new ProviderError(`the API key for "${name}" is not set on the server`, { provider: name, code: "MissingKey" });
    return a;
  }

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

  return { get, status, redact, capabilities: Object.keys(METHOD), method: (capability) => METHOD[capability] };
}

module.exports = { createProviders, ProviderError, ADAPTERS };
