# eToro Public API — what was verified (Trading Desk, Stage 1)

Read from the official portal (https://api-portal.etoro.com/llms.txt and the pages it
lists, plus builders.etoro.com) on 2026-11-12. OpenAPI version shown by the portal: v1.415.0.
Re-check the changelog (https://api-portal.etoro.com/core/changelog.md) before each stage —
eToro withdrew and restored endpoints several times during 2026.

**Status (2026-11-13): confirmed by real calls from the Render server** — authentication,
`GET /api/v1/trading/info/demo/pnl` (credit $100,000, no positions), instrument search,
`/api/v2/market-data/rates` and candles, for AAPL (instrumentId 1001) and BTC (instrumentId
100000), plus the `RateLimit-*` headers (60/min account, 120/min market data).

Confirmed by real calls on 2026-11-13 07:32–07:34 UTC (Stage 2): `/demo/portfolio`,
`/api/v2/market-data/instruments` and a search for each of the 31 allowlisted symbols.

Still verified against the documentation only: the order lookup (needs a demo order — Stage 5).

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
   OpenAPI schema puts `credit` inside `clientPortfolio`. The real call on 2026-11-13
   confirmed the schema is right and the guide's sample code is wrong.
4. The search reference marks `fields` as required while the guide's example omits it.
   The client always sends it.
5. `GET /api/v1/trading/info/demo/orders/{orderId}`: restored on 27 Jul 2026, listed as
   withdrawn on 18 Aug 2026, and shown under "deprecated". The client uses the v2 lookup.
6. Rates can be `delayed` rather than `realtime` (`quoteType`), and `/rates` answers 206
   when only some instruments were found. Stage 5's fresh-price check must treat both as "not fresh".
7. Not documented: how long a market order stays pending when the stock market is closed,
   and minimum trade sizes per instrument. To be measured on demo in Stage 5/8.
8. The portal blocks plain HTTP clients (Cloudflare); it was read with a browser.

## Observed in the real responses (2026-11-13)

1. Search returned only `displayname`, `internalSymbolFull`, `instrumentId`,
   `internalExchangeName`, `internalAssetClassName`. The requested `isOpen`, `instrumentType`,
   `instrumentTypeID` and `exchangeID` were NOT returned, so search cannot tell whether a
   market is open. Asset class comes from `internalAssetClassName` ("Stocks" / "Crypto").
2. A rate's `date` has no timezone suffix (`2026-11-13T05:41:23.053`). The docs say UTC —
   parse it as UTC explicitly, never as local time.
3. `quoteType: "realtime"` does not mean fresh: the rates were 40–70 s older than the call,
   and AAPL was quoted at 05:41 UTC with the US market closed. A fresh-price check must
   compare the rate's own `date` with the clock.
4. Daily candles include today's unfinished candle (first item with `desc`).
5. Candle `volume` is unreliable: null for every BTC candle and for today's AAPL candle,
   and identical on adjacent AAPL days. Do not base analysis on it.
6. With `desc`, `rangeOpen` / `rangeClose` are the newest candle's open and the oldest
   candle's close — reversed in time. Compute ranges from the candles themselves.

## Observed in the Stage 2 calls (2026-11-13)

1. `/api/v2/market-data/instruments?instrumentsIds=1001,100000` answers
   `{ results: [{ instrumentId, displayName, type, symbol, exchangeId, image }], pagination }`.
   `type` is "Stocks" / "Crypto". The exchange comes as a number (`exchangeId`: 4 for AAPL,
   8 for BTC), not a name — the name is only in the search (`internalExchangeName`).
   There are NO trading-hours or market-open fields, so this endpoint cannot help with
   market-open detection.
2. `/demo/portfolio` answers `{ clientPortfolio: { positions, mirrors, credit, orders,
   stockOrders, entryOrders, exitOrders, ordersForOpen, ordersForClose,
   ordersForCloseMultiple, bonusCredit } }` — credit 100000, every list empty.
   `stockOrders`, `entryOrders`, `exitOrders` and `ordersForClose*` are not part of eToro's
   published available-cash formula. Whether any of them reserves cash is unknown; Stage 5
   must measure it with a real demo order before trusting the balance while orders are pending.
3. Allowlist search: 30 of 31 symbols returned exactly one exact match of the right asset
   class. **OPTT returned no exact match** and stays untradable. Exchange names seen so far
   for the stocks: "Nasdaq" and "NYSE".

## How to test (from a phone)

Log in to the console first, then open in the same browser:

- `/api/trading/test/demo-account` — balance, PnL, positions (`?raw=1` adds eToro's raw response)
- `/api/trading/test/market-data?symbol=AAPL` — search + rate + 5 daily candles
- `/api/trading/test/order-status?orderId=…` — needs an existing demo order
- `/api/trading/test/demo-portfolio` — eToro's raw answer from `/demo/portfolio`
- `/api/trading/test/instrument?ids=1001,100000` — raw answer from `/api/v2/market-data/instruments`
- `/api/trading/test/verify-allowlist` — searches every allowlisted symbol; saves nothing

Database routes and setup: see `docs/trading-desk-database.md`.
