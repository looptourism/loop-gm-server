// ---------------------------------------------------------------------------
// Trading Desk — the database side of Market Monitoring (Stage 3): which
// instruments are watched, storing rates and candles, the run log, and the
// ONE function agents use to read market data (readMarketView).
//
// Every stored row keeps eToro's own timestamp (as_of), when we asked
// (fetched_at), which call it came from (source) and the untouched item (raw).
// ---------------------------------------------------------------------------
const { appendAudit } = require("./store");
const { rateFreshness, candleRange } = require("../market-data");

const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString());

// The instruments the job collects: on an allowlist, active, and verified
// against eToro (linked to an instrument). Nothing else is ever fetched.
async function listMonitored(db) {
  const r = await db.query(
    `select i.instrument_id, i.symbol, i.display_name, i.asset_class, i.exchange
       from trading.instruments i
       join (select instrument_id from trading.stock_allowlist  where active and instrument_id is not null
             union
             select instrument_id from trading.crypto_allowlist where active and instrument_id is not null) a
         on a.instrument_id = i.instrument_id
      order by i.asset_class, i.symbol`
  );
  return r.rows.map((x) => ({ instrumentId: Number(x.instrument_id), symbol: x.symbol, displayName: x.display_name, assetClass: x.asset_class, exchange: x.exchange }));
}

// Stores rates. A rate whose (instrument, eToro timestamp) is already stored
// is skipped: eToro had nothing newer.
async function saveRates(tx, rates, { source, fetchedAt }) {
  if (!rates.length) return { inserted: 0, unchanged: 0 };
  const rows = rates.map((r) => ({ instrument_id: r.instrumentId, as_of: r.asOf, bid: r.bid, ask: r.ask, quote_type: r.quoteType, raw: r.raw }));
  const out = await tx.query(
    `insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at)
     select x.instrument_id, 'rate', x.as_of, x.bid, x.ask, x.quote_type, x.raw, $2, $3
       from jsonb_to_recordset($1::jsonb) as x(instrument_id bigint, as_of timestamptz, bid numeric, ask numeric, quote_type text, raw jsonb)
     on conflict (instrument_id, as_of) where kind = 'rate' do nothing`,
    [JSON.stringify(rows), source, fetchedAt]
  );
  return { inserted: out.rowCount, unchanged: rates.length - out.rowCount };
}

const same = (stored, fresh) => Math.abs(Number(stored) - fresh) <= 1e-9 * Math.max(1, Math.abs(fresh));

// Stores finished candles for one instrument and interval. New ones are
// inserted. One that is already stored with the same figures is left alone.
// One that eToro has since CHANGED is corrected, and the old and new figures
// go to the permanent audit log — a stored candle never changes silently.
async function saveCandles(tx, { instrumentId, symbol, interval }, candles, { source, fetchedAt }) {
  if (!candles.length) return { inserted: 0, unchanged: 0, revised: 0 };
  const existing = await tx.query(
    `select id, as_of, open, high, low, close from trading.market_snapshots
      where kind = 'candle' and instrument_id = $1 and candle_interval = $2 and as_of = any($3::timestamptz[])`,
    [instrumentId, interval, candles.map((c) => c.asOf)]
  );
  const stored = new Map(existing.rows.map((r) => [iso(r.as_of), r]));
  const fresh = [], revisions = [];
  for (const c of candles) {
    const old = stored.get(c.asOf);
    if (!old) fresh.push(c);
    else if (!(same(old.open, c.open) && same(old.high, c.high) && same(old.low, c.low) && same(old.close, c.close))) revisions.push({ old, c });
  }
  if (fresh.length) {
    await tx.query(
      `insert into trading.market_snapshots (instrument_id, kind, candle_interval, as_of, open, high, low, close, raw, source, fetched_at)
       select $1, 'candle', $2, x."asOf", x.open, x.high, x.low, x.close, x.raw, $4, $5
         from jsonb_to_recordset($3::jsonb) as x("asOf" timestamptz, open numeric, high numeric, low numeric, close numeric, raw jsonb)`,
      [instrumentId, interval, JSON.stringify(fresh), source, fetchedAt]
    );
  }
  for (const { old, c } of revisions) {
    await tx.query(
      `update trading.market_snapshots set open = $2, high = $3, low = $4, close = $5, raw = $6, source = $7, fetched_at = $8, revised_at = now() where id = $1`,
      [old.id, c.open, c.high, c.low, c.close, JSON.stringify(c.raw), source, fetchedAt]
    );
  }
  if (revisions.length) {
    await appendAudit(tx, {
      eventType: "market.candle_revised", entityType: "instrument", entityId: instrumentId, actor: "system:monitor",
      data: { symbol, interval, source, fetchedAt, candles: revisions.map(({ old, c }) => ({
        asOf: c.asOf, snapshotId: old.id,
        was: { open: num(old.open), high: num(old.high), low: num(old.low), close: num(old.close) },
        now: { open: c.open, high: c.high, low: c.low, close: c.close },
      })) },
    });
  }
  return { inserted: fresh.length, unchanged: candles.length - fresh.length - revisions.length, revised: revisions.length };
}

// Start time of the newest stored candle per instrument, for one interval.
async function latestCandleTimes(db, interval) {
  const r = await db.query(
    `select instrument_id, max(as_of) as latest from trading.market_snapshots where kind = 'candle' and candle_interval = $1 group by instrument_id`,
    [interval]
  );
  return new Map(r.rows.map((x) => [Number(x.instrument_id), new Date(x.latest)]));
}

