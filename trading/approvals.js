// ---------------------------------------------------------------------------
// Approvals (Stage 5) — plain code.
//
//   dispatch()  takes draft proposals through the risk engine and, for those
//               that pass, sends the owner a Telegram message with Approve
//               and Reject buttons. A draft waits (it is not judged) while
//               its price is not fresh — a stock is offered for approval
//               when its market is open, so an approval can be acted on.
//   decide()    records the owner's tap. On Approve it hands the proposal to
//               the execution gateway, which checks everything again.
//   sweep()     expires what has run out of time and asks the gateway to
//               settle orders that are still in flight.
//
// An approval belongs to one proposal and one exact set of parameters (the
// hash), lasts 15 minutes, is decided once and used once. The database
// enforces each of those as well; this file checks them first so the owner
// gets a clear answer instead of a database error.
//
// Nothing is sent to the owner, and nothing can be approved, while trading
// is switched off.
// ---------------------------------------------------------------------------
const crypto = require("crypto");
const { POLICY } = require("./policy");
const { MONITORING } = require("./config");
const { assess } = require("./risk/engine");
const { buildContext, saveAssessment, loadProposal, readHalted } = require("./risk/context");
const { paramsHash } = require("./proposals");
const { appendAudit } = require("./db/store");
const { rateFreshness } = require("./market-data");
const notify = require("./notify");

const CALLBACK = /^td:(ok|no):([0-9a-f-]{36})$/;
const iso = (v) => (v ? new Date(v).toISOString() : null);

// Is `now` inside the quiet window? Times are wall-clock in the given zone.
function inQuietHours(now, q) {
  if (!q || !q.start || !q.end) return false;
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: q.timeZone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return q.start <= q.end ? hm >= q.start && hm < q.end : hm >= q.start || hm < q.end;
}

// The quiet hours in force: the owner's /trade_quiet setting when there is
// one, otherwise POLICY.quietHours. Stored as desk_state 'quiet_hours':
// { start, end, timeZone } or { off: true }. If the setting cannot be read the
// answer is "quiet" — an approval request is held, never sent by mistake.
async function readQuietHours(db, policy = POLICY) {
  try {
    const r = await db.query("select value from trading.desk_state where key = 'quiet_hours'");
    if (!r.rows.length) return { hours: policy.quietHours || null, from: "policy" };
    const v = r.rows[0].value || {};
    return v.off ? { hours: null, from: "telegram" } : { hours: { start: v.start, end: v.end, timeZone: v.timeZone || "UTC" }, from: "telegram" };
  } catch (e) { return { hours: null, from: "unreadable", unreadable: true }; }
}

