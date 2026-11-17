// ---------------------------------------------------------------------------
// Trading Desk — Stage 8: the end-to-end checklist.
//
// Read-only. Every tick on this list is a record the desk wrote while doing
// the real thing on eToro DEMO: a stored price, an agent's analysis, a
// proposal, the risk engine's verdict, your tap in Telegram, eToro's order
// and its lookup, the monitor's alert, the close proposal, your second tap,
// and the close. Nothing here calls eToro or Claude, and nothing can be
// ticked by hand: a step is done only when its record exists.
//
// The run starts at `since` (desk_state 'e2e_since', set the first time
// /trade_e2e is used); records from before it do not count.
// ---------------------------------------------------------------------------
const notify = require("./notify");

const iso = (v) => (v ? new Date(v).toISOString() : null);
const short = (id) => String(id ?? "").slice(0, 8);

const FLOW_STEPS = [
  ["monitoring", "Monitoring: a stored eToro price the analysis was given"],
  ["analysis", "Analysis by the agent"],
  ["proposal", "Proposal by the Portfolio Manager"],
  ["risk", "Risk engine passed it"],
  ["approval", "You approved it in Telegram"],
  ["order", "Order filled on eToro DEMO"],
  ["verification", "Order looked up and position recorded"],
  ["alert", "Monitor alert: exit condition or holding limit reached"],
  ["closeProposal", "Close proposal created by the monitor"],
  ["closeApproval", "You approved the close"],
  ["close", "Position closed on eToro DEMO"],
];

const CHECK_STEPS = [
  ["ownerReject", "Rejection: you tapped Reject"],
  ["riskReject", "Rejection by the risk engine"],
  ["expired", "Expired approval: not answered in 15 minutes, nothing sent"],
  ["duplicate", "Duplicate click: a second tap did nothing"],
  ["quietHours", "Quiet hours: a request held, then sent after the window"],
  ["killSwitch", "Kill switch: an approved order refused because trading was stopped"],
];

async function readSince(db) {
  const r = await db.query("select value from trading.desk_state where key = 'e2e_since'");
  return r.rows.length && r.rows[0].value?.since ? r.rows[0].value.since : null;
}

async function startRun(db, at, actor = "owner:telegram") {
  await db.query("insert into trading.desk_state (key, value, updated_by) values ('e2e_since', $1, $2) on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()", [JSON.stringify({ since: iso(at) }), actor]);
  return iso(at);
}

// One open flow, from the stored price to the close. Every step that has a
// record gets { at, ref }; a step without one is null.
async function traceFlow(db, p) {
  const q = (sql, args) => db.query(sql, args).then((r) => r.rows);
  const s = Object.fromEntries(FLOW_STEPS.map(([k]) => [k, null]));
  s.proposal = { at: iso(p.created_at), ref: `proposal ${short(p.id)}, $${Number(p.amount_usd).toFixed(2)}` };

  const [analysis] = await q("select id, created_at, snapshot_ids, recommendation from trading.analyses where agent = $1 and instrument_id = $2 and created_at <= $3 order by created_at desc limit 1", [p.asset_class, p.instrument_id, p.created_at]);
  if (analysis) {
    s.analysis = { at: iso(analysis.created_at), ref: `${p.asset_class} analysis ${short(analysis.id)} (${analysis.recommendation ?? "?"})` };
    const [snap] = await q("select id, as_of, bid, source from trading.market_snapshots where id = any($1::uuid[]) and kind = 'rate' order by as_of desc limit 1", [analysis.snapshot_ids || []]);
    if (snap) s.monitoring = { at: iso(snap.as_of), ref: `bid ${Number(snap.bid)} from ${snap.source}` };
  }
  const [risk] = await q("select created_at, engine_version, checks from trading.risk_assessments where proposal_id = $1 and phase = 'pre_approval' and passed order by created_at desc limit 1", [p.id]);
  if (risk) s.risk = { at: iso(risk.created_at), ref: `${(risk.checks || []).length} checks, ${risk.engine_version}` };
  const [appr] = await q("select decided_at, channel from trading.approvals where proposal_id = $1 and decision = 'approved'", [p.id]);
  if (appr && appr.channel === "telegram") s.approval = { at: iso(appr.decided_at), ref: "Telegram" };
  const [order] = await q("select id, status, etoro_order_id, submitted_at, verified_at from trading.orders where proposal_id = $1", [p.id]);
  if (!order || order.status !== "filled") return s;
  s.order = { at: iso(order.submitted_at), ref: `eToro order ${order.etoro_order_id}` };
  const [pos] = await q("select id, etoro_position_id, status, closed_at, realized_pnl_usd from trading.positions where opened_by_order_id = $1 order by created_at limit 1", [order.id]);
  if (!pos || !order.verified_at) return s;
  s.verification = { at: iso(order.verified_at), ref: `position ${pos.etoro_position_id}` };

  const [alert] = await q("select created_at, kind, condition_key from trading.position_alerts where etoro_position_id = $1 and kind in ('exit_condition', 'time_limit') order by created_at limit 1", [pos.etoro_position_id]);
  if (alert) s.alert = { at: iso(alert.created_at), ref: `${alert.kind}: ${alert.condition_key}` };
  const [cp] = await q("select id, created_at, status from trading.proposals where action = 'close' and position_id = $1 and details->>'source' = 'position monitor' order by created_at desc limit 1", [pos.id]);
  if (!cp) return s;
  s.closeProposal = { at: iso(cp.created_at), ref: `close proposal ${short(cp.id)}` };
  const [ca] = await q("select decided_at, channel from trading.approvals where proposal_id = $1 and decision = 'approved'", [cp.id]);
  if (ca) s.closeApproval = { at: iso(ca.decided_at), ref: ca.channel === "telegram" ? "Telegram" : "console" };
  const [co] = await q("select status, etoro_order_id, verified_at from trading.orders where proposal_id = $1", [cp.id]);
  if (co && co.status === "filled" && pos.status === "closed") s.close = { at: iso(pos.closed_at), ref: `eToro close order ${co.etoro_order_id}${pos.realized_pnl_usd !== null ? `, result $${Number(pos.realized_pnl_usd).toFixed(2)}` : ""}` };
  return s;
}

