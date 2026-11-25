// Run with: npm test
// Stage 7: the Trading Desk page in the console. The database tests run only
// when TEST_TRADING_DATABASE_URL points at a throw-away Postgres; each gets
// its own fresh database.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { buildDesk } = require("../desk/data");
const { createGateway } = require("../execution/gateway");
const { createApprovals } = require("../approvals");
const { createDb } = require("../db");
const { paramsHash } = require("../proposals");
const { mount } = require("../index");

const ROOT = path.join(__dirname, "..", "..");
const page = fs.readFileSync(path.join(ROOT, "trading", "desk", "desk.html"), "utf8");
const consoleHtml = fs.readFileSync(path.join(ROOT, "public", "console.html"), "utf8");

// ---- the page and the console tab, read as files --------------------------------
test("the console gets one tab that shows the Trading Desk page in a frame — no trading code in the console", () => {
  assert.match(consoleHtml, /const viewTrading=\(\)=>`[^`]*<iframe class="office-frame" data-frame="trading" src="\/trading-desk"/);
  assert.match(consoleHtml, /trading:viewTrading\}/);
  assert.match(consoleHtml, /href="#trading" class="desk"/);                    // phone tab bar
  assert.match(consoleHtml, /مكتب التداول<\/span><span class="desk-demo">DEMO<\/span>/); // iPad sidebar, with the DEMO mark
  assert.match(consoleHtml, /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(consoleHtml, /data-frame="office" src="\/office\?embed=1"/);      // the Office frame is still told apart
  for (const word of ["/api/trading", "eToro", "TRADING_ENABLED"]) assert.ok(!consoleHtml.includes(word), `console.html mentions ${word}`);
});

