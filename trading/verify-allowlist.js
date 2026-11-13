// ---------------------------------------------------------------------------
// Checks every allowlisted symbol against eToro's Market Data search.
// Read-only. A symbol counts as verified only when the search returned
// exactly ONE instrument whose internalSymbolFull equals the symbol and
// whose asset class is the one the list expects. Anything else — no match,
// several matches, wrong asset class, a failed call — is reported and left
// unverified. Nothing is guessed.
// ---------------------------------------------------------------------------
const ASSET_CLASS = { stocks: "stock", crypto: "crypto" }; // eToro's internalAssetClassName → ours

const pick = (i) => ({
  instrumentId: i.instrumentId,
  symbol: i.internalSymbolFull,
  displayName: i.displayname ?? null,
  etoroAssetClass: i.internalAssetClassName ?? null,
  exchange: i.internalExchangeName ?? null,
});

function classify(entry, items) {
  const exact = items.filter((i) => i.internalSymbolFull === entry.symbol);
  const candidates = items.map(pick);
  if (exact.length === 0) return { status: "no_match", candidates };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact.map(pick) };
  const found = exact[0];
  if (!Number.isInteger(found.instrumentId) || found.instrumentId <= 0) return { status: "bad_response", candidates };
  const assetClass = ASSET_CLASS[String(found.internalAssetClassName || "").toLowerCase()] || null;
  if (assetClass !== entry.assetClass) return { status: "wrong_asset_class", match: pick(found) };
  return { status: "verified", match: pick(found), raw: found };
}

// `entries` come from seedAllowlist(). One search per symbol, one after the
// other (31 symbols against a quota of 120 per minute). If eToro answers
// 429, the remaining symbols are reported as not checked rather than retried.
async function verifyAllowlist(client, entries) {
  const results = [];
  let stopped = null;
  for (const entry of entries) {
    const base = { symbol: entry.symbol, assetClass: entry.assetClass, cryptoCorrelated: entry.cryptoCorrelated };
    if (stopped) { results.push({ ...base, status: "not_checked", error: stopped }); continue; }
    try {
      const r = await client.searchInstruments(entry.symbol);
      const items = Array.isArray(r.data.items) ? r.data.items : null;
      if (!items) { results.push({ ...base, status: "bad_response", source: r.source, fetchedAt: r.fetchedAt }); continue; }
      results.push({ ...base, ...classify(entry, items), source: r.source, fetchedAt: r.fetchedAt });
    } catch (e) {
      results.push({ ...base, status: "error", error: e.message });
      if (e.status === 429 || e.code === "MissingKeys") stopped = `stopped after ${entry.symbol}: ${e.message}`;
    }
  }
  const verified = results.filter((r) => r.status === "verified");
  return {
    total: results.length,
    verified: verified.length,
    allVerified: verified.length === results.length,
    problems: results.filter((r) => r.status !== "verified").map((r) => `${r.symbol}: ${r.status}`),
    results,
  };
}

module.exports = { verifyAllowlist, classify };
