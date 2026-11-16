// Run with: npm test
// Startup migrations, Telegram summaries and Telegram commands.
// The database part runs only when TEST_TRADING_DATABASE_URL points at a
// throw-away Postgres; it creates its own database ("trading_ops_test").
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDb, listMigrations } = require("../db");
const { mount } = require("../index");
const notify = require("../notify");

const wait = async (until, ms = 1000) => { for (let i = 0; i < ms / 5 && !until(); i++) await new Promise((r) => setTimeout(r, 5)); };
function fakeApp() {
  const routes = {};
  return {
    get: (p, ...handlers) => { routes[p] = handlers; },
    async call(p, query = {}) {
      const res = { statusCode: 200, body: null, set() { return res; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
      const run = async (i) => { if (routes[p][i]) await routes[p][i]({ query }, res, () => run(i + 1)); };
      await run(0);
      return res;
    },
  };
}
const cfg = { hasKeys: false, tradingEnabled: false, monitorEnabled: true, agentsScheduleEnabled: true, databaseUrl: "x", providerKeys: {}, anthropicKey: "k" };
function parts() {
  const started = [];
  const sent = [];
  const runs = [];
  const state = { ready: true, notReadyBecause: null, running: null, schedule: { running: false, runs: [] } };
  return {
    started, sent, runs, state,
    opts: {
      authOn: true, config: cfg, client: { redact: (t) => String(t ?? "") },
      monitor: { start: () => started.push("monitor"), state: () => ({}) },
      research: { start: () => started.push("research"), state: () => ({}) },
      agents: { start: () => started.push("agents"), state: () => state, run: async (s, o) => { runs.push([s, o]); }, recentRuns: async () => [], budget: { status: async () => ({ available: true, month: "2026-11", budgetUsd: 50, spentUsd: 12.4, remainingUsd: 37.6, reached: false, warning: null }) } },
      notifier: { enabled: true, send: async (html) => { sent.push(html); return true; } },
      positions: { start: () => started.push("positions"), state: () => ({ scheduled: true, lastCheck: null }) },
    },
  };
}

// ---- startup migrations: the wiring ------------------------------------------
test("startup: nothing that uses the database starts until migrations have been applied", async () => {
  const p = parts();
  let release;
  const db = { configured: true, redact: (t) => String(t ?? ""), migrateAll: () => new Promise((r) => { release = () => r({ applied: ["004_api_usage"], upToDate: true }); }) };
  const app = fakeApp();
  const desk = mount(app, { ...p.opts, db });
  assert.strictEqual(desk.dbState.state, "starting");
  assert.deepStrictEqual(p.started, []);                                          // no schedule yet
  assert.strictEqual((await app.call("/api/trading/monitor/status")).statusCode, 503);
  release();
  await wait(() => desk.dbState.state === "ok");
  assert.deepStrictEqual(p.started, ["monitor", "research", "agents", "positions"]);
  assert.deepStrictEqual(desk.dbState.applied, ["004_api_usage"]);
  assert.match(p.sent[0], /database updated[\s\S]*004_api_usage/);                 // the owner is told what was applied
});

test("startup fails closed: a failed migration keeps the desk off, says why once, and retries", async () => {
  const p = parts();
  let calls = 0;
  const db = { configured: true, redact: (t) => String(t ?? "").replace("s3cret", "[redacted]"), migrateAll: async () => { calls++; if (calls < 3) throw new Error("migration 005_x failed and was rolled back: syntax error s3cret"); return { applied: ["005_x"], upToDate: true }; } };
  const app = fakeApp();
  const desk = mount(app, { ...p.opts, db, retryMs: 20 });
  await wait(() => desk.dbState.state === "failed");
  assert.deepStrictEqual(p.started, []);                                          // monitoring, research and agents are not started
  const blocked = await app.call("/api/trading/agents/run", { screened: "yes", confirm: "yes" });
  assert.strictEqual(blocked.statusCode, 503);
  assert.match(blocked.body.error, /Trading Desk is off: its database could not be prepared/);
  assert.deepStrictEqual(p.runs, []);
  assert.ok(!JSON.stringify([blocked.body, p.sent]).includes("s3cret"));
  await desk.handleTelegramCommand("trade_run", "/trade_run");                    // the Telegram command is refused too
  assert.match(p.sent[p.sent.length - 1], /Not started: the database is failed/);
  assert.deepStrictEqual(p.runs, []);
  await wait(() => desk.dbState.state === "ok", 3000);                            // third attempt succeeds
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(p.started, ["monitor", "research", "agents", "positions"]);
  assert.strictEqual(p.sent.filter((m) => /is off: its database/.test(m)).length, 1); // the same failure is reported once, not on every retry
  assert.ok(p.sent.some((m) => /database updated/.test(m)));
});

test("startup: without a database nothing is migrated or started, and the rest of the server is untouched", () => {
  const p = parts();
  const desk = mount(fakeApp(), { ...p.opts, db: { configured: false, redact: (t) => t, migrateAll: async () => { throw new Error("must not be called"); } } });
  assert.strictEqual(desk.dbState.state, "not_configured");
  assert.deepStrictEqual(p.started, []);
});

// ---- Telegram: messages built by code ----------------------------------------
const finished = {
  ok: true, trigger: "schedule", mode: "screened", scope: "all", startedAt: "2026-11-16T12:00:00.100Z", finishedAt: "2026-11-16T12:09:10.000Z",
  screen: { minScore: 6, results: [{ symbol: "MSTR", score: 8, shortlisted: true }, { symbol: "NVO", score: 7, shortlisted: true }, { symbol: "BTC", score: 3, shortlisted: false }, { symbol: "SE", score: null, error: "x", shortlisted: false }] },
  instruments: [{ symbol: "MSTR", analysis: { ok: true, recommendation: "avoid" }, riskReview: { ok: true, stance: "no_objection" } }, { symbol: "NVO", analysis: { ok: true, recommendation: "buy" }, riskReview: { ok: true, stance: "caution" } }],
  portfolioManager: { decisions: [{ symbol: "MSTR", decision: "no_trade" }, { symbol: "NVO", decision: "propose_buy" }] },
  proposals: [{ symbol: "NVO", amountUsd: 300 }], problems: ["SE screen: x — not shortlisted"],
  usage: { estimatedCostUsd: 1.42, byAgent: { screen: { estimatedCostUsd: 0.02 }, stock: { estimatedCostUsd: 0.6 }, risk: { estimatedCostUsd: 0.5 }, portfolio_manager: { estimatedCostUsd: 0.3 } } },
  budget: { available: true, month: "2026-11", budgetUsd: 50, spentUsd: 12.4, reached: false, warning: null },
};

test("run summary: instruments screened, shortlist, proposals, cost and budget — from the result, by code", () => {
  const t = notify.runSummary(finished);
  for (const piece of ["screened run", "(DEMO)", "schedule · 2026-11-16 12:00 UTC · 9 min", "Screened: 3 of 4", "Shortlist (2): MSTR 8, NVO 7", "MSTR avoid / no objection; NVO buy / caution",
    "1 buy proposed, 1 no trade", "Draft proposals (1): NVO $300.00", "Problems (1): SE screen", "about $1.42 (screen $0.02, analysts $0.60, risk $0.50, manager $0.30)", "$12.40 of $50.00 used in 2026-11 (25%)", "No order was placed"]) assert.ok(t.includes(piece), piece);
  assert.ok(t.length < 4096);                                                      // fits one Telegram message
  const quiet = notify.runSummary({ ...finished, screen: { minScore: 6, results: [{ symbol: "BTC", score: 3, shortlisted: false }] }, instruments: [], portfolioManager: undefined, proposals: [], problems: [] });
  assert.ok(quiet.includes("Shortlist: none scored 6 or more") && quiet.includes("Draft proposals: none"));
  const skipped = notify.runSummary({ trigger: "schedule", mode: "screened", startedAt: "2026-11-16T12:00:00Z", skipped: "monthly budget reached: about $49.9 of $50 used", budget: { ...finished.budget, spentUsd: 49.9, reached: true } });
  assert.ok(skipped.includes("Nothing ran: monthly budget reached"));
  assert.match(notify.budgetLine({ ...finished.budget, spentUsd: 49.9, reached: true }), /⛔[\s\S]*reached, runs are stopped until next month/);
  assert.match(notify.budgetLine({ available: false, error: "no ledger" }), /no agent may run/);
  // text from a run is escaped, never interpreted as Telegram markup
  assert.ok(notify.runSummary({ ...finished, problems: ["<b>bad</b> & co"] }).includes("&lt;b&gt;bad&lt;/b&gt; &amp; co"));
  // the summary module contains no Claude client at all
  assert.ok(!/anthropic|messages\.create/i.test(fs.readFileSync(path.join(__dirname, "..", "notify.js"), "utf8").replace(/\/\/.*$/gm, "")));
});

test("the notifier never throws and says nothing when Telegram is not set up", async () => {
  const logs = [];
  assert.strictEqual(await notify.createNotifier({ telegram: null, log: (...a) => logs.push(a.join(" ")) }).send("x"), false);
  assert.strictEqual(await notify.createNotifier({ telegram: { enabled: false, sendMessage: async () => { throw new Error("no"); } }, log: () => {} }).send("x"), false);
  const failing = notify.createNotifier({ telegram: { enabled: true, sendMessage: async () => { throw new Error("telegram down TOKEN123"); }, redact: (t) => String(t).replace("TOKEN123", "[redacted]") }, log: (...a) => logs.push(a.join(" ")) });
  assert.strictEqual(await failing.send("x"), false);
  assert.ok(logs.some((l) => /telegram send failed: telegram down \[redacted\]/.test(l)));
  const got = [];
  assert.strictEqual(await notify.createNotifier({ telegram: { enabled: true, sendMessage: async (t) => got.push(t) } }).send("<b>hi</b>"), true);
  assert.deepStrictEqual(got, ["<b>hi</b>"]);
});

test("Telegram commands: /trade_run starts a screened run only; /trade_status reports; nothing else is handled", async () => {
  const p = parts();
  const desk = mount(fakeApp(), { ...p.opts, db: { configured: true, redact: (t) => String(t ?? "") } });
  assert.deepStrictEqual([...desk.telegramCommands], ["trade_run", "trade_status"]);
  assert.strictEqual(await desk.handleTelegramCommand("brief", "/brief"), false);  // not the desk's command: left to the server
  assert.deepStrictEqual([p.runs, p.sent], [[], []]);
  await desk.handleTelegramCommand("trade_run", "/trade_run");
  await desk.handleTelegramCommand("trade_run", "/trade_run crypto");
  assert.deepStrictEqual(p.runs, [["all", { trigger: "telegram", screened: true, scope: "all" }], ["all", { trigger: "telegram", screened: true, scope: "crypto" }]]);
  assert.match(p.sent[0], /Screened run started \(all instruments\)/);
  assert.match(p.sent[1], /coins only/);
  p.state.running = { step: "screening NVO", startedAt: "2026-11-16T12:00:00Z" };
  await desk.handleTelegramCommand("trade_run", "/trade_run");
  assert.strictEqual(p.runs.length, 2);                                            // not started twice
  assert.match(p.sent[2], /already in progress: screening NVO/);
  await desk.handleTelegramCommand("trade_status", "/trade_status");
  assert.match(p.sent[3], /Trading Desk status[\s\S]*Running now: screening NVO[\s\S]*\$12\.40 of \$50\.00[\s\S]*Last run: none yet[\s\S]*Position checks: on, first check pending/);
  // while a run is in progress, its own start record is not reported as a run that "did not finish"
  p.opts.agents.recentRuns = async () => [{ event: "started", at: "2026-11-16T14:00:00Z" }, { event: "finished", at: "2026-11-15T12:09:00Z", ok: true, proposals: [], usage: { estimatedCostUsd: 0.82 } }];
  await desk.handleTelegramCommand("trade_status", "/trade_status");
  assert.match(p.sent[4], /Running now: screening NVO[\s\S]*Last run: 2026-11-15 12:09 UTC — ok, 0 draft\(s\), about \$0\.82/);
  assert.ok(!/did not finish/.test(p.sent[4]));
  p.state.running = null;                                                          // the same records with nothing running: that run really was cut short
  await desk.handleTelegramCommand("trade_status", "/trade_status");
  assert.match(p.sent[5], /Last run: 2026-11-16 14:00 UTC — did not finish \(server restarted\)/);
  p.sent.splice(4, 2);
  p.state.ready = false; p.state.notReadyBecause = "ANTHROPIC_API_KEY is not set on the server";
  await desk.handleTelegramCommand("trade_run", "/trade_run");
  assert.match(p.sent[4], /Not started: ANTHROPIC_API_KEY/);
  assert.strictEqual(p.runs.length, 2);
  for (const c of desk.telegramCommandList) assert.match(c.command, /^[a-z0-9_]{1,32}$/); // valid Telegram command names
});

// ---- startup migrations against a real Postgres -------------------------------
const TEST_URL = process.env.TEST_TRADING_DATABASE_URL;
const dbTest = (name, fn) => test(name, { skip: TEST_URL ? false : "TEST_TRADING_DATABASE_URL is not set" }, fn);
const urlFor = (name) => { const u = new URL(TEST_URL); u.pathname = `/${name}`; return u.toString(); };
if (TEST_URL) {
  test.before(async () => {
    const admin = createDb({ config: { databaseUrl: TEST_URL } });
    await admin.query("drop database if exists trading_ops_test");
    await admin.query("create database trading_ops_test");
    await admin.close();
  });
}

dbTest("migrateAll: applies everything pending in order, logs each one, and is a no-op the second time", async () => {
  const db = createDb({ config: { databaseUrl: urlFor("trading_ops_test") } });
  try {
    const names = listMigrations().map((m) => m.name);
    const seen = [];
    assert.deepStrictEqual(await db.migrateAll({ onApplied: (n) => seen.push(n) }), { applied: names, upToDate: true });
    assert.deepStrictEqual(seen, names);
    assert.deepStrictEqual(await db.migrateAll(), { applied: [], upToDate: true });  // idempotent
    const [a, b] = await Promise.all([db.migrateAll(), db.migrateAll()]);           // two server instances at once
    assert.deepStrictEqual([a.applied, b.applied], [[], []]);
    const st = await db.status();
    assert.deepStrictEqual([st.migrations.pending, st.migrations.problems], [[], []]);
    const log = await db.query("select entity_id from trading.audit_log where event_type = 'migration.applied' order by seq");
    assert.deepStrictEqual(log.rows.map((r) => r.entity_id), names);
  } finally { await db.close(); }
});

dbTest("migrateAll fails closed: a broken migration is rolled back, earlier ones stay, and an edited file stops everything", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  const real = path.join(__dirname, "..", "db", "migrations");
  for (const f of fs.readdirSync(real)) fs.copyFileSync(path.join(real, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "905_good.sql"), "create table trading.t5 (id int);");
  fs.writeFileSync(path.join(dir, "906_broken.sql"), "create table trading.t6 (id int); select no_such_function();");
  fs.writeFileSync(path.join(dir, "907_never.sql"), "create table trading.t7 (id int);");
  const db = createDb({ config: { databaseUrl: urlFor("trading_ops_test") }, migrationsDir: dir });
  try {
    await assert.rejects(db.migrateAll(), (e) => e.code === "MigrationFailed" && /906_broken failed and was rolled back/.test(e.message));
    const tables = (await db.query("select tablename from pg_tables where schemaname = 'trading' and tablename in ('t5', 't6', 't7') order by 1")).rows.map((r) => r.tablename);
    assert.deepStrictEqual(tables, ["t5"]);                                         // 005 stayed, 006 left nothing, 007 was never tried
    assert.deepStrictEqual((await db.status()).migrations.pending, ["906_broken", "907_never"]);
    await assert.rejects(db.migrateAll(), (e) => e.code === "MigrationFailed");     // still failing, still nothing half-done
    fs.writeFileSync(path.join(dir, "906_broken.sql"), "create table trading.t6 (id int);"); // the fix arrives with a later deploy
    assert.deepStrictEqual((await db.migrateAll()).applied, ["906_broken", "907_never"]);
    fs.appendFileSync(path.join(dir, "905_good.sql"), "\n-- edited after it was applied");
    fs.writeFileSync(path.join(dir, "908_next.sql"), "create table trading.t8 (id int);");
    await assert.rejects(db.migrateAll(), (e) => e.code === "MigrationProblem" && /905_good was edited after it was applied/.test(e.message));
    assert.strictEqual((await db.query("select to_regclass('trading.t8') as t")).rows[0].t, null); // nothing ran
  } finally { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