test("the page: a permanent DEMO band, its own colour, escaped text, and only two endpoints", () => {
  assert.match(page, /<html lang="ar" dir="rtl">/);
  assert.match(page, /<header class="demo"[^>]*>\s*<div class="row"><span class="badge">DEMO<\/span>/);
  assert.match(page, /\.demo\{position:sticky;top:0/);                            // stays on screen while scrolling
  assert.match(page, /--desk:#5BD9F5/);                                           // not the console's department violet
  const urls = [...page.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(urls, ["/api/trading/desk", "/api/trading/desk/admin/unlock", "/api/trading/desk/admin/lock",
    "/api/trading/desk/allowlist/add", "/api/trading/desk/allowlist/remove", "/api/trading/desk/decide"]); // the allowlist editor: admin session + add/remove only
  assert.match(page, /"X-Trading-Desk": "1"/);
  assert.ok(!/<script src=/.test(page));                                          // no outside scripts
  // every piece of data the page writes into HTML goes through esc()/num()/usd()/sym(): no raw ${x.something} of server text
  const script = page.split("<script>")[1].split("</script>")[0];
  for (const raw of ["${p.rationale}", "${x.text}", "${a.message}", "${h.reason}", "${d.issue}", "${w}"]) assert.ok(!script.includes(raw), `unescaped ${raw}`);
  assert.match(script, /confirmDecision\(b\.dataset\.decide, b\.dataset\.approval\)/); // Approve and Reject both ask for confirmation first
});

// ---- routes without a database ------------------------------------------------------
function fakeApp() {
  const routes = { GET: {}, POST: {} };
  const call = (method) => async (p, { query = {}, body = {}, headers = {} } = {}) => {
    let done; const finished = new Promise((r) => { done = r; });
    const res = { statusCode: 200, body: null, headers: {}, file: null, set(k, v) { res.headers[k] = v; return res; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; done(); return res; }, type() { return res; }, send(b) { res.body = b; done(); return res; }, sendFile(f) { res.file = f; done(); return res; } };
    const req = { query, body, get: (h) => headers[h] ?? headers[h.toLowerCase()] ?? null };
    const run = (i) => routes[method][p][i] && routes[method][p][i](req, res, () => run(i + 1));
    run(0);
    await finished;
    return res;
  };
  return { get: (p, ...h) => { routes.GET[p] = h; }, post: (p, ...h) => { routes.POST[p] = h; }, GET: call("GET"), POST: call("POST") };
}
const quiet = { start: () => false, state: () => ({}) };

test("routes: the page needs the login switched on; the data and the decisions need a database", async () => {
  const off = fakeApp();
  mount(off, { authOn: false, config: { hasKeys: true }, client: { redact: (t) => t }, db: { configured: false, redact: (t) => t }, monitor: quiet, research: quiet, positions: quiet, agents: quiet, approvals: { start: () => false } });
  assert.strictEqual((await off.GET("/trading-desk")).statusCode, 503);
  assert.strictEqual((await off.GET("/api/trading/desk")).statusCode, 503);
  assert.strictEqual((await off.POST("/api/trading/desk/decide", { headers: { "X-Trading-Desk": "1" }, body: { decision: "approve" } })).statusCode, 503);
  const on = fakeApp();
  mount(on, { authOn: true, config: { hasKeys: true }, client: { redact: (t) => t }, db: { configured: false, redact: (t) => t }, monitor: quiet, research: quiet, positions: quiet, agents: quiet, approvals: { start: () => false } });
  const r = await on.GET("/trading-desk");
  assert.deepStrictEqual([r.file, r.headers["Content-Security-Policy"], r.headers["Cache-Control"]], [path.join(ROOT, "trading", "desk", "desk.html"), "frame-ancestors 'self'", "no-store"]);
});

// ---- against a real Postgres ------------------------------------------------------------
const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, async () => {
  const dbName = `trading_s7_${Math.random().toString(36).slice(2, 10)}`;
  const admin = createDb({ config: { databaseUrl: TEST_URL } });
  await admin.query(`create database ${dbName}`);
  const u = new URL(TEST_URL); u.pathname = `/${dbName}`;
  const db = createDb({ config: { databaseUrl: u.toString() } });
  try { await db.migrateAll(); await fn(await world(db)); }
  finally { await db.close(); await admin.query(`drop database ${dbName} with (force)`); await admin.close(); }
});

const T = new Date("2099-11-17T15:10:00Z");
async function world(db) {
  const w = { db, sent: [], edits: [], buttons: [], orderCalls: [], outcomes: [] };
  for (const [id, symbol, cls] of [[100000, "BTC", "crypto"], [2001, "MSTR", "stock"], [2002, "NKE", "stock"]]) {
    await db.query("insert into trading.instruments (instrument_id, symbol, display_name, asset_class, raw, source, fetched_at) values ($1, $2, $3, $4, '{}', 't', now())", [id, symbol, `${symbol} name`, cls]);
    await db.query(`insert into trading.${cls}_allowlist (symbol, instrument_id, verified_at) values ($1, $2, now())`, [symbol, id]);
    await db.query("insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at) values ($1, 'rate', $2, 100, 100.1, 'realtime', '{}', 'eToro', $2)", [id, "2099-11-17T15:08:00Z"]);
  }
  await db.query("insert into trading.stock_allowlist (symbol) values ('WYFI')");
  await db.query("update trading.stock_allowlist set crypto_correlated = true where symbol = 'MSTR'");
  await db.query("insert into trading.account_snapshots (taken_at, credit_usd, invested_usd, pending_orders_usd, unrealized_pnl_usd, equity_usd, open_positions, source) values ('2099-11-17T00:07:00Z', 99550, 450, 0, 0, 100000, 2, 'eToro'), ('2099-11-17T15:07:00Z', 99550, 450, 0, -3.1, 99996.9, 2, 'eToro pnl')");
  await db.query(`insert into trading.positions (etoro_position_id, instrument_id, direction, leverage, amount_usd, units, open_rate, opened_at, exit_conditions, source, last_synced_at) values
    (11, 100000, 'buy', 1, 250, 2.5, 101, '2099-11-16T10:00:00Z', '[{"type":"price_below","value":95,"description":"stop"}]', 't', now()), (12, 2002, 'buy', 1, 200, 2, 99, '2099-11-17T10:00:00Z', '[]', 't', now())`);
  await db.query("insert into trading.position_alerts (etoro_position_id, condition_key, kind, symbol, message, delivered) values (12, 'no_stop_level', 'no_exit_conditions', 'NKE', '🚨 <b>Position has no stop level — NKE</b> (DEMO)', true)");
  await db.query("insert into trading.account_alerts (alert_key, kind, message) values ('crypto_exposure:80:2099-11-17', 'limit_warning', 'Crypto exposure (MSTR counts): 1250 of 1500')");
  // a proposal waiting for approval, with a real hash
  const expiresAt = "2099-11-18T15:00:00.000Z";
  const hash = paramsHash({ action: "open", instrumentId: 2001, direction: "buy", leverage: 1, orderType: "market", limitRate: null, amountUsd: 300, positionId: null, expiresAt });
  w.proposalId = (await db.query(`insert into trading.proposals (action, instrument_id, asset_class, direction, leverage, order_type, amount_usd, expires_at, params_hash, status, details)
    values ('open', 2001, 'stock', 'buy', 1, 'market', 300, $1, $2, 'pending_approval', $3) returning id`, [expiresAt, hash, JSON.stringify({ holding_days: 6, rationale: "<b>pulled back</b>", exit_conditions: [{ type: "price_below", value: 96, description: "stop" }], disagreements: [{ issue: "size", analyst_position: "$450", risk_position: "$300", my_view: "$300" }] })])).rows[0].id;
  w.approvalId = (await db.query("insert into trading.approvals (proposal_id, params_hash, requested_at, expires_at, telegram_message_id) values ($1, $2, $3, $4, 777) returning id", [w.proposalId, hash, "2099-11-17T15:09:00Z", "2099-11-17T15:24:00Z"])).rows[0].id;
  await db.query("insert into trading.risk_assessments (proposal_id, phase, passed, checks, policy, inputs, engine_version) values ($1, 'pre_approval', true, $2, '{}', $3, 'risk-engine-2')",
    [w.proposalId, JSON.stringify(Array.from({ length: 24 }, (_, i) => ({ name: `c${i}`, passed: true, message: "ok" }))), JSON.stringify({ price: { bid: 100, ask: 100.1, asOf: "2099-11-17T15:08:00Z" }, warnings: ["earnings are due on 2099-11-19, inside the planned 6-day holding period"] })]);
  await db.query("insert into trading.proposals (action, instrument_id, asset_class, direction, leverage, order_type, amount_usd, expires_at, params_hash, status, status_reason) values ('open', 2002, 'stock', 'buy', 1, 'market', 600, $1, $2, 'risk_rejected', '$600 against a limit of $500 per stock trade')", [expiresAt, "b".repeat(64)]);
  await db.query("insert into trading.analyses (agent, instrument_id, recommendation, confidence, output, model) values ('stock', 2001, 'buy', 0.66, '{\"thesis\":\"A rebound setup.\"}', 'claude-opus-5-5')");
  w.config = { tradingEnabled: true, hasKeys: true, monitorEnabled: true, agentsScheduleEnabled: false };
  w.client = {
    redact: (x) => String(x ?? ""),
    getDemoPnl: async () => ({ data: { clientPortfolio: { credit: 100000, positions: [], ordersForOpen: [], orders: [], mirrors: [] } }, source: "pnl", fetchedAt: T.toISOString() }),
    getRates: async ([id]) => ({ status: 200, source: "rates", fetchedAt: T.toISOString(), data: { results: [{ instrumentId: id, bid: 100, ask: 100.1, quoteType: "realtime", date: "2099-11-17T15:09:40" }] } }),
    getDemoOrder: async () => ({ data: { orderId: 9, status: { id: 3, name: "Filled" }, positionExecutions: [{ positionId: 13, marginAccountCurrency: 299.7, openingData: { openTime: "2099-11-17T15:10:01Z", units: 3, avgPrice: 100.1 } }] } }),
  };
  w.orders = { redact: (x) => String(x ?? ""), placeDemoOrder: async (body, { idempotencyKey }) => { w.orderCalls.push({ body, idempotencyKey }); return { accepted: true, orderId: 9, response: {}, fetchedAt: T.toISOString() }; } };
  w.notifier = { enabled: true, send: async (h) => { w.sent.push(h); return true; }, sendButtons: async () => ({ ok: true, messageId: 1 }), edit: async (id, h) => { w.edits.push({ id, html: h }); return true; }, answer: async () => true };
  w.gateway = createGateway({ config: w.config, db, client: w.client, orders: w.orders, now: () => T, onOutcome: (o) => w.outcomes.push(o), log: () => {} });
  w.approvals = createApprovals({ config: w.config, db, client: w.client, gateway: w.gateway, notifier: w.notifier, now: () => T, log: () => {} });
  w.agents = { state: () => ({ ready: true, notReadyBecause: null, running: null, schedule: { running: false, runs: [] }, models: { screen: "claude-haiku-5-5", stock: "claude-opus-5-5" } }), budget: { status: async () => ({ available: true, month: "2099-11", budgetUsd: 75, spentUsd: 1.2, reached: false }) }, recentRuns: async () => [{ event: "finished", at: "2099-11-17T12:09:00Z", ok: true, trigger: "schedule", mode: "screened", screen: { shortlist: ["MSTR"], results: [1, 2, 3] }, proposals: [{}], usage: { estimatedCostUsd: 0.82 } }] };
  w.positions = { start: () => false, state: () => ({ scheduled: true, lastCheck: { limits: [{ name: "crypto_exposure", label: "Crypto exposure (MSTR counts)", unit: "$", value: 250, limit: 1500, pct: 17 }] } }) };
  return w;
}

dbTest("the page's data: account, limits, waiting requests, positions, history, alerts and settings — read-only, with times", async (w) => {
  const calls = [];
  const watched = new Proxy(w.client, { get: (o, k) => (typeof o[k] === "function" && k !== "redact" ? (...a) => { calls.push(k); return o[k](...a); } : o[k]) });
  const d = await buildDesk({ db: w.db, config: w.config, agents: w.agents, positions: w.positions, approvals: w.approvals, client: watched, now: T });
  assert.deepStrictEqual(calls, []);                                                // no eToro call to show the page
  assert.deepStrictEqual([d.ok, d.environment], [true, "demo"]);
  const o = d.overview;
  assert.deepStrictEqual([o.availableCashUsd, o.investedUsd, o.unrealizedPnlUsd, o.todayPnlUsd, o.at, o.split], [99550, 450, -3.1, -3.1, "2099-11-17T15:07:00.000Z", { stockUsd: 200, cryptoUsd: 250 }]);
  assert.strictEqual(o.limits[0].name, "crypto_exposure");
  const p = d.pending[0];
  assert.deepStrictEqual([p.approvalId, p.symbol, p.amountUsd, p.holdingDays, p.answerBy, p.checksPassed, p.checksTotal, p.price.bid], [w.approvalId, "MSTR", 300, 6, "2099-11-17T15:24:00.000Z", 24, 24, 100]);
  assert.match(p.warnings[0], /earnings are due/);
  assert.strictEqual(p.rationale, "<b>pulled back</b>");                           // raw text: the page escapes it
  assert.deepStrictEqual(d.positions.map((x) => [x.symbol, x.amountUsd, x.estimatedPnlUsd, x.bid]), [["NKE", 200, 2, 100], ["BTC", 250, -2.5, 100]]);
  assert.deepStrictEqual(d.history.map((h) => [h.symbol, h.status]).sort(), [["MSTR", "pending_approval"], ["NKE", "risk_rejected"]]);
  assert.deepStrictEqual(d.alerts.map((a) => a.scope).sort(), ["account", "position", "risk"]);
  assert.strictEqual(d.alerts.find((a) => a.scope === "position").message, "🚨 Position has no stop level — NKE (DEMO)"); // Telegram markup removed
  assert.deepStrictEqual([d.settings.tradingOn, d.settings.stopped, d.settings.policy.maxPerTradeUsd.stock, d.settings.policy.holdingDays], [true, false, 500, { min: 1, max: 14 }]);
  assert.deepStrictEqual(d.settings.allowlists.stocks.map((s) => [s.symbol, s.tradable, s.cryptoCorrelated]), [["MSTR", true, true], ["NKE", true, false], ["WYFI", false, false]]);
  assert.deepStrictEqual([d.agents.budget.budgetUsd, d.agents.runs[0].shortlist, d.agents.analyses[0].text], [75, ["MSTR"], "A rebound setup."]);
  // a stop shows as trading off
  await w.db.query("insert into trading.desk_state (key, value, updated_by) values ('trading_halted', '{\"halted\":true}', 'test')");
  const stopped = await buildDesk({ db: w.db, config: w.config, agents: w.agents, positions: w.positions, approvals: w.approvals, now: T });
  assert.deepStrictEqual([stopped.settings.tradingOn, stopped.settings.stopped], [false, true]);
});

dbTest("Approve in the console: the same checks and gateway as Telegram, recorded as a dashboard decision; forged requests are refused", async (w) => {
  const app = fakeApp();
  mount(app, { authOn: true, config: w.config, client: w.client, db: w.db, notifier: w.notifier, approvals: { ...w.approvals, start: () => false }, gateway: w.gateway, orders: w.orders, agents: { ...w.agents, start: () => false }, positions: w.positions, monitor: quiet, research: quiet });
  await new Promise((r) => setTimeout(r, 100));
  const decide = (body, headers = { "X-Trading-Desk": "1", Host: "x.onrender.com", Origin: "https://x.onrender.com" }) => app.POST("/api/trading/desk/decide", { body, headers });
  // refused before anything is looked at
  assert.strictEqual((await decide({ approvalId: w.approvalId, decision: "approve" }, {})).statusCode, 403);                                  // no header
  assert.strictEqual((await decide({ approvalId: w.approvalId, decision: "approve" }, { "X-Trading-Desk": "1", Host: "x.onrender.com", Origin: "https://evil.example" })).statusCode, 403);
  assert.strictEqual((await decide({ approvalId: w.approvalId, decision: "buy-everything" })).statusCode, 400);
  assert.strictEqual(w.orderCalls.length, 0);
  assert.strictEqual((await w.db.query("select decision from trading.approvals where id = $1", [w.approvalId])).rows[0].decision, null);
  // the real thing
  const r = await decide({ approvalId: w.approvalId, decision: "approve" });
  await new Promise((r2) => setTimeout(r2, 20));
  assert.deepStrictEqual([r.statusCode, r.body.outcome, r.body.execution.status], [200, "approved", "filled"], JSON.stringify(r.body));
  assert.match(r.body.message, /اعتُمد ونُفّذ الأمر/);
  assert.strictEqual(w.orderCalls.length, 1);
  const a = (await w.db.query("select decision, channel, actor, consumed_at from trading.approvals where id = $1", [w.approvalId])).rows[0];
  assert.deepStrictEqual([a.decision, a.channel, a.actor, !!a.consumed_at], ["approved", "dashboard", "console", true]);
  assert.match(w.edits[0].html, /Approved[\s\S]*decided in the console/);                                                                  // the Telegram buttons are removed
  assert.strictEqual(w.edits[0].id, 777);
  const v = (await w.db.query("select phase from trading.risk_assessments where proposal_id = $1 order by created_at", [w.proposalId])).rows.map((x) => x.phase);
  assert.deepStrictEqual(v, ["pre_approval", "pre_execution"]);                                                                            // re-checked live before sending
  // a second tap anywhere does nothing
  const again = await decide({ approvalId: w.approvalId, decision: "approve" });
  assert.deepStrictEqual([again.body.outcome, w.orderCalls.length], ["already_decided", 1]);
  assert.match(again.body.message, /سبق البتّ/);
  const nonsense = await decide({ approvalId: "not-an-id", decision: "reject" });
  assert.deepStrictEqual([nonsense.body.outcome, nonsense.body.ok], ["unknown", false]);
  // the page's data no longer lists it as waiting
  assert.deepStrictEqual((await app.GET("/api/trading/desk")).body.pending, []);
});
