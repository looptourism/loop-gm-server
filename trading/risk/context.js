// ---------------------------------------------------------------------------
// Gathers the facts the risk engine judges: the proposal, the allowlist, the
// demo account (read live from eToro), other trades in flight, the price,
// and today's loss. Each fact carries where it came from and when.
//
// Nothing here decides anything. If a fact cannot be obtained it is passed on
// as "not ok" with the reason, and the engine fails the check that needs it.
// ---------------------------------------------------------------------------
const { summarizeDemoAccount } = require("../account");
const { parseUtc, rateFreshness } = require("../market-data");
const { MONITORING } = require("../config");

const iso = (v) => (v ? new Date(v).toISOString() : null);
const r2 = (n) => Math.round(n * 100) / 100;

// The runtime stop. Unreadable = stopped.
async function readHalted(db) {
  try {
    const r = await db.query("select value from trading.desk_state where key = 'trading_halted'");
    return r.rows.length ? r.rows[0].value?.halted === true : false;
  } catch { return true; }
}

async function loadProposal(q, proposalId, { forUpdate = false } = {}) {
  const r = await q.query(
    `select p.*, i.symbol, i.display_name from trading.proposals p join trading.instruments i on i.instrument_id = p.instrument_id where p.id = $1${forUpdate ? " for update of p" : ""}`, [proposalId]
  );
  const p = r.rows[0];
  if (!p) return null;
  return {
    id: p.id, action: p.action, instrumentId: Number(p.instrument_id), symbol: p.symbol, displayName: p.display_name, assetClass: p.asset_class, direction: p.direction, leverage: p.leverage,
    orderType: p.order_type, limitRate: p.limit_rate === null ? null : Number(p.limit_rate), amountUsd: Number(p.amount_usd), positionId: p.position_id,
    expiresAt: iso(p.expires_at), paramsHash: p.params_hash, idempotencyKey: p.idempotency_key, status: p.status, details: p.details || {}, createdAt: iso(p.created_at),
  };
}

async function loadAllowlist(db, proposal) {
  const table = proposal.assetClass === "crypto" ? "crypto_allowlist" : proposal.assetClass === "stock" ? "stock_allowlist" : null;
  if (!table) return { listed: false };
  const col = table === "stock_allowlist" ? "crypto_correlated" : "false as crypto_correlated";
  const r = await db.query(`select active, verified_at, asset_class, ${col} from trading.${table} where instrument_id = $1`, [proposal.instrumentId]);
  const a = r.rows[0];
  return a ? { listed: true, active: a.active === true, verified: a.verified_at !== null, assetClass: a.asset_class, cryptoCorrelated: a.crypto_correlated === true } : { listed: false };
}

// The demo account, read live. Positions carry the asset class the desk
// knows for them ("unknown" when the instrument is not in its records).
async function loadAccount(db, client) {
  try {
    const summary = summarizeDemoAccount(await client.getDemoPnl());
    const ids = [...new Set(summary.positions.map((p) => p.instrumentId))];
    const known = ids.length ? (await db.query(
      `select i.instrument_id, i.asset_class, coalesce(s.crypto_correlated, false) as crypto_correlated
         from trading.instruments i left join trading.stock_allowlist s on s.instrument_id = i.instrument_id where i.instrument_id = any($1::bigint[])`, [ids])).rows : [];
    const by = new Map(known.map((k) => [Number(k.instrument_id), k]));
    return {
      ok: true, source: summary.source, fetchedAt: summary.fetchedAt, availableCashUsd: summary.availableCashUsd, investedUsd: summary.investedUsd, unrealizedPnlUsd: summary.unrealizedPnlUsd,
      creditUsd: summary.creditUsd, pendingOrdersUsd: summary.pendingOrdersUsd, copyPortfolios: summary.copyPortfolios,
      // eToro's formula: equity = available cash + total invested (positions + pending orders) + unrealized P/L
      equityUsd: r2(summary.availableCashUsd + summary.investedUsd + summary.pendingOrdersUsd + summary.unrealizedPnlUsd),
      positions: summary.positions.map((p) => { const k = by.get(p.instrumentId); return { positionId: p.positionId, instrumentId: p.instrumentId, amountUsd: p.amountUsd, units: p.units, direction: p.direction, leverage: p.leverage, unrealizedPnlUsd: p.unrealizedPnlUsd, assetClass: k ? k.asset_class : "unknown", cryptoCorrelated: k ? k.crypto_correlated === true : false }; }),
    };
  } catch (e) { return { ok: false, reason: db.redact(client.redact(e?.message || String(e))) }; }
}

