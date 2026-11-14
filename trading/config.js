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
    // The Claude API key the rest of the server already uses. The Trading Desk
    // builds its OWN client from it; it shares no agent, tool or conversation
    // with the GM, the departments or the secretary.
    anthropicKey: (env.ANTHROPIC_API_KEY || "").trim(),
    providerKeys: {
      finnhub: (env.FINNHUB_API_KEY || "").trim(),
      coingecko: (env.COINGECKO_API_KEY || "").trim(),
      // SEC EDGAR has no key. It requires every caller to identify itself in
      // the User-Agent header ("Name email"); that text is the owner's to set.
      sec: (env.SEC_USER_AGENT || "").trim(),
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
  stock: { profile: "finnhub", fundamentals: "finnhub", earnings: "finnhub", news: "finnhub", filings: "sec" },
  crypto: { fundamentals: "coingecko", marketNews: "finnhub" },
};

// Request ceilings per provider — every call to a provider (collection job,
// coverage test, test routes) goes through the same limiter.
//   Finnhub free: 60 calls/minute          → we use at most 40
//   CoinGecko Demo: reported 30–100/minute, 10,000/month → at most 10/minute
//   SEC EDGAR: 10 requests/second          → at most 60/minute
const PROVIDER_LIMITS = {
  finnhub: { perMinute: 40, minGapMs: 1500 },
  coingecko: { perMinute: 10, minGapMs: 3000 },
  sec: { perMinute: 60, minGapMs: 500 },
};

// The research collection job (news, fundamentals, earnings, filings).
// It runs under the same switch as price monitoring (TRADING_MONITOR_ENABLED).
// Per day with 22 stocks and 9 coins: about 180 Finnhub calls, 9 CoinGecko
// calls (≈270 a month of the 10,000 allowed) and 23 SEC calls.
const RESEARCH = {
  cron: "40 * * * *",                    // UTC; each run only does what is due
  dailyEveryMs: 24 * 60 * 60 * 1000,              // profile, fundamentals, earnings, filings
  newsEveryMs: 6 * 60 * 60 * 1000,                // company news + general crypto news
  newsDaysFirstRun: 30,
  newsDays: 3,
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

// ---------------------------------------------------------------------------
// The four Trading Desk agents (Stage 4).
// They run only when the owner starts a run — there is no schedule, because
// every run costs Claude API money. pricePerMTok is Anthropic's list price for
// `model` (US dollars per million tokens), used only to ESTIMATE a run's cost;
// update both together.
// ---------------------------------------------------------------------------
const AGENTS = {
  model: "claude-opus-5-5",
  pricePerMTok: { input: 4, output: 20 },
  maxTokens: 16000,
  maxTurns: 12,             // tool rounds per agent before the run is abandoned
  timeoutMs: 5 * 60 * 1000, // per Claude request
  maxSymbolsPerRun: 40,
};

module.exports = { ETORO_BASE_URL, AGENTS, MONITORING, DATA_PROVIDERS, PROVIDER_LIMITS, RESEARCH, readConfig };
