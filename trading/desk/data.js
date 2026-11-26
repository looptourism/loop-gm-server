// ---------------------------------------------------------------------------
// Everything the Trading Desk page shows (Stage 7), in one read-only answer.
//
// It reads the desk's own database and the in-memory state of its jobs. It
// makes NO call to eToro and no call to Claude, so opening the page costs
// nothing and cannot change anything. Every figure keeps the time it was
// taken, so the page can say how old it is.
// ---------------------------------------------------------------------------
const { POLICY } = require("../policy");
const { AGENTS } = require("../config");
const { readAllowlists } = require("../db/store");
const { readHalted } = require("../risk/context");
const { readQuietHours } = require("../approvals");
const { trackRecord } = require("../report");
const { holdingHoursOf } = require("../horizon");

const iso = (v) => (v ? new Date(v).toISOString() : null);
const n = (v) => (v === null || v === undefined ? null : Number(v));
const r2 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);

async function buildDesk({ db, config, agents, positions, approvals, watches = null, now = new Date() }) {
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;

  // ---- overview: the account at the last 15-minute check ---------------------
  const snap = (await q("select * from trading.account_snapshots order by taken_at desc, created_at desc limit 1"))[0] || null;
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const first = (await q("select equity_usd, taken_at from trading.account_snapshots where taken_at >= $1 order by taken_at asc, created_at asc limit 1", [dayStart.toISOString()]))[0] || null;
  const open = await q(
    `select p.id, p.etoro_position_id, i.symbol, i.display_name, i.asset_class, coalesce(s.crypto_correlated, false) as crypto_correlated,
            p.amount_usd, p.units, p.open_rate, p.opened_at, p.exit_conditions, p.last_synced_at,
            (select bid from trading.market_snapshots m where m.kind = 'rate' and m.instrument_id = p.instrument_id order by as_of desc limit 1) as bid,
            (select as_of from trading.market_snapshots m where m.kind = 'rate' and m.instrument_id = p.instrument_id order by as_of desc limit 1) as bid_at,
            (select status from trading.proposals c where c.position_id = p.id and c.action = 'close' order by c.created_at desc limit 1) as close_status
       from trading.positions p join trading.instruments i on i.instrument_id = p.instrument_id left join trading.stock_allowlist s on s.instrument_id = p.instrument_id
      where p.status = 'open' order by p.opened_at desc nulls last`
  );
  const split = { stock: 0, crypto: 0 };
  for (const p of open) split[p.asset_class === "crypto" ? "crypto" : "stock"] += Number(p.amount_usd);
  const lastCheck = typeof positions?.state === "function" ? positions.state().lastCheck : null;
  const overview = snap ? {
    at: iso(snap.taken_at), source: snap.source,
    availableCashUsd: r2(Number(snap.credit_usd) - Number(snap.pending_orders_usd)),
    investedUsd: r2(snap.invested_usd), pendingOrdersUsd: r2(snap.pending_orders_usd), unrealizedPnlUsd: r2(snap.unrealized_pnl_usd), equityUsd: r2(snap.equity_usd),
    openPositions: snap.open_positions,
    todayPnlUsd: first ? r2(Number(snap.equity_usd) - Number(first.equity_usd)) : null, todaySince: first ? iso(first.taken_at) : null,
    split: { stockUsd: r2(split.stock), cryptoUsd: r2(split.crypto) },
    limits: Array.isArray(lastCheck?.limits) ? lastCheck.limits : null,
  } : null;

  // ---- agents --------------------------------------------------------------------
  const state = typeof agents?.state === "function" ? agents.state() : null;
  let budget = null, runs = [];
  try { budget = agents?.budget ? await agents.budget.status() : null; } catch { /* shown as unknown */ }
  try { runs = typeof agents?.recentRuns === "function" ? (await agents.recentRuns(8)).filter((x) => x.event === "finished" || x.warning).slice(0, 5) : []; } catch { /* none */ }
  const analyses = await q(
    `select a.id, a.agent, i.symbol, a.recommendation, a.confidence, a.model, a.created_at, a.output->>'thesis' as thesis, a.output->>'summary' as summary
       from trading.analyses a left join trading.instruments i on i.instrument_id = a.instrument_id
      where a.agent in ('stock', 'crypto', 'risk') order by a.created_at desc limit 12`
  );
  const pm = (await q("select id, created_at, output from trading.analyses where agent = 'portfolio_manager' order by created_at desc limit 1"))[0] || null;

  // ---- waiting for you ---------------------------------------------------------------
  const pending = await q(
    `select p.id, p.action, i.symbol, p.asset_class, p.amount_usd, p.details, p.expires_at, p.created_at, a.id as approval_id, a.expires_at as approval_expires_at,
            (select r.inputs from trading.risk_assessments r where r.proposal_id = p.id and r.phase = 'pre_approval' order by r.created_at desc limit 1) as inputs,
            (select r.checks from trading.risk_assessments r where r.proposal_id = p.id and r.phase = 'pre_approval' order by r.created_at desc limit 1) as checks
       from trading.proposals p join trading.instruments i on i.instrument_id = p.instrument_id
       join trading.approvals a on a.proposal_id = p.id and a.decision is null
      where p.status = 'pending_approval' and a.expires_at > $1 order by a.expires_at`, [now.toISOString()]
  );
  const drafts = await q(
    `select p.id, p.action, i.symbol, p.amount_usd, p.status_reason, p.expires_at, p.created_at from trading.proposals p join trading.instruments i on i.instrument_id = p.instrument_id
      where p.status in ('draft', 'approved', 'executing') order by p.created_at desc limit 10`
  );

  // ---- history, alerts --------------------------------------------------------------
  const history = await q(
    `select p.id, p.action, i.symbol, p.amount_usd, p.status, p.status_reason, p.created_at, p.updated_at, p.details->>'source' as source,
            o.status as order_status, o.error as order_error,
            pos.close_rate, pos.realized_pnl_usd, pos.closed_at
       from trading.proposals p join trading.instruments i on i.instrument_id = p.instrument_id
       left join trading.orders o on o.proposal_id = p.id
       left join trading.positions pos on pos.closed_by_order_id = o.id
      order by p.created_at desc limit 40`
  );
  const alerts = [
    ...(await q("select created_at, 'position' as scope, kind, symbol, message from trading.position_alerts order by created_at desc limit 20")),
    ...(await q("select created_at, 'account' as scope, kind, null as symbol, message from trading.account_alerts order by created_at desc limit 20")),
    ...(await q(`select p.updated_at as created_at, 'risk' as scope, 'risk_rejected' as kind, i.symbol, p.status_reason as message
                   from trading.proposals p join trading.instruments i on i.instrument_id = p.instrument_id where p.status = 'risk_rejected' order by p.updated_at desc limit 20`)),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 30)
    .map((x) => ({ at: iso(x.created_at), scope: x.scope, kind: x.kind, symbol: x.symbol, message: x.scope === "position" ? String(x.message).replace(/<[^>]+>/g, "") : x.message }));

  // ---- settings ------------------------------------------------------------------------
  const lists = await readAllowlists(db);
  const halted = await readHalted(db);
  const quiet = await readQuietHours(db);
  const settings = {
    tradingEnabled: config.tradingEnabled === true, stopped: halted,
    tradingOn: config.tradingEnabled === true && !halted,
    monitorEnabled: config.monitorEnabled === true, agentsScheduleEnabled: config.agentsScheduleEnabled === true,
    policy: {
      maxPerTradeUsd: POLICY.maxPerTradeUsd, maxTotalExposureUsd: POLICY.maxTotalExposureUsd, maxCryptoExposureUsd: POLICY.maxCryptoExposureUsd,
      maxDailyLossUsd: POLICY.maxDailyLossUsd, maxOpenPositions: POLICY.maxOpenPositions, leverage: POLICY.leverage, direction: POLICY.direction,
      holdingHours: POLICY.holdingHours, fees: POLICY.fees, approvalValidMinutes: POLICY.approvalValidMinutes, quietHours: quiet.hours, quietHoursFrom: quiet.from,
      cryptoCorrelatedCountsTowardCryptoCap: POLICY.cryptoCorrelatedCountsTowardCryptoCap,
    },
    agents: { models: AGENTS.models, shortlistMax: AGENTS.shortlistMax, shortlistMinScore: AGENTS.shortlistMinScore, monthlyBudgetUsd: AGENTS.monthlyBudgetUsd, schedule: AGENTS.schedule.map((s) => s.label) },
    allowlists: {
      stocks: lists.stocks.map((s) => ({ symbol: s.symbol, tradable: s.tradable, active: s.active, cryptoCorrelated: s.crypto_correlated === true })),
      crypto: lists.crypto.map((s) => ({ symbol: s.symbol, tradable: s.tradable, active: s.active })),
    },
  };

  return {
    ok: true, environment: "demo", generatedAt: now.toISOString(),
    overview,
    agents: {
      ready: state?.ready ?? null, notReadyBecause: state?.notReadyBecause ?? null, running: state?.running ?? null,
      schedule: state?.schedule ?? null, models: state?.models ?? AGENTS.models, budget,
      runs: runs.map((x) => ({ at: x.at, ok: x.ok ?? null, warning: x.warning ?? null, skipped: x.skipped ?? null, mode: x.mode ?? null, trigger: x.trigger ?? null, shortlist: x.screen?.shortlist ?? null, screened: x.screen?.results?.length ?? null, proposals: (x.proposals || []).length, costUsd: x.usage?.estimatedCostUsd ?? null })),
      analyses: analyses.map((a) => ({ id: a.id, agent: a.agent, symbol: a.symbol, recommendation: a.recommendation, confidence: n(a.confidence), model: a.model, at: iso(a.created_at), text: (a.thesis || a.summary || "").slice(0, 600) })),
      watches: watches && typeof watches.list === "function" ? await watches.list(10) : [],
      record: await trackRecord(db, { now, days: 30 }),
      portfolioManager: pm ? { at: iso(pm.created_at), note: pm.output?.portfolio_note ?? null, decisions: (pm.output?.decisions || []).map((d) => ({ symbol: d.symbol, decision: d.decision, amountUsd: d.amount_usd ?? null, rationale: String(d.rationale || "").slice(0, 500), disagreements: d.disagreements || [] })) } : null,
    },
    pending: pending.map((p) => {
      const d = p.details || {};
      return {
        proposalId: p.id, approvalId: p.approval_id, action: p.action, symbol: p.symbol, assetClass: p.asset_class, amountUsd: r2(p.amount_usd), answerBy: iso(p.approval_expires_at),
        holdingHours: holdingHoursOf(d), exitConditions: d.exit_conditions || [], rationale: d.rationale || d.reason || null, disagreements: d.disagreements || [], source: d.source || "agents",
        etoroPositionId: d.etoroPositionId ?? null,
        price: p.inputs?.price ? { bid: p.inputs.price.bid, ask: p.inputs.price.ask, asOf: p.inputs.price.asOf } : null,
        warnings: p.inputs?.warnings || [], checksPassed: Array.isArray(p.checks) ? p.checks.filter((c) => c.passed).length : null, checksTotal: Array.isArray(p.checks) ? p.checks.length : null,
      };
    }),
    inProgress: drafts.map((x) => ({ proposalId: x.id, action: x.action, symbol: x.symbol, amountUsd: r2(x.amount_usd), note: x.status_reason, expiresAt: iso(x.expires_at), at: iso(x.created_at) })),
    positions: open.map((p) => {
      const bid = n(p.bid), openRate = n(p.open_rate), units = n(p.units);
      return {
        etoroPositionId: n(p.etoro_position_id), symbol: p.symbol, name: p.display_name, assetClass: p.asset_class, cryptoCorrelated: p.crypto_correlated,
        amountUsd: r2(p.amount_usd), openRate, openedAt: iso(p.opened_at), exitConditions: p.exit_conditions || [], syncedAt: iso(p.last_synced_at),
        bid, bidAt: iso(p.bid_at), estimatedPnlUsd: bid !== null && openRate !== null && units !== null ? r2((bid - openRate) * units) : null,
        closeStatus: p.close_status || null,
      };
    }),
    history: history.map((h) => ({ proposalId: h.id, action: h.action, symbol: h.symbol, amountUsd: r2(h.amount_usd), status: h.status, reason: h.status_reason || h.order_error || null, source: h.source || "agents", at: iso(h.created_at), updatedAt: iso(h.updated_at), orderStatus: h.order_status || null, closeRate: n(h.close_rate), resultUsd: r2(h.realized_pnl_usd), closedAt: iso(h.closed_at) })),
    alerts,
    settings,
  };
}

module.exports = { buildDesk };