async function recordRun(db, run) {
  await db.query(
    `insert into trading.monitor_runs (kind, candle_interval, trigger, status, started_at, finished_at, instruments, requests, rows_inserted, rows_unchanged, rows_revised, problems)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [run.kind, run.interval || null, run.trigger, run.status, run.startedAt, run.finishedAt, run.instruments, run.requests, run.inserted, run.unchanged, run.revised, JSON.stringify(run.problems)]
  );
}

// When the last fully successful run of this kind started (null = never).
async function lastOkRun(db, kind, interval = null) {
  const r = await db.query(
    `select max(started_at) as t from trading.monitor_runs where kind = $1 and candle_interval is not distinct from $2 and status = 'ok'`,
    [kind, interval]
  );
  return r.rows[0].t ? new Date(r.rows[0].t) : null;
}

async function recentRuns(db, limit = 12) {
  const r = await db.query(
    `select kind, candle_interval, trigger, status, started_at, finished_at, instruments, requests, rows_inserted, rows_unchanged, rows_revised, problems
       from trading.monitor_runs order by started_at desc limit $1`, [limit]
  );
  return r.rows;
}

// What is stored per instrument: newest rate (with its freshness, judged by
// eToro's own timestamp) and how many candles of each interval.
async function coverage(db, { now, rateFreshSec }) {
  const instruments = await listMonitored(db);
  const rates = await db.query(
    `select distinct on (instrument_id) instrument_id, as_of, quote_type, fetched_at
       from trading.market_snapshots where kind = 'rate' order by instrument_id, as_of desc`
  );
  const candles = await db.query(
    `select instrument_id, candle_interval, count(*) as n, min(as_of) as oldest, max(as_of) as newest
       from trading.market_snapshots where kind = 'candle' group by instrument_id, candle_interval`
  );
  const rateBy = new Map(rates.rows.map((r) => [Number(r.instrument_id), r]));
  return instruments.map((i) => {
    const r = rateBy.get(i.instrumentId);
    const f = r ? rateFreshness({ asOf: r.as_of, quoteType: r.quote_type }, now, rateFreshSec) : null;
    const c = {};
    for (const row of candles.rows) if (Number(row.instrument_id) === i.instrumentId) c[row.candle_interval] = { count: Number(row.n), oldest: iso(row.oldest), newest: iso(row.newest) };
    return { symbol: i.symbol, assetClass: i.assetClass, instrumentId: i.instrumentId, rate: r ? { asOf: iso(r.as_of), ageSec: f.ageSec, fresh: f.fresh, quoteType: r.quote_type } : null, candles: c };
  });
}

// ---------------------------------------------------------------------------
// The agents' ONLY door to market data (Stage 4 builds its tools on this).
// It reads stored snapshots and nothing else — it never calls eToro. Every
// figure comes back with its source, eToro's timestamp and the snapshot ID.
// Missing data is returned as null with a reason; nothing is estimated.
// Only an allowlisted, verified instrument can be read.
// ---------------------------------------------------------------------------
async function readMarketView(db, symbol, { now = new Date(), rateFreshSec, dailyCount = 260, hourlyCount = 48 } = {}) {
  const wanted = String(symbol || "").trim().toUpperCase();
  const instrument = (await listMonitored(db)).find((i) => i.symbol === wanted);
  if (!instrument) return { ok: false, symbol: wanted, error: "not an allowlisted, verified instrument" };

  const rateRow = (await db.query(
    `select id, as_of, bid, ask, quote_type, source, fetched_at from trading.market_snapshots
      where kind = 'rate' and instrument_id = $1 order by as_of desc limit 1`, [instrument.instrumentId]
  )).rows[0];
  let rate = null;
  if (rateRow) {
    const f = rateFreshness({ asOf: rateRow.as_of, quoteType: rateRow.quote_type }, now, rateFreshSec);
    rate = {
      snapshotId: rateRow.id, bid: num(rateRow.bid), ask: num(rateRow.ask), quoteType: rateRow.quote_type,
      asOf: iso(rateRow.as_of), ageSec: f.ageSec, fresh: f.fresh, notFreshBecause: f.reasons,
      source: rateRow.source, fetchedAt: iso(rateRow.fetched_at),
    };
  }

  const series = async (interval, count) => {
    const rows = (await db.query(
      `select id, as_of, open, high, low, close, source, fetched_at, revised_at from trading.market_snapshots
        where kind = 'candle' and instrument_id = $1 and candle_interval = $2 order by as_of desc limit $3`,
      [instrument.instrumentId, interval, count]
    )).rows.reverse();
    const candles = rows.map((r) => ({ snapshotId: r.id, asOf: iso(r.as_of), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close), source: r.source, fetchedAt: iso(r.fetched_at), revised: r.revised_at !== null }));
    return { interval, finishedCandlesOnly: true, volume: "not provided: eToro's candle volume is unreliable", range: candleRange(candles), candles };
  };

  return {
    ok: true, instrument, readAt: now.toISOString(),
    rate, rateMissing: rate ? null : "no rate has been stored for this instrument yet",
    daily: await series("OneDay", dailyCount),
    hourly: await series("OneHour", hourlyCount),
  };
}

module.exports = { listMonitored, saveRates, saveCandles, latestCandleTimes, recordRun, lastOkRun, recentRuns, coverage, readMarketView };
