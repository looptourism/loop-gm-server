// ---------------------------------------------------------------------------
// Trading Desk configuration — the only place this module reads env vars.
//
// The Trading Desk is isolated from the rest of the server: it has its own
// env vars, and nothing in here is ever handed to the GM, the department
// agents or the secretary. See docs/trading-desk-plan.md (HARD RULES).
// ---------------------------------------------------------------------------
const ETORO_BASE_URL = "https://public-api.etoro.com";

function readConfig(env = process.env) {
  const apiKey = (env.ETORO_API_KEY || "").trim();
  const userKey = (env.ETORO_USER_KEY || "").trim();
  return {
    baseUrl: ETORO_BASE_URL,
    apiKey,
    userKey,
    hasKeys: !!(apiKey && userKey),
    // Kill switch for ORDERS. Only the exact string "true" turns it on; a
    // missing, misspelled or unclear value means off. No stage so far places
    // orders, so here it is only reported — read-only calls stay available
    // so the positions remain visible while trading is stopped.
    tradingEnabled: env.TRADING_ENABLED === "true",
    // The Trading Desk's own Postgres (a Supabase project used by nothing
    // else). Deliberately not called DATABASE_URL, so no other part of the
    // server can pick it up by accident.
    databaseUrl: (env.TRADING_DATABASE_URL || "").trim(),
  };
}

module.exports = { ETORO_BASE_URL, readConfig };
