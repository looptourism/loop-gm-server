// ---------------------------------------------------------------------------
// Position monitoring — plain code, no AI, read-only.
//
// Every 15 minutes (two minutes after each price collection) it:
//   1. reads the open positions of the eToro DEMO account (one request);
//   2. keeps the desk's own record of them in step (trading.positions);
//   3. checks each position against its exit conditions, using the newest
//      stored price — and only if that price is fresh;
//   4. sends a Telegram alert when a condition is reached.
//
// It never closes, changes or opens anything: there is no such code here. An
// alert is information for the owner. Closing a position will be a proposal
// that needs approval, like opening one (Stage 6).
//
// "During market hours" needs no calendar: a price counts only when eToro's
// own timestamp for it is recent. A stock outside market hours has an old
// price, so nothing is judged on it; coins are checked around the clock.
//
// Each alert is sent ONCE per position and condition, however many checks
// see it as true. If Telegram does not accept the message it is not recorded
// as sent, so the next check tries again.
//
// Limits: a price that crosses a level and comes back between two checks is
// not seen, and an alert is not a stop order — the position stays open until
// the owner acts.
// ---------------------------------------------------------------------------
const crypto = require("crypto");
const { POSITIONS, MONITORING } = require("./config");
const { POLICY } = require("./policy");
const { summarizeDemoAccount } = require("./account");
const { parseUtc, rateFreshness } = require("./market-data");
const { recordRun } = require("./db/snapshots");
const notify = require("./notify");

const DAY = 86400000;
const iso = (v) => (v ? new Date(v).toISOString() : null);

// What one stored condition means, and the key that makes its alert unique.
function conditionKey(c) {
  if (c.type === "price_below" || c.type === "price_above") return `${c.type}:${Number(c.value)}`;
  if (c.type === "date_after") return `date_after:${c.date}`;
  return `other:${crypto.createHash("sha256").update(String(c.description || "")).digest("hex").slice(0, 12)}`;
}

// Pure: which conditions of one position are reached right now.
// `rate` is { bid, asOf, fresh } or null. A long position is closed by
// selling, so price levels are compared with the BID.
function evaluatePosition({ position, rate, now, policy = POLICY }) {
  const hits = [], notChecked = [];
  const conditions = Array.isArray(position.exitConditions) ? position.exitConditions : [];
  for (const c of conditions) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "price_below" || c.type === "price_above") {
      const level = Number(c.value);
      if (!(level > 0)) { notChecked.push({ condition: c, why: "no usable price level" }); continue; }
      if (!rate) { notChecked.push({ condition: c, why: "no price is stored" }); continue; }
      if (!rate.fresh) { notChecked.push({ condition: c, why: "the price is not fresh (market closed or data delayed)" }); continue; }
      if (c.type === "price_below" ? rate.bid <= level : rate.bid >= level) hits.push({ key: conditionKey(c), kind: "exit_condition", condition: c });
    } else if (c.type === "date_after") {
      const end = /^\d{4}-\d{2}-\d{2}$/.test(c.date || "") ? Date.parse(`${c.date}T23:59:59Z`) : NaN;
      if (Number.isNaN(end)) notChecked.push({ condition: c, why: "no usable date" });
      else if (now.getTime() > end) hits.push({ key: conditionKey(c), kind: "exit_condition", condition: c });
    } else notChecked.push({ condition: c, why: "described in words only; code cannot check it" });
  }
  // The desk's own rule, whatever the proposal said: a swing position is not held beyond the maximum.
  const opened = position.openedAt ? Date.parse(position.openedAt) : NaN;
  if (!Number.isNaN(opened) && now.getTime() - opened > policy.holdingDays.max * DAY) {
    hits.push({ key: `time_limit:${policy.holdingDays.max}d`, kind: "time_limit", condition: { type: "date_after", description: `held longer than the desk's maximum of ${policy.holdingDays.max} days` } });
  }
  if (!conditions.some((c) => c && c.type === "price_below" && Number(c.value) > 0)) {
    hits.push({ key: "no_stop_level", kind: "no_exit_conditions", condition: { type: "other", description: "this position has no stop level on record, so the desk cannot watch one for it" } });
  }
  return { hits, notChecked };
}

