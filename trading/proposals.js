// ---------------------------------------------------------------------------
// The fingerprint of a proposal's exact trade parameters (HARD RULE 3).
// An approval is bound to this hash: if the instrument, direction, amount,
// order type, limit price, leverage, expiry or the position to close differ
// in any way, the hash differs and the approval does not apply.
// The text that is hashed is fixed-format, so the same parameters always give
// the same hash, on any machine.
// ---------------------------------------------------------------------------
const crypto = require("crypto");

const money = (n) => Number(n).toFixed(2);

function canonicalParams({ action, instrumentId, direction, leverage, orderType, limitRate = null, amountUsd, positionId = null, expiresAt }) {
  const expiry = new Date(expiresAt);
  if (!["open", "close"].includes(action)) throw new Error("proposal: action must be open or close");
  if (!Number.isInteger(instrumentId) || instrumentId <= 0) throw new Error("proposal: invalid instrument");
  if (direction !== "buy") throw new Error("proposal: direction must be buy");
  if (leverage !== 1) throw new Error("proposal: leverage must be 1");
  if (!["market", "limit"].includes(orderType)) throw new Error("proposal: order type must be market or limit");
  if ((orderType === "limit") !== (limitRate !== null)) throw new Error("proposal: a limit price is required for limit orders only");
  if (!(Number.isFinite(amountUsd) && amountUsd > 0)) throw new Error("proposal: amount must be above zero");
  if (Number.isNaN(expiry.getTime())) throw new Error("proposal: invalid expiry");
  return ["v1", action, instrumentId, direction, leverage, orderType, limitRate === null ? "" : String(Number(limitRate)), money(amountUsd), positionId || "", expiry.toISOString()].join("|");
}

const paramsHash = (params) => crypto.createHash("sha256").update(canonicalParams(params)).digest("hex");

module.exports = { canonicalParams, paramsHash };
