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
    // Show how close the rest came, so an empty or short shortlist can be judged.
    const rest = scored.filter((x) => !x.shortlisted).sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol)).slice(0, 5);
    if (rest.length) lines.push(`📉 Next highest: ${rest.map((x) => `${esc(x.symbol)} ${x.score}`).join(", ")}`);
    const top = scored.slice().sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))[0];
    if (top?.reason) lines.push(`💬 Top score (${esc(top.symbol)}): ${esc(clip(top.reason, 200))}`);
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
  lines.push(r.proposals?.length ? "No order was placed. Each draft goes to the risk engine; if it passes and trading is on, you get an Approve / Reject request." : "No order was placed. /trade_status for more.");
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

// ---- Stage 5: approval requests and results ------------------------------------
const hhmm = (d) => `${new Date(d).toISOString().slice(11, 16)} UTC`;

// The message with the Approve / Reject buttons. Everything in it comes from
// the stored proposal, the risk engine's verdict and the price it used.
function approvalRequest({ proposal, verdict, price, account, expiresAt }) {
  if (proposal.action === "close") return closeRequest({ proposal, verdict, price, account, expiresAt });
  const d = proposal.details || {};
  const exits = Array.isArray(d.exit_conditions) ? d.exit_conditions : [];
  const stop = exits.filter((c) => c.type === "price_below").map((c) => c.value);
  const target = exits.filter((c) => c.type === "price_above").map((c) => c.value);
  const lines = [
    `🟢 <b>Approve a BUY? — ${esc(proposal.symbol)}</b> (DEMO)`,
    `Amount: <b>${usd(proposal.amountUsd)}</b> · market order · no leverage`,
    `Price now: bid ${price.bid} / ask ${price.ask} (${price.ageSec} s old)`,
    `Plan: hold about ${esc(d.holding_days)} day(s)${stop.length ? ` · stop ${stop.join(", ")}` : ""}${target.length ? ` · target ${target.join(", ")}` : ""}`,
  ];
  const lossCheck = verdict.checks.find((c) => c.name === "loss_at_stop");
  if (lossCheck?.actual !== undefined && lossCheck.actual !== null) lines.push(`If the stop is reached: about -${usd(lossCheck.actual)}`);
  if (d.rationale) lines.push(`Why: ${esc(clip(d.rationale, 420))}`);
  if (Array.isArray(d.disagreements) && d.disagreements.length) lines.push(`Analyst and reviewer disagreed on ${d.disagreements.length} point(s): ${esc(clip(d.disagreements.map((x) => x.issue).join("; "), 200))}`);
  lines.push(`Risk engine: all ${verdict.checks.length} checks passed`);
  for (const w of verdict.warnings || []) lines.push(`⚠️ ${esc(w)}`);
  if (account?.ok) lines.push(`Account: ${usd(account.availableCashUsd)} cash, ${account.positions.length} open position(s)`);
  lines.push(`⏳ Answer by ${hhmm(expiresAt)}. The price and every limit are checked again before anything is sent.`);
  return clip(lines.join("\n"), 3900);
}

// The request to CLOSE a position (Stage 6).
function closeRequest({ proposal, verdict, price, account, expiresAt }) {
  const d = proposal.details || {};
  const live = account?.ok ? account.positions.find((p) => p.positionId === d.etoroPositionId) : null;
  const lines = [
    `🔴 <b>Approve a CLOSE? — ${esc(proposal.symbol)}</b> (DEMO)`,
    `Position ${esc(d.etoroPositionId)}: ${usd(live ? live.amountUsd : proposal.amountUsd)} invested${d.openRate ? `, opened at ${d.openRate}` : ""}${d.openedAt ? ` on ${String(d.openedAt).slice(0, 10)}` : ""}`,
  ];
  if (live && typeof live.unrealizedPnlUsd === "number") lines.push(`Profit/loss now: ${live.unrealizedPnlUsd < 0 ? "-" : "+"}${usd(Math.abs(live.unrealizedPnlUsd))} (eToro)`);
  lines.push(`Price now: bid ${price.bid} (${price.ageSec} s old)`);
  if (d.reason) lines.push(`Why: ${esc(clip(d.reason, 300))}`);
  lines.push("The whole position is closed at the market price. The position is checked again at eToro before anything is sent.");
  lines.push(`⏳ Answer by ${hhmm(expiresAt)}. Reject keeps it open; it stays watched.`);
  return clip(lines.join("\n"), 3900);
}