function createPositionMonitor({ config, client, db, notifier, settings = POSITIONS, policy = POLICY, freshSec = MONITORING.rateFreshSec, now = () => new Date(), cron = null, log = (...a) => console.log("[trading/positions]", ...a) } = {}) {
  let running = false, scheduled = false, failures = 0, lastCheck = null;
  const clean = (e) => db.redact(client.redact(e?.message || String(e)));

  // Sends an alert unless the same one was already sent. Recorded only if delivered.
  async function alert(run, { etoroPositionId, key, kind, symbol, html, facts }) {
    const seen = await db.query("select 1 from trading.position_alerts where etoro_position_id = $1 and condition_key = $2", [etoroPositionId, key]);
    if (seen.rows.length) return false;
    if (!(await notifier.send(html))) { run.problems.push({ symbol, instrumentId: null, problem: `alert "${key}" could not be delivered to Telegram; it will be tried again at the next check` }); return false; }
    await db.query(
      "insert into trading.position_alerts (etoro_position_id, condition_key, kind, symbol, message, facts, delivered) values ($1, $2, $3, $4, $5, $6, true) on conflict do nothing",
      [etoroPositionId, key, kind, symbol, html, JSON.stringify(facts || {})]
    );
    run.inserted++;
    return true;
  }

  async function check(trigger = "schedule") {
    if (running) return { ok: false, skipped: "a check is already in progress" };
    running = true;
    const run = { kind: "positions", trigger, startedAt: now().toISOString(), instruments: 0, requests: 0, inserted: 0, unchanged: 0, revised: 0, problems: [] };
    const out = { ok: false, trigger, startedAt: run.startedAt, positions: [], alertsSent: 0 };
    try {
      if (!config.hasKeys) { out.skipped = "ETORO_API_KEY / ETORO_USER_KEY are not set"; return out; }
      if (!db.configured) { out.skipped = "TRADING_DATABASE_URL is not set"; return out; }
      run.requests = 1;
      const pnl = await client.getDemoPnl();
      const account = summarizeDemoAccount(pnl); // throws if eToro's answer is not usable
      const t = now();
      // The account's figures at this moment. The risk engine measures today's loss
      // against the first of these each day; without it no order can be sent.
      const equity = Math.round((account.availableCashUsd + account.investedUsd + account.pendingOrdersUsd + account.unrealizedPnlUsd) * 100) / 100;
      await db.query(
        "insert into trading.account_snapshots (taken_at, credit_usd, invested_usd, pending_orders_usd, unrealized_pnl_usd, equity_usd, open_positions, source) values ($1, $2, $3, $4, $5, $6, $7, $8)",
        [pnl.fetchedAt, account.creditUsd, account.investedUsd, account.pendingOrdersUsd, account.unrealizedPnlUsd, equity, account.openPositions, pnl.source]
      );
      const known = new Map((await db.query("select instrument_id, symbol, asset_class from trading.instruments")).rows.map((r) => [Number(r.instrument_id), r]));
      const seenIds = [];
      run.instruments = account.positions.length;

      for (const p of account.positions) {
        const inst = known.get(p.instrumentId);
        const symbol = inst?.symbol ?? `instrument ${p.instrumentId}`;
        const figures = { amountUsd: p.amountUsd, unrealizedPnlUsd: p.unrealizedPnlUsd, openRate: p.openRate, openedAt: p.openedAt };
        const outside = [!inst && "its instrument is not on your allowlists", p.direction !== "buy" && "it is not a buy (long) position", p.leverage !== 1 && `it uses leverage ${p.leverage ?? "unknown"}`].filter(Boolean);
        if (outside.length) {
          // The desk's record only holds positions inside its rules; this one is reported instead.
          out.positions.push({ symbol, etoroPositionId: p.positionId, outsideRules: outside });
          await alert(run, { etoroPositionId: p.positionId, key: "outside_rules", kind: "outside_rules", symbol, facts: { ...figures, outside, source: pnl.source, fetchedAt: pnl.fetchedAt },
            html: notify.positionAlert({ title: "A demo position is outside the desk's rules", symbol, lines: [`Why: ${outside.join("; ")}.`, "The desk does not watch exit conditions for it."], figures }) });
          continue;
        }
        const openedAt = parseUtc(typeof p.openedAt === "string" ? p.openedAt : "")?.toISOString() ?? null;
        const row = (await db.query(
          `insert into trading.positions (etoro_position_id, instrument_id, direction, leverage, amount_usd, units, open_rate, opened_at, source, last_synced_at)
           values ($1, $2, 'buy', 1, $3, $4, $5, $6, $7, $8)
           on conflict (etoro_position_id) do update set amount_usd = excluded.amount_usd, units = excluded.units, last_synced_at = excluded.last_synced_at
           returning id, exit_conditions, opened_at, status`,
          [p.positionId, p.instrumentId, p.amountUsd, p.units, p.openRate, openedAt, pnl.source, pnl.fetchedAt]
        )).rows[0];
        seenIds.push(p.positionId);
        run.unchanged++;

        const r = (await db.query("select bid, ask, as_of, quote_type, source from trading.market_snapshots where kind = 'rate' and instrument_id = $1 order by as_of desc limit 1", [p.instrumentId])).rows[0];
        const f = r ? rateFreshness({ asOf: r.as_of, quoteType: r.quote_type }, t, freshSec) : null;
        const rate = r ? { bid: Number(r.bid), ask: Number(r.ask), asOf: iso(r.as_of), ageSec: f.ageSec, fresh: f.fresh, source: r.source } : null;
        const verdict = evaluatePosition({ position: { exitConditions: row.exit_conditions, openedAt: iso(row.opened_at) }, rate, now: t, policy });
        out.positions.push({ symbol, etoroPositionId: p.positionId, priceFresh: rate ? rate.fresh : null, reached: verdict.hits.map((h) => h.key), notChecked: verdict.notChecked.length });
        for (const h of verdict.hits) {
          const title = h.kind === "exit_condition" ? "Exit condition reached" : h.kind === "time_limit" ? "Holding limit passed" : "Position has no stop level";
          const what = h.condition.type === "price_below" ? `price at or below ${h.condition.value}` : h.condition.type === "price_above" ? `price at or above ${h.condition.value}` : h.condition.type === "date_after" && h.condition.date ? `after ${h.condition.date}` : null;
          const lines = [what ? `Condition: ${what} — ${h.condition.description}` : `${h.condition.description}`];
          if (rate) lines.push(`Price now: bid ${rate.bid} at ${rate.asOf.slice(0, 16).replace("T", " ")} UTC (${rate.fresh ? "fresh" : "NOT fresh"})`);
          lines.push("Nothing was closed. The position stays open until you act.");
          await alert(run, { etoroPositionId: p.positionId, key: h.key, kind: h.kind, symbol, facts: { ...figures, condition: h.condition, rate, source: pnl.source, fetchedAt: pnl.fetchedAt },
            html: notify.positionAlert({ title, symbol, lines, figures }) });
        }
      }

      // A position we have on record as open that eToro no longer lists was closed somewhere else.
      const gone = (await db.query("update trading.positions set status = 'closed', closed_at = $2, last_synced_at = $2 where status = 'open' and not (etoro_position_id = any($1::bigint[])) returning etoro_position_id, instrument_id, amount_usd, closed_by_order_id", [seenIds, t.toISOString()])).rows;
      for (const g of gone) {
        const symbol = known.get(Number(g.instrument_id))?.symbol ?? `instrument ${g.instrument_id}`;
        run.revised++;
        if (g.closed_by_order_id) continue; // closed through the desk: already reported there
        await alert(run, { etoroPositionId: Number(g.etoro_position_id), key: "closed_elsewhere", kind: "closed_elsewhere", symbol, facts: { amountUsd: Number(g.amount_usd), noticedAt: t.toISOString() },
          html: notify.positionAlert({ title: "A position is no longer open on eToro", symbol, lines: ["It was closed outside the Trading Desk (by you on eToro, or by eToro). The desk has marked it closed."], figures: { amountUsd: Number(g.amount_usd) } }) });
      }
      out.alertsSent = run.inserted;
      out.account = { openPositions: account.openPositions, investedUsd: account.investedUsd, unrealizedPnlUsd: account.unrealizedPnlUsd, readAt: account.fetchedAt };
      out.ok = run.problems.length === 0;
    } catch (e) {
      run.problems.push({ symbol: null, instrumentId: null, problem: clean(e) });
      out.error = clean(e);
    } finally {
      out.finishedAt = now().toISOString();
      if (!out.skipped) {
        run.finishedAt = out.finishedAt;
        run.status = out.error ? "failed" : run.problems.length ? "partial" : "ok";
        out.problems = run.problems.map((p) => p.problem);
        try { await recordRun(db, run); } catch (e) { log("could not record the check:", clean(e)); }
        // Tell the owner when the watch itself stops working, and when it is back.
        if (out.error) {
          failures++;
          if (failures === settings.failuresBeforeAlert) await notifier.send(`⚠️ <b>Position monitoring is not working</b> (DEMO)\n${notify.esc(out.error.slice(0, 300))}\nOpen positions are NOT being checked. It keeps trying every 15 minutes.`);
        } else {
          if (failures >= settings.failuresBeforeAlert) await notifier.send("✅ <b>Position monitoring is working again</b> (DEMO)");
          failures = 0;
        }
        if (out.error || run.inserted || run.problems.length) log(out.error ? `failed: ${out.error}` : `${run.instruments} position(s), ${run.inserted} alert(s), ${run.problems.length} problem(s)`);
      }
      lastCheck = out;
      running = false;
    }
    return out;
  }

  // Same switch as price monitoring: only when TRADING_MONITOR_ENABLED is exactly "true".
  function start() {
    if (scheduled || !config.monitorEnabled) return false;
    (cron || require("node-cron")).schedule(settings.cron, () => { check("schedule"); }, { timezone: "UTC" });
    scheduled = true;
    log(`schedule on (${settings.cron} UTC): open positions are checked every 15 minutes`);
    return true;
  }

  const state = () => ({ scheduled, cronUtc: settings.cron, consecutiveFailures: failures, lastCheck });
  return { check, start, state };
}

module.exports = { createPositionMonitor, evaluatePosition, conditionKey };
