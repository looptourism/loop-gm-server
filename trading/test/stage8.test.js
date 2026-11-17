// Run with: npm test
// Stage 8: the tools for the live end-to-end run — quiet hours set from
// Telegram, duplicate taps on record, the kill switch refusing an approved
// order, the exit drill, direct /trade_run, and the checklist that reads it
// all back. Database tests need TEST_TRADING_DATABASE_URL (a throw-away Postgres).
const test = require("node:test");
const assert = require("node:assert");
const { createGateway } = require("../execution/gateway");
const { createApprovals, readQuietHours, inQuietHours } = require("../approvals");
const { createDb } = require("../db");
const analysesStore = require("../db/analyses");
const e2e = require("../e2e");
const notify = require("../notify");
const { mount } = require("../index");

test("the new commands are the desk's, listed for the bot, and the checklist names every step the plan asks for", () => {
  const names = notify.COMMANDS.map((c) => c.command);
  for (const c of ["trade_quiet", "trade_e2e", "trade_drill_exit"]) assert.ok(names.includes(c), c);
  assert.deepStrictEqual(e2e.FLOW_STEPS.map(([k]) => k), ["monitoring", "analysis", "proposal", "risk", "approval", "order", "verification", "alert", "closeProposal", "closeApproval", "close"]);
  assert.deepStrictEqual(e2e.CHECK_STEPS.map(([k]) => k), ["ownerReject", "riskReject", "expired", "duplicate", "quietHours", "killSwitch"]);
});

test("server.js hands every desk command to the desk: its command pattern accepts each name (/trade_e2e has a digit)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "server.js"), "utf8");
  const m = /const command = (\/\^.*?\/i)\.exec\(msg\.text/.exec(src);
  assert.ok(m, "command pattern not found in server.js");
  const pattern = eval(m[1]);
  for (const { command } of notify.COMMANDS) {
    assert.strictEqual(pattern.exec(`/${command}`)?.[1]?.toLowerCase(), command, command);
    assert.strictEqual(pattern.exec(`/${command}@LoopHQBot restart`)?.[1]?.toLowerCase(), command, command);
  }
});

test("quiet hours: a window across midnight in Dubai time", () => {
  const q = { start: "23:00", end: "07:00", timeZone: "Asia/Dubai" };
  assert.strictEqual(inQuietHours(new Date("2099-11-17T19:30:00Z"), q), true);   // 23:30 Dubai
  assert.strictEqual(inQuietHours(new Date("2099-11-17T02:59:00Z"), q), true);   // 06:59 Dubai
  assert.strictEqual(inQuietHours(new Date("2099-11-17T03:00:00Z"), q), false);  // 07:00 Dubai
});

const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, async () => {
  const dbName = `trading_s8_${Math.random().toString(36).slice(2, 10)}`;
  const admin = createDb({ config: { databaseUrl: TEST_URL } });
  await admin.query(`create database ${dbName}`);
  const u = new URL(TEST_URL); u.pathname = `/${dbName}`;
  const db = createDb({ config: { databaseUrl: u.toString() } });
  try { await db.migrateAll(); await fn(await world(db)); }
  finally { await db.close(); await admin.query(`drop database ${dbName} with (force)`); await admin.close(); }
});

