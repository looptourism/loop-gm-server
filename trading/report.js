// ---------------------------------------------------------------------------
// Trading Desk — the weekly report and the agents' track record.
//
// Plain code over stored records: no eToro call, no Claude call, nothing
// that can trade. Prices are the bids the monitor stored, with their times.
//
// Track record: for every analyst recommendation (buy / hold / avoid), what
// the stored price did 1, 5 and 14 days later. It describes; it does not
// grade. A "hold" followed by +4% was not necessarily wrong — it says what
// the price did, so judgement over many analyses becomes possible.
// ---------------------------------------------------------------------------
const notify = require("./notify");

const DAY = 24 * 3600 * 1000;
const HORIZONS = [1, 5, 14];
const iso = (v) => (v ? new Date(v).toISOString() : null);
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => r2(((b - a) / a) * 100);

// The stored bid at time t: the newest at or before t, at most 3 days older
// (weekends and holidays for stocks), and strictly after `after` when given —
// a later price must be a newer one, never the starting price again. null if
// there is none.
async function bidAt(db, instrumentId, t, after = null) {
  const floor = new Date(Math.max(t.getTime() - 3 * DAY, after ? Date.parse(after) + 1 : 0));
  const r = (await db.query("select bid, as_of from trading.market_snapshots where kind = 'rate' and instrument_id = $1 and as_of <= $2 and as_of >= $3 order by as_of desc limit 1", [instrumentId, iso(t), iso(floor)])).rows[0];
  return r ? { bid: Number(r.bid), at: iso(r.as_of) } : null;
}

async function trackRecord(db, { now = new Date(), days = 30 } = {}) {
  const t = new Date(now);
  const rows = (await db.query(
    `select a.id, a.agent, a.recommendation, a.created_at, a.instrument_id, a.snapshot_ids, i.symbol from trading.analyses a join trading.instruments i on i.instrument_id = a.instrument_id
      where a.agent in ('stock', 'crypto') and a.recommendation is not null and a.created_at >= $1 order by a.created_at desc`, [iso(new Date(t.getTime() - days * DAY))])).rows;
  const items = [];
  for (const a of rows) {
    // The price the analyst was given; failing that, the stored one at the time.
    let start = null;
    if (a.snapshot_ids && a.snapshot_ids.length) {
      const s = (await db.query("select bid, as_of from trading.market_snapshots where id = any($1::uuid[]) and kind = 'rate' and instrument_id = $2 order by as_of desc limit 1", [a.snapshot_ids, a.instrument_id])).rows[0];
      if (s) start = { bid: Number(s.bid), at: iso(s.as_of) };
    }
    if (!start) start = await bidAt(db, a.instrument_id, new Date(a.created_at));
    const after = {};
    for (const h of HORIZONS) {
      const target = new Date(new Date(a.created_at).getTime() + h * DAY);
      if (!start || target > t) { after[h] = null; continue; }
      const p = await bidAt(db, a.instrument_id, target, start.at);
      after[h] = p ? { pct: pct(start.bid, p.bid), bid: p.bid, at: p.at } : null;
    }
    items.push({ id: a.id, symbol: a.symbol, agent: a.agent, recommendation: a.recommendation, at: iso(a.created_at), start, after });
  }
  // Per recommendation: how many, and the average move where it is known.
  const summary = {};
  for (const rec of ["buy", "hold", "avoid"]) {
    const of = items.filter((x) => x.recommendation === rec);
    summary[rec] = { count: of.length };
    for (const h of HORIZONS) {
      const known = of.map((x) => x.after[h]?.pct).filter((v) => typeof v === "number");
      summary[rec][`after${h}d`] = known.length ? { avgPct: r2(known.reduce((s, v) => s + v, 0) / known.length), n: known.length, up: known.filter((v) => v > 0).length } : null;
    }
  }
  return { days, at: iso(t), items, summary, note: "the stored bid when analysed vs the stored bid 1, 5 and 14 days later; a description, not a grade" };
}

