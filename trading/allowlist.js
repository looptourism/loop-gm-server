// ---------------------------------------------------------------------------
// The owner's allowlists, exactly as given (2026-11-13). This file is the
// seed; the database tables stock_allowlist / crypto_allowlist are what the
// risk engine will read.
//
// The server makes NO Sharia judgment. The stock list is screened by the
// owner; the code only records it and checks that each symbol exists on
// eToro. A symbol is tradable only after a real eToro search returned
// exactly one instrument of the right asset class for it.
//
// cryptoCorrelated: a stock whose price follows crypto (MSTR holds Bitcoin).
// Stage 5 decides whether such a stock also counts toward the crypto cap.
// ---------------------------------------------------------------------------
const STOCKS = [
  { symbol: "MSTR", cryptoCorrelated: true },
  { symbol: "BABA" }, { symbol: "ADBE" }, { symbol: "ORCL" }, { symbol: "NKE" },
  { symbol: "TTD" }, { symbol: "HIMS" }, { symbol: "NEM" }, { symbol: "INTU" },
  { symbol: "GRAB" }, { symbol: "NVO" }, { symbol: "TMDX" }, { symbol: "PLAB" },
  { symbol: "VISN" }, { symbol: "WYFI" }, { symbol: "SE" }, { symbol: "AMPX" },
  { symbol: "GRRR" }, { symbol: "MRAM" }, { symbol: "ENPH" }, { symbol: "INOD" },
  { symbol: "OPTT" },
];

const CRYPTO = ["FET", "ATOM", "BTC", "SUI", "SOL", "XRP", "ADA", "ETH", "DOGE"].map((symbol) => ({ symbol }));

function seedAllowlist() {
  return [
    ...STOCKS.map((s) => ({ symbol: s.symbol, assetClass: "stock", cryptoCorrelated: s.cryptoCorrelated === true })),
    ...CRYPTO.map((c) => ({ symbol: c.symbol, assetClass: "crypto", cryptoCorrelated: false })),
  ];
}

module.exports = { seedAllowlist };