const SINCE = "2000-01-01T00:00:00.000Z";
async function world(db) {
  const w = { db, clock: new Date("2099-11-17T15:10:00Z"), sent: [], edits: [], buttons: [], orderCalls: [], runs: [], checks: [] };
  const now = () => w.clock;
  for (const [id, symbol, cls] of [[100000, "BTC", "crypto"], [2002, "NKE", "stock"]]) {
    await db.query("insert into trading.instruments (instrument_id, symbol, display_name, asset_class, raw, source, fetched_at) values ($1, $2, $3, $4, '{}', 't', now())", [id, symbol, `${symbol} name`, cls]);
    await db.query(`insert into trading.${cls}_allowlist (symbol, instrument_id, verified_at) values ($1, $2, now())`, [symbol, id]);
  }
  w.rate = async (id, asOf, bid = 100) => (await db.query("insert into trading.market_snapshots (instrument_id, kind, as_of, bid, ask, quote_type, raw, source, fetched_at) values ($1, 'rate', $2, $3, $4, 'realtime', '{}', 'eToro rates', $2) returning id", [id, asOf, bid, bid * 1.001])).rows[0].id;
  await w.rate(2002, "2099-11-17T15:09:00Z");
  await w.rate(100000, "2099-11-17T15:09:00Z");
  await db.query("insert into trading.account_snapshots (taken_at, credit_usd, invested_usd, pending_orders_usd, unrealized_pnl_usd, equity_usd, open_positions, source) values ('2099-11-17T00:07:00Z', 100000, 0, 0, 0, 100000, 0, 'eToro')");
  w.config = { tradingEnabled: true, hasKeys: true, monitorEnabled: true, agentsScheduleEnabled: false };
  w.client = {
    redact: (x) => String(x ?? ""),
    getDemoPnl: async () => ({ data: { clientPortfolio: { credit: 100000, positions: [], ordersForOpen: [], orders: [], mirrors: [] } }, source: "pnl", fetchedAt: now().toISOString() }),
    getRates: async ([id]) => ({ status: 200, source: "rates", fetchedAt: now().toISOString(), data: { results: [{ instrumentId: id, bid: 100, ask: 100.1, quoteType: "realtime", date: new Date(now().getTime() - 20000).toISOString().slice(0, 19) }] } }),
    getDemoOrder: async () => ({ data: { orderId: 9, status: { id: 3, name: "Filled" }, positionExecutions: [{ positionId: 13, marginAccountCurrency: 49.7, openingData: { openTime: now().toISOString(), units: 0.5, avgPrice: 100.1 } }] } }),
  };
  w.orders = { redact: (x) => String(x ?? ""), placeDemoOrder: async (body, { idempotencyKey }) => { w.orderCalls.push({ body, idempotencyKey }); return { accepted: true, orderId: 9, response: {}, fetchedAt: now().toISOString() }; } };
  w.notifier = { enabled: true, send: async (h) => { w.sent.push(h); return true; }, sendButtons: async (h) => { w.buttons.push(h); return { ok: true, messageId: 500 + w.buttons.length }; }, edit: async (id, h) => { w.edits.push({ id, html: h }); return true; }, answer: async () => true };
  w.outcomes = [];
  w.gateway = createGateway({ config: w.config, db, client: w.client, orders: w.orders, now, onOutcome: (o) => w.outcomes.push(o), log: () => {} });
  w.approvals = createApprovals({ config: w.config, db, client: w.client, gateway: w.gateway, notifier: w.notifier, now, log: () => {} });
  w.draft = async (symbol, amountUsd = 50) => {
    const i = (await db.query("select instrument_id, asset_class from trading.instruments where symbol = $1", [symbol])).rows[0];
    return (await db.withTransaction((tx) => analysesStore.saveDraftProposal(tx, { instrument: { instrumentId: Number(i.instrument_id), symbol, assetClass: i.asset_class }, amountUsd, expiresAt: new Date(now().getTime() + 24 * 3600000), analysisId: null, details: { holding_days: 3, exit_conditions: [{ type: "price_below", value: 90, description: "stop" }] }, actor: "test" }))).id;
  };
  w.approvalOf = async (proposalId) => (await db.query("select id from trading.approvals where proposal_id = $1", [proposalId])).rows[0]?.id;
  w.events = async (type) => (await db.query("select data, actor from trading.audit_log where event_type = $1 order by seq", [type])).rows;
  w.agents = { state: () => ({ ready: true, notReadyBecause: null, running: null }), budget: { status: async () => ({ available: true, budgetUsd: 75, spentUsd: 0 }) }, recentRuns: async () => [], start: () => false, run: (symbols, options) => { w.runs.push({ symbols, options }); } };
  w.positions = { start: () => false, state: () => ({}), check: async (why) => { w.checks.push(why); return { ok: true }; } };
  w.mounted = async () => {
    const desk = mount({ get: () => {}, post: () => {} }, { authOn: true, config: w.config, client: w.client, db, notifier: w.notifier, approvals: { ...w.approvals, start: () => false }, gateway: w.gateway, orders: w.orders, agents: w.agents, positions: w.positions, monitor: { start: () => false, state: () => ({}) }, research: { start: () => false, state: () => ({}) } });
    await new Promise((r) => setTimeout(r, 100));
    return desk;
  };
  return w;
}

