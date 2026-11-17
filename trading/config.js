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
    // Claude API key for the Trading Desk's own client. It shares no agent,
    // tool or conversation with the GM, the departments or the secretary.
    // TRADING_ANTHROPIC_API_KEY — a key of its own (ideally from its own
    // Anthropic workspace), so the desk's cost is billed and limited apart
    // from the rest of the server. Until it is set, the server's shared
    // ANTHROPIC_API_KEY is used and anthropicKeySource says so.
    anthropicKey: (env.TRADING_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || "").trim(),
    anthropicKeySource: (env.TRADING_ANTHROPIC_API_KEY || "").trim() ? "TRADING_ANTHROPIC_API_KEY (the desk's own key)" : (env.ANTHROPIC_API_KEY || "").trim() ? "ANTHROPIC_API_KEY (shared with the rest of the server)" : "none",
    // Switch for the agents' own schedule. Separate from monitoring because
    // it spends Claude API money. Only the exact string "true" turns it on.
    agentsScheduleEnabled: env.TRADING_AGENTS_SCHEDULE_ENABLED === "true",
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
// The Trading Desk agents (Stage 4) — models, cost controls and schedule.
// Owner's decisions of 2026-11-15 are marked.
//
// Two tiers, to keep the cost down:
//   1. SCREEN  — a cheap model looks at every instrument (one short request
//                each, on a data pack built by code) and scores it 0–10.
//   2. ANALYSE — the strong model runs the full analyst → risk reviewer →
//                portfolio manager chain, only for the best-scored few.
// A screen can only cause an instrument to be skipped; it can never cause a
// trade.
// ---------------------------------------------------------------------------
const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";
const AGENTS = {
  models: { screen: HAIKU, stock: OPUS, crypto: OPUS, risk: OPUS, portfolio_manager: OPUS },
  // Anthropic's list prices, US dollars per million tokens. Used only to
  // ESTIMATE cost; update when a model or its price changes. (Haiku's price
  // is for prompts up to 100K tokens; a screen prompt is a few thousand.)
  pricesPerMTok: { [OPUS]: { input: 4, output: 20 }, [HAIKU]: { input: 0.1, output: 0.5 } },

  shortlistMax: 5,            // owner: at most 5 instruments get the full analysis per run
  shortlistMinScore: 6,       // a screen score below this is never analysed, even if fewer than 5 qualify

  monthlyBudgetUsd: 75,       // owner (2026-11-16, raised from 50 for weekday runs): hard stop for the calendar month (UTC)
  warnAtFraction: 0.8,
  // What one step is assumed to cost at most. A step is refused if the
  // month's spend plus this would exceed the budget.
  stepReserveUsd: { screen: 0.02, stock: 0.4, crypto: 0.4, risk: 0.4, portfolio_manager: 1.5 },

  // owner (2026-11-16): screened runs every weekday at 12:00 UTC (all
  // instruments), and on Saturday at 12:00 UTC (coins only). They run only
  // when TRADING_AGENTS_SCHEDULE_ENABLED is exactly "true".
  schedule: [
    { cron: "0 12 * * 1-5", scope: "all", label: "Mon–Fri 12:00 UTC — all instruments, screened" },
    // owner (2026-11-17): a second weekday screen during the US session
    // (22:00 Dubai), so the day's moves are seen while prices are live and
    // the owner is still awake to approve.
    { cron: "0 18 * * 1-5", scope: "all", label: "Mon–Fri 18:00 UTC — all instruments, screened (US session)" },
    { cron: "0 12 * * 6", scope: "crypto", label: "Sat 12:00 UTC — coins only, screened" },
  ],

  // Revisit watches (2026-11-17): an analyst's "look again when ..." is
  // watched by plain code; when it is met the instrument is analysed again.
  // A watch lasts at most maxDays; at most maxRunsPerDay such runs start per
  // UTC day (each costs about $0.70), and only while the agents' schedule is on.
  watch: { maxDays: 14, maxRunsPerDay: 3, everyMinutes: 15 },

  maxTokens: 16000,
  maxTurns: 12,             // tool rounds per agent before the run is abandoned
  timeoutMs: 5 * 60 * 1000, // per Claude request
  maxSymbolsPerRun: 40,
};

// ---------------------------------------------------------------------------
// Position monitoring (owner's requirement, 2026-11-16): open demo positions
// are checked against their exit conditions every 15 minutes, two minutes
// after each price collection so the prices are new. It runs under the same
// switch as price monitoring (TRADING_MONITOR_ENABLED). One eToro request per
// check, on the account quota (60 per minute).
// ---------------------------------------------------------------------------
const POSITIONS = {
  cron: "7,22,37,52 * * * *",   // UTC
  failuresBeforeAlert: 2,        // consecutive failed checks before a Telegram alert
};

module.exports = { ETORO_BASE_URL, AGENTS, POSITIONS, MONITORING, DATA_PROVIDERS, PROVIDER_LIMITS, RESEARCH, readConfig };
