// ---------------------------------------------------------------------------
// The desk's trading horizon (owner, 2026-11-26): hours, up to two days.
// Small helpers shared by the agents' validator, the risk engine, the
// execution gateway and the position monitor, so they all read a plan the
// same way. Plain code, no trading imports.
// ---------------------------------------------------------------------------
const HOUR = 3600 * 1000;

// Planned holding period in hours. Proposals written before 2026-11-26 carry
// whole days instead (holding_days); those are read as days × 24.
function holdingHoursOf(details) {
  const d = details || {};
  if (Number.isInteger(d.holding_hours)) return d.holding_hours;
  if (Number.isInteger(d.holding_days)) return d.holding_days * 24;
  return null;
}

// An exit or revisit time: either a date "YYYY-MM-DD" (UTC, the whole day) or
// an exact time "YYYY-MM-DDTHH:MM[:SS]Z" / with an offset such as +04:00.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const isExitTime = (s) => typeof s === "string" && (DATE_RE.test(s) || TIME_RE.test(s)) && !Number.isNaN(Date.parse(DATE_RE.test(s) ? `${s}T00:00:00Z` : s));
// { start, end } in ms: a date covers its whole UTC day; an exact time is one instant.
function exitWindow(s) {
  if (!isExitTime(s)) return null;
  if (DATE_RE.test(s)) return { start: Date.parse(`${s}T00:00:00Z`), end: Date.parse(`${s}T23:59:59Z`) };
  const t = Date.parse(s);
  return { start: t, end: t };
}

// eToro's fees for opening AND closing a position of `amountUsd`.
function roundTripFeesUsd(assetClass, amountUsd, fees) {
  if (!fees || !(amountUsd > 0)) return null;
  if (assetClass === "crypto") return Math.round(amountUsd * (fees.cryptoPerSidePct / 100) * 2 * 100) / 100;
  if (assetClass === "stock") return fees.stockPerSideUsd * 2;
  return null;
}

// For messages: a date stays as it is; an exact time reads "2026-11-27 20:00 UTC".
const showExitTime = (s) => (typeof s === "string" && TIME_RE.test(s) ? new Date(Date.parse(s)).toISOString().slice(0, 16).replace("T", " ") + " UTC" : String(s ?? ""));

module.exports = { HOUR, holdingHoursOf, isExitTime, exitWindow, roundTripFeesUsd, showExitTime };