// What the request message becomes once it is decided, expired or withdrawn.
function approvalClosed({ symbol, amountUsd, outcome, action = "open", note = null, at = null }) {
  const head = { approved: "✅ Approved", rejected: "❌ Rejected — nothing was sent", expired: "⌛ Expired — nothing was sent", withdrawn: "↩️ Withdrawn — nothing was sent", mismatch: "⛔ Refused — nothing was sent", not_pending: "ℹ️ No longer open", unknown: "ℹ️ Not on record", error: "⚠️ Not recorded — nothing was sent" }[outcome] || "ℹ️ Closed";
  return [`<b>${head}</b> — ${action === "close" ? "CLOSE" : "BUY"} ${esc(symbol)} ${usd(amountUsd)} (DEMO)`, at ? `at ${hhmm(at)}` : null, note ? esc(clip(note, 300)) : null].filter(Boolean).join("\n");
}

function riskRejected({ proposal, reasons }) {
  return clip([`🛑 <b>Proposal stopped by the risk engine — ${esc(proposal.symbol)}</b> (DEMO)`, `${proposal.action === "close" ? "CLOSE" : "BUY"} ${usd(proposal.amountUsd)} was not offered for approval.${proposal.action === "close" ? " The position stays open and watched." : ""}`, ...reasons.slice(0, 6).map((r) => `• ${esc(clip(r, 220))}`), reasons.length > 6 ? `… and ${reasons.length - 6} more` : null].filter(Boolean).join("\n"), 3900);
}

// What happened after an approval: built from the gateway's outcome.
function executionResult(o) {
  const p = o.proposal || {};
  const what = `${p.action === "close" ? "CLOSE" : "BUY"} ${esc(p.symbol)} ${usd(p.amountUsd)} (DEMO)`;
  if (o.status === "closed") {
    const lines = [`✅ <b>Position closed — ${esc(p.symbol)}</b> (DEMO)`, `Position ${esc(o.etoroPositionId)}${o.closeRate ? ` closed at ${o.closeRate}` : ""}`];
    if (typeof o.pnlUsd === "number") lines.push(`Result: about ${o.pnlUsd < 0 ? "-" : "+"}${usd(Math.abs(o.pnlUsd))} (from the open and close prices; fees not included)`);
    if (typeof o.proceedsUsd === "number") lines.push(`eToro reports proceeds of ${usd(o.proceedsUsd)}`);
    if (o.note) lines.push(esc(o.note));
    return lines.join("\n");
  }
  if (o.status === "filled") {
    const pos = (o.positions || [])[0];
    const lines = [`✅ <b>Order filled — ${what}</b>`];
    if (pos) lines.push(`Position ${pos.positionId}${pos.openRate ? ` opened at ${pos.openRate}` : ""}, ${usd(pos.amountUsd)} invested`);
    if (o.partial) lines.push("⚠️ eToro reports the order as partially filled.");
    if (pos?.exitConditions?.length) lines.push(`Watching: ${esc(pos.exitConditions.map((c) => (c.type === "price_below" ? `stop ${c.value}` : c.type === "price_above" ? `target ${c.value}` : c.type === "date_after" ? `until ${c.date}` : "a condition in words")).join(" · "))}`);
    lines.push("Open positions are checked every 15 minutes; nothing is closed without you.");
    return lines.join("\n");
  }
  if (o.status === "submitted") return `⏳ <b>${p.action === "close" ? "Close" : "Order"} accepted, not executed yet — ${what}</b>\n${esc(clip(o.reason, 300))}\nI will tell you when it fills or is rejected.`;
  if (o.status === "unknown") return `⚠️ <b>Order result unknown — ${what}</b>\n${esc(clip(o.reason, 400))}`;
  if (o.status === "rejected") return `❌ <b>${p.action === "close" ? "Close" : "Order"} rejected by eToro — ${what}</b>\n${esc(clip(o.reason, 400))}\n${p.action === "close" ? "The position is still open and watched." : "No position was opened."}`;
  return `🛑 <b>No order was sent — ${what}</b>\n${esc(clip(o.reason, 600))}\nA new proposal and a new approval are needed to try again.`;
}

// A warning about the account as a whole: a limit approached or reached.
function limitAlert({ limits, level }) {
  const head = level === 100 ? "⛔ <b>Limit reached</b> (DEMO)" : "⚠️ <b>Limit approached</b> (DEMO)";
  const lines = [head, ...limits.map((l) => `• ${esc(l.label)}: ${l.unit === "$" ? usd(l.value) : l.value} of ${l.unit === "$" ? usd(l.limit) : l.limit} (${l.pct}%)`)];
  lines.push(level === 100 ? "The risk engine refuses every new buy that would go past it. Closing is not affected." : "New buys that would go past it will be refused by the risk engine.");
  return lines.join("\n");
}

