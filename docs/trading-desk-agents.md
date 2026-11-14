# Trading Desk — the four agents (Stage 4)

Four Claude agents, each with its own system prompt and its own read-only tools. They analyse
the data the Trading Desk has already stored and save **analyses** and **draft proposals**.
Nothing is executed: there is no order code anywhere, and a draft goes nowhere until Stage 5
(the code risk engine and your Telegram approval) exists.

**Status (2026-11-14):** built and tested with a scripted stand-in for Claude and a local
Postgres 16 (83 tests pass). **Not yet run with the real Claude API** — see "First real run".

## Who does what

| Agent | Reads (tools) | Hands in |
|---|---|---|
| Stock Analyst | price + ranges, technicals, fundamentals, earnings, SEC filings, company news | buy / hold / avoid, thesis, evidence, entry and exit conditions, amount, holding period, risks, confidence, assumptions, data gaps |
| Crypto Analyst | price + ranges, technicals, coin fundamentals, general crypto headlines | the same |
| Risk Reviewer | price + ranges, technicals, the demo portfolio, the policy — plus the analysis it critiques | no objection / caution / object, concerns with severity, claims it checked, a smaller amount if it thinks so. **Opinion only** |
| Portfolio Manager | the analyses and reviews, price + ranges, the demo portfolio, the policy | one decision per instrument (propose buy / no trade), with every analyst-vs-reviewer disagreement written out, and a draft proposal for each "propose buy" |

Order of a run: analyst → risk reviewer → portfolio manager. An instrument reaches the
Portfolio Manager only if both its analysis and its risk review were produced and accepted.

## What the code enforces (not the AI)

- **No invented data.** Every piece of data a tool returns has a tag (R1, N3, …) recorded with
  its real source, timestamp and database row. An agent must cite tags as evidence; a tag no
  tool issued is refused, and the source and timestamp shown with each citation come from the
  desk's records, not from what the agent wrote. A submission still invalid after two
  corrections is dropped and logged (`analysis.rejected`).
- **Technicals are computed by code** (moving averages, RSI, volatility, drawdown) from stored
  candles. A figure that needs more history than is stored is null. Volume is never used.
- **Read-only tools.** Every tool starts with `get_`; none can write, call the network or trade.
  A tool can only read the symbols of its own run, and only allowlisted, verified instruments.
- **Drafts only.** A proposal is saved with status `draft`, buy, leverage 1, market order, an
  expiry 24 hours ahead, and a hash of its exact parameters (for Stage 5's approval binding).
  A newer draft for the same instrument cancels the older one — nothing piles up.
- **Limits are not enforced here.** `trading/policy.js` holds your limits; the agents can read
  them, and Stage 5's code engine will enforce them. A draft above a limit will be rejected there.
- **Fail closed.** A refusal, a cut-off answer, an API error, or an agent that never hands in a
  valid result ends that step with nothing saved. No default is ever substituted.
- **Isolation.** The agents have their own Claude client and tools inside `/trading`. A test
  checks that `server.js` touches the Trading Desk in exactly one place (mounting the routes).
- **No schedule.** A run starts only when you start it, because every run costs money.

## Model and cost

- Model: `claude-opus-5-5` (set in `AGENTS` in `trading/config.js`, with its list price of $4
  per million input tokens and $20 per million output tokens). The rest of the server uses
  `claude-sonnet-4-6`; the two are independent.
- It uses the `ANTHROPIC_API_KEY` already set in Render. No new env var.
- **Cost is not known yet.** My rough expectation is $0.30–$1 per instrument (three agents read
  each one), so a full run of all 30 could be $10–$30. Every run reports its real token use and
  an estimated cost — check it after the first small run before starting a large one.

## First real run (phone)

1. Merge the branch on GitHub and wait for Render to deploy.
2. Log in to the console, then open `/api/trading/agents/status` — expect `"ready": true`.
3. Open `/api/trading/agents/run?symbols=MSTR,BTC&confirm=yes` — one stock and one coin.
4. Wait about 5–10 minutes, reloading `/api/trading/agents/status`. When `running` is `null`,
   `lastResult` shows what happened, the problems, the token use and the estimated cost.
   **Send me that output.**
5. `/api/trading/agents/latest?symbol=MSTR` — the analysis, the risk review and the decision, with sources.
6. `/api/trading/agents/proposals` — the draft proposals.

To run everything later: `/api/trading/agents/run?all=yes&confirm=yes` (expect over an hour).

## Limitations

1. Not yet run with the real Claude API. The server's Claude library is old (0.32.1), so the
   agents use only its basic features; if the API rejects something, the status page will say what.
2. Evidence checking proves that a cited source exists — not that the agent read it correctly
   or quoted the number right. The Risk Reviewer re-reads the data as a second look; Stage 5's
   engine re-checks the price itself.
3. News text is written by third parties and could try to steer an agent. The agents are told to
   treat it as data, and nothing they produce is executed, but a misleading article can still
   colour an analysis.
4. The portfolio is read from eToro once at the start of a run. If that fails, the agents are
   told it is unknown and the run continues.
5. Closing positions is not covered: the Portfolio Manager only proposes buying. Close proposals
   come with Stage 6.
6. Analyses are in English.
7. If Claude declines a request, that step fails; there is no automatic retry on another model.