async function buildE2E({ db, since }) {
  const q = (sql, args) => db.query(sql, args).then((r) => r.rows);
  const out = { ok: true, environment: "demo", since, flows: {}, checks: {} };

  // The flow per asset class: the agent-made open proposal (not a /trade_test)
  // that got furthest. MSTR is a stock here even though it counts as crypto exposure.
  for (const cls of ["stock", "crypto"]) {
    const candidates = await q(
      `select p.id, p.created_at, p.instrument_id, p.amount_usd, i.symbol, i.asset_class from trading.proposals p join trading.instruments i on i.instrument_id = p.instrument_id
        where p.action = 'open' and p.analysis_id is not null and i.asset_class = $1 and p.created_at >= $2 order by p.created_at desc limit 20`, [cls, since]);
    let best = null;
    for (const p of candidates) {
      const steps = await traceFlow(db, p);
      const done = Object.values(steps).filter(Boolean).length;
      if (!best || done > best.done) best = { symbol: p.symbol, proposalId: p.id, steps, done };
    }
    if (!best) {
      // No proposal yet: the newest analysis still counts for its two steps,
      // and what the agents decided is shown, so "no trade" is not a mystery.
      best = { symbol: null, proposalId: null, steps: Object.fromEntries(FLOW_STEPS.map(([k]) => [k, null])), done: 0 };
      const [a] = await q(`select a.id, a.created_at, a.snapshot_ids, a.recommendation, i.symbol from trading.analyses a join trading.instruments i on i.instrument_id = a.instrument_id
                            where a.agent = $1 and a.created_at >= $2 order by a.created_at desc limit 1`, [cls, since]);
      if (a) {
        best.symbol = a.symbol;
        best.steps.analysis = { at: iso(a.created_at), ref: `${cls} analysis ${short(a.id)} (${a.recommendation ?? "?"})` };
        const [snap] = await q("select as_of, bid, source from trading.market_snapshots where id = any($1::uuid[]) and kind = 'rate' order by as_of desc limit 1", [a.snapshot_ids || []]);
        if (snap) best.steps.monitoring = { at: iso(snap.as_of), ref: `bid ${Number(snap.bid)} from ${snap.source}` };
        best.done = Object.values(best.steps).filter(Boolean).length;
        // The Portfolio Manager's word on it, from the run that analysed it.
        const [pm] = await q("select output from trading.analyses where agent = 'portfolio_manager' and created_at >= $1 order by created_at limit 1", [a.created_at]);
        const d = (Array.isArray(pm?.output?.decisions) ? pm.output.decisions : []).find((x) => x && x.symbol === a.symbol);
        best.noTrade = { analyst: a.recommendation ?? null, manager: d ? String(d.decision ?? "") : null };
      }
    }
    out.flows[cls] = best;
  }

  const one = async (sql, args, ref) => { const [r] = await q(sql, args); return r ? { at: iso(r.at), ref: ref(r) } : null; };
  out.checks.ownerReject = await one("select a.decided_at as at, i.symbol, a.channel from trading.approvals a join trading.proposals p on p.id = a.proposal_id join trading.instruments i on i.instrument_id = p.instrument_id where a.decision = 'rejected' and a.decided_at >= $1 order by a.decided_at desc limit 1", [since], (r) => `${r.symbol}, in ${r.channel}`);
  out.checks.riskReject = await one("select l.created_at as at, i.symbol, l.data from trading.audit_log l join trading.proposals p on p.id = l.proposal_id join trading.instruments i on i.instrument_id = p.instrument_id where l.event_type = 'risk.rejected' and l.created_at >= $1 order by l.seq desc limit 1", [since], (r) => `${r.symbol}: ${String((r.data?.failed || [])[0]?.name ?? (r.data?.failed || [])[0] ?? "")}`);
  out.checks.expired = await one("select l.created_at as at, i.symbol from trading.audit_log l join trading.proposals p on p.id = l.proposal_id join trading.instruments i on i.instrument_id = p.instrument_id where l.event_type = 'approval.expired' and l.created_at >= $1 and not exists (select 1 from trading.orders o where o.proposal_id = l.proposal_id) order by l.seq desc limit 1", [since], (r) => `${r.symbol}: expired, no order`);
  out.checks.duplicate = await one("select l.created_at as at, i.symbol, l.data from trading.audit_log l join trading.proposals p on p.id = l.proposal_id join trading.instruments i on i.instrument_id = p.instrument_id where l.event_type = 'approval.duplicate' and l.created_at >= $1 order by l.seq desc limit 1", [since], (r) => `${r.symbol}: second "${r.data?.attempted}" after "${r.data?.previous}"`);
  out.checks.quietHours = await one(
    `select r.created_at as at, i.symbol, coalesce((h.data->>'at')::timestamptz, h.created_at) as held_at from trading.audit_log h join trading.audit_log r on r.proposal_id = h.proposal_id and r.event_type = 'approval.requested' and r.seq > h.seq
       join trading.proposals p on p.id = h.proposal_id join trading.instruments i on i.instrument_id = p.instrument_id
      where h.event_type = 'approval.quiet_hold' and h.created_at >= $1 order by r.seq desc limit 1`, [since], (r) => `${r.symbol}: held at ${notify.esc(iso(r.held_at).slice(11, 16))} UTC, sent after the window`);
  out.checks.killSwitch = await one("select l.created_at as at, i.symbol, l.data from trading.audit_log l join trading.proposals p on p.id = l.proposal_id join trading.instruments i on i.instrument_id = p.instrument_id where l.event_type = 'execution.refused' and (l.data->>'reason' like '%TRADING_ENABLED%' or l.data->>'reason' like '%/trade_stop%') and l.created_at >= $1 order by l.seq desc limit 1", [since], (r) => `${r.symbol}: ${String(r.data?.reason || "").slice(0, 80)}`);

  const flowDone = ["stock", "crypto"].every((c) => out.flows[c].done === FLOW_STEPS.length);
  const checksDone = CHECK_STEPS.every(([k]) => out.checks[k]);
  out.complete = flowDone && checksDone;
  return out;
}

