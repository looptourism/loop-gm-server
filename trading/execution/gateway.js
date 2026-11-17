// ---------------------------------------------------------------------------
// The execution gateway (Stage 5) — the only path from an approval to an
// order, and it is plain code.
//
// execute(proposalId) sends ONE demo order, and only if every one of these
// holds at that moment. Any "no" or "don't know" ends with no order:
//
//   1. the proposal is in status "approved" (taken to "executing" under a
//      row lock, so two calls can never both proceed);
//   2. its approval is approved, unused and not expired;
//   3. the hash of the proposal's parameters, recomputed now, equals the hash
//      stored on the proposal AND the hash stored on the approval;
//   4. the risk engine passes again with a LIVE account and a LIVE price —
//      including the kill switch and how far the price moved since you were
//      asked;
//   5. the approval is marked used and the order row is written in one
//      transaction (the database refuses the row otherwise) BEFORE anything
//      is sent.
//
// Then the order is sent once, with the proposal's idempotency key as the
// request ID. It is never sent again: not on a timeout, not on a restart.
// If eToro's answer is lost or unclear the order is "unknown" and is settled
// only by looking it up on eToro (reconcile), using that same key.
// ---------------------------------------------------------------------------
const { POLICY } = require("../policy");
const { paramsHash } = require("../proposals");
const { assess } = require("../risk/engine");
const { buildContext, saveAssessment, loadProposal, readHalted } = require("../risk/context");
const { appendAudit } = require("../db/store");
const { buildOpenOrder, buildCloseOrder, OrderError, DEMO_CLOSE_PATH_PREFIX } = require("./etoro-orders");
const { summarizeDemoAccount } = require("../account");
const { parseUtc } = require("../market-data");

// Close orders have their own status list (Stage 6, "Get close order information").
const CLOSE_FILLED = 3;
const CLOSE_NOT_EXECUTED = new Set([4, 7, 8]);  // Rejected, Canceled, Expired
const CLOSE_PARTLY_THEN_STOPPED = new Set([9, 10]); // CanceledPartiallyFilled, RejectedPartiallyFilled
const CLOSE_IN_FLIGHT = new Set([1, 2, 5, 6, 11]);
const FILLED = new Set([3, 5]);       // Filled, PartiallyFilled
const REJECTED = new Set([4, 10]);    // Rejected, RejectedPartiallyFilled
const IN_FLIGHT = new Set([1, 2, 11, 12]); // Received, Placed, WaitingForMarket, PendingTriggeredRate
const DAY = 86400000;
const iso = (v) => (v ? new Date(v).toISOString() : null);