// Other proposals that are approved-or-awaiting and not yet positions: their
// money is spoken for.
async function loadCommitments(db) {
  const r = await db.query(
    `select p.id, p.instrument_id, p.amount_usd, p.asset_class, coalesce(s.crypto_correlated, false) as crypto_correlated
       from trading.proposals p left join trading.stock_allowlist s on s.instrument_id = p.instrument_id
      where p.action = 'open' and p.status in ('pending_approval', 'approved', 'executing')`
  );
  return r.rows.map((x) => ({ proposalId: x.id, instrumentId: Number(x.instrument_id), amountUsd: Number(x.amount_usd), assetClass: x.asset_class, cryptoCorrelated: x.crypto_correlated === true }));
}

// Today's loss = the first account snapshot of the UTC day minus the equity
// now. The snapshots come from the 15-minute position check.
async function loadDailyLoss(db, account, now) {
  if (!account.ok) return { ok: false, reason: "the account could not be read" };
  try {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const r = await db.query("select taken_at, equity_usd from trading.account_snapshots where taken_at >= $1 and taken_at <= $2 order by taken_at asc, created_at asc limit 1", [dayStart.toISOString(), now.toISOString()]);
    if (!r.rows.length) return { ok: false, reason: "no account snapshot has been recorded today (position monitoring must be running)" };
    const baseline = Number(r.rows[0].equity_usd);
    return { ok: true, baselineEquityUsd: baseline, baselineAt: iso(r.rows[0].taken_at), equityUsd: account.equityUsd, lossUsd: r2(baseline - account.equityUsd) };
  } catch (e) { return { ok: false, reason: db.redact(e?.message || String(e)) }; }
}

// The newest STORED price (for the approval request).
async function loadStoredPrice(db, instrumentId, now) {
  try {
    const r = (await db.query("select bid, ask, as_of, quote_type, source from trading.market_snapshots where kind = 'rate' and instrument_id = $1 order by as_of desc limit 1", [instrumentId])).rows[0];
    if (!r) return { ok: false, reason: "no price is stored for this instrument" };
    const f = rateFreshness({ asOf: r.as_of, quoteType: r.quote_type }, now, MONITORING.rateFreshSec);
    return { ok: true, bid: Number(r.bid), ask: Number(r.ask), asOf: iso(r.as_of), ageSec: f.ageSec, quoteType: r.quote_type, source: r.source };
  } catch (e) { return { ok: false, reason: db.redact(e?.message || String(e)) }; }
}

// The LIVE price (immediately before an order). A partial answer (206), a
// missing bid or ask, or an unreadable timestamp all mean "no price".
async function loadLivePrice(db, client, instrumentId, now) {
  try {
    const r = await client.getRates([instrumentId]);
    if (r.status !== 200) return { ok: false, reason: `eToro answered ${r.status} for the rate (not a complete answer)` };
    const item = (Array.isArray(r.data?.results) ? r.data.results : []).find((x) => x?.instrumentId === instrumentId);
    const asOf = item ? parseUtc(item.date) : null;
    if (!item || typeof item.bid !== "number" || typeof item.ask !== "number" || !asOf) return { ok: false, reason: "eToro returned no usable bid, ask and timestamp" };
    return { ok: true, bid: item.bid, ask: item.ask, asOf: asOf.toISOString(), ageSec: Math.round((now.getTime() - asOf.getTime()) / 1000), quoteType: item.quoteType || null, source: r.source, fetchedAt: r.fetchedAt };
  } catch (e) { return { ok: false, reason: db.redact(client.redact(e?.message || String(e))) }; }
}

