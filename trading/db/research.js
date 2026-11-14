// ---------------------------------------------------------------------------
// Trading Desk — the database side of research data: storing what the
// providers return, and the ONE function agents use to read it
// (readResearchView). Like readMarketView, it reads stored rows only and
// never calls a provider.
// ---------------------------------------------------------------------------
const crypto = require("crypto");
const { listMonitored } = require("./snapshots");

const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString());

// JSON with object keys in a fixed order, so the same answer always hashes the same.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}
const hashOf = (data) => crypto.createHash("sha256").update(stable(data)).digest("hex");

// Stores one provider answer. Unchanged since the last stored answer → only
// last_confirmed_at moves. Changed → a new row; the old one stays as history.
async function saveResearch(tx, { instrumentId, capability, provider, data, raw, source, fetchedAt }) {
  const hash = hashOf(data);
  const last = (await tx.query(
    `select id, data_hash from trading.research_snapshots
      where instrument_id = $1 and capability = $2 and provider = $3 order by fetched_at desc limit 1`,
    [instrumentId, capability, provider]
  )).rows[0];
  if (last && last.data_hash === hash) {
    await tx.query("update trading.research_snapshots set last_confirmed_at = greatest(last_confirmed_at, $2) where id = $1", [last.id, fetchedAt]);
    return "unchanged";
  }
  await tx.query(
    `insert into trading.research_snapshots (instrument_id, capability, provider, data, data_hash, raw, source, fetched_at, last_confirmed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [instrumentId, capability, provider, JSON.stringify(data), hash, JSON.stringify(raw ?? {}), source, fetchedAt]
  );
  return "inserted";
}

// Stores news articles; one already stored (same provider, instrument and ID) is skipped.
async function saveNews(tx, { assetClass, instrumentId = null, provider, items, source, fetchedAt }) {
  const rows = items.map((n) => ({
    external_id: String(n.id ?? n.url ?? ""), headline: n.headline, summary: n.summary ?? null, url: n.url ?? null,
    publisher: n.publisher ?? null, published_at: n.publishedAt, raw: n.raw ?? {},
  })).filter((r) => r.external_id && r.headline && r.published_at);
  if (!rows.length) return { inserted: 0, unchanged: 0 };
  const out = await tx.query(
    `insert into trading.news_items (asset_class, instrument_id, provider, external_id, headline, summary, url, publisher, published_at, raw, source, fetched_at)
     select $1, $2, $3, x.external_id, x.headline, x.summary, x.url, x.publisher, x.published_at, x.raw, $5, $6
       from jsonb_to_recordset($4::jsonb) as x(external_id text, headline text, summary text, url text, publisher text, published_at timestamptz, raw jsonb)
     on conflict do nothing`,
    [assetClass, instrumentId, provider, JSON.stringify(rows), source, fetchedAt]
  );
  return { inserted: out.rowCount, unchanged: rows.length - out.rowCount };
}

// When the last run of this kind that stored something started (null = never).
async function lastUsefulRun(db, kind) {
  const r = await db.query("select max(started_at) as t from trading.monitor_runs where kind = $1 and status in ('ok', 'partial')", [kind]);
  return r.rows[0].t ? new Date(r.rows[0].t) : null;
}

// What is stored per instrument, for the status page.
async function researchCoverage(db) {
  const instruments = await listMonitored(db);
  const snaps = await db.query(
    `select distinct on (instrument_id, capability) instrument_id, capability, provider, fetched_at, last_confirmed_at
       from trading.research_snapshots order by instrument_id, capability, fetched_at desc`
  );
  const news = await db.query("select instrument_id, count(*) as n, max(published_at) as newest from trading.news_items where instrument_id is not null group by instrument_id");
  const general = await db.query("select asset_class, count(*) as n, max(published_at) as newest from trading.news_items where instrument_id is null group by asset_class");
  const newsBy = new Map(news.rows.map((r) => [Number(r.instrument_id), r]));
  return {
    instruments: instruments.map((i) => {
      const caps = {};
      for (const s of snaps.rows) if (Number(s.instrument_id) === i.instrumentId) caps[s.capability] = { provider: s.provider, since: iso(s.fetched_at), lastConfirmed: iso(s.last_confirmed_at) };
      const n = newsBy.get(i.instrumentId);
      return { symbol: i.symbol, assetClass: i.assetClass, ...caps, news: n ? { articles: Number(n.n), newest: iso(n.newest) } : null };
    }),
    generalNews: Object.fromEntries(general.rows.map((r) => [r.asset_class, { articles: Number(r.n), newest: iso(r.newest) }])),
  };
}

// ---------------------------------------------------------------------------
// The agents' door to research data (Stage 4 builds its tools on this).
// Stored rows only. Each block carries provider, source and timestamps; a
// capability with nothing stored is null with a reason — never estimated.
// Only an allowlisted, verified instrument can be read.
// ---------------------------------------------------------------------------
async function readResearchView(db, symbol, { newsLimit = 30 } = {}) {
  const wanted = String(symbol || "").trim().toUpperCase();
  const instrument = (await listMonitored(db)).find((i) => i.symbol === wanted);
  if (!instrument) return { ok: false, symbol: wanted, error: "not an allowlisted, verified instrument" };
  const snaps = (await db.query(
    `select distinct on (capability) id, capability, provider, data, source, fetched_at, last_confirmed_at
       from trading.research_snapshots where instrument_id = $1 order by capability, fetched_at desc`, [instrument.instrumentId]
  )).rows;
  const out = { ok: true, instrument };
  for (const c of ["profile", "fundamentals", "earnings", "filings"]) {
    const s = snaps.find((x) => x.capability === c);
    out[c] = s ? { snapshotId: s.id, provider: s.provider, source: s.source, fetchedAt: iso(s.fetched_at), lastConfirmedAt: iso(s.last_confirmed_at), data: s.data } : null;
  }
  out.missing = ["profile", "fundamentals", "earnings", "filings"].filter((c) => out[c] === null).map((c) => `${c}: nothing stored`);
  const shape = (n) => ({ newsId: n.id, headline: n.headline, summary: n.summary, url: n.url, publisher: n.publisher, publishedAt: iso(n.published_at), provider: n.provider, source: n.source, fetchedAt: iso(n.fetched_at) });
  out.news = (await db.query(
    "select id, headline, summary, url, publisher, published_at, provider, source, fetched_at from trading.news_items where instrument_id = $1 order by published_at desc limit $2",
    [instrument.instrumentId, newsLimit]
  )).rows.map(shape);
  out.generalNews = {
    note: `general ${instrument.assetClass} headlines, not specific to ${instrument.symbol}`,
    items: (await db.query(
      "select id, headline, summary, url, publisher, published_at, provider, source, fetched_at from trading.news_items where instrument_id is null and asset_class = $1 order by published_at desc limit $2",
      [instrument.assetClass, newsLimit]
    )).rows.map(shape),
  };
  return out;
}

module.exports = { hashOf, saveResearch, saveNews, lastUsefulRun, researchCoverage, readResearchView };
