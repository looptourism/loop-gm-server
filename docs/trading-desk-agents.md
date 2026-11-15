# Trading Desk — the four agents (Stage 4)

Four Claude agents, each with its own system prompt and its own read-only tools. They analyse
the data the Trading Desk has already stored and save **analyses** and **draft proposals**.
Nothing is executed: there is no order code anywhere, and a draft goes nowhere until Stage 5
(the code risk engine and your Telegram approval) exists.

**Status (2026-11-14): confirmed by a real run** with the Claude API on the Render server
(22:04–22:06 UTC, MSTR and BTC): all five agent steps completed with no problems — two
analyses (both "avoid"), two risk reviews (both "no objection"), one Portfolio Manager output
(both "no trade", two disagreements recorded for each), no draft proposal, demo portfolio read.
10 Claude requests, 88,272 input and 13,339 output tokens, estimated $0.62 — about $0.31 per
instrument and about one minute each. A run that ends in a draft proposal has not been seen yet.

**Second real run (2026-11-15 19:41–19:44 UTC, MSTR and BTC),** after the reviewer was given
the analyst's research tools and MSTR was allowed to read BTC's price: completed with no
problems, same outcome (both "avoid", both "no trade", no draft). 115,065 input and 17,739
output tokens, estimated $0.82 — about $0.41 per instrument, so roughly $12 for all 30.

**Owner's decision for Stage 5 (2026-11-15):** MSTR counts toward the $1,500 crypto cap
(recorded in `trading/policy.js`; enforced by the Stage 5 engine, not yet by any code).

**Server restarts (resolved 2026-11-15 — the Render service was moved to a plan that stays awake):** the server restarted about 15 minutes after that run with no deploy,
which is what a hosting plan that puts idle services to sleep looks like. If so, the 15-minute
price schedule and the research schedule do not run while it sleeps, and a long agent run can
be cut short. To be confirmed in Render (instance type).

## Who does what

| Agent | Reads (tools) | Hands in |
|---|---|---|
| Stock Analyst | price + ranges, technicals, fundamentals, earnings, SEC filings, company news | buy / hold / avoid, thesis, evidence, entry and exit conditions, amount, holding period, risks, confidence, assumptions, data gaps |
| Crypto Analyst | price + ranges, technicals, coin fundamentals, general crypto headlines | the same |
| Risk Reviewer | everything the analyst it checks could read, plus the demo portfolio and the policy — and the analysis it critiques | no objection / caution / object, concerns with severity, claims it checked, a smaller amount if it thinks so. **Opinion only** |
| Portfolio Manager | the analyses and reviews, price + ranges, the demo portfolio, the policy | one decision per instrument (propose buy / no trade), with every analyst-vs-reviewer disagreement written out, and a draft proposal for each "propose buy" |

A stock you flagged as crypto-correlated (MSTR) can also read BTC's stored price in all three
steps, because it cannot be judged without it. BTC is then a reference only, not up for a decision.

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

## Models, screening, schedule and budget (owner's decisions, 2026-11-15)

| Step | Model | List price per million tokens (input / output) |
|---|---|---|
| Screener | `claude-haiku-5-5` | $0.10 / $0.50 |
| Stock Analyst, Crypto Analyst, Risk Reviewer, Portfolio Manager | `claude-opus-5-5` | $4 / $20 |

All of this is set in `AGENTS` in `trading/config.js`.

- **Screening.** In a screened run the Screener scores every instrument from 0 to 10 on a data
  pack built by code (price, ranges, technicals, key fundamentals, next earnings date, six
  headlines). It has no tools. Code then picks the shortlist: score 6 or more, highest first,
  at most 5. Only the shortlist gets the full analysis. A screen can only cause an instrument
  to be skipped; it cannot cause a trade.
- **Schedule.** Monday, Wednesday and Friday at 12:00 UTC: all instruments, screened. Saturday at
  12:00 UTC: coins only, screened. It runs only when `TRADING_AGENTS_SCHEDULE_ENABLED` is `true`
  in Render (off by default, separate from the monitoring switch because it spends money).
- **Monthly budget: $50, enforced in code.** Every Claude request is written to a ledger
  (`trading.api_usage`, append-only). Before every agent step the calendar month's total (UTC)
  is read; if the step would take it over $50, the step is refused and the run stops there.
  Fail closed: if the ledger cannot be read no agent runs, and if a request's usage cannot be
  written that agent stops at once. A warning shows from 80%.
- **Limits of the budget.** Costs are estimates at list price from Claude's token counts, not
  the invoice, and one step can overshoot by its own cost. The spend limit you set on the
  Anthropic workspace is the backstop outside this code.
- **The desk's own key.** `TRADING_ANTHROPIC_API_KEY`, if set, is used instead of the server's
  shared `ANTHROPIC_API_KEY`; the status page says which is in use.
- **Measured cost so far** (two real runs, before screening existed, all on Opus): $0.62 and
  $0.82 for two instruments. Every run now reports tokens and cost per agent.

## How to use it (Telegram)

The desk uses the server's existing bot. Its commands are answered by the desk's own code and
never reach the GM agent.

- `/trade_run` — start a screened run now (all instruments). `/trade_run crypto` — coins only.
- `/trade_status` — what is running, the schedule, the month's budget, the last run.
- After **every** run (scheduled, from Telegram or from a URL) a summary arrives: instruments
  screened, the shortlist with scores, what was analysed, draft proposals, cost by agent, and
  budget used. It is built by plain code from the run's result.
- You are also told when the database was updated at startup, and if the desk is off because
  its database could not be prepared.

The pages remain for details: `/api/trading/agents/status`, `/api/trading/agents/latest?symbol=…`,
`/api/trading/agents/proposals`.

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
