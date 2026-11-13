// ---------------------------------------------------------------------------
// Trading Desk — Postgres access (its own Supabase project, used by nothing
// else on this server).
//
//   * The connection string comes only from TRADING_DATABASE_URL.
//   * TLS is always on and always VERIFIED against Supabase's root CA
//     (bundled next to this file — a public certificate, not a secret).
//     There is no "skip verification" switch. Plain connections are allowed
//     only to localhost, which is what the automated tests use.
//   * Nothing here runs by itself: no table is created at startup. A
//     migration is applied only when the owner calls the migrate route and
//     names the exact file.
//   * No session-level features are used, so it works through Supabase's
//     shared pooler in either mode (session mode is the one to use).
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const CA_FILE = path.join(__dirname, "supabase-root-2021-ca.crt");
const LOCK_KEY = 778201; // any fixed number: serializes migration runs

class DbError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = "DbError";
    this.code = code;
  }
}

// Turns the URL into explicit options. Query parameters such as ?sslmode=
// are ignored on purpose: TLS behaviour is decided here, not by the string.
function parseDatabaseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new DbError("TRADING_DATABASE_URL is not a valid URL", { code: "BadDatabaseUrl" }); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new DbError("TRADING_DATABASE_URL must start with postgresql://", { code: "BadDatabaseUrl" });
  }
  const password = decodeURIComponent(u.password);
  if (!u.hostname || !u.username || !password) throw new DbError("TRADING_DATABASE_URL needs a user, a password and a host", { code: "BadDatabaseUrl" });
  if (password === "[YOUR-PASSWORD]") throw new DbError("TRADING_DATABASE_URL still contains the [YOUR-PASSWORD] placeholder", { code: "BadDatabaseUrl" });
  const host = u.hostname;
  const local = host === "localhost" || host === "127.0.0.1";
  const warnings = [];
  if (/^db\..+\.supabase\.co$/.test(host)) warnings.push("This is Supabase's direct connection, which is IPv6-only. Render has no IPv6 — use the Session pooler string instead.");
  if (/\.pooler\.supabase\.com$/.test(host) && u.port === "6543") warnings.push("Port 6543 is the Transaction pooler. It works, but the Session pooler (port 5432) is the one this server is meant to use.");
  return {
    options: {
      host,
      port: Number(u.port) || 5432,
      user: decodeURIComponent(u.username),
      password,
      database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
      ssl: local ? false : { ca: fs.readFileSync(CA_FILE, "utf8"), rejectUnauthorized: true },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      statement_timeout: 30000,
      application_name: "loop-trading-desk",
    },
    password,
    describe: { host, port: Number(u.port) || 5432, tls: local ? "off (localhost)" : "on, verified against the Supabase root CA" },
    warnings,
  };
}

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort().map((file) => {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    return { name: file.replace(/\.sql$/, ""), sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
  });
}