async function weekly(db, { now = new Date(), budget = null } = {}) {
  const t = new Date(now), from = new Date(t.getTime() - 7 * DAY);
  const q = (sql, args = [from.toISOString()]) => db.query(sql, args).then((r) => r.rows);
  const statuses = Object.fromEntries((await q("select status, count(*) as n from trading.proposals where created_at >= $1 and action = 'open' group by status")).map((r) => [r.status, Number(r.n)]));
  const decisions = Object.fromEntries((await q("select decision, count(*) as n from trading.approvals where decided_at >= $1 group by decision")).map((r) => [r.decision, Number(r.n)]));
  const expired = Number((await q("select count(*) as n from trading.audit_log where event_type = 'approval.expired' and created_at >= $1"))[0].n);
  const opened = await q("select i.symbol, p.amount_usd, p.opened_at from trading.positions p join trading.instruments i using (instrument_id) where p.opened_at >= $1 and p.opened_by_order_id is not null order by p.opened_at");
  const closed = await q("select i.symbol, p.amount_usd, p.realized_pnl_usd, p.closed_at from trading.positions p join trading.instruments i using (instrument_id) where p.closed_at >= $1 and p.status = 'closed' order by p.closed_at");
  const open = await q("select i.symbol, p.amount_usd from trading.positions p join trading.instruments i using (instrument_id) where p.status = 'open' order by p.opened_at", []);
  const snaps = await q("select taken_at, equity_usd from trading.account_snapshots where taken_at >= $1 order by taken_at asc, created_at asc");
  const runs = await q("select data from trading.audit_log where event_type = 'agents.run_finished' and created_at >= $1");
  const spend = Number((await q("select coalesce(sum(estimated_cost_usd), 0) as usd from trading.api_usage where occurred_at >= $1"))[0].usd);
  const analyses = await q("select a.recommendation, i.symbol from trading.analyses a join trading.instruments i using (instrument_id) where a.agent in ('stock', 'crypto') and a.created_at >= $1");
  const watches = Object.fromEntries((await q("select status, count(*) as n from trading.watches where created_at >= $1 group by status")).map((r) => [r.status, Number(r.n)]));
  const record = await trackRecord(db, { now: t, days: 30 });
  const byRec = (r) => analyses.filter((a) => a.recommendation === r).length;
  return {
    from: from.toISOString(), to: t.toISOString(),
    proposals: { made: Object.values(statuses).reduce((s, n) => s + n, 0), riskRejected: statuses.risk_rejected || 0 },
    approvals: { approved: decisions.approved || 0, rejected: decisions.rejected || 0, expired },
    opened: opened.map((p) => ({ symbol: p.symbol, amountUsd: Number(p.amount_usd), at: iso(p.opened_at) })),
    closed: closed.map((p) => ({ symbol: p.symbol, amountUsd: Number(p.amount_usd), resultUsd: p.realized_pnl_usd === null ? null : Number(p.realized_pnl_usd), at: iso(p.closed_at) })),
    openNow: open.map((p) => ({ symbol: p.symbol, amountUsd: Number(p.amount_usd) })),
    equity: snaps.length ? { startUsd: Number(snaps[0].equity_usd), endUsd: Number(snaps[snaps.length - 1].equity_usd), startAt: iso(snaps[0].taken_at), endAt: iso(snaps[snaps.length - 1].taken_at) } : null,
    agents: { runs: runs.length, analyses: analyses.length, buy: byRec("buy"), hold: byRec("hold"), avoid: byRec("avoid"), spendUsd: r2(spend), watchesSet: (watches.open || 0) + (watches.triggered || 0) + (watches.done || 0) + (watches.expired || 0) + (watches.replaced || 0) },
    budget: budget && budget.available ? { spentUsd: budget.spentUsd, budgetUsd: budget.budgetUsd, month: budget.month } : null,
    // Passed on this week: holds and avoids, with what the price has done since.
    passedOn: record.items.filter((x) => x.recommendation !== "buy" && Date.parse(x.at) >= from.getTime()).slice(0, 8),
    record,
  };
}

const sign = (n) => `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(2)}`;
const usd = (n) => `$${Number(n).toFixed(2)}`;
const day = (v) => String(v).slice(5, 10);