dbTest("/trade_quiet sets quiet hours: a request is held and put on record once, then sent after the window; an unreadable setting holds too", async (w) => {
  const { handleTelegramCommand } = await w.mounted();
  assert.deepStrictEqual(await readQuietHours(w.db), { hours: null, from: "policy" });
  await handleTelegramCommand("trade_quiet", "/trade_quiet 25:00-07:00");
  assert.match(w.sent.pop(), /Usage/);
  await handleTelegramCommand("trade_quiet", "/trade_quiet 23:00-07:00 Mars/Olympus");
  assert.match(w.sent.pop(), /Unknown time zone/);
  await handleTelegramCommand("trade_quiet", "/trade_quiet 18:00-20:00");                 // Dubai: 14:00–16:00 UTC
  assert.match(w.sent.pop(), /Quiet hours set: 18:00–20:00 \(Asia\/Dubai\)/);
  assert.deepStrictEqual((await readQuietHours(w.db)).hours, { start: "18:00", end: "20:00", timeZone: "Asia/Dubai" });

  const id = await w.draft("NKE");
  await w.approvals.tick();
  await w.approvals.tick();                                                                // twice: still one hold on record
  assert.deepStrictEqual([w.buttons.length, (await w.events("approval.quiet_hold")).length], [0, 1]);
  assert.strictEqual((await w.db.query("select status from trading.proposals where id = $1", [id])).rows[0].status, "draft");

  w.clock = new Date("2099-11-17T16:01:00Z");                                              // 20:01 Dubai
  await w.rate(2002, "2099-11-17T16:00:30Z");
  await w.approvals.tick();
  assert.strictEqual(w.buttons.length, 1);
  assert.ok(await w.approvalOf(id));
  const list = await e2e.buildE2E({ db: w.db, since: SINCE });
  assert.match(list.checks.quietHours.ref, /^NKE: held at 15:10 UTC/);

  await handleTelegramCommand("trade_quiet", "/trade_quiet off");
  assert.deepStrictEqual(await readQuietHours(w.db), { hours: null, from: "telegram" });
  await handleTelegramCommand("trade_quiet", "/trade_quiet");
  assert.match(w.sent.pop(), /Quiet hours: none/);
  // a database that cannot answer means "quiet": nothing is sent
  const broken = { query: async () => { throw new Error("down"); } };
  assert.deepStrictEqual(await readQuietHours(broken), { hours: null, from: "unreadable", unreadable: true });
});

dbTest("a duplicate tap and an approve while trading is stopped: nothing is sent, both are on record, and the checklist sees them", async (w) => {
  const a1 = await w.draft("NKE");
  await w.approvals.tick();
  const ap1 = await w.approvalOf(a1);
  await w.db.query("insert into trading.desk_state (key, value, updated_by) values ('trading_halted', '{\"halted\":true}', 'test')");  // /trade_stop after the request was sent
  // the tap, exactly as Telegram delivers it
  assert.strictEqual(await w.approvals.handleTelegramCallback({ id: "cq1", data: `td:ok:${ap1}`, from: { id: 1 }, message: { message_id: 501 } }), true);
  await new Promise((r2) => setTimeout(r2, 20));
  assert.strictEqual(w.orderCalls.length, 0);
  const r = { execution: w.outcomes[0] };
  assert.deepStrictEqual([w.outcomes.length, r.execution.status, r.execution.sent, r.execution.proposal.symbol], [1, "refused", false, "NKE"]);
  assert.match(r.execution.reason, /\/trade_stop/);
  // the owner is told, and the "Approved" message itself says nothing was sent
  assert.match(notify.executionResult(r.execution), /No order was sent — BUY NKE \$50\.00 \(DEMO\)[\s\S]*trading was stopped/);
  assert.match(w.edits.at(-1).html, /Approved<\/b> — BUY NKE[\s\S]*but NO order was sent: trading was stopped/);
  const again = await w.approvals.decide(ap1, true, { channel: "dashboard", actor: "console" });
  assert.deepStrictEqual([again.outcome, w.orderCalls.length], ["already_decided", 0]);
  assert.deepStrictEqual((await w.events("approval.duplicate")).map((e) => [e.data.attempted, e.data.previous, e.actor]), [["approve", "approved", "owner:dashboard"]]);
  const list = await e2e.buildE2E({ db: w.db, since: SINCE });
  assert.match(list.checks.killSwitch.ref, /^NKE: trading was stopped/);
  assert.match(list.checks.duplicate.ref, /second "approve" after "approved"/);
  assert.strictEqual(list.complete, false);
  assert.strictEqual(list.checks.expired, null);
  // an approval request nobody answers: expired, its buttons removed, no order
  await w.db.query("delete from trading.desk_state where key = 'trading_halted'");
  const a2 = await w.draft("NKE");
  await w.approvals.tick();
  w.clock = new Date(w.clock.getTime() + 16 * 60000);
  await w.rate(2002, new Date(w.clock.getTime() - 20000).toISOString());
  await w.approvals.tick();
  assert.strictEqual((await w.db.query("select status from trading.proposals where id = $1", [a2])).rows[0].status, "expired");
  assert.match(w.edits.at(-1).html, /xpired/);
  assert.match((await e2e.buildE2E({ db: w.db, since: SINCE })).checks.expired.ref, /^NKE: expired, no order/);
  assert.strictEqual(w.orderCalls.length, 0);
});

