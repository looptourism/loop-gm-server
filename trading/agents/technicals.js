// ---------------------------------------------------------------------------
// Technical figures computed by plain code from stored daily candles.
// The agents never do this arithmetic themselves: they receive these numbers
// from a tool, with the candles they were computed from named in `basis`.
//
// A figure that needs more candles than are stored is null — never
// extrapolated. Volume is not used (unreliable on eToro).
// ---------------------------------------------------------------------------
const DAY = 86400000;
const round = (n, d = 4) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function sma(closes, n) { return closes.length >= n ? mean(closes.slice(-n)) : null; }

// Wilder's RSI over `n` periods; needs n + 1 closes.
function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

// `candles`: finished daily candles, oldest first, each { asOf, open, high, low, close }.
// periodsPerYear: 252 for stocks (trading days), 365 for crypto.
function computeTechnicals(candles, { periodsPerYear }) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];
  const lastT = Date.parse(last.asOf);
  // close of the newest candle that is at least `days` calendar days older than the last one
  const closeDaysAgo = (days) => { for (let i = candles.length - 1; i >= 0; i--) if (lastT - Date.parse(candles[i].asOf) >= days * DAY) return candles[i].close; return null; };
  const change = (days) => { const c = closeDaysAgo(days); return c === null ? null : round(((last.close - c) / c) * 100, 2); };
  const within = (days) => candles.filter((c) => lastT - Date.parse(c.asOf) < days * DAY);

  const rets = [];
  const recent = candles.slice(-31);
  for (let i = 1; i < recent.length; i++) rets.push(Math.log(recent[i].close / recent[i - 1].close));
  let vol = null;
  if (rets.length >= 20) { const m = mean(rets); vol = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1)) * Math.sqrt(periodsPerYear) * 100; }

  const year = within(365);
  const coversYear = lastT - Date.parse(candles[0].asOf) >= 358 * DAY;
  const high = Math.max(...year.map((c) => c.high)), low = Math.min(...year.map((c) => c.low));
  // worst peak-to-trough fall of the close within the last 90 days
  let peak = -Infinity, maxDd = 0;
  for (const c of within(90)) { peak = Math.max(peak, c.close); maxDd = Math.min(maxDd, (c.close - peak) / peak); }
  const trs = [];
  for (let i = Math.max(1, candles.length - 14); i < candles.length; i++) trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const vs = (avg) => (avg === null ? null : round(((last.close - avg) / avg) * 100, 2));

  return {
    basis: { interval: "OneDay", finishedCandles: candles.length, from: candles[0].asOf, to: last.asOf, note: "computed by Trading Desk code from stored eToro candles; volume is not used" },
    lastClose: last.close,
    changePct: { d1: change(1), d7: change(7), d30: change(30), d90: change(90), d365: change(365) },
    sma: { d20: round(s20), d50: round(s50), d200: round(s200) },
    closeVsSmaPct: { d20: vs(s20), d50: vs(s50), d200: vs(s200) },
    rsi14: round(rsi(closes, 14), 1),
    volatility30dAnnualizedPct: round(vol, 1),
    atr14Pct: trs.length === 14 ? round((mean(trs) / last.close) * 100, 2) : null,
    range365d: { high, low, belowHighPct: round(((last.close - high) / high) * 100, 2), aboveLowPct: round(((last.close - low) / low) * 100, 2), coversFullYear: coversYear },
    maxDrawdown90dPct: round(maxDd * 100, 2),
  };
}

module.exports = { computeTechnicals, sma, rsi };
