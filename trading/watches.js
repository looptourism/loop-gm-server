// ---------------------------------------------------------------------------
// Trading Desk — revisit watches.
//
// An analyst who does not recommend buying now may name one checkable
// trigger for looking again ("revisit"): the stored price crossing a level,
// or a date. This module keeps it and checks it every 15 minutes, with plain
// code, against the prices the monitor stores. When it is met:
//   • the owner gets a Telegram message, and
//   • the agents analyse that instrument again — only while their schedule
//     is on (TRADING_AGENTS_SCHEDULE_ENABLED), within the monthly budget, and
//     at most AGENTS.watch.maxRunsPerDay times per UTC day.
// A new analysis can only lead to a draft proposal, which goes to the risk
// engine and then to the owner. Nothing here can place an order.
// ---------------------------------------------------------------------------
const { AGENTS, MONITORING } = require("./config");
const { appendAudit } = require("./db/store");
const { rateFreshness } = require("./market-data");
const notify = require("./notify");

const DAY = 24 * 3600 * 1000;
const iso = (v) => (v ? new Date(v).toISOString() : null);

function describe(c) {
  return c.type === "price_above" ? `price at or above ${c.value}` : c.type === "price_below" ? `price at or below ${c.value}` : `on or after ${c.date}`;
}

// Called inside the transaction that saves an analysis. Returns what was done.
async function createWatch(tx, { instrumentId, analysisId, recommendation, revisit, now = new Date(), settings = AGENTS.watch, freshSec = MONITORING.rateFreshSec }) {
  if (!revisit || recommendation === "buy") return null;
  const t = new Date(now);
  // A newer analysis replaces any open watch on the same instrument.
  await tx.query("update trading.watches set status = 'replaced', status_reason = 'a newer analysis replaced it', updated_at = now() where instrument_id = $1 and status in ('open', 'triggered')", [instrumentId]);
  const r = (await tx.query("select bid, as_of, quote_type from trading.market_snapshots where kind = 'rate' and instrument_id = $1 order by as_of desc limit 1", [instrumentId])).rows[0];
  const bid = r ? Number(r.bid) : null;
  const fresh = r ? rateFreshness({ asOf: r.as_of, quoteType: r.quote_type }, t, freshSec).fresh : false;
  let expiresAt = new Date(t.getTime() + settings.maxDays * DAY);
  let skip = null;
  if (revisit.type === "date_after") {
    const d = Date.parse(`${revisit.date}T00:00:00Z`);
    if (Number.isNaN(d)) skip = "the date is not a date";
    else if (d > expiresAt.getTime()) skip = `the date is more than ${settings.maxDays} days away`;
    else expiresAt = new Date(Math.max(d + DAY, t.getTime() + DAY));
  } else if (bid !== null) {
    // A level the price is already past would fire at once: not a trigger.
    if (revisit.type === "price_above" && bid >= revisit.value) skip = `the price (${bid}) is already at or above ${revisit.value}`;
    if (revisit.type === "price_below" && bid <= revisit.value) skip = `the price (${bid}) is already at or below ${revisit.value}`;
  }
  const condition = { type: revisit.type, value: revisit.value ?? null, date: revisit.date ?? null, description: String(revisit.description || "").slice(0, 500) };
  const row = (await tx.query(
    "insert into trading.watches (instrument_id, analysis_id, condition, price_at_start, status, status_reason, expires_at) values ($1, $2, $3, $4, $5, $6, $7) returning id",
    [instrumentId, analysisId, JSON.stringify(condition), bid, skip ? "skipped" : "open", skip, expiresAt.toISOString()]
  )).rows[0];
  await appendAudit(tx, { eventType: skip ? "watch.skipped" : "watch.created", entityType: "watch", entityId: row.id, actor: "system:watches", data: { instrumentId, analysisId, condition, priceAtStart: bid, priceFresh: fresh, reason: skip } });
  return { id: row.id, status: skip ? "skipped" : "open", reason: skip };
}