dbTest("/trade_run with symbols runs the full analysis of exactly those; /trade_drill_exit adds a real condition and checks now", async (w) => {
  const desk = await w.mounted();
  await desk.handleTelegramCommand("trade_run", "/trade_run nke BTC");
  await desk.handleTelegramCommand("trade_run", "/trade_run crypto");
  await desk.handleTelegramCommand("trade_run", "/trade_run A B C D E");
  assert.deepStrictEqual(w.runs.map((r) => [r.symbols, r.options.screened ?? false]), [[["NKE", "BTC"], false], ["all", true]]);
  assert.match(w.sent.pop(), /up to 4 symbols/);

  await desk.handleTelegramCommand("trade_drill_exit", "/trade_drill_exit BTC");
  assert.match(w.sent.pop(), /no open position in BTC/);
  await w.db.query("insert into trading.positions (etoro_position_id, instrument_id, direction, leverage, amount_usd, units, open_rate, opened_at, exit_conditions, source, last_synced_at) values (77, 100000, 'buy', 1, 50, 0.5, 100, '2099-11-17T10:00:00Z', '[{\"type\":\"price_below\",\"value\":90,\"description\":\"stop\"}]', 't', now())");
  await w.db.query("delete from trading.market_snapshots where instrument_id = 100000");
  await w.rate(100000, new Date(Date.now() - 10000).toISOString());                     // the command reads the real clock
  await desk.handleTelegramCommand("trade_drill_exit", "/trade_drill_exit btc");
  const conds = (await w.db.query("select exit_conditions from trading.positions where etoro_position_id = 77")).rows[0].exit_conditions;
  assert.deepStrictEqual(conds.map((c) => [c.type, c.value]), [["price_below", 90], ["price_above", 99]]);
  assert.match(conds[1].description, /^Stage 8 drill/);
  assert.deepStrictEqual(w.checks, ["drill"]);
  assert.strictEqual((await w.events("position.drill_exit")).length, 1);
  // stale price: refused
  await w.db.query("delete from trading.market_snapshots where instrument_id = 2002");
  await w.rate(2002, "2026-01-01T00:00:00Z");
  await w.db.query("insert into trading.positions (etoro_position_id, instrument_id, direction, leverage, amount_usd, units, open_rate, opened_at, source, last_synced_at) values (78, 2002, 'buy', 1, 50, 0.5, 100, '2099-11-17T10:00:00Z', 't', now())");
  await desk.handleTelegramCommand("trade_drill_exit", "/trade_drill_exit NKE");
  assert.match(w.sent.pop(), /no fresh price/);

  // /trade_e2e starts the run once and replies with the checklist
  await desk.handleTelegramCommand("trade_e2e", "/trade_e2e");
  const first = await e2e.readSince(w.db);
  assert.ok(first);
  assert.match(w.sent.pop(), /End-to-end check[\s\S]*⬜ Monitoring[\s\S]*→ \/trade_run NKE/);
  await desk.handleTelegramCommand("trade_e2e", "/trade_e2e");
  assert.strictEqual(await e2e.readSince(w.db), first);
});