function createDb({ config, pgImpl, migrationsDir = MIGRATIONS_DIR } = {}) {
  const configured = !!config?.databaseUrl;
  let pool = null;
  let parsed = null;

  const redact = (text) => {
    let out = String(text ?? "");
    if (parsed?.password && parsed.password.length >= 4) out = out.split(parsed.password).join("[redacted]").split(encodeURIComponent(parsed.password)).join("[redacted]");
    return out;
  };
  const wrap = (e) => (e instanceof DbError ? e : new DbError(redact(`database error: ${e.message}`), { code: e.code || "DbFailure" }));

  function getPool() {
    if (!configured) throw new DbError("TRADING_DATABASE_URL is not set on the server", { code: "NoDatabase" });
    if (!pool) {
      parsed = parseDatabaseUrl(config.databaseUrl);
      const { Pool } = pgImpl || require("pg");
      pool = new Pool(parsed.options);
      pool.on("error", (e) => console.error("[trading/db] idle connection error:", redact(e.message)));
    }
    return pool;
  }

  async function query(text, params) {
    try { return await getPool().query(text, params); } catch (e) { throw wrap(e); }
  }

  // Runs fn(tx) inside one transaction: everything it wrote is committed
  // together, or — on any error — nothing is.
  async function withTransaction(fn) {
    let client;
    try { client = await getPool().connect(); } catch (e) { throw wrap(e); }
    try {
      await client.query("begin");
      const out = await fn({ query: (text, params) => client.query(text, params) });
      await client.query("commit");
      return out;
    } catch (e) {
      try { await client.query("rollback"); } catch { /* the connection is discarded below */ }
      throw wrap(e);
    } finally {
      client.release();
    }
  }

  async function appliedMigrations(q) {
    const exists = await q.query("select to_regclass('trading.schema_migrations') as t");
    if (!exists.rows[0].t) return [];
    return (await q.query("select name, checksum, applied_at from trading.schema_migrations order by name")).rows;
  }

  function plan(applied, files) {
    const byName = new Map(applied.map((a) => [a.name, a]));
    const problems = [];
    for (const f of files) {
      const a = byName.get(f.name);
      if (a && a.checksum !== f.checksum) problems.push(`${f.name} was edited after it was applied — add a new migration instead`);
    }
    for (const a of applied) if (!files.some((f) => f.name === a.name)) problems.push(`${a.name} is applied in the database but its file is missing`);
    return { pending: files.filter((f) => !byName.has(f.name)).map((f) => f.name), problems };
  }

  // Connection check + what is applied / pending + row counts. Read-only.
  async function status() {
    const files = listMigrations(migrationsDir);
    if (!configured) return { configured: false, connected: false, error: "TRADING_DATABASE_URL is not set on the server", migrationFiles: files.map((f) => f.name) };
    try {
      getPool();
      const info = (await query("select now() as now, current_database() as database, current_user as \"user\", current_setting('server_version') as version")).rows[0];
      const applied = await appliedMigrations({ query });
      const { pending, problems } = plan(applied, files);
      const tables = (await query("select tablename from pg_tables where schemaname = 'trading' order by tablename")).rows.map((r) => r.tablename);
      const rowCounts = {};
      for (const t of tables) rowCounts[t] = Number((await query(`select count(*) as n from trading."${t.replace(/"/g, "")}"`)).rows[0].n);
      return {
        configured: true, connected: true, connection: parsed.describe, warnings: parsed.warnings,
        server: { time: info.now, database: info.database, user: info.user, postgres: info.version },
        migrations: { applied: applied.map((a) => ({ name: a.name, appliedAt: a.applied_at })), pending, problems },
        tables: rowCounts,
      };
    } catch (e) {
      return { configured: true, connected: false, connection: parsed?.describe || null, warnings: parsed?.warnings || [], error: wrap(e).message, code: e.code || null };
    }
  }

  // Applies exactly ONE migration: the next pending one, and only if the
  // caller named it. The whole file runs in a single transaction.
  async function migrate(confirmName) {
    const files = listMigrations(migrationsDir);
    return withTransaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock($1)", [LOCK_KEY]);
      await tx.query("create schema if not exists trading");
      await tx.query("create table if not exists trading.schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())");
      const { pending, problems } = plan(await appliedMigrations(tx), files);
      if (problems.length) throw new DbError(`migration refused: ${problems.join("; ")}`, { code: "MigrationProblem" });
      if (!pending.length) throw new DbError("nothing to migrate: every migration is already applied", { code: "NothingPending" });
      if (confirmName !== pending[0]) throw new DbError(`migration refused: the next pending migration is "${pending[0]}" — pass confirm=${pending[0]}`, { code: "ConfirmMismatch" });
      const file = files.find((f) => f.name === pending[0]);
      await tx.query(file.sql);
      await tx.query("insert into trading.schema_migrations (name, checksum) values ($1, $2)", [file.name, file.checksum]);
      return { applied: file.name, remaining: pending.slice(1) };
    });
  }

  async function close() {
    if (pool) { const p = pool; pool = null; await p.end(); }
  }

  return { configured, query, withTransaction, status, migrate, close, redact };
}

module.exports = { createDb, DbError, parseDatabaseUrl, listMigrations };
