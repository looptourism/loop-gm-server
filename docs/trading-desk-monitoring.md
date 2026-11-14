# Trading Desk — Market Monitoring (Stage 3)

Plain code, no AI. A scheduled job asks eToro for prices and candles of every instrument that
is on an allowlist, active and verified, and stores them as timestamped snapshots in the
Trading Desk database. Agents (Stage 4) will read **only** these stored snapshots.
The job can only read market data; the client it uses has no order call.

**Status (2026-11-13): confirmed by a real run** on the Render server against the eToro demo
API and Supabase (manual run at 12:29 UTC): 30 instruments, 61 requests, all three collections
`ok` with no problems — 30 rates, 11,681 daily candles, 7,182 hourly candles; each batch of 30
candle requests took 60 seconds (the 30-per-minute ceiling). The schedule itself
(`TRADING_MONITOR_ENABLED`) had not been switched on at that point. One allowlisted symbol is
not verified on eToro and is therefore not monitored (30 of 31).

## What is collected

| What | How often | Requests to eToro |
|---|---|---|
| Bid/ask rates, all instruments | every 15 minutes (minutes 05, 20, 35, 50 UTC) | 1 (all instruments in one call) |
| Hourly candles | once per hour | 1 per instrument |
| Daily candles | once per 6 hours | 1 per instrument |

First run: 400 daily and 240 hourly candles per instrument. Afterwards only the candles since
the newest stored one, plus the last 3 again to catch corrections.

## Request budget

eToro's quota: 120 market-data requests per rolling 60 seconds, shared by everything using
your key. (The reference pages and the real headers say 120; eToro's "Rate Limits" guide says
60. The job is safe under both.)

- The job's own ceiling is **30 requests per minute**, with at least 2 seconds between requests.
- The heaviest possible run (31 instruments, both candle intervals due) is 63 requests, spread
  over a little more than 2 minutes. A normal 15-minute run is 1 request.
- If eToro reports fewer than 40 requests left in its window, the job waits for the next window.
- After a 429 the run stops at once, the rest is marked "not attempted", and nothing is sent
  for at least 5 minutes. There are no automatic retries.

## The Stage 1 findings, as applied

| Finding | What the code does |
|---|---|
| Timestamps have no timezone | Every eToro timestamp is parsed as UTC explicitly (`parseUtc`) |
| "realtime" does not mean fresh | Freshness = eToro's own timestamp for the quote compared with the clock; older than 20 minutes or not `realtime` → `fresh: false`, with the reason. Never judged from when we asked |
| Today's candle is unfinished | A candle is stored only when its whole period is over (start + interval ≤ time of the call). Applies to hourly candles too |
| Volume is unreliable | Never read. The `volume` column stays empty and agents get no volume figure |
| `rangeOpen` / `rangeClose` are reversed | Ignored. Open, close, high, low and change are computed from the stored candles |
| 206 = partial answer | The missing instruments are listed as problems; the run is marked `partial` |

Also: a rate without bid, ask or timestamp, or a candle whose figures do not add up, is rejected
and reported — never repaired. If eToro later changes a finished candle, the stored row is
corrected and the old and new figures are written to the permanent audit log.

## Turning it on (phone)

Requires Stage 2 to be done first (database connected, `001_initial` migrated, allowlist synced —
see `docs/trading-desk-database.md`). Log in to the console, then open in the same browser:

1. `/api/trading/admin/db-status` — expect `"pending": ["002_monitoring"]`.
2. `/api/trading/admin/migrate?confirm=002_monitoring` — adds the run log and the no-duplicates rules.
3. `/api/trading/monitor/run?confirm=yes` — one collection, now. It answers immediately and
   works in the background for about 3 minutes.
4. `/api/trading/monitor/status` — expect three recent runs with `"status": "ok"` and, under
   `stored`, a rate and candle counts for every instrument. **Send me this output**: it is the
   first real result, and it shows whether any instrument has problems.
5. `/api/trading/monitor/view?symbol=BTC` (and `?symbol=MSTR`) — exactly what an agent will be given.
6. Only when step 4 looks right: Render → **loop-gm-server-1** → **Environment** → add
   `TRADING_MONITOR_ENABLED` = `true` → **Save, rebuild, and deploy**. The schedule then runs by itself.

**To stop the schedule:** set `TRADING_MONITOR_ENABLED` to `false` (or delete it) and deploy.
It is separate from `TRADING_ENABLED` (the order kill switch), which stays `false`.

## Limitations

1. The 15-minute schedule has not been observed running yet (only the manual run).
2. Stock rates outside market hours simply stop changing; they are stored once and shown as
   not fresh. The job does not know market hours — that is the Stage 5 calendar.
3. Daily candles are assumed to start at 00:00 UTC (as seen in Stage 1). If eToro still adjusts
   a day's candle after midnight UTC, the correction is picked up by a later run.
4. If the server is asleep or restarting at a scheduled minute, that run is skipped; the next
   one catches up on candles. Rates for the missed minutes are not recoverable.
5. Storage grows by roughly 1,700 rate rows a day (about 300 MB a year at this rate). Nothing is
   deleted automatically. Supabase's free plan size should be checked before the first year ends.
6. No Telegram alert yet when runs keep failing — visible only on the status page (alerts are Stage 6).