dbTest("the checklist follows one flow from the stored price to the close, step by step, and only counts agent proposals approved in Telegram", async (w) => {
  const db = w.db;
  const snap = await w.rate(100000, "2099-11-17T12:00:00Z", 64000);
  const analysis = (await db.query("insert into trading.analyses (agent, instrument_id, recommendation, confidence, output, snapshot_ids, model) values ('crypto', 100000, 'buy', 0.6, '{}', $1, 'm') returning id", [[snap]])).rows[0].id;
  const pm = (await db.query("insert into trading.analyses (agent, instrument_id, recommendation, output, model) values ('portfolio_manager', null, null, '{}', 'm') returning id")).rows[0].id;
  const step = async () => (await e2e.buildE2E({ db, since: SINCE })).flows.crypto;
  assert.deepStrictEqual([(await step()).done, (await step()).proposalId], [2, null]);   // analysed, nothing proposed yet
  const pid = await w.draft("BTC");
  await db.query("update trading.proposals set analysis_id = $2 where id = $1", [pid, pm]);
  let f = await step();
  assert.deepStrictEqual([f.symbol, f.done, !!f.steps.monitoring, !!f.steps.analysis, !!f.steps.proposal, f.steps.risk], ["BTC", 3, true, true, true, null]);
  assert.match(f.steps.monitoring.ref, /bid 64000 from eToro rates/);
  assert.match(f.steps.analysis.ref, new RegExp(`crypto analysis ${analysis.slice(0, 8)}`));
  // risk → approval in Telegram → order filled → position recorded
  await w.approvals.tick();
  const ap = await w.approvalOf(pid);
  const r = await w.approvals.decide(ap, true, { channel: "telegram", actor: "1" });
  assert.strictEqual(r.execution.status, "filled");
  f = await step();
  assert.deepStrictEqual(["risk", "approval", "order", "verification"].map((k) => !!f.steps[k]), [true, true, true, true]);
  assert.strictEqual(f.steps.alert, null);
  // the monitor's alert and its close proposal
  await db.query("insert into trading.position_alerts (etoro_position_id, condition_key, kind, symbol, message, delivered) values (13, 'price_above:99', 'exit_condition', 'BTC', 'x', true)");
  const pos = (await db.query("select id from trading.positions where etoro_position_id = 13")).rows[0].id;
  await db.withTransaction((tx) => analysesStore.saveCloseProposal(tx, { positionRowId: pos, expiresAt: new Date(w.clock.getTime() + 3600000), details: { source: "position monitor", reason: "drill" }, actor: "system:positions" }));
  f = await step();
  assert.deepStrictEqual([f.done, f.steps.closeProposal.ref.startsWith("close proposal"), f.steps.closeApproval], [9, true, null]);
  assert.match(e2e.e2eText(await e2e.buildE2E({ db, since: SINCE })), /Crypto — BTC<\/b> \(9\/11\)[\s\S]*⬜ You approved the close\n    → tap Approve on the close request/);
  // a console approval of an OPEN does not count for the Telegram step
  const other = await w.draft("NKE");
  await db.query("update trading.proposals set analysis_id = $2 where id = $1", [other, pm]);
  await w.approvals.tick();
  await w.approvals.decide(await w.approvalOf(other), true, { channel: "dashboard", actor: "console" });
  assert.strictEqual((await e2e.buildE2E({ db, since: SINCE })).flows.stock.steps.approval, null);
  // records from before the run's start do not count
  assert.strictEqual((await e2e.buildE2E({ db, since: "2999-01-01T00:00:00Z" })).flows.crypto.done, 0);
});

dbTest("no proposal yet: the checklist still ticks the stored price and the analysis, and says what the agents decided", async (w) => {
  const db = w.db;
  const snap = await w.rate(2002, "2099-11-17T12:00:00Z", 74.2);
  await db.query("insert into trading.analyses (agent, instrument_id, recommendation, confidence, output, snapshot_ids, model) values ('stock', 2002, 'hold', 0.5, '{}', $1, 'm')", [[snap]]);
  await db.query("insert into trading.analyses (agent, instrument_id, output, model) values ('portfolio_manager', null, $1, 'm')", [JSON.stringify({ decisions: [{ symbol: "NKE", decision: "no_trade" }] })]);
  const r = await e2e.buildE2E({ db, since: SINCE });
  const f = r.flows.stock;
  assert.deepStrictEqual([f.symbol, f.done, f.proposalId, f.noTrade], ["NKE", 2, null, { analyst: "hold", manager: "no_trade" }]);
  assert.match(f.steps.monitoring.ref, /bid 74.2 from eToro rates/);
  assert.match(e2e.e2eText(r), /Stock — NKE<\/b> \(2\/11\)[\s\S]*✅ Analysis by the agent[\s\S]*⬜ Proposal by the Portfolio Manager\n    → the agents decided not to buy NKE \(analyst: hold, manager: no_trade\)/);
  assert.strictEqual(r.flows.crypto.done, 0);
});
