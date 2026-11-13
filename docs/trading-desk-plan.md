PROJECT CONTEXT
I want to add an isolated "Trading Desk" tab to my existing GM console (مجلس الإدارة الرقمي): a Node.js server deployed from GitHub to Render (service: loop-gm-server-1), using the Claude API and a Telegram bot that already sends me approve/reject buttons.

I work ONLY from iPhone/iPad. I cannot run local commands. All work happens in Claude Code cloud sessions, deployment is via GitHub push → Render, and env vars are set in the Render dashboard. Give me exact Render env var names and step-by-step mobile-friendly instructions for anything I must do manually.

HARD RULES (never break these):
1. DEMO ONLY. Do not implement any eToro "real" endpoint anywhere in the code. Only /demo/ paths exist in this codebase.
2. ISOLATION. Trading tools must never be registered with the GM agent, the four department agents, or the personal secretary. All trading code lives in its own module folder (e.g. /trading). Separate env vars: ETORO_API_KEY, ETORO_USER_KEY, TRADING_ENABLED (kill switch, default "false").
3. NO AUTO-EXECUTION. Every order requires my explicit approval via Telegram (and the dashboard). Approval is bound to a hash of the exact instrument, direction, amount, order type and expiry, expires after 15 minutes, and is single-use. Any parameter change = new approval.
4. FAIL CLOSED. If auth, data, risk checks, approval verification or the kill switch fail or are unclear → no order is sent.
5. RISK LIMITS ARE CODE, NOT AI. Limits are enforced by deterministic code. Claude may explain a rejection but can never override one.
6. NO INVENTED DATA. Every price/figure an agent uses must come from a tool call and carry a source + timestamp. If data is unavailable, the agent says so.
7. VERIFY BEFORE CODING. Check every endpoint, header and payload against the official eToro API portal (https://api-portal.etoro.com/llms.txt and builders.etoro.com). The docs show both v1 and v2 order paths: confirm which is current and tell me. Never use unofficial endpoints.
8. NO FAKE SUCCESS. Do not mark anything as working until a real call to the eToro DEMO API returned a real result. Note: the Claude Code cloud environment may block outbound network; if so, add a protected test endpoint on the Render server and I will trigger it from my phone.

TRADING POLICY (configurable in one config file):
- Asset classes: stocks and crypto only. No ETFs.
- Max per trade: $500 (crypto: $250) | Max total exposure: $5,000 (crypto cap: $1,500)
- Max daily loss: $100 | Max open positions: 10
- Leverage: 1 only. Buy (long) only, no short selling.
- Stocks: only instruments on my Sharia allowlist. Crypto: only coins on a separate crypto allowlist I approve.
- Closing a position is also a trade and requires my approval, the same as opening.
- Quiet hours setting for Telegram (crypto trades 24/7); proposals still expire normally.
- Prevent duplicate orders (idempotency key per proposal).

STORAGE
Use whatever database the server already uses. If it has none suitable, propose Supabase Postgres and ask me before adding it. Keep a permanent audit log: proposals, risk results, approvals, rejections, orders, execution results.

WORKING METHOD
One stage per session. At the end of each stage: what was built, files changed, tests run + results, limitations, what I must do manually, and the next stage. First read the existing repo structure and follow its conventions.

STAGES

STAGE 1. Read the existing repo first. Then verify against official eToro docs: auth headers, demo endpoints for balance, portfolio, PnL, instrument search, rates and order status, plus rate limits. Build a read-only eToro demo client in /trading with no order placement yet. Add a protected test endpoint that returns my demo balance and portfolio. Report any API limitation clearly.

STAGE 2. Create the data models: instruments, stock allowlist, crypto allowlist, market snapshots, analyses, proposals, risk assessments, approvals, orders, positions, audit log. Use unique IDs, timestamps and transactions. Show me the schema before migrating.

STAGE 3. Market Monitoring layer. This is plain code, not an AI agent. Build a scheduled job that collects prices and candles from eToro for allowlisted instruments and stores timestamped snapshots. For news, fundamentals and earnings, propose 2–3 official data providers covering both stocks and crypto, with pros, cons and pricing, and do not integrate any until I choose. Agents read only from these stored snapshots.

STAGE 4. Build four Claude agents with separate system prompts and tools:
- Stock Agent: analyzes allowlisted stocks (fundamentals, earnings, technicals, valuation, risks).
- Crypto Agent: analyzes allowlisted coins (price action, volatility, technicals, sentiment, crypto-specific risks).
- Risk Agent: independently critiques each analysis (downside, concentration, volatility). It gives an opinion only; the code engine in Stage 5 makes the binding decision.
- Portfolio Manager: collects all findings, preserves and explains disagreements (never forces consensus), and creates trade proposals.
Each agent returns structured JSON: instrument, asset class, recommendation, thesis, evidence with sources and timestamps, entry and exit conditions, amount, holding period, risks, analytical confidence (clearly not a win probability), assumptions. Proposals are saved only; nothing is executed.

STAGE 5. Risk Validation: a deterministic code engine checks every policy limit, both allowlists, available demo balance, duplicates and expiry, and it cannot be overridden by any agent. Passing proposals go to my Telegram with Approve/Reject buttons, reusing the existing bot. On approval, the Execution Gateway re-checks everything (kill switch, hash, expiry, single-use, a fresh price check), sends the DEMO order with an idempotency key, then fetches and verifies the result and logs it. Write tests for every rejection path.

STAGE 6. Portfolio Monitoring: track positions, PnL, exposure against limits, and each position's exit conditions. When an exit condition is hit or a limit is approached, send a Telegram alert. If closing is suggested, create a close proposal that goes through the same Stage 5 validation and approval flow. Nothing closes automatically.

STAGE 7. Add the Trading Desk as its own tab inside the GM console, visually separate from the company departments, with a permanent "DEMO" badge. Sections: overview (balance, PnL, exposure vs limits, stocks vs crypto split), agents (status, latest analysis, disagreements), pending proposals with approve/reject, positions, history including rejections, risk alerts, and settings (limits, both allowlists, quiet hours, kill switch status). Match the console's existing design, optimized for iPad and iPhone.

STAGE 8. Run the full end-to-end flow on eToro DEMO for one stock and one crypto: monitoring → analysis → proposal → risk → Telegram approval → order → verification → monitoring alert → close proposal → approval → close. Also test a rejection, an expired approval, a duplicate click, quiet hours, and the kill switch. Then write a short README covering env vars, how to operate, and how to stop everything.