function createGateway({ config, db, client, orders, policy = POLICY, now = () => new Date(), onOutcome = null, log = (...a) => console.log("[trading/gateway]", ...a) } = {}) {
  const clean = (e) => db.redact(client.redact(orders.redact(e?.message || String(e))));
  const audit = (q, eventType, proposalId, data, entity = {}) => appendAudit(q, { eventType, entityType: entity.type || "proposal", entityId: entity.id || proposalId, proposalId, actor: "system:gateway", data });
  const tell = (outcome) => { if (onOutcome) Promise.resolve().then(() => onOutcome(outcome)).catch((e) => log("could not report an outcome:", clean(e))); };

  const hashOf = (p) => paramsHash({ action: p.action, instrumentId: p.instrumentId, direction: p.direction, leverage: p.leverage, orderType: p.orderType, limitRate: p.limitRate, amountUsd: p.amountUsd, positionId: p.positionId, expiresAt: p.expiresAt });

  // Ends an execution attempt with no order. The proposal becomes "failed":
  // a new proposal and a new approval are needed to try again.
  async function refuse(proposalId, reason, extra = {}) {
    try {
      await db.withTransaction(async (tx) => {
        await tx.query("update trading.proposals set status = 'failed', status_reason = $2 where id = $1 and status in ('approved', 'executing')", [proposalId, reason.slice(0, 500)]);
        await audit(tx, "execution.refused", proposalId, { reason, ...extra });
      });
    } catch (e) { log("could not record a refusal:", clean(e)); }
    // Tell the owner, the same as any other outcome: an approval that ends
    // with no order must never look like a trade that went through.
    let proposal = null;
    try { proposal = await loadProposal(db, proposalId); } catch { /* the message names no symbol */ }
    const out = { ok: false, sent: false, status: "refused", reason, ...extra, proposal };
    tell(out);
    return out;
  }

  async function execute(proposalId) {
    // ---- 1–3: state, approval, hash — under row locks -------------------------
    let proposal, approval;
    try {
      const gate = await db.withTransaction(async (tx) => {
        const p = await loadProposal(tx, proposalId, { forUpdate: true });
        if (!p) return { stop: "the proposal does not exist", soft: true };
        if (p.status !== "approved") return { stop: `the proposal is "${p.status}", not approved — nothing was sent`, soft: true };
        const a = (await tx.query("select * from trading.approvals where proposal_id = $1 for update", [proposalId])).rows[0];
        if (!a || a.decision !== "approved") return { stop: "there is no approved approval for this proposal" };
        if (a.consumed_at !== null) return { stop: "the approval has already been used" };
        if (now().getTime() > new Date(a.expires_at).getTime()) return { stop: `the approval expired at ${iso(a.expires_at)}` };
        let recomputed;
        try { recomputed = hashOf(p); } catch (e) { return { stop: `the proposal's parameters are not valid: ${e.message}` }; }
        if (recomputed !== p.paramsHash || a.params_hash !== p.paramsHash) return { stop: "the approval does not match the proposal's parameters (hash mismatch)" };
        await tx.query("update trading.proposals set status = 'executing', status_reason = null where id = $1", [proposalId]);
        return { p, a };
      });
      if (gate.stop) return gate.soft ? { ok: false, sent: false, status: "refused", reason: gate.stop } : refuse(proposalId, gate.stop);
      proposal = gate.p; approval = gate.a;
    } catch (e) { return { ok: false, sent: false, status: "refused", reason: `the database could not be used: ${clean(e)}` }; }

    // ---- kill switch, before anything else is asked of eToro ---------------------
    if (config.tradingEnabled !== true) return refuse(proposalId, "trading is switched off (TRADING_ENABLED is not \"true\")");
    if (await readHalted(db)) return refuse(proposalId, "trading was stopped (/trade_stop), or the stop state could not be read");

    // ---- 4: the risk engine again, on live facts --------------------------------
    let verdict, ctx, body;
    try {
      const ref = (await db.query("select inputs from trading.risk_assessments where proposal_id = $1 and phase = 'pre_approval' and passed order by created_at desc limit 1", [proposalId])).rows[0];
      ctx = await buildContext({ db, client, config, policy, proposal, phase: "pre_execution", now: now(), referenceAsk: ref?.inputs?.price?.ask ?? null });
      verdict = assess(ctx);
      await saveAssessment(db, proposalId, ctx, verdict);
      body = proposal.action === "close"
        ? buildCloseOrder({ etoroPositionId: ctx.position?.etoroPositionId, instrumentId: proposal.instrumentId })
        : buildOpenOrder({ instrumentId: proposal.instrumentId, amountUsd: proposal.amountUsd, direction: proposal.direction, leverage: proposal.leverage, orderType: proposal.orderType, action: proposal.action });
    } catch (e) { return refuse(proposalId, `the pre-execution check could not be completed: ${clean(e)}`); }
    if (!verdict.passed) {
      const why = verdict.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message}`);
      return refuse(proposalId, `risk engine: ${why.join("; ")}`, { failedChecks: verdict.failed });
    }

    // ---- 5: use the approval and write the order row, then send -----------------
    let orderRow;
    try {
      orderRow = await db.withTransaction(async (tx) => {
        const a = (await tx.query("select expires_at, consumed_at, decision from trading.approvals where id = $1 for update", [approval.id])).rows[0];
        const t = now();
        if (!a || a.decision !== "approved" || a.consumed_at !== null) throw new Error("the approval is no longer usable");
        if (t.getTime() > new Date(a.expires_at).getTime()) throw new Error(`the approval expired at ${iso(a.expires_at)} while the checks were running`);
        await tx.query("update trading.approvals set consumed_at = $2 where id = $1", [approval.id, t.toISOString()]);
        const o = (await tx.query(
          "insert into trading.orders (proposal_id, approval_id, params_hash, idempotency_key, status, request, created_at, order_kind) values ($1, $2, $3, $4, 'submitting', $5, $6, $7) returning id",
          [proposalId, approval.id, proposal.paramsHash, proposal.idempotencyKey, JSON.stringify({
            path: proposal.action === "close" ? `POST ${DEMO_CLOSE_PATH_PREFIX}${ctx.position.etoroPositionId}` : "POST /api/v2/trading/execution/demo/orders",
            requestId: proposal.idempotencyKey, body, ...(proposal.action === "close" ? { etoroPositionId: ctx.position.etoroPositionId } : {}),
          }), t.toISOString(), proposal.action === "close" ? "close" : "open"]
        )).rows[0];
        await audit(tx, "order.created", proposalId, { orderId: o.id, body, livePrice: ctx.price }, { type: "order", id: o.id });
        return o;
      });
    } catch (e) { return refuse(proposalId, `the order could not be recorded, so it was not sent: ${clean(e)}`); }

    let placed;
    try {
      placed = proposal.action === "close"
        ? await orders.placeDemoClose(ctx.position.etoroPositionId, body, { idempotencyKey: proposal.idempotencyKey })
        : await orders.placeDemoOrder(body, { idempotencyKey: proposal.idempotencyKey });
    }
    catch (e) {
      const message = e instanceof OrderError ? clean(e) : `unexpected error: ${clean(e)}`;
      if (e instanceof OrderError && e.sent === false) {
        // eToro did not take it (or it never left): final, no order exists.
        await settle(orderRow.id, proposal, { status: e.code === "Rejected" ? "rejected" : "failed", error: message, response: e.body ?? null, proposalStatus: "failed", event: "order.not_placed" });
        const out = { ok: false, sent: false, status: "not_placed", reason: message, proposal };
        tell(out); return out;
      }
      // The answer was lost or unclear: the order may exist. Never resend.
      await settle(orderRow.id, proposal, { status: "unknown", error: message, event: "order.unknown" });
      const checked = await reconcileOrder(orderRow.id, { announce: false });
      const out = checked.final ? checked : { ok: false, sent: true, status: "unknown", reason: `${message}. The order may or may not exist on eToro; it will be looked up, and it will NOT be sent again.`, proposal };
      tell(out); return out;
    }
    await settle(orderRow.id, proposal, { status: "submitted", etoroOrderId: placed.orderId, response: placed.response, submittedAt: placed.fetchedAt, event: "order.submitted" });
    const out = await reconcileOrder(orderRow.id, { announce: false });
    tell(out);
    return out;
  }

  // Writes an order's new state (and the proposal's, when it is final).
  async function settle(orderId, proposal, { status, error = null, response, etoroOrderId, submittedAt, verification, verifiedAt, proposalStatus = null, proposalReason = null, event, data = {} }) {
    try {
      await db.withTransaction(async (tx) => {
        await tx.query(
          `update trading.orders set status = $2, error = $3, response = coalesce($4, response), etoro_order_id = coalesce($5, etoro_order_id),
             submitted_at = coalesce($6, submitted_at), verification = coalesce($7, verification), verified_at = coalesce($8, verified_at) where id = $1`,
          [orderId, status, error, response === undefined ? null : JSON.stringify(response), etoroOrderId ?? null, submittedAt ?? null, verification === undefined ? null : JSON.stringify(verification), verifiedAt ?? null]
        );
        if (proposalStatus) await tx.query("update trading.proposals set status = $2, status_reason = $3 where id = $1 and status = 'executing'", [proposal.id, proposalStatus, (proposalReason || error || "").slice(0, 500) || null]);
        await audit(tx, event, proposal.id, { orderId, status, error, etoroOrderId: etoroOrderId ?? null, ...data }, { type: "order", id: orderId });
      });
    } catch (e) { log(`could not record ${event}:`, clean(e)); }
  }

  // Records the position(s) an order opened, with the exit conditions the
  // owner approved — this is what the 15-minute position check watches.
  async function recordPositions(tx, order, proposal, info) {
    const made = [];
    const exits = Array.isArray(proposal.details.exit_conditions) ? [...proposal.details.exit_conditions] : [];
    for (const x of Array.isArray(info.positionExecutions) ? info.positionExecutions : []) {
      if (!Number.isInteger(x?.positionId)) continue;
      const opened = parseUtc(x.openingData?.openTime || "") || now();
      const conditions = [...exits];
      if (Number.isInteger(proposal.details.holding_days)) conditions.push({ type: "date_after", date: new Date(opened.getTime() + proposal.details.holding_days * DAY).toISOString().slice(0, 10), description: `planned holding period of ${proposal.details.holding_days} day(s)` });
      // The dollars invested in the position. eToro's real answer (first demo
      // order, 2026-11-16) carried them in marginAccountCurrency and
      // initialExposureAccountCurrency (49.97 for a $50 order, after $0.47
      // fees); investedAmountCurrency was 1, not a dollar figure, and is not
      // used. At leverage 1 margin and exposure are the same amount.
      const dollars = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null);
      const amount = dollars(x.marginAccountCurrency) ?? dollars(x.initialExposureAccountCurrency) ?? proposal.amountUsd;
      await tx.query(
        `insert into trading.positions (etoro_position_id, instrument_id, direction, leverage, amount_usd, units, open_rate, opened_at, exit_conditions, source, last_synced_at, opened_by_order_id)
         values ($1, $2, 'buy', 1, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (etoro_position_id) do update set exit_conditions = excluded.exit_conditions, opened_by_order_id = excluded.opened_by_order_id, open_rate = coalesce(excluded.open_rate, trading.positions.open_rate)`,
        [x.positionId, proposal.instrumentId, amount, x.openingData?.units ?? x.remainingUnits ?? null, x.openingData?.avgPrice ?? null, opened.toISOString(), JSON.stringify(conditions), "eToro Public API GET /api/v2/trading/info/demo/orders:lookup", now().toISOString(), order.id]
      );
      made.push({ positionId: x.positionId, amountUsd: amount, openRate: x.openingData?.avgPrice ?? null, exitConditions: conditions });
    }
    return made;
  }

  // Asks eToro what became of one order and records the answer. Read-only
  // toward eToro. Returns an outcome; `final` says whether it is settled.
  async function reconcileOrder(orderId, { announce = true } = {}) {
    const order = (await db.query("select * from trading.orders where id = $1", [orderId])).rows[0];
    if (!order) return { ok: false, final: true, status: "unknown", reason: "no such order" };
    const proposal = await loadProposal(db, order.proposal_id);
    const done = (out) => { if (announce && out.final) tell(out); return out; };
    if (!["submitting", "submitted", "unknown"].includes(order.status)) return { ok: order.status === "filled", final: true, sent: true, status: order.status, proposal };
    if (order.order_kind === "close") return done(await reconcileClose(order, proposal));
    let info;
    try {
      const r = await client.getDemoOrder(order.etoro_order_id ? { orderId: Number(order.etoro_order_id) } : { referenceId: order.idempotency_key });
      info = r.data;
    } catch (e) {
      if (e?.status === 404 && !order.etoro_order_id) {
        // eToro has no order under our request ID. Right after a lost answer that proves nothing yet.
        const ageMin = (now().getTime() - new Date(order.created_at).getTime()) / 60000;
        if (ageMin < policy.execution.lookupGiveUpMinutes) return { ok: false, final: false, sent: true, status: "unknown", reason: "eToro has no record of the order yet; it will be looked up again", proposal };
        const reason = `eToro has no record of the order ${Math.round(ageMin)} minutes after it was sent: it was not placed`;
        await settle(order.id, proposal, { status: "failed", error: reason, verifiedAt: now().toISOString(), proposalStatus: "failed", event: "order.not_found" });
        return done({ ok: false, final: true, sent: false, status: "not_placed", reason, proposal });
      }
      return { ok: false, final: false, sent: true, status: order.status, reason: `the order could not be looked up: ${clean(e)}`, proposal };
    }
    const id = info?.status?.id;
    const at = now().toISOString();
    if (FILLED.has(id)) {
      let positions = [];
      try {
        await db.withTransaction(async (tx) => {
          positions = await recordPositions(tx, order, proposal, info);
          await tx.query("update trading.orders set status = 'filled', error = null, etoro_order_id = coalesce(etoro_order_id, $2), verification = $3, verified_at = $4 where id = $1", [order.id, info.orderId ?? null, JSON.stringify(info), at]);
          await tx.query("update trading.proposals set status = 'executed', status_reason = null where id = $1 and status = 'executing'", [proposal.id]);
          await audit(tx, "order.filled", proposal.id, { orderId: order.id, etoroOrderId: info.orderId ?? null, etoroStatus: info.status, positions }, { type: "order", id: order.id });
        });
      } catch (e) { return { ok: false, final: false, sent: true, status: order.status, reason: `eToro reports the order filled, but it could not be recorded: ${clean(e)}`, proposal }; }
      return done({ ok: true, final: true, sent: true, status: "filled", partial: id === 5, etoroOrderId: info.orderId ?? null, positions, proposal });
    }
    if (REJECTED.has(id)) {
      const reason = `eToro rejected the order: ${info.status.errorMessage || info.status.name || "no reason given"} (code ${info.status.errorCode ?? "?"})`;
      await settle(order.id, proposal, { status: "rejected", error: reason, etoroOrderId: info.orderId, verification: info, verifiedAt: at, proposalStatus: "failed", event: "order.rejected" });
      return done({ ok: false, final: true, sent: true, status: "rejected", reason, proposal });
    }
    if (IN_FLIGHT.has(id)) {
      if (order.status !== "submitted") await settle(order.id, proposal, { status: "submitted", etoroOrderId: info.orderId, verification: info, verifiedAt: at, event: "order.in_flight" });
      return { ok: false, final: false, sent: true, status: "submitted", reason: `eToro has the order and has not executed it yet (${info.status.name || `status ${id}`})`, etoroOrderId: info.orderId ?? null, proposal };
    }
    return { ok: false, final: false, sent: true, status: order.status, reason: `eToro returned a status this code does not know (${id}); it will be looked up again`, proposal };
  }

  // What became of a CLOSE order. eToro offers a lookup by its own close
  // order ID only. If the answer to the close request was lost there is no
  // such ID, and the only evidence is the account itself: a position eToro
  // no longer lists is closed; one it still lists after the give-up time was
  // not closed by this request. The close is never sent again by itself.
  async function reconcileClose(order, proposal) {
    const position = (await db.query("select id, etoro_position_id, open_rate, units, amount_usd from trading.positions where id = $1", [proposal.positionId])).rows[0];
    let resultBasis = null;
    const etoroPositionId = position ? Number(position.etoro_position_id) : null;
    const at = now().toISOString();
    // The result of a close. eToro's own proceeds minus the dollars invested
    // is the authoritative figure: it includes eToro's closing costs. (First
    // real close, 2026-11-17: proceeds 49.06 on 49.97 invested = -0.91, while
    // the price change alone gave -0.44.) Only when eToro reports no proceeds
    // is the price-based figure used, and it is labelled as such.
    const markClosed = async (tx, { rate = null, units = null, occurred = null, proceeds = null }) => {
      const openRate = position?.open_rate === null || position?.open_rate === undefined ? null : Number(position.open_rate);
      const u = typeof units === "number" && units > 0 ? units : position?.units === null || position?.units === undefined ? null : Number(position.units);
      const invested = position?.amount_usd === null || position?.amount_usd === undefined ? null : Number(position.amount_usd);
      const fromProceeds = typeof proceeds === "number" && proceeds > 0 && invested !== null ? Math.round((proceeds - invested) * 100) / 100 : null;
      const fromPrices = typeof rate === "number" && openRate !== null && u !== null ? Math.round((rate - openRate) * u * 100) / 100 : null;
      const pnl = fromProceeds ?? fromPrices;
      resultBasis = fromProceeds !== null ? "proceeds" : fromPrices !== null ? "prices" : null;
      await tx.query("update trading.positions set status = 'closed', closed_at = coalesce(closed_at, $2), close_rate = coalesce($3, close_rate), realized_pnl_usd = coalesce($4, realized_pnl_usd), closed_by_order_id = $5, last_synced_at = $6 where id = $1",
        [proposal.positionId, occurred || at, rate, pnl, order.id, at]);
      return pnl;
    };
    if (!order.etoro_order_id) {
      let summary;
      try { summary = summarizeDemoAccount(await client.getDemoPnl()); }
      catch (e) { return { ok: false, final: false, sent: true, status: "unknown", reason: `the account could not be read to see whether the position closed: ${clean(e)}`, proposal }; }
      if (!summary.positions.some((p) => p.positionId === etoroPositionId)) {
        await db.withTransaction(async (tx) => {
          await markClosed(tx, {});
          await tx.query("update trading.orders set status = 'filled', error = null, verification = $2, verified_at = $3 where id = $1", [order.id, JSON.stringify({ method: "the position is no longer listed in the demo account", checkedAt: at, source: summary.source }), at]);
          await tx.query("update trading.proposals set status = 'executed', status_reason = null where id = $1 and status = 'executing'", [proposal.id]);
          await audit(tx, "order.filled", proposal.id, { orderId: order.id, kind: "close", evidence: "position no longer listed" }, { type: "order", id: order.id });
        });
        return { ok: true, final: true, sent: true, status: "closed", etoroPositionId, closeRate: null, pnlUsd: null, note: "eToro's answer to the close request was lost; the position is no longer in the account, so it is closed. The closing price is not known.", proposal };
      }
      const ageMin = (now().getTime() - new Date(order.created_at).getTime()) / 60000;
      if (ageMin < policy.execution.lookupGiveUpMinutes) return { ok: false, final: false, sent: true, status: "unknown", reason: "the position is still open; the close may still be processing. It will be checked again and NOT sent again.", proposal };
      const reason = `the position is still open ${Math.round(ageMin)} minutes after the close request, whose answer was lost: it was not closed`;
      await settle(order.id, proposal, { status: "failed", error: reason, verifiedAt: at, proposalStatus: "failed", event: "order.not_found" });
      return { ok: false, final: true, sent: false, status: "not_placed", reason, proposal };
    }
    let info;
    try { info = (await client.getDemoCloseOrder(Number(order.etoro_order_id))).data; }
    catch (e) { return { ok: false, final: false, sent: true, status: order.status, reason: `the close order could not be looked up: ${clean(e)}`, proposal }; }
    const s = info?.statusID;
    if (s === CLOSE_FILLED) {
      const mine = (Array.isArray(info.positions) ? info.positions : []).find((p) => Number(p?.positionID) === etoroPositionId) || null;
      const rate = typeof mine?.rate === "number" ? mine.rate : null;
      let pnl = null;
      try {
        await db.withTransaction(async (tx) => {
          pnl = await markClosed(tx, { rate, units: mine?.units ?? null, occurred: typeof mine?.occurred === "string" ? mine.occurred : null, proceeds: typeof info.proceeds === "number" ? info.proceeds : null });
          await tx.query("update trading.orders set status = 'filled', error = null, verification = $2, verified_at = $3 where id = $1", [order.id, JSON.stringify(info), at]);
          await tx.query("update trading.proposals set status = 'executed', status_reason = null where id = $1 and status = 'executing'", [proposal.id]);
          await audit(tx, "order.filled", proposal.id, { orderId: order.id, kind: "close", etoroOrderId: Number(order.etoro_order_id), closeRate: rate, proceeds: info.proceeds ?? null, pnlEstimateUsd: pnl }, { type: "order", id: order.id });
        });
      } catch (e) { return { ok: false, final: false, sent: true, status: order.status, reason: `eToro reports the position closed, but it could not be recorded: ${clean(e)}`, proposal }; }
      return { ok: true, final: true, sent: true, status: "closed", etoroPositionId, closeRate: rate, proceedsUsd: typeof info.proceeds === "number" ? info.proceeds : null, investedUsd: position ? Number(position.amount_usd) : null, pnlUsd: pnl, resultBasis, proposal };
    }
    if (CLOSE_NOT_EXECUTED.has(s) || CLOSE_PARTLY_THEN_STOPPED.has(s)) {
      const partly = CLOSE_PARTLY_THEN_STOPPED.has(s);
      const reason = `${partly ? "eToro closed only part of the position, then stopped" : "eToro did not close the position"}: ${info.errorMessage || `status ${s}`}${info.errorCode ? ` (code ${info.errorCode})` : ""}${partly ? ". Check the position on eToro; the desk will read its new size at the next check." : ""}`;
      await settle(order.id, proposal, { status: "rejected", error: reason, verification: info, verifiedAt: at, proposalStatus: "failed", event: "order.rejected" });
      return { ok: false, final: true, sent: true, status: "rejected", reason, proposal };
    }
    if (CLOSE_IN_FLIGHT.has(s)) {
      if (order.status !== "submitted") await settle(order.id, proposal, { status: "submitted", verification: info, verifiedAt: at, event: "order.in_flight" });
      return { ok: false, final: false, sent: true, status: "submitted", reason: `eToro has the close order and has not executed it yet (status ${s}${s === 11 ? ": waiting for the market to open" : ""})`, proposal };
    }
    return { ok: false, final: false, sent: true, status: order.status, reason: `eToro returned a close status this code does not know (${s}); it will be looked up again`, proposal };
  }

  // Every order whose fate is not settled yet. Called every minute.
  async function reconcileAll() {
    const open = (await db.query("select id, status, created_at from trading.orders where status in ('submitting', 'submitted', 'unknown') order by created_at")).rows;
    const out = [];
    for (const o of open) {
      // A row still "submitting" a minute later means the server stopped mid-send: treat as unknown, look it up.
      if (o.status === "submitting" && now().getTime() - new Date(o.created_at).getTime() < 60000) continue;
      try { out.push(await reconcileOrder(o.id)); } catch (e) { log("reconcile failed:", clean(e)); }
    }
    return out;
  }

  return { execute, reconcileOrder, reconcileAll, hashOf, _recordPositionsForTest: recordPositions };
}

module.exports = { createGateway };
