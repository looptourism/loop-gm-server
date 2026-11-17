# Trading Desk — risk engine, approvals and execution (Stage 5)

From a draft proposal to a demo order. Every step here is plain code; no agent takes part.

**Status (2026-11-16):** built and tested with stand-ins for eToro and Telegram and a local
Postgres 16 (138 tests pass, including one for every way a trade can be refused).
**Confirmed by a real demo order on 2026-11-16**: `/trade_test BTC 50` → risk engine → your
Approve on Telegram → one order → filled at 65,069.63 → verified by lookup → position recorded
and watched. One field was misread on that first fill (the position was recorded as $1.00
invested); the position check corrected it from eToro's account figures, and the gateway reads
the right field since 2026-11-17. A real proposal from the agents has not reached you yet.

## The path of one trade

1. **Draft.** The Portfolio Manager saves a proposal (Stage 4).
2. **Waiting for a fresh price.** A draft is not judged while its price is old. A stock is
   offered to you only when its market is open, so an approval can actually be acted on.
3. **Risk engine, first pass** (`trading/risk/engine.js`). Fails → the proposal is stopped and
   you are told why. Passes → step 4.
4. **Approval request** on Telegram with ✅ Approve and ❌ Reject. It is valid for 15 minutes,
   bound to the hash of the proposal's exact parameters, decided once and used once.
5. **Your tap.** Reject, a late tap, a second tap → nothing is sent.
6. **Execution gateway** (`trading/execution/gateway.js`), immediately after Approve:
   - the proposal is "approved", the approval is approved, unused and not expired;
   - the parameter hash is recomputed and must equal the one on the proposal and on the approval;
   - the kill switch is on and trading has not been stopped;
   - the risk engine runs **again**, with the account and the price read live from eToro;
   - the approval is marked used and the order row is written in one transaction;
   - only then is **one** DEMO order sent, with the proposal's idempotency key as request ID.
7. **Verification.** The result is fetched from eToro (order lookup), never assumed. Filled → the
   position is recorded with the exit conditions you approved plus the planned holding period,
   and the 15-minute position check starts watching it.
8. **You are told the outcome** on Telegram at each point. Everything is in the audit log.

## What the risk engine checks

| Group | Checks |
|---|---|
| Switch | `TRADING_ENABLED` is exactly `true`, and trading was not stopped with `/trade_stop` |
| Shape of the trade | demo only · opens a position · stock or crypto · on the right allowlist, active and verified · buy only · leverage 1 · market order |
| Limits | $500 per stock trade, $250 per coin · cash available · total exposure $5,000 · crypto exposure $1,500 (MSTR counts as crypto) · 10 open positions · daily loss $100 |
| Duplicates | no position already open in the instrument · no other proposal for it awaiting approval or execution · the proposal has not expired |
| Price | realtime and fresh by eToro's own timestamp. Before execution: live, no older than 3 minutes, and no more than 3% away from the price in your approval request |
| Swing-trade plan (1 to 14 days) | holding days stated, 1 to 14 · a stop level, below the current bid · the loss if the stop is reached is no more than the $100 daily loss limit · any target is above the current price · any exit date is not past and within 14 days |

Limits count trades in flight: a proposal you have approved but that has not become a position
yet uses up cash, exposure and a position slot. Any fact the engine cannot get — the account,
the price, today's starting balance — fails the checks that need it. One failed check stops the
trade. Earnings due inside the holding period is shown to you as a warning, not a rejection.

**Daily loss** is measured from the first account snapshot of the day (UTC), taken by the
15-minute position check, to the account's value now (eToro's equity formula). No snapshot
today → the check fails.

## If eToro's answer is lost

An order is sent once. A timeout, a dropped connection, a 401, a 429 or a 5xx means the result
is **unknown** — eToro may have the order. It is never sent again. Every minute the desk looks
it up on eToro by its request ID until it is filled, rejected, or — after 10 minutes with no
record at eToro — marked not placed. A server restart changes nothing: the order row was
written before sending.

Only a 400 or 404 from eToro is treated as a definite "not placed".

## The switches

- `TRADING_ENABLED` in Render, exactly `true`. Default off. While off: no approval request is
  sent, nothing can be approved, no order can be placed. Agents, monitoring and alerts still run.
- `/trade_stop` in Telegram: stops trading at once, including orders you already approved. It
  survives restarts. `/trade_resume` lifts it. It can only make the desk stricter.
- Open positions are never closed by the desk, whatever the switches say.

## Settings I chose that you did not specify (all in `trading/policy.js`)