function weeklyText(w) {
  const L = [`📅 <b>Trading Desk — the week</b> (DEMO)`, `${day(w.from)} to ${day(w.to)} (UTC)`];
  L.push("", "<b>Trades</b>");
  L.push(`Proposals: ${w.proposals.made} (${w.proposals.riskRejected} stopped by the risk engine) · approved ${w.approvals.approved}, rejected ${w.approvals.rejected}, expired ${w.approvals.expired}`);
  L.push(w.opened.length ? `Opened: ${w.opened.map((p) => `${notify.esc(p.symbol)} ${usd(p.amountUsd)}`).join(", ")}` : "Opened: none");
  if (w.closed.length) {
    const total = w.closed.reduce((s, p) => s + (p.resultUsd || 0), 0);
    L.push(`Closed: ${w.closed.map((p) => `${notify.esc(p.symbol)} ${p.resultUsd === null ? "result unknown" : `$${sign(p.resultUsd)}`}`).join(", ")} — total $${sign(total)}`);
  } else L.push("Closed: none");
  L.push(w.openNow.length ? `Open now: ${w.openNow.map((p) => `${notify.esc(p.symbol)} ${usd(p.amountUsd)}`).join(", ")}` : "Open now: none");
  if (w.equity) L.push(`Account: ${usd(w.equity.startUsd)} → ${usd(w.equity.endUsd)} (${sign(w.equity.endUsd - w.equity.startUsd)})`);
  L.push("", "<b>Agents</b>");
  L.push(`Runs: ${w.agents.runs} · analyses: ${w.agents.analyses} (buy ${w.agents.buy}, hold ${w.agents.hold}, avoid ${w.agents.avoid}) · revisit watches set: ${w.agents.watchesSet}`);
  L.push(`Claude: about ${usd(w.agents.spendUsd)} this week${w.budget ? ` · ${usd(w.budget.spentUsd)} of ${usd(w.budget.budgetUsd)} in ${notify.esc(w.budget.month)}` : ""}`);
  if (w.passedOn.length) {
    L.push("", "<b>Passed on this week</b> (price since, stored bid)");
    for (const x of w.passedOn) {
      const last = [14, 5, 1].map((h) => x.after[h] && { h, ...x.after[h] }).find(Boolean);
      L.push(`${notify.esc(x.symbol)} ${notify.esc(x.recommendation)} ${day(x.at)}: ${last ? `${sign(last.pct)}% after ${last.h} day${last.h > 1 ? "s" : ""}` : "too early to tell"}`);
    }
  }
  L.push("", "<b>Track record</b> (30 days, average move after the call)");
  for (const rec of ["buy", "hold", "avoid"]) {
    const s = w.record.summary[rec];
    if (!s.count) continue;
    const parts = [5, 14].map((h) => s[`after${h}d`] ? `${h}d ${sign(s[`after${h}d`].avgPct)}% (${s[`after${h}d`].up}/${s[`after${h}d`].n} up)` : null).filter(Boolean);
    L.push(`${rec}: ${s.count} call${s.count > 1 ? "s" : ""}${parts.length ? ` — ${parts.join(", ")}` : " — too early to tell"}`);
  }
  if (!["buy", "hold", "avoid"].some((r) => w.record.summary[r].count)) L.push("No analyses yet.");
  L.push("", "A move after a hold is a description, not a grade. Details: /api/trading/report");
  return L.join("\n").slice(0, 4000);
}

// Sends the report once a week: Saturday from 04:00 UTC (08:00 Dubai), after
// the US week has closed. desk_state 'weekly_report' remembers the last week
// sent, so a restart neither skips nor repeats it.
function createReporter({ config, db, notifier, agents, now = () => new Date(), log = (...a) => console.log("[trading/report]", ...a) } = {}) {
  let timer = null;
  const weekKey = (t) => t.toISOString().slice(0, 10);

  async function build() {
    const budget = agents && agents.budget ? await agents.budget.status() : null;
    return weekly(db, { now: now(), budget });
  }

  async function tick() {
    const t = now();
    if (t.getUTCDay() !== 6 || t.getUTCHours() < 4 || !db.configured) return { sent: false };
    try {
      const last = (await db.query("select value from trading.desk_state where key = 'weekly_report'")).rows[0]?.value?.week;
      if (last === weekKey(t)) return { sent: false, already: true };
      const ok = await notifier.send(weeklyText(await build()));
      if (!ok) return { sent: false };
      await db.query("insert into trading.desk_state (key, value, updated_by) values ('weekly_report', $1, 'system:report') on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()", [JSON.stringify({ week: weekKey(t), at: t.toISOString() })]);
      return { sent: true };
    } catch (e) { log("weekly report failed:", db.redact ? db.redact(e?.message) : e?.message); return { sent: false, error: true }; }
  }

  function start() {
    if (timer || !config.monitorEnabled) return false;
    timer = setInterval(() => { tick(); }, 15 * 60000);
    if (typeof timer.unref === "function") timer.unref();
    return true;
  }
  return { build, tick, start };
}

module.exports = { trackRecord, weekly, weeklyText, createReporter, bidAt };