function createApprovals({ config, db, client, gateway, notifier, policy = POLICY, now = () => new Date(), log = (...a) => console.log("[trading/approvals]", ...a) } = {}) {
  let busy = false, timer = null;
  const clean = (e) => db.redact(client.redact(e?.message || String(e)));
  const audit = (q, eventType, proposalId, data, actor = "system:approvals") => appendAudit(q, { eventType, entityType: "proposal", entityId: proposalId, proposalId, actor, data });
  const tradingOff = async () => (config.tradingEnabled !== true ? "TRADING_ENABLED is not \"true\"" : (await readHalted(db)) ? "trading was stopped with /trade_stop" : null);

  async function expireOld() {
    const t = now().toISOString();
    const drafts = await db.query("update trading.proposals set status = 'expired', status_reason = 'not approved before it expired' where status = 'draft' and expires_at <= $1 returning id", [t]);
    // Approval requests nobody answered in time.
    const late = (await db.query("select a.id, a.proposal_id, a.telegram_message_id, i.symbol, p.amount_usd, p.action from trading.approvals a join trading.proposals p on p.id = a.proposal_id join trading.instruments i on i.instrument_id = p.instrument_id where a.decision is null and a.expires_at < $1 and p.status = 'pending_approval'", [t])).rows;
    for (const a of late) {
      await db.withTransaction(async (tx) => {
        await tx.query("update trading.proposals set status = 'expired', status_reason = 'the approval request was not answered within its time' where id = $1 and status = 'pending_approval'", [a.proposal_id]);
        await audit(tx, "approval.expired", a.proposal_id, { approvalId: a.id });
      });
      if (a.telegram_message_id) await notifier.edit(Number(a.telegram_message_id), notify.approvalClosed({ symbol: a.symbol, amountUsd: Number(a.amount_usd), action: a.action, outcome: "expired" }));
    }
    return { drafts: drafts.rowCount, approvals: late.length };
  }

  // Draft proposals → risk engine → approval request.
  async function dispatch() {
    const out = { sent: [], rejected: [], waiting: [], skipped: null };
    const off = await tradingOff();
    if (off) { out.skipped = `trading is off: ${off}`; return out; }
    const quiet = await readQuietHours(db, policy);
    if (quiet.unreadable || inQuietHours(now(), quiet.hours)) {
      out.skipped = quiet.unreadable ? "quiet hours (the setting could not be read)" : "quiet hours";
      // One audit record per held proposal, so the hold is on record (Stage 8).
      try {
        const held = (await db.query("select p.id from trading.proposals p where p.status = 'draft' and p.action in ('open', 'close') and p.expires_at > $1 and not exists (select 1 from trading.audit_log l where l.proposal_id = p.id and l.event_type = 'approval.quiet_hold')", [now().toISOString()])).rows;
        for (const h of held) await audit(db, "approval.quiet_hold", h.id, { quietHours: quiet.hours, setBy: quiet.from, at: now().toISOString() });
      } catch (e) { log("could not record a quiet-hours hold:", clean(e)); }
      return out;
    }
    const drafts = (await db.query("select id from trading.proposals where status = 'draft' and action in ('open', 'close') and expires_at > $1 order by action = 'close' desc, created_at", [now().toISOString()])).rows;
    for (const d of drafts) {
      const proposal = await loadProposal(db, d.id);
      // A cheap look first: while the price is not fresh the proposal simply waits.
      const r = (await db.query("select as_of, quote_type from trading.market_snapshots where kind = 'rate' and instrument_id = $1 order by as_of desc limit 1", [proposal.instrumentId])).rows[0];
      if (!r || !rateFreshness({ asOf: r.as_of, quoteType: r.quote_type }, now(), MONITORING.rateFreshSec).fresh) {
        out.waiting.push(proposal.symbol);
        await db.query("update trading.proposals set status_reason = 'waiting for a fresh price (market closed or data delayed)' where id = $1 and status = 'draft' and status_reason is distinct from 'waiting for a fresh price (market closed or data delayed)'", [proposal.id]);
        continue;
      }
      const ctx = await buildContext({ db, client, config, policy, proposal, phase: "pre_approval", now: now() });
      const verdict = assess(ctx);
      const assessmentId = await saveAssessment(db, proposal.id, ctx, verdict);
      if (!verdict.passed) {
        const why = verdict.checks.filter((c) => !c.passed).map((c) => c.message);
        await db.withTransaction(async (tx) => {
          await tx.query("update trading.proposals set status = 'risk_rejected', status_reason = $2 where id = $1 and status = 'draft'", [proposal.id, why.join("; ").slice(0, 500)]);
          await audit(tx, "risk.rejected", proposal.id, { assessmentId, failed: verdict.failed });
        });
        out.rejected.push({ symbol: proposal.symbol, failed: verdict.failed });
        await notifier.send(notify.riskRejected({ proposal, reasons: why }));
        continue;
      }
      // Passed: ask the owner. The request cannot outlive the proposal.
      const approvalId = crypto.randomUUID();
      const requestedAt = now();
      const expiresAt = new Date(Math.min(requestedAt.getTime() + policy.approvalValidMinutes * 60000, new Date(proposal.expiresAt).getTime()));
      const msg = await notifier.sendButtons(notify.approvalRequest({ proposal, verdict, price: ctx.price, account: ctx.account, expiresAt }), [[{ text: "✅ Approve", callback_data: `td:ok:${approvalId}` }, { text: "❌ Reject", callback_data: `td:no:${approvalId}` }]]);
      if (!msg.ok) { out.waiting.push(`${proposal.symbol} (Telegram did not accept the request; it will be tried again)`); continue; }
      try {
        await db.withTransaction(async (tx) => {
          await tx.query("insert into trading.approvals (id, proposal_id, params_hash, requested_at, expires_at, telegram_message_id) values ($1, $2, $3, $4, $5, $6)", [approvalId, proposal.id, proposal.paramsHash, requestedAt.toISOString(), expiresAt.toISOString(), msg.messageId]);
          await tx.query("update trading.proposals set status = 'pending_approval', status_reason = null where id = $1 and status = 'draft'", [proposal.id]);
          await audit(tx, "approval.requested", proposal.id, { approvalId, assessmentId, expiresAt: expiresAt.toISOString(), paramsHash: proposal.paramsHash, warnings: verdict.warnings });
        });
        out.sent.push(proposal.symbol);
      } catch (e) {
        // The buttons are on screen but there is no approval behind them: say so, and a tap will find nothing.
        await notifier.edit(msg.messageId, notify.approvalClosed({ symbol: proposal.symbol, amountUsd: proposal.amountUsd, action: proposal.action, outcome: "withdrawn", note: "the request could not be recorded" }));
        log("could not record an approval request:", clean(e));
      }
    }
    return out;
  }

  // The owner's decision. `outcome` says what happened in one word.
  async function decide(approvalId, approve, { channel, actor }) {
    let result;
    try {
      result = await db.withTransaction(async (tx) => {
        const a = (await tx.query("select * from trading.approvals where id = $1 for update", [approvalId])).rows[0];
        if (!a) return { outcome: "unknown", message: "This request is not on record. Nothing was done." };
        const p = await loadProposal(tx, a.proposal_id, { forUpdate: true });
        const base = { proposal: p, messageId: a.telegram_message_id === null ? null : Number(a.telegram_message_id) };
        if (a.decision !== null) {
          // A second tap (or a tap on the other channel). Nothing happens; it is put on record.
          await audit(tx, "approval.duplicate", p.id, { approvalId, attempted: approve ? "approve" : "reject", previous: a.decision }, `owner:${channel}`);
          return { ...base, outcome: "already_decided", message: `This request was already ${a.decision} at ${iso(a.decided_at)}. Nothing more was done.`, previous: a.decision };
        }
        const t = now();
        if (t.getTime() > new Date(a.expires_at).getTime()) {
          await tx.query("update trading.proposals set status = 'expired', status_reason = 'the approval request was not answered within its time' where id = $1 and status = 'pending_approval'", [p.id]);
          await audit(tx, "approval.expired", p.id, { approvalId, lateAttempt: approve ? "approve" : "reject" }, `owner:${channel}`);
          return { ...base, outcome: "expired", message: `This request expired at ${iso(a.expires_at)}. Nothing was done.` };
        }
        if (p.status !== "pending_approval") return { ...base, outcome: "not_pending", message: `The proposal is "${p.status}". Nothing was done.` };
        let recomputed = null;
        try { recomputed = paramsHash({ action: p.action, instrumentId: p.instrumentId, direction: p.direction, leverage: p.leverage, orderType: p.orderType, limitRate: p.limitRate, amountUsd: p.amountUsd, positionId: p.positionId, expiresAt: p.expiresAt }); } catch { /* treated as a mismatch */ }
        if (recomputed !== p.paramsHash || a.params_hash !== p.paramsHash) {
          await tx.query("update trading.proposals set status = 'failed', status_reason = 'the approval request does not match the proposal''s parameters (hash mismatch)' where id = $1", [p.id]);
          await audit(tx, "approval.mismatch", p.id, { approvalId }, `owner:${channel}`);
          return { ...base, outcome: "mismatch", message: "The request does not match the proposal's parameters. Nothing was done; a new proposal is needed." };
        }
        await tx.query("update trading.approvals set decision = $2, decided_at = $3, channel = $4, actor = $5 where id = $1", [approvalId, approve ? "approved" : "rejected", t.toISOString(), channel, String(actor ?? "")]);
        await tx.query("update trading.proposals set status = $2, status_reason = $3 where id = $1", [p.id, approve ? "approved" : "rejected", approve ? null : "rejected by the owner"]);
        await audit(tx, approve ? "approval.approved" : "approval.rejected", p.id, { approvalId, paramsHash: p.paramsHash }, `owner:${channel}`);
        return { ...base, outcome: approve ? "approved" : "rejected", message: approve ? "Approved." : "Rejected. Nothing was sent." };
      });
    } catch (e) { return { outcome: "error", message: `The decision could not be recorded, so nothing was done: ${clean(e)}` }; }
    if (result.outcome === "approved") result.execution = await gateway.execute(result.proposal.id);
    return result;
  }

  const ownsCallback = (data) => CALLBACK.test(String(data || ""));

  // A tap on Approve / Reject. server.js has already checked that it comes
  // from the owner's chat and carries Telegram's webhook secret.
  async function handleTelegramCallback(cq) {
    const m = CALLBACK.exec(String(cq?.data || ""));
    if (!m) return false;
    const approve = m[1] === "ok";
    const r = await decide(m[2], approve, { channel: "telegram", actor: cq.from?.id ?? cq.message?.chat?.id ?? "owner" });
    await notifier.answer(cq.id, r.outcome === "approved" ? "Approved — checking and sending" : r.outcome === "rejected" ? "Rejected" : r.message.slice(0, 180));
    const messageId = cq.message?.message_id ?? r.messageId;
    if (messageId && r.proposal && r.outcome !== "already_decided") {
      await notifier.edit(messageId, notify.approvalClosed({ symbol: r.proposal.symbol, amountUsd: r.proposal.amountUsd, action: r.proposal.action, outcome: r.outcome, note: r.outcome === "approved" ? notSentNote(r.execution) : r.outcome === "rejected" ? null : r.message, at: now() }));
    }
    return true;
  }

  // Every minute: expire, offer what can be offered, settle orders in flight.
  // A tap on Approve / Reject in the console's Trading Desk tab (Stage 7). The
  // same decide() as Telegram, recorded with channel "dashboard"; the Telegram
  // request for the same approval is then edited so its buttons are gone.
  // On the approved request itself: whether the order was then sent.
  const notSentNote = (x) => (x && x.sent === false ? `but NO order was sent: ${x.reason}` : null);

  async function decideFromDashboard(approvalId, approve) {
    if (!/^[0-9a-f-]{36}$/.test(String(approvalId || ""))) return { outcome: "unknown", message: "This request is not on record. Nothing was done." };
    const r = await decide(approvalId, approve, { channel: "dashboard", actor: "console" });
    if (r.messageId && r.proposal && r.outcome !== "already_decided") {
      await notifier.edit(r.messageId, notify.approvalClosed({ symbol: r.proposal.symbol, amountUsd: r.proposal.amountUsd, action: r.proposal.action, outcome: r.outcome, note: r.outcome === "approved" ? ["decided in the console", notSentNote(r.execution)].filter(Boolean).join(", ") : r.outcome === "rejected" ? "decided in the console" : r.message, at: now() }));
    }
    return r;
  }

  async function tick() {
    if (busy) return { skipped: "busy" };
    busy = true;
    const out = {};
    try {
      out.expired = await expireOld();
      out.dispatch = await dispatch();
      out.orders = await gateway.reconcileAll();
    } catch (e) { out.error = clean(e); log("tick failed:", out.error); }
    finally { busy = false; }
    return out;
  }

  function start() {
    if (timer) return false;
    timer = setInterval(() => { tick(); }, 60000);
    if (typeof timer.unref === "function") timer.unref();
    return true;
  }

  async function summary() {
    const r = await db.query("select status, count(*) as n from trading.proposals where status in ('draft', 'pending_approval', 'approved', 'executing') group by status");
    const o = await db.query("select status, count(*) as n from trading.orders where status in ('submitting', 'submitted', 'unknown') group by status");
    return { proposals: Object.fromEntries(r.rows.map((x) => [x.status, Number(x.n)])), ordersInFlight: Object.fromEntries(o.rows.map((x) => [x.status, Number(x.n)])), tradingOff: await tradingOff() };
  }

  return { dispatch, decide, decideFromDashboard, expireOld, tick, start, summary, ownsCallback, handleTelegramCallback };
}

module.exports = { createApprovals, inQuietHours, readQuietHours, CALLBACK };
