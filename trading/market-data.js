// ---------------------------------------------------------------------------
// Turns eToro's raw rates and candles into figures that are safe to store.
// Pure functions: no network, no database, no clock of their own.
//
// Every rule here comes from what the real API was seen to do
// (docs/trading-desk-etoro-api.md, "Observed in the real responses"):
//   * timestamps without a timezone are UTC — never local time;
//   * a rate's age is measured from eToro's own `date`, not from when we
//     asked, and "realtime" alone does not mean fresh;
//   * the newest candle may still be forming — it is dropped;
//   * candle volume is unreliable — it is never read;
//   * eToro's rangeOpen / rangeClose are reversed with `desc` — ranges are
//     computed from the candles themselves.
// Anything that is missing or does not add up is rejected with a reason.
// Nothing is repaired, filled in or guessed.
// ---------------------------------------------------------------------------
const MINUTE = 60 * 1000;
const INTERVAL_MS = {
  OneMinute: MINUTE, FiveMinutes: 5 * MINUTE, TenMinutes: 10 * MINUTE, FifteenMinutes: 15 * MINUTE,
  ThirtyMinutes: 30 * MINUTE, OneHour: 60 * MINUTE, FourHours: 240 * MINUTE,
  OneDay: 1440 * MINUTE, OneWeek: 7 * 1440 * MINUTE,
};

class MarketDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "MarketDataError";
    this.code = "BadMarketData";
  }
}

// eToro timestamp → Date, always read as UTC. "2026-11-13T05:41:23.053" has
// no zone; JavaScript would read that as LOCAL time, so the zone is added
// here. A value that already carries Z or an offset keeps it.
function parseUtc(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim());
  if (!m) return null;
  const [, day, hm, sec = "00", frac = "", zone] = m;
  const ms = (frac + "000").slice(0, 3);
  const z = !zone ? "Z" : /^z$/i.test(zone) ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const d = new Date(`${day}T${hm}:${sec}.${ms}${z}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const price = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

// One item of /api/v2/market-data/rates → { ok, rate } or { ok: false, reason }.
function normalizeRate(item) {
  if (!item || typeof item !== "object") return { ok: false, reason: "not an object" };
  if (!Number.isInteger(item.instrumentId)) return { ok: false, reason: "no instrumentId" };
  if (!price(item.bid) || !price(item.ask)) return { ok: false, reason: "bid or ask is missing" };
  if (item.ask < item.bid) return { ok: false, reason: "ask is below bid" };
  const asOf = parseUtc(item.date);
  if (!asOf) return { ok: false, reason: "no usable timestamp" };
  const quoteType = typeof item.quoteType === "string" ? item.quoteType : null;
  return { ok: true, rate: { instrumentId: item.instrumentId, bid: item.bid, ask: item.ask, asOf: asOf.toISOString(), quoteType, raw: item } };
}

// How old a rate is, judged ONLY by eToro's own timestamp for it.
// Fresh = marked realtime, and no older than maxAgeSec. A timestamp more
// than a minute in the future means a clock is wrong: not fresh.
function rateFreshness({ asOf, quoteType }, now, maxAgeSec) {
  const t = asOf instanceof Date ? asOf : new Date(asOf);
  const ageSec = Math.round((now.getTime() - t.getTime()) / 1000);
  const reasons = [];
  if (!Number.isFinite(ageSec)) reasons.push("no timestamp");
  else if (ageSec > maxAgeSec) reasons.push(`the price is ${ageSec} s old (limit ${maxAgeSec} s)`);
  else if (ageSec < -60) reasons.push("the price is dated in the future");
  if (quoteType !== "realtime") reasons.push(`quote type is ${quoteType || "unknown"}, not realtime`);
  return { ageSec: Number.isFinite(ageSec) ? ageSec : null, fresh: reasons.length === 0, reasons };
}

// The answer of the candle-history call → finished, valid candles, oldest
// first. `now` decides what "finished" means: a candle is kept only when its
// whole period (fromDate + interval) lies in the past.
function normalizeCandles(data, { instrumentId, interval, now }) {
  const size = INTERVAL_MS[interval];
  if (!size) throw new MarketDataError(`unknown interval ${interval}`);
  if (!data || typeof data !== "object" || !Array.isArray(data.candles)) throw new MarketDataError("eToro's answer has no candle list");
  if (data.interval !== undefined && data.interval !== interval) throw new MarketDataError(`asked for ${interval}, eToro answered ${data.interval}`);
  const group = data.candles.find((g) => g && g.instrumentId === instrumentId);
  if (!group || !Array.isArray(group.candles)) throw new MarketDataError(`eToro's answer has no candles for instrument ${instrumentId}`);

  const dropped = { unfinished: 0, invalid: 0, duplicate: 0 };
  const byTime = new Map();
  for (const c of group.candles) {
    const from = c && typeof c === "object" ? parseUtc(c.fromDate) : null;
    const ok = from && price(c.open) && price(c.high) && price(c.low) && price(c.close)
      && c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close)
      && (c.instrumentID === undefined || c.instrumentID === instrumentId);
    if (!ok) { dropped.invalid++; continue; }
    if (from.getTime() + size > now.getTime()) { dropped.unfinished++; continue; }
    if (byTime.has(from.getTime())) { dropped.duplicate++; continue; }
    // volume is deliberately not read (unreliable on eToro); it stays only inside `raw`
    byTime.set(from.getTime(), { asOf: from.toISOString(), open: c.open, high: c.high, low: c.low, close: c.close, raw: c });
  }
  const candles = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  return { candles, dropped, received: group.candles.length };
}

// Range figures computed from the candles themselves (any order in, sorted
// here). Never from eToro's rangeOpen / rangeClose.
function candleRange(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const sorted = [...candles].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  const first = sorted[0], last = sorted[sorted.length - 1];
  return {
    count: sorted.length,
    from: first.asOf,          // start of the oldest candle
    to: last.asOf,             // start of the newest finished candle
    open: first.open,
    close: last.close,
    high: Math.max(...sorted.map((c) => c.high)),
    low: Math.min(...sorted.map((c) => c.low)),
    changePct: Math.round(((last.close - first.open) / first.open) * 1e6) / 1e4,
  };
}

module.exports = { INTERVAL_MS, MarketDataError, parseUtc, normalizeRate, rateFreshness, normalizeCandles, candleRange };
