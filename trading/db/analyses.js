// ---------------------------------------------------------------------------
// Trading Desk — the database side of the agents: saving analyses and draft
// proposals, and reading them back. Analyses are append-only (the database
// refuses to change one); a proposal's trade parameters are frozen at insert.
// Stage 4 only ever writes proposals with status 'draft'.
// ---------------------------------------------------------------------------
const { appendAudit } = require("./store");
const { paramsHash } = require("../proposals");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v) => (v ? new Date(v).toISOString() : null);

async function saveAnalysis(tx, { agent, instrumentId = null, subjectAnalysisId = null, recommendation = null, confidence = null, output, rowIds = [], model }) {
  const ids = [...new Set(rowIds.filter((x) => typeof x === "string" && UUID.test(x)))];
  const r = await tx.query(
    `insert into trading.analyses (agent, instrument_id, subject_analysis_id, recommendation, confidence, output, snapshot_ids, model)
     values ($1, $2, $3, $4, $5, $6, $7::uuid[], $8) returning id, created_at`,
    [agent, instrumentId, subjectAnalysisId, recommendation, confidence, JSON.stringify(output), ids, model]
  );
  const row = { id: r.rows[0].id, createdAt: iso(r.rows[0].created_at) };
  await appendAudit(tx, { eventType: "analysis.created", entityType: "analysis", entityId: row.id, actor: `agent:${agent}`, data: { instrumentId, recommendation, confidence, subjectAnalysisId, model } });
  return row;
}

// Saves one DRAFT proposal to open a position. An older draft for the same
// instrument is cancelled in the same transaction, so there is never more
// than one current draft per instrument. Nothing is sent anywhere.
async function saveDraftProposal(tx, { instrument, amountUsd, expiresAt, analysisId, details, actor }) {
  const params = { action: "open", instrumentId: instrument.instrumentId, direction: "buy", leverage: 1, orderType: "market", limitRate: null, amountUsd, positionId: null, expiresAt };
  const hash = paramsHash(params);
  const old = await tx.query(
    `update trading.proposals set status = 'cancelled', status_reason = 'superseded by a newer draft'
      where instrument_id = $1 and action = 'open' and status = 'draft' returning id`, [instrument.instrumentId]
  );
  const r = await tx.query(
    `insert into trading.proposals (action, instrument_id, asset_class, direction, leverage, order_type, amount_usd, expires_at, params_hash, status, analysis_id, details)
     values ('open', $1, $2, 'buy', 1, 'market', $3, $4, $5, 'draft', $6, $7) returning id, created_at`,
    [instrument.instrumentId, instrument.assetClass, amountUsd, new Date(expiresAt).toISOString(), hash, analysisId, JSON.stringify(details)]
  );
  const id = r.rows[0].id;
  await appendAudit(tx, { eventType: "proposal.created", entityType: "proposal", entityId: id, proposalId: id, actor, data: { symbol: instrument.symbol, amountUsd, expiresAt: new Date(expiresAt).toISOString(), paramsHash: hash, status: "draft", superseded: old.rows.map((x) => x.id) } });
  return { id, paramsHash: hash, superseded: old.rows.length };
}

// The newest analysis and risk review for one symbol, and the newest
// Portfolio Manager output.
async function latestForSymbol(db, symbol) {
  const s = String(symbol || "").trim().toUpperCase();
  const inst = (await db.query("select instrument_id, symbol, asset_class from trading.instruments where symbol = $1", [s])).rows[0];
  if (!inst) return { ok: false, symbol: s, error: "unknown instrument" };
  const one = async (where, params) => {
    const r = (await db.query(`select id, agent, recommendation, confidence, output, model, created_at, subject_analysis_id from trading.analyses where ${where} order by created_at desc limit 1`, params)).rows[0];
    return r ? { id: r.id, agent: r.agent, recommendation: r.recommendation, confidence: r.confidence === null ? null : Number(r.confidence), model: r.model, createdAt: iso(r.created_at), subjectAnalysisId: r.subject_analysis_id, output: r.output } : null;
  };
  const analysis = await one("instrument_id = $1 and agent in ('stock', 'crypto')", [inst.instrument_id]);
  const review = analysis ? await one("subject_analysis_id = $1 and agent = 'risk'", [analysis.id]) : null;
  const pm = await one("agent = 'portfolio_manager'", []);
  const decision = pm?.output?.decisions?.find((d) => d.symbol === s) || null;
  return { ok: true, symbol: s, analysis, riskReview: review, portfolioManager: pm ? { id: pm.id, createdAt: pm.createdAt, model: pm.model, decisionForThisSymbol: decision, portfolioNote: pm.output?.portfolio_note ?? null } : null };
}

async function listProposals(db, limit = 20) {
  const r = await db.query(
    `select p.id, i.symbol, p.asset_class, p.action, p.direction, p.leverage, p.order_type, p.amount_usd, p.status, p.status_reason, p.expires_at, p.created_at, p.params_hash, p.details
       from trading.proposals p join trading.instruments i on i.instrument_id = p.instrument_id order by p.created_at desc limit $1`, [limit]
  );
  return r.rows.map((p) => ({ ...p, amount_usd: Number(p.amount_usd), expires_at: iso(p.expires_at), created_at: iso(p.created_at) }));
}

module.exports = { saveAnalysis, saveDraftProposal, latestForSymbol, listProposals };
