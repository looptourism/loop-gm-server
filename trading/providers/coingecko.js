// ---------------------------------------------------------------------------
// CoinGecko adapter — READ-ONLY. Crypto fundamentals only (market cap, rank,
// supply). CoinGecko has nothing for stocks.
//
// Confirmed by real calls from the Render server on 2026-11-14: path,
// header, field names, and all nine coin IDs below.
//
// CoinGecko identifies coins by its own IDs, not by ticker — and several
// coins can share a ticker. So the mapping below is explicit, and every
// answer is checked: if the coin CoinGecko returns does not carry our ticker,
// the answer is refused rather than stored under the wrong name.
// ---------------------------------------------------------------------------
const { ProviderError } = require("./finnhub");

const BASE_URL = "https://api.coingecko.com/api/v3";
const TIMEOUT_MS = 20000;

// Our ticker (eToro's symbol) → CoinGecko coin ID.
const COIN_IDS = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple", ADA: "cardano",
  DOGE: "dogecoin", ATOM: "cosmos", SUI: "sui", FET: "fetch-ai",
};

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function createCoinGecko({ apiKey = "", fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const name = "coingecko";
  const redact = (t) => { const out = String(t ?? ""); return apiKey.length >= 8 ? out.split(apiKey).join("[redacted]") : out; };

  async function getFundamentals(symbol) {
    const s = String(symbol || "").trim().toUpperCase();
    const id = COIN_IDS[s];
    if (!id) throw new ProviderError(`no CoinGecko ID is mapped for ${s || "this symbol"}`, { provider: name, code: "BadInput" });
    if (!apiKey) throw new ProviderError("COINGECKO_API_KEY is not set", { provider: name, code: "MissingKey" });
    const url = new URL(`${BASE_URL}/coins/markets`);
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("ids", id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res, body;
    try {
      res = await fetchImpl(url, { method: "GET", headers: { "x-cg-demo-api-key": apiKey, Accept: "application/json" }, signal: controller.signal });
      body = await res.text();
    } catch (e) {
      throw new ProviderError(e.name === "AbortError" ? `CoinGecko did not answer within ${TIMEOUT_MS / 1000}s` : redact(`network error: ${e.message}`), { provider: name, code: e.name === "AbortError" ? "Timeout" : "Network" });
    } finally { clearTimeout(timer); }
    let json;
    try { json = JSON.parse(body); } catch { json = undefined; }
    if (!res.ok) {
      const code = res.status === 429 ? "RateLimited" : res.status === 401 ? "BadKey" : res.status === 403 ? "NotInPlan" : "HttpError";
      throw new ProviderError(redact(`CoinGecko ${res.status}`), { provider: name, status: res.status, code });
    }
    if (!Array.isArray(json)) throw new ProviderError("CoinGecko returned a response that is not a list", { provider: name, status: res.status, code: "BadResponse" });
    const c = json.find((x) => x && x.id === id);
    const base = { provider: name, capability: "fundamentals", symbol: s, source: "CoinGecko GET /api/v3/coins/markets", fetchedAt: now().toISOString(), raw: c || null };
    if (!c) return { ...base, data: null };
    if (String(c.symbol || "").toUpperCase() !== s) {
      throw new ProviderError(`CoinGecko's "${id}" has ticker ${String(c.symbol).toUpperCase()}, not ${s} — the ID mapping is wrong`, { provider: name, code: "WrongCoin" });
    }
    return {
      ...base,
      data: {
        coinGeckoId: id, name: typeof c.name === "string" ? c.name : null,
        priceUsd: finite(c.current_price),            // CoinGecko's price — for reference only; eToro's rate is the trading price
        marketCapUsd: finite(c.market_cap), marketCapRank: finite(c.market_cap_rank),
        fullyDilutedValuationUsd: finite(c.fully_diluted_valuation), volume24hUsd: finite(c.total_volume),
        circulatingSupply: finite(c.circulating_supply), totalSupply: finite(c.total_supply),
        maxSupply: finite(c.max_supply),               // null for coins with no fixed maximum (e.g. ETH) — not a gap
        allTimeHighUsd: finite(c.ath), allTimeHighDate: typeof c.ath_date === "string" ? c.ath_date : null,
        providerUpdatedAt: typeof c.last_updated === "string" ? c.last_updated : null,
      },
    };
  }

  return { name, hasKey: !!apiKey, callsPer: { fundamentals: 1 }, coreFundamentals: ["marketCapUsd", "marketCapRank", "circulatingSupply", "totalSupply", "volume24hUsd"], getFundamentals, redact };
}

module.exports = { createCoinGecko, COIN_IDS };