// The answer to /trade_status.
function statusText({ agents, budget, lastRun, dbState, positions = null, trading = null }) {
  const lines = ["📈 <b>Trading Desk status</b> (DEMO)"];
  if (trading) {
    const p = trading.proposals || {}, o = Object.values(trading.ordersInFlight || {}).reduce((a, b) => a + b, 0);
    lines.push(trading.tradingOff ? `⛔ Trading: OFF — ${esc(trading.tradingOff)}. No approval request is sent and no order can be placed.` : "🟢 Trading: ON (demo) — every order still needs your approval");
    const bits = [p.draft && `${p.draft} draft(s) waiting`, p.pending_approval && `${p.pending_approval} awaiting your answer`, (p.approved || p.executing) && `${(p.approved || 0) + (p.executing || 0)} being executed`, o && `${o} order(s) not settled yet`].filter(Boolean);
    if (bits.length) lines.push(`📨 ${bits.join(" · ")}`);
  }
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
    const lim = positions.lastCheck?.limits;
    if (Array.isArray(lim) && lim.length) lines.push(`📏 Limits: ${lim.map((l) => `${esc(l.short)} ${l.unit === "$" ? usd(l.value) : l.value}/${l.unit === "$" ? usd(l.limit) : l.limit}`).join(" · ")}`);
    lines.push(!positions.scheduled ? "👁 Position checks: off" : !c ? "👁 Position checks: on, first check pending" : c.error ? `⚠️ Position checks: last one failed at ${when(c.startedAt)}` : `👁 Positions: ${c.account?.openPositions ?? 0} open, checked ${when(c.startedAt)}${c.account?.openPositions ? `, profit/loss ${c.account.unrealizedPnlUsd < 0 ? "-" : "+"}${usd(Math.abs(c.account.unrealizedPnlUsd))}` : ""}`);
  }
  lines.push("/trade_run — start a screened run · /trade_run crypto — coins only");
  lines.push("/trade_stop — stop all trading now · /trade_resume — allow it again");
  lines.push("/trade_test BTC 50 — a small test trade through the same checks and your approval");
  lines.push("/trade_close BTC — propose closing a position (your approval needed)");
  return lines.join("\n");
}

function createNotifier({ telegram = null, log = (...a) => console.log("[trading/notify]", ...a) } = {}) {
  const enabled = !!telegram?.enabled && typeof telegram.sendMessage === "function";
  async function send(html) {
    if (!enabled) { log("telegram is not configured; message not sent"); return false; }
    try { await telegram.sendMessage(html); return true; }
    catch (e) { log("telegram send failed:", typeof telegram.redact === "function" ? telegram.redact(e?.message) : "error"); return false; }
  }
  // A message with inline buttons. Returns the message ID so it can be edited later.
  async function sendButtons(html, keyboard) {
    if (!enabled) { log("telegram is not configured; approval request not sent"); return { ok: false }; }
    try { const m = await telegram.sendMessage(html, { reply_markup: { inline_keyboard: keyboard } }); return { ok: true, messageId: m?.message_id ?? null }; }
    catch (e) { log("telegram send failed:", typeof telegram.redact === "function" ? telegram.redact(e?.message) : "error"); return { ok: false }; }
  }
  // Replaces a message's text and removes its buttons.
  async function edit(messageId, html) {
    if (!enabled || !messageId) return false;
    try { await telegram.editMessageText(messageId, html); return true; } catch (e) { log("telegram edit failed:", typeof telegram.redact === "function" ? telegram.redact(e?.message) : "error"); return false; }
  }
  async function answer(callbackId, text) {
    if (!enabled || !callbackId) return false;
    try { await telegram.answerCallbackQuery(callbackId, text); return true; } catch { return false; }
  }
  return { enabled, send, sendButtons, edit, answer };
}

// The commands the desk adds to the existing bot. server.js routes exactly
// these to the desk's code, before anything is passed to the GM agent.
const COMMANDS = [
  { command: "trade_run", description: "مكتب التداول (تجريبي): تشغيل فحص وتحليل الآن" },
  { command: "trade_status", description: "مكتب التداول (تجريبي): الحالة والميزانية وآخر تشغيل" },
  { command: "trade_test", description: "مكتب التداول (تجريبي): صفقة اختبار صغيرة، مثال: /trade_test BTC 50" },
  { command: "trade_close", description: "مكتب التداول (تجريبي): اقتراح إغلاق مركز، مثال: /trade_close BTC" },
  { command: "trade_stop", description: "مكتب التداول (تجريبي): إيقاف التداول فورًا" },
  { command: "trade_resume", description: "مكتب التداول (تجريبي): السماح بالتداول من جديد" },
];

module.exports = { createNotifier, runSummary, statusText, positionAlert, limitAlert, closeRequest, approvalRequest, approvalClosed, riskRejected, executionResult, budgetLine, COMMANDS, esc };
