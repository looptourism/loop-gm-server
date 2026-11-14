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
    // Switch for the Market Monitoring schedule (Stage 3). Read-only: it
    // collects prices, it cannot trade. Same rule as the kill switch — only
    // the exact string "true" turns it on.
    monitorEnabled: env.TRADING_MONITOR_ENABLED === "true",
    // Keys of the news / fundamentals providers, by provider name. A provider
    // without a key is simply unavailable; nothing falls back to another one.
    providerKeys: {
      finnhub: (env.FINNHUB_API_KEY || "").trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// News, fundamentals and earnings: WHICH provider answers WHICH question.
// This table is the only place that names a provider. The rest of the code
// asks for a capability ("stock" + "news") and gets whatever is named here.
//
// Owner's choice (2026-11-13): Option A — Finnhub for stocks.
// To move a capability to another provider, change its name here. The name
// must be one registered in trading/providers/index.js; an unknown name or a
// missing key makes that capability unavailable (it never silently falls
// back). Crypto capabilities are added when CoinGecko is integrated.
// ---------------------------------------------------------------------------
const DATA_PROVIDERS = {
  stock: { profile: "finnhub", fundamentals: "finnhub", earnings: "finnhub", news: "finnhub" },
  crypto: {},
};

// ---------------------------------------------------------------------------
// Market Monitoring settings (Stage 3) — everything the job does is decided
// here, in one place.
//
// eToro's market-data quota is 120 requests per rolling 60 s, shared by ALL
// market-data calls of this user key (the reference pages and the real
// RateLimit-* headers say 120; eToro's "Rate Limits" guide says 60). The job
// keeps to 30 per minute — a quarter of the quota, and half of the lower
// figure — and stops early when eToro reports that little quota is left, so
// the test routes and the Stage 5 fresh-price check always have room.
//
// Requests per run with 31 instruments: 1 for all rates, plus 1 per
// instrument for each candle interval that is due — at most 63, spread over
// a little more than two minutes.
// ---------------------------------------------------------------------------
const HOUR = 60 * 60 * 1000;
const MONITORING = {
  cron: "5,20,35,50 * * * *",   // UTC; rates are collected on every run
  requestsPerMinute: 30,          // the job's own ceiling (quota: 120)
  minGapMs: 2000,                 // at least 2 s between two requests
  reserveRemaining: 40,           // wait for the next window if eToro says fewer than this are left
  pauseAfter429Ms: 5 * 60 * 1000, // after a 429: no requests for at least this long
  candles: [
    // backfill: candles asked for the first time; refreshEveryMs: how often the interval is collected
    { interval: "OneDay", backfill: 400, refreshEveryMs: 6 * HOUR },
    { interval: "OneHour", backfill: 240, refreshEveryMs: HOUR },
  ],
  candleOverlap: 3,               // finished candles re-read each time, to catch eToro revising them
  // A stored rate counts as fresh only if eToro's OWN timestamp for it is
  // this recent (one collection cycle plus a margin) and it is "realtime".
  rateFreshSec: 20 * 60,
};

module.exports = { ETORO_BASE_URL, MONITORING, DATA_PROVIDERS, readConfig };
