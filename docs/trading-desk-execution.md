# Trading Desk — risk engine, approvals and execution (Stage 5)

From a draft proposal to a demo order. Every step here is plain code; no agent takes part.

**Status (2026-11-16):** built and tested with stand-ins for eToro and Telegram and a local
Postgres 16 (138 tests pass, including one for every way a trade can be refused).
**No real demo order has been placed yet**, so by the project's rules this does not count as
working. The order request and the order lookup were checked against eToro's official
reference on 2026-11-16, but eToro's real answers to them have not been seen.

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

## What you need to do

1. **A demo key that can trade.** eToro keys are created with Read or Write permission. The
   current key was created for reading. In eToro → Settings → Trading → API Key Management,
   create a **Demo** key with **Write** permission and put it in Render as `ETORO_API_KEY` /
   `ETORO_USER_KEY` (same names). A read-only key will make every order fail.
2. **`TRADING_ENABLED` = `true`** in Render, when you are ready.

## Limitations

1. No real demo order yet (see Status). eToro's real order and lookup answers may differ from
   the documentation, as its market-data answers did in Stage 1.
2. Only opening is built. Closing through the desk comes with Stage 6; eToro's order endpoint
   itself currently supports only orders that open a position.
3. The stop level is watched by the desk every 15 minutes and you are alerted; it is **not** a
   stop order at eToro. eToro can hold a stop-loss on the order itself, which would close the
   position automatically; that is not used, because your rule is that nothing closes
   automatically.
4. Minimum trade sizes per instrument are not documented by eToro; an order below one will be
   rejected by eToro and reported.
5. Approval works from Telegram only; the console tab is Stage 7.
6. Details: `/api/trading/orders/status` (add `?all=yes` for every check of each verdict).
