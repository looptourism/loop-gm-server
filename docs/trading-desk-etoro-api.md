# eToro Public API — what was verified (Trading Desk, Stage 1)

Read from the official portal (https://api-portal.etoro.com/llms.txt and the pages it
lists, plus builders.etoro.com) on 2026-11-12. OpenAPI version shown by the portal: v1.415.0.
Re-check the changelog (https://api-portal.etoro.com/core/changelog.md) before each stage —
eToro withdrew and restored endpoints several times during 2026.

**Status: verified against the documentation only. No real call has succeeded yet** —
that happens from the Render server (see "How to test" below).

## Base URL and headers

- Base URL: `https://public-api.etoro.com`
- Every request: `x-api-key` (Public API Key), `x-user-key` (User Key), `x-request-id` (a new UUID per request).
- Keys come from eToro → Settings → Trading → API Key Management. A key is created for
  ONE environment (Demo or Real) with Read or Write permission.

## Endpoints used by the read-only client (`trading/etoro-client.js`)

| Need | Method and path | Quota |
|---|---|---|
| Balance + PnL + positions | `GET /api/v1/trading/info/demo/pnl` | 60/min, shared with the next row |
| Portfolio (positions, pending orders) | `GET /api/v1/trading/info/demo/portfolio` | 60/min, shared |
| Order status | `GET /api/v2/trading/info/demo/orders:lookup?orderId=` or `?referenceId=` | 60/min, shared |
| Symbol → instrument ID | `GET /api/v1/market-data/search?internalSymbolFull=AAPL&fields=…` | 120/min, shared by all market data |
| Instrument metadata by ID | `GET /api/v2/market-data/instruments?instrumentsIds=` | 120/min, shared |
| Bid/ask rates (max 1000 IDs) | `GET /api/v2/market-data/rates?instrumentIds=` | 120/min, shared |
| Candles (max 1000) | `GET /api/v1/market-data/instruments/{id}/history/candles/{asc\|desc}/{interval}/{count}` | 120/min, shared |

Intervals: OneMinute, FiveMinutes, TenMinutes, FifteenMinutes, ThirtyMinutes, OneHour, FourHours, OneDay, OneWeek.

Balance: there is no "demo balance" endpoint. eToro's guide derives it from the PnL response:
`available cash = credit − (Σ ordersForOpen.amount where mirrorID = 0 + Σ orders.amount)`.

Rate limits are per user key over a rolling 60 seconds. Over the limit → HTTP 429 with
`Retry-After`. Responses carry `RateLimit-Limit / -Remaining / -Reset`.

## Order endpoints (NOT implemented — for Stage 5)

- **v1 is withdrawn.** Changelog, 18 Aug 2026: the v1 endpoints for placing and cancelling
  orders were removed on real and demo. They now sit under "deprecated" in the portal.
- **v2 is the current synchronous path:** `POST /api/v2/trading/execution/demo/orders`
  (body: `action`, `transaction`, `instrumentId`, `orderType`, `leverage`, and exactly one of
  `amount` / `units` / `contracts`). Quota 20/min.
- **v3 also exists** (added 23 Aug 2026): `POST /api/v3/trading/execution/demo/orders`,
  asynchronous — submit, then poll the order lookup.
- **Danger:** eToro's own guide "Open and close market orders" shows
  `POST /api/v2/trading/execution/orders` — with no `/demo/`, that is the REAL account path.
  Never copy paths from that guide; the demo path always contains `/demo/`.

## Limitations and doc inconsistencies found

1. Market-data paths have no `/demo/` variant — prices are the same for every account.
   They are read-only; the client allows only an explicit list of them.
2. `GET /api/v1/balances` and `GET /api/v1/me` are account-wide (they include live-account
   data), so the Trading Desk does not use them.
3. The "available cash" guide's JavaScript reads `data.credits` at the top level, but the
   OpenAPI schema puts `credit` inside `clientPortfolio`. The code follows the schema and
   fails closed if the field is missing; the first real call settles it.
4. The search reference marks `fields` as required while the guide's example omits it.
   The client always sends it.
5. `GET /api/v1/trading/info/demo/orders/{orderId}`: restored on 27 Jul 2026, listed as
   withdrawn on 18 Aug 2026, and shown under "deprecated". The client uses the v2 lookup.
6. Rates can be `delayed` rather than `realtime` (`quoteType`), and `/rates` answers 206
   when only some instruments were found. Stage 5's fresh-price check must treat both as "not fresh".
7. Not documented: how long a market order stays pending when the stock market is closed,
   and minimum trade sizes per instrument. To be measured on demo in Stage 5/8.
8. The portal blocks plain HTTP clients (Cloudflare); it was read with a browser.

## How to test (from a phone)

Log in to the console first, then open in the same browser:

- `/api/trading/test/demo-account` — balance, PnL, positions (`?raw=1` adds eToro's raw response)
- `/api/trading/test/market-data?symbol=AAPL` — search + rate + 5 daily candles
- `/api/trading/test/order-status?orderId=…` — needs an existing demo order
