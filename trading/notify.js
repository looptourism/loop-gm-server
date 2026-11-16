// ---------------------------------------------------------------------------
// Telegram messages of the Trading Desk — built by plain code from results.
// No Claude call is involved in writing them.
//
// The desk does not have its own bot: it uses the server's existing one,
// handed in by server.js. Sending never throws — a Telegram failure is
// logged and must not disturb the work it reports on.
//
// The desk's Telegram COMMANDS are handled by code in trading/index.js.
// They never reach the GM agent, and the GM agent has no trading tool.
// ---------------------------------------------------------------------------
const esc = (t) => String(t ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const clip = (t, max) => { const s = String(t ?? ""); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const when = (iso) => (iso ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC` : "?");
const minutes = (a, b) => { const m = Math.round((Date.parse(b) - Date.parse(a)) / 60000); return Number.isFinite(m) ? (m < 1 ? "under a minute" : `${m} min`) : "?"; };

function budgetLine(b) {
  if (!b) return null;
  if (!b.available) return `⚠️ Budget: the usage ledger could not be read — no agent may run. ${esc(clip(b.error, 160))}`;
  const pct = b.budgetUsd > 0 ? Math.round((b.spentUsd / b.budgetUsd) * 100) : 0;
  return `${b.reached ? "⛔" : b.warning ? "⚠️" : "💰"} Budget: ${usd(b.spentUsd)} of ${usd(b.budgetUsd)} used in ${esc(b.month)} (${pct}%)${b.reached ? " — reached, runs are stopped until next month" : ""}`;
}

// The message sent after every agent run.
function runSummary(r) {
  const title = `📊 <b>Trading Desk — ${r.mode === "screened" ? "screened run" : "agent run"}</b> (DEMO)`;
  const head = `${esc(r.trigger)} · ${when(r.startedAt)}${r.finishedAt ? ` · ${minutes(r.startedAt, r.finishedAt)}` : ""}`;
  const lines = [title, head];
  if (r.skipped) {
    lines.push(`⏸ Nothing ran: ${esc(clip(r.skipped, 300))}`);
    return lines.join("\n");
  }
  if (r.error) lines.push(`❌ The run failed: ${esc(clip(r.error, 300))}`);
  if (r.screen) {
    const scored = r.screen.results.filter((x) => x.score !== null);
    const short = r.screen.results.filter((x) => x.shortlisted).sort((a, b) => b.score - a.score);
    lines.push(`🔎 Screened: ${scored.length} of ${r.screen.results.length}${r.scope === "crypto" ? " (coins only)" : ""}`);
    lines.push(short.length ? `📋 Shortlist (${short.length}): ${short.map((x) => `${esc(x.symbol)} ${x.score}`).join(", ")}` : `📋 Shortlist: none scored ${r.screen.minScore} or more`);
  }
  if (r.instruments?.length) {
    const one = (i) => (!i.analysis?.ok ? `${esc(i.symbol)} failed` : `${esc(i.symbol)} ${esc(i.analysis.recommendation)}${i.riskReview?.ok ? ` / ${esc(String(i.riskReview.stance).replace("_", " "))}` : " / no review"}`);
    lines.push(`🧠 Analysed (${r.instruments.length}): ${r.instruments.slice(0, 8).map(one).join("; ")}${r.instruments.length > 8 ? "; …" : ""}`);
  }
  if (r.portfolioManager) {
    const buys = r.portfolioManager.decisions.filter((d) => d.decision === "propose_buy");
    lines.push(`⚖️ Decisions: ${buys.length ? `${buys.length} buy proposed, ` : ""}${r.portfolioManager.decisions.length - buys.length} no trade`);
  }
  lines.push(r.proposals?.length
    ? `📝 Draft proposals (${r.proposals.length}): ${r.proposals.map((p) => `${esc(p.symbol)} ${usd(p.amountUsd)}`).join(", ")}`
    : "📝 Draft proposals: none");
  if (r.problems?.length) lines.push(`⚠️ Problems (${r.problems.length}): ${esc(clip(r.problems[0], 220))}${r.problems.length > 1 ? " …" : ""}`);
  if (r.usage) {
    const by = r.usage.byAgent || {};
    const part = (label, ...agents) => { const c = agents.reduce((a, k) => a + (by[k]?.estimatedCostUsd || 0), 0); return agents.some((k) => by[k]) ? `${label} ${usd(c)}` : null; };
    const parts = [part("screen", "screen"), part("analysts", "stock", "crypto"), part("risk", "risk"), part("manager", "portfolio_manager")].filter(Boolean);
    lines.push(`💵 Cost: about ${usd(r.usage.estimatedCostUsd)}${parts.length ? ` (${parts.join(", ")})` : ""}`);
  }
  const b = budgetLine(r.budget);
  if (b) lines.push(b);
  lines.push("No order was placed. Drafts wait for the risk engine and your approval. /trade_status for more.");
  return clip(lines.join("\n"), 3900);
}

// An alert about one demo position. `figures` are the position's own numbers.
function positionAlert({ title, symbol, lines, figures = {} }) {
  const out = [`🚨 <b>${esc(title)} — ${esc(symbol)}</b> (DEMO)`, ...lines.map(esc)];
  const bits = [];
  if (figures.amountUsd !== undefined && figures.amountUsd !== null) bits.push(`${usd(figures.amountUsd)} invested`);
  if (figures.openRate) bits.push(`opened at ${figures.openRate}`);
  if (figures.openedAt) bits.push(`on ${String(figures.openedAt).slice(0, 10)}`);
  if (typeof figures.unrealizedPnlUsd === "number") bits.push(`profit/loss ${figures.unrealizedPnlUsd < 0 ? "-" : "+"}${usd(Math.abs(figures.unrealizedPnlUsd))}`);
  if (bits.length) out.push(`Position: ${esc(bits.join(", "))}`);
  return clip(out.join("\n"), 3900);
}

// The answer to /trade_status.
function statusText({ agents, budget, lastRun, dbState, positions = null }) {
  const lines = ["📈 <b>Trading Desk status</b> (DEMO)"];
  if (dbState && dbState.state !== "ok") lines.push(`⛔ Database: ${esc(dbState.state)}${dbState.error ? ` — ${esc(clip(dbState.error, 200))}` : ""}. The desk is off until this is fixed.`);
  lines.push(agents.running ? `⏳ Running now: ${esc(agents.running.step)} (since ${when(agents.running.startedAt)})` : agents.ready ? "✅ Ready, nothing running" : `⛔ Not ready: ${esc(agents.notReadyBecause)}`);
  lines.push(`🗓 Schedule: ${agents.schedule.running ? esc(agents.schedule.runs.join("; ")) : "off"}`);
  const b = budgetLine(budget);
  if (b) lines.push(b);
  if (lastRun) {
    lines.push(`🕘 Last run: ${when(lastRun.at)} — ${lastRun.event === "started" ? "did not finish (server restarted)" : `${lastRun.skipped ? "nothing ran" : lastRun.ok ? "ok" : "with problems"}, ${lastRun.proposals?.length || 0} draft(s), about ${usd(lastRun.usage?.estimatedCostUsd)}`}`);
  } else lines.push("🕘 Last run: none yet");
  if (positions) {
    const c = positions.lastCheck;
    lines.push(!positions.scheduled ? "👁 Position checks: off" : !c ? "👁 Position checks: on, first check pending" : c.error ? `⚠️ Position checks: last one failed at ${when(c.startedAt)}` : `👁 Positions: ${c.account?.openPositions ?? 0} open, checked ${when(c.startedAt)}${c.account?.openPositions ? `, profit/loss ${c.account.unrealizedPnlUsd < 0 ? "-" : "+"}${usd(Math.abs(c.account.unrealizedPnlUsd))}` : ""}`);
  }
  lines.push("/trade_run — start a screened run · /trade_run crypto — coins only");
  return lines.join("\n");
}

function createNotifier({ telegram = null, log = (...a) => console.log("[trading/notify]", ...a) } = {}) {
  const enabled = !!telegram?.enabled && typeof telegram.sendMessage === "function";
  async function send(html) {
    if (!enabled) { log("telegram is not configured; message not sent"); return false; }
    try { await telegram.sendMessage(html); return true; }
    catch (e) { log("telegram send failed:", typeof telegram.redact === "function" ? telegram.redact(e?.message) : "error"); return false; }
  }
  return { enabled, send };
}

// The commands the desk adds to the existing bot. server.js routes exactly
// these to the desk's code, before anything is passed to the GM agent.
const COMMANDS = [
  { command: "trade_run", description: "مكتب التداول (تجريبي): تشغيل فحص وتحليل الآن" },
  { command: "trade_status", description: "مكتب التداول (تجريبي): الحالة والميزانية وآخر تشغيل" },
];

module.exports = { createNotifier, runSummary, statusText, positionAlert, budgetLine, COMMANDS, esc };