async function loadEarnings(db, instrumentId) {
  try {
    const r = (await db.query("select data from trading.research_snapshots where instrument_id = $1 and capability = 'earnings' order by fetched_at desc limit 1", [instrumentId])).rows[0];
    return { nextDate: r?.data?.upcoming?.[0]?.date ?? null };
  } catch { return { nextDate: null }; }
}

// The desk's record of the position a close proposal is about.
async function loadPosition(db, positionRowId) {
  if (!positionRowId) return null;
  try {
    const r = (await db.query("select id, etoro_position_id, instrument_id, status, amount_usd, units, open_rate, opened_at, exit_conditions from trading.positions where id = $1", [positionRowId])).rows[0];
    return r ? { id: r.id, etoroPositionId: Number(r.etoro_position_id), instrumentId: Number(r.instrument_id), status: r.status, amountUsd: Number(r.amount_usd), units: r.units === null ? null : Number(r.units), openRate: r.open_rate === null ? null : Number(r.open_rate), openedAt: iso(r.opened_at), exitConditions: r.exit_conditions } : null;
  } catch { return null; }
}

// Is a close order for this position already waiting at eToro?
async function loadCloseInFlight(db, proposal) {
  try {
    const r = await db.query(
      `select count(*) as n from trading.proposals p join trading.orders o on o.proposal_id = p.id
        where p.action = 'close' and p.position_id = $1 and p.id <> $2 and o.status in ('submitting', 'submitted', 'unknown')`, [proposal.positionId, proposal.id]
    );
    return { ok: true, count: Number(r.rows[0].n) };
  } catch (e) { return { ok: false, reason: db.redact(e?.message || String(e)) }; }
}

// Everything the engine needs for one proposal, in one object.
async function buildContext({ db, client, config, policy, proposal, phase, now, referenceAsk = null }) {
  const account = await loadAccount(db, client);
  if (proposal.action === "close") {
    return {
      phase, now, policy, proposal,
      tradingEnabled: config.tradingEnabled === true,
      halted: await readHalted(db),
      storedPriceMaxAgeSec: MONITORING.rateFreshSec,
      account,
      position: await loadPosition(db, proposal.positionId),
      closeInFlight: await loadCloseInFlight(db, proposal),
      price: phase === "pre_execution" ? await loadLivePrice(db, client, proposal.instrumentId, now) : await loadStoredPrice(db, proposal.instrumentId, now),
    };
  }
  return {
    phase, now, policy, proposal, referenceAsk,
    tradingEnabled: config.tradingEnabled === true,
    halted: await readHalted(db),
    storedPriceMaxAgeSec: MONITORING.rateFreshSec,
    allowlist: await loadAllowlist(db, proposal),
    account,
    commitments: await loadCommitments(db),
    dailyLoss: await loadDailyLoss(db, account, now),
    price: phase === "pre_execution" ? await loadLivePrice(db, client, proposal.instrumentId, now) : await loadStoredPrice(db, proposal.instrumentId, now),
    earnings: proposal.assetClass === "stock" ? await loadEarnings(db, proposal.instrumentId) : null,
  };
}

// Stores the verdict permanently, with the limits and the facts it was based on.
async function saveAssessment(q, proposalId, ctx, verdict) {
  const { now, policy, proposal, ...facts } = ctx;
  const r = await q.query(
    "insert into trading.risk_assessments (proposal_id, phase, passed, checks, policy, inputs, engine_version) values ($1, $2, $3, $4, $5, $6, $7) returning id",
    [proposalId, verdict.phase, verdict.passed, JSON.stringify(verdict.checks), JSON.stringify(policy), JSON.stringify({ assessedAt: now.toISOString(), warnings: verdict.warnings, ...facts }), verdict.engineVersion]
  );
  return r.rows[0].id;
}

module.exports = { buildContext, saveAssessment, loadProposal, loadAccount, loadPosition, readHalted, loadAllowlist };
