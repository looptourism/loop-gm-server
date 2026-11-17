# Trading Desk in the GM console (Stage 7)

The console has a tab of its own for the Trading Desk: **التداول** in the phone tab bar and
**مكتب التداول** (with a DEMO mark) in the iPad sidebar, set apart from the company's
departments. The tab shows the page `/trading-desk` in a frame, the same way the Office tab
shows `/office`. The console's own code contains no trading code; the page belongs to
`trading/desk/`.

## What the page shows

A **DEMO** band stays at the top of the page at all times, with "trading on / off". The page
uses the console's design and its own teal accent so it is never mistaken for a department.

| Section | Contents |
| --- | --- |
| نظرة عامة | Cash available, invested, unrealised PnL, PnL today (from the first account snapshot of the UTC day), stocks vs crypto split of the desk's open positions, exposure vs every limit (from the position monitor's last check) |
| بانتظار قرارك | Each request waiting for approval: amount, price with its time, exit conditions, holding period, risk-check count, warnings, disagreements, time left — with Approve / Reject |
| المراكز | The desk's open positions, the latest stored bid with its time, an estimated PnL, and any close request in progress |
| الوكلاء | Agent status, monthly Claude budget, recent runs, latest analyses, the portfolio manager's decisions and disagreements |
| السجل | The last 40 proposals, including risk-engine rejections, with order and close results |
| التنبيهات | Position alerts, limit warnings and risk rejections (last 30) |
| الإعدادات | The kill switch (`TRADING_ENABLED`) and `/trade_stop` state, limits, holding period, quiet hours, schedules, both allowlists |

Every figure comes from the database, with the time it was stored. Showing the page makes no
call to eToro or to Claude. It refreshes every 30 seconds (not while a confirmation is open).

## Approve / Reject from the page

The buttons work only on a request that is already waiting for approval (one that Telegram was
also sent). A tap asks for confirmation, then posts to `/api/trading/desk/decide`, which calls
the same decision code as the Telegram buttons:

- the same approval record, hash check, 15-minute expiry and single use;
- on Approve, the same execution gateway: live risk re-check, kill switch, one send, reconcile;
- the decision is stored with channel `dashboard`, actor `console`;
- the Telegram request is edited so its buttons disappear ("decided in the console"). A tap on
  the other channel afterwards answers "already decided" and does nothing.

The page cannot create, change or resize a trade.

## Protection

- The page and its API sit behind the console login (the server's global login check). The page
  is refused (503) when `CONSOLE_PASSWORD` is not set.
- The decision endpoint needs the header `X-Trading-Desk: 1` (browsers cannot send it from
  another site, as the server's CORS rules do not allow it) and, when the browser sends
  `Origin`, it must be this server. Anything else gets 403.
- The page may be framed only by the console itself (`frame-ancestors 'self'`) and is never cached.
- All text from the database is escaped before it is shown.

## Limitations

1. PnL on positions is an estimate from the last stored bid (every 15 minutes), not eToro's
   own figure; the overview's unrealised PnL is eToro's, from the last account snapshot.
2. Settings are shown, not edited. Limits are code (`trading/policy.js`); the kill switch is
   `TRADING_ENABLED` on Render plus `/trade_stop` / `/trade_resume` in Telegram.
