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
  maxDailyLossUsd: 100,
  maxOpenPositions: 10,
  proposalValidHours: 24,                      // a draft proposal expires after this
  approvalValidMinutes: 15,                    // an approval request expires after this (Stage 5)
};

module.exports = { POLICY };
