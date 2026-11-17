# Trading Desk (eToro DEMO only)

The Trading Desk is a separate part of the GM server. Plain code watches prices and your
positions. Claude agents analyse your allowlisted stocks and coins and propose trades. Nothing
is bought or sold until you tap **Approve**. It only ever talks to eToro's **demo** account: no
real-money endpoint exists in this code. The GM agent, the department agents and the secretary
have no trading tools.

Rules: `docs/trading-desk-plan.md`. Limits: `trading/policy.js` (code, not AI).

## Env vars (Render → loop-gm-server-1 → Environment)

| Name | Needed | What it does |
| --- | --- | --- |
| `TRADING_ENABLED` | yes | **The kill switch.** Orders and approval requests only when exactly `true`. Anything else = off. |
| `ETORO_API_KEY`, `ETORO_USER_KEY` | yes | eToro Public API keys for the demo account |
| `TRADING_DATABASE_URL` | yes | Supabase Postgres. Migrations run by themselves at startup |
| `CONSOLE_PASSWORD` | yes | Console login. The Trading Desk page and its buttons are closed without it |
| `TRADING_MONITOR_ENABLED` | yes | `true` = prices every minute and positions every 15 minutes |
| `TRADING_ANTHROPIC_API_KEY` | yes | The desk's own Claude key (falls back to `ANTHROPIC_API_KEY`). Spend is capped at $75/month in code |
| `TRADING_AGENTS_SCHEDULE_ENABLED` | optional | `true` = agents run weekdays 12:00 and 18:00 UTC (all) and Saturday 12:00 UTC (coins) |
| `FINNHUB_API_KEY`, `COINGECKO_API_KEY`, `SEC_USER_AGENT` | optional | News, fundamentals and earnings for the agents |

Telegram uses the server's existing bot. Nothing extra is needed.

## Operating it

**Telegram** (all messages say DEMO):

| Command | Does |
| --- | --- |
| `/trade_status` | Trading on/off, budget, last run, position checks, requests waiting |
| `/trade_run` | Screened run: Haiku scores everything, the best 5 get the full analysis. `/trade_run crypto` = coins only |
| `/trade_run NKE BTC` | Full analysis of exactly these (up to 4), no screen |
| `/trade_test BTC 50` | Your own small test buy (at most $50). Goes through the same checks and approval |
| `/trade_close BTC` | Proposes closing the desk's position in BTC. Needs your Approve |
| `/trade_quiet 23:00-07:00` | No approval requests in this window (Dubai time, or add a zone like `UTC`). `/trade_quiet off` removes it |
| `/trade_stop`, `/trade_resume` | Stop / allow trading at once (see below) |
| `/trade_report` | This week's report and the agents' track record (also sent every Saturday 08:00 Dubai) |
| `/trade_e2e` | The end-to-end checklist (`docs/trading-desk-e2e.md`) |
| `/trade_drill_exit BTC` | Drill: makes the monitor's exit alert and close proposal fire on an open position |

**What a trade looks like:** agent proposal → risk engine (24 code checks) → Telegram request
with Approve / Reject (15 minutes, single use) → on Approve, everything is checked again with a
fresh price → one DEMO order → eToro's answer is looked up and recorded → the position is
watched every 15 minutes. Closing works the same way and also needs your Approve.

**Console:** the **التداول** tab shows the balance, limits, waiting requests (with Approve /
Reject), positions, agents, history, alerts and settings.

## Stopping everything

| How fast | What | Effect |
| --- | --- | --- |
| Seconds | `/trade_stop` in Telegram | No approval request and no order, including ones already approved. Undo: `/trade_resume` |
| A few minutes | Render: `TRADING_ENABLED` → `false`, save (Render restarts the server) | The same, and `/trade_resume` cannot undo it |
| Also stop the analyses | Render: `TRADING_AGENTS_SCHEDULE_ENABLED` → `false` | No scheduled Claude runs (and no Claude spend) |
| Also stop watching | Render: `TRADING_MONITOR_ENABLED` → `false` | No price collection and no position alerts |

Open positions stay open on the demo account until you close them, with `/trade_close` or in
the eToro app.

## Details

`docs/trading-desk-execution.md` (orders), `docs/trading-desk-monitoring.md` (alerts),
`docs/trading-desk-agents.md`, `docs/trading-desk-console.md`, `docs/trading-desk-etoro-api.md`,
`docs/trading-desk-database.md`.