| Setting | Value | Why |
|---|---|---|
| One position per instrument | on | adding to a position doubles the exposure the first approval covered |
| Loss if the stop is reached | at most $100 | one trade should not plan to use more than the whole daily loss limit |
| Price movement since the request | at most 3% | you approved a trade at a price; beyond this it is a different trade |
| Live price age at execution | at most 180 s | eToro's "realtime" rates were seen 40–70 s old |
| Quiet hours | none | no window was given; set `quietHours` to add one |

## Closing a position (Stage 6)

Nothing closes automatically. A close is a proposal, and it needs your Approve like a buy.

**Where a close proposal comes from**
- **The position monitor**, when an exit condition you approved is reached (the stop, a target,
  the planned holding date) or the position has been held longer than 14 days. One proposal per
  condition: if you reject it, that condition does not propose again. The alert says a close
  was proposed.
- **You**, with `/trade_close BTC` in Telegram.

**What the risk engine checks for a close**

| Check | Why |
|---|---|
| Kill switch on, trading not stopped | Hard rule: no order of any kind while the switch is off |
| Demo only · not expired · a long, unleveraged market close | Same as a buy |
| The position is open in the desk's records, for this instrument | It closes exactly the position you approved |
| The account can be read, and eToro still lists the position as a long, unleveraged position in this instrument | A position already closed is not "closed again" |
| No other close order for it is at eToro | No double close |
| A fresh price (realtime, eToro's own timestamp) | A stock is closed while its market is open |

The opening limits (cash, exposure, open positions, daily loss, the swing plan) do **not**
apply to a close, because closing reduces risk: a limit must never keep a position open. For
the same reason, how far the price moved since your approval request does not stop a close —
refusing would leave you holding a position in a falling market.

**First real close (2026-11-17, `/trade_close BTC`):** close order sent, verified by eToro's
close-order lookup, position closed at 64,500.41 with proceeds of $49.06 on $49.97 invested.
The first message reported "about -$0.44" from the prices alone; the result is now eToro's
proceeds minus the amount invested (-$0.91 there), which includes eToro's closing costs.

**What is sent:** `POST /api/v1/trading/execution/demo/market-close-orders/positions/{positionId}`
with `{ InstrumentID, UnitsToDeduct: null }` — the whole position. Partial closes are not used.
The result is fetched with eToro's close-order lookup; the position is then marked closed with
its closing price and an estimated result (from the open and close prices; fees not included).

**If eToro's answer to a close is lost:** eToro offers no lookup of a close by our request ID,
so the account itself is the evidence. If eToro no longer lists the position, it is closed (the
closing price is then not known). If it still lists it 10 minutes later, the close is marked
not placed. A close is never sent twice by the desk.

**Kill switch and closing:** with `TRADING_ENABLED` off or `/trade_stop` active, a close cannot
be sent either — that is hard rule 4 taken literally. A close proposed meanwhile waits and is
offered when trading is back on (it expires after 24 hours). You can always close on eToro yourself.

## Limit warnings (Stage 6)

At each 15-minute position check the desk compares the account with your limits: total exposure
($5,000), crypto exposure ($1,500, MSTR counts), open positions (10) and today's loss ($100).
At 80% you get a "Limit approached" message; at 100% a "Limit reached" message. Each fires once
per limit, level and UTC day. `/trade_status` shows all four at any time.

## A test trade you start yourself: `/trade_test`

`/trade_test BTC 50` creates one small draft proposal by hand, so the path from proposal to
position can be proven without waiting for the agents to propose something. It is at most $50,
needs a fresh price, and only works while trading is on. No agent analyses it, so its plan is
set by fixed rules in `trading/policy.js`: a stop 5% below the bid and a 3-day holding period.
From there it is treated exactly like any other proposal: the risk engine, your Approve /
Reject request, the live re-check, one demo order, verification, and the position watch.

## What you need to do

1. **A demo key that can trade.** eToro keys are created with Read or Write permission. The
   current key was created for reading. In eToro → Settings → Trading → API Key Management,
   create a **Demo** key with **Write** permission and put it in Render as `ETORO_API_KEY` /
   `ETORO_USER_KEY` (same names). A read-only key will make every order fail.
2. **`TRADING_ENABLED` = `true`** in Render, when you are ready.

## Limitations

1. No real demo order yet (see Status). eToro's real order and lookup answers may differ from
   the documentation, as its market-data answers did in Stage 1.
2. Closing is a separate eToro endpoint (Stage 6); it has not yet been used with a real position.
3. The stop level is watched by the desk every 15 minutes and you are alerted; it is **not** a
   stop order at eToro. eToro can hold a stop-loss on the order itself, which would close the
   position automatically; that is not used, because your rule is that nothing closes
   automatically.
4. Minimum trade sizes per instrument are not documented by eToro; an order below one will be
   rejected by eToro and reported.
5. Approval works from Telegram only; the console tab is Stage 7.
6. Details: `/api/trading/orders/status` (add `?all=yes` for every check of each verdict).