// What to do next, for the first missing step. Plain text, built by code.
function nextHint(cls, key, symbol, noTrade = null) {
  const sym = symbol || (cls === "stock" ? "a stock" : "a coin");
  return {
    monitoring: `/trade_run ${cls === "stock" ? "NKE" : "BTC"} — the agents analyse it from stored prices`,
    analysis: `/trade_run ${symbol || (cls === "stock" ? "NKE" : "BTC")}`,
    proposal: noTrade ? `the agents decided not to buy ${symbol} (analyst: ${noTrade.analyst || "?"}${noTrade.manager ? `, manager: ${noTrade.manager}` : ""}). Try /trade_run with other symbols, or wait for a scheduled run` : "the agents did not propose a buy; try /trade_run with another symbol",
    risk: "wait for the risk engine (within a minute), or read why it was rejected",
    approval: "tap Approve on the Telegram request (not in the console, for this step)",
    order: "the order is being sent or looked up — /trade_status",
    verification: "the order is being looked up — wait a minute",
    alert: `/trade_drill_exit ${sym} — or wait for a real exit condition`,
    closeProposal: "the monitor creates it with the alert — wait up to 15 minutes",
    closeApproval: "tap Approve on the close request",
    close: "the close is being sent or looked up — wait a minute",
  }[key];
}

function e2eText(r) {
  const lines = ["🧭 <b>End-to-end check</b> (DEMO)", `Since ${notify.esc(r.since.slice(0, 16).replace("T", " "))} UTC. Each ✅ is a record the desk wrote.`];
  for (const cls of ["stock", "crypto"]) {
    const f = r.flows[cls];
    lines.push("", `<b>${cls === "stock" ? "Stock" : "Crypto"}${f.symbol ? ` — ${notify.esc(f.symbol)}` : ""}</b> (${f.done}/${FLOW_STEPS.length})`);
    let hinted = false;
    for (const [k, label] of FLOW_STEPS) {
      const s = f.steps[k];
      lines.push(s ? `✅ ${label} — ${notify.esc(s.ref)}, ${notify.esc(s.at.slice(5, 16).replace("T", " "))}` : `⬜ ${label}${!hinted ? `\n    → ${notify.esc(nextHint(cls, k, f.symbol, f.noTrade))}` : ""}`);
      if (!s) hinted = true;
    }
  }
  lines.push("", "<b>Safety checks</b>");
  for (const [k, label] of CHECK_STEPS) { const s = r.checks[k]; lines.push(s ? `✅ ${label} — ${notify.esc(s.ref)}` : `⬜ ${label}`); }
  lines.push("", r.complete ? "🏁 Every step is on record." : "Steps: docs/trading-desk-e2e.md. /trade_e2e again to refresh.");
  return lines.join("\n").slice(0, 4000);
}

module.exports = { buildE2E, e2eText, readSince, startRun, FLOW_STEPS, CHECK_STEPS };