function createWatchKeeper({ config, db, agents, notifier, settings = AGENTS.watch, freshSec = MONITORING.rateFreshSec, now = () => new Date(), log = (...a) => console.log("[trading/watches]", ...a) } = {}) {
  let running = false, timer = null, lastCheck = null;

  async function runsToday(t) {
    const dayStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
    return Number((await db.query("select count(*) as n from trading.watches where run_started_at >= $1", [dayStart.toISOString()])).rows[0].n);
  }

  // Whether a new analysis may start now, and if not, why.
  async function mayRun(t) {
    if (config.agentsScheduleEnabled !== true) return "the agents' schedule is off (TRADING_AGENTS_SCHEDULE_ENABLED)";
    const st = agents.state();
    if (!st.ready) return st.notReadyBecause || "the agents are not ready";
    if (st.running) return "busy";
    const b = await agents.budget.status();
    if (!b.available || b.reached) return "the monthly Claude budget is reached or unreadable";
    if ((await runsToday(t)) >= settings.maxRunsPerDay) return `already ${settings.maxRunsPerDay} revisit runs today`;
    return null;
  }

  async function check(trigger = "schedule") {
    if (running) return { skipped: "a check is already running" };
    running = true;
    const out = { trigger, at: now().toISOString(), triggered: [], started: [], expired: 0, waiting: [] };
    try {
      if (!db.configured) { out.skipped = "TRADING_DATABASE_URL is not set"; return out; }
      const t = now();
      out.expired = (await db.query("update trading.watches set status = 'expired', status_reason = 'not met in time', updated_at = now() where status = 'open' and expires_at <= $1", [t.toISOString()])).rowCount;
      const open = (await db.query("select w.*, i.symbol from trading.watches w join trading.instruments i on i.instrument_id = w.instrument_id where w.status = 'open' order by w.created_at")).rows;
      for (const w of open) {
        const c = w.condition;
        let met = false, price = null;
        if (c.type === "date_after") met = t.getTime() >= Date.parse(`${c.date}T00:00:00Z`);
        else {
          const r = (await db.query("select bid, as_of, quote_type from trading.market_snapshots where kind = 'rate' and instrument_id = $1 order by as_of desc limit 1", [w.instrument_id])).rows[0];
          // Only a fresh stored price counts: a stale one is not evidence of anything.
          if (r && rateFreshness({ asOf: r.as_of, quoteType: r.quote_type }, t, freshSec).fresh) {
            price = { bid: Number(r.bid), asOf: iso(r.as_of) };
            met = c.type === "price_above" ? price.bid >= c.value : price.bid <= c.value;
          }
        }
        if (!met) continue;
        await db.withTransaction(async (tx) => {
          await tx.query("update trading.watches set status = 'triggered', triggered_at = $2, triggered_price = $3, updated_at = now() where id = $1 and status = 'open'", [w.id, t.toISOString(), price?.bid ?? null]);
          await appendAudit(tx, { eventType: "watch.triggered", entityType: "watch", entityId: w.id, actor: "system:watches", data: { symbol: w.symbol, condition: c, price } });
        });
        out.triggered.push(w.symbol);
        w.justTriggered = { price };
      }

      // Triggered watches whose new analysis has not started yet (also ones
      // left waiting by an earlier check because the agents were busy).
      const due = (await db.query("select w.*, i.symbol, a.created_at as analysed_at, a.recommendation from trading.watches w join trading.instruments i on i.instrument_id = w.instrument_id join trading.analyses a on a.id = w.analysis_id where w.status = 'triggered' and w.run_started_at is null order by w.triggered_at")).rows;
      const fresh = new Map(open.filter((w) => w.justTriggered).map((w) => [w.id, w.justTriggered]));
      for (const w of due) {
        const why = await mayRun(t);
        const head = `👀 <b>Revisit — ${notify.esc(w.symbol)}</b> (DEMO)\nThe ${notify.esc(w.recommendation)} analysis of ${iso(w.analysed_at).slice(0, 10)} asked to look again when: ${notify.esc(describe(w.condition))}.\n${notify.esc(String(w.condition.description || "").slice(0, 300))}`;
        const priceLine = fresh.get(w.id)?.price ? `\nNow: bid ${fresh.get(w.id).price.bid} at ${fresh.get(w.id).price.asOf.slice(11, 16)} UTC.` : "";
        if (why === "busy") { out.waiting.push(w.symbol); continue; }
        if (why) {
          // Not run automatically: the owner is told once and can start it.
          await db.query("update trading.watches set status = 'done', status_reason = $2, updated_at = now() where id = $1", [w.id, `not analysed again automatically: ${why}`]);
          await notifier.send(`${head}${priceLine}\nNot analysed again automatically: ${notify.esc(why)}. To do it now: <code>/trade_run ${notify.esc(w.symbol)}</code>`);
          continue;
        }
        await db.query("update trading.watches set status = 'done', run_started_at = $2, status_reason = 'analysed again', updated_at = now() where id = $1", [w.id, t.toISOString()]);
        await notifier.send(`${head}${priceLine}\nStarting a new full analysis. The summary follows; any proposal still needs the risk engine and your Approve.`);
        agents.run([w.symbol], { trigger: "revisit" });
        out.started.push(w.symbol);
        break; // one run at a time; the next waits for the next check
      }
      out.ok = true;
    } catch (e) {
      out.error = db.redact ? db.redact(e?.message) : String(e?.message);
      log("check failed:", out.error);
    } finally {
      lastCheck = out;
      running = false;
    }
    return out;
  }

  async function list(limit = 10) {
    return (await db.query("select w.id, i.symbol, w.condition, w.status, w.status_reason, w.price_at_start, w.expires_at, w.triggered_at, w.triggered_price, w.run_started_at, w.created_at from trading.watches w join trading.instruments i on i.instrument_id = w.instrument_id order by (w.status = 'open') desc, w.created_at desc limit $1", [limit])).rows
      .map((w) => ({ id: w.id, symbol: w.symbol, condition: w.condition, text: describe(w.condition), status: w.status, reason: w.status_reason, priceAtStart: w.price_at_start === null ? null : Number(w.price_at_start), expiresAt: iso(w.expires_at), triggeredAt: iso(w.triggered_at), createdAt: iso(w.created_at) }));
  }

  // Under the same switch as the other monitors. An interval, like the
  // approvals loop: it does not keep the process alive on its own.
  function start() {
    if (timer || !config.monitorEnabled) return false;
    timer = setInterval(() => { check("schedule"); }, settings.everyMinutes * 60000);
    if (typeof timer.unref === "function") timer.unref();
    log(`checks every ${settings.everyMinutes} minutes`);
    return true;
  }

  const state = () => ({ scheduled: !!timer, lastCheck });
  return { check, start, state, list };
}

module.exports = { createWatch, createWatchKeeper, describe };
