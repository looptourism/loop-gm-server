// ---------------------------------------------------------------------------
// TRADING POLICY — the one file that holds the owner's limits.
//
// Stage 4 only SHOWS these to the agents, so their suggestions are sized
// sensibly. They are not enforced here. Enforcement is the Stage 5 risk
// engine: plain code that reads this file and cannot be overridden by any
// agent. An agent proposing more than a limit simply produces a draft that
// the engine will reject.
// ---------------------------------------------------------------------------
const POLICY = {
  environment: "demo",
  assetClasses: ["stock", "crypto"],           // no ETFs
  direction: "buy",                            // long only, no short selling
  leverage: 1,
  maxPerTradeUsd: { stock: 500, crypto: 250 },
  maxTotalExposureUsd: 5000,
  maxCryptoExposureUsd: 1500,
  // Owner's decision (2026-11-15): a stock flagged crypto_correlated on the
  // allowlist (MSTR) counts toward the crypto cap as well as the total cap.
  // It stays a stock for the per-trade limit ($500).
  cryptoCorrelatedCountsTowardCryptoCap: true,
  maxDailyLossUsd: 100,
  maxOpenPositions: 10,
  // Owner's decision (2026-11-26, replacing the 1–14-day swing style of
  // 2026-11-16): short-term trades held from a few hours up to two days.
  // Every proposal must state how many HOURS it expects to be held, within
  // this range, and must carry a stop level and a price target. A position
  // still open after `max` hours is flagged by the position monitor, which
  // asks the owner to approve the close — nothing is closed by itself.
  style: "intraday",
  holdingHours: { min: 1, max: 48 },
  // eToro's fees, so that a target is only worth trading if it clears them
  // (etoro.com/trading/fees, read 2026-11-26): stocks $1 or $2 per side
  // depending on the country — the higher figure is used; crypto 1% per side.
  // The risk engine requires the gain at the target to be at least
  // `hurdleMultiple` times the round-trip fees.
  fees: { stockPerSideUsd: 2, cryptoPerSidePct: 1, hurdleMultiple: 2 },
  // Stage 5 — rules of the risk engine and the execution gateway.
  onePositionPerInstrument: true,              // no second position in an instrument that is already held
  execution: {
    priceMaxAgeSec: 180,                       // the live price must be this recent when the order is sent (eToro's "realtime" rates were seen 40–70 s old)
    maxPriceDriftPct: 3,                       // refuse if the price moved more than this since the approval request was sent
    lookupGiveUpMinutes: 10,                   // an order whose fate is unknown and that eToro still has no record of after this long is marked failed
  },
  // /trade_test — a small trade the owner starts by hand to prove the path
  // from proposal to position. No agent analyses it, so its stop and holding
  // period are set by these fixed rules. It goes through the same risk
  // engine, the same approval and the same gateway as any other proposal
  // (only the fee/target check does not apply: it has no target).
  testTrade: { maxUsd: 50, stopPctBelowBid: 5, holdingHours: 24 },
  // Telegram quiet hours: no approval request is sent inside this window;
  // proposals wait and still expire normally. null = no quiet hours.
  // Example: { start: "23:00", end: "07:00", timeZone: "Asia/Dubai" }
  quietHours: null,
  proposalValidHours: 24,                      // a draft proposal expires after this
  approvalValidMinutes: 15,                    // an approval request expires after this (Stage 5)
};

module.exports = { POLICY };
