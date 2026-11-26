# Stage 8: the end-to-end run on eToro DEMO

The run is done from your phone: the approvals are your taps, and the cloud session that
builds the desk cannot reach eToro. `/trade_e2e` keeps score. It ticks a step only when the
desk has written that step's record: a stored price, an analysis, a proposal, a risk verdict,
your tap, eToro's order and its lookup, the alert, the close. Nothing can be ticked by hand.

Start: send `/trade_e2e`. The run counts from that moment; `/trade_e2e restart` starts it again.

## Part 1: one stock and one coin, from analysis to close

Trading must be on (`/trade_status`). Stocks need US market hours (about 17:30–24:00 Dubai time).

1. `/trade_run NKE BTC` (or any allowlisted stock and coin). Costs about $1–2 of the Claude budget.
   The summary comes in about 10 minutes.
   - If the agents decide not to buy, the step "Proposal" stays empty. Try `/trade_run` with
     another stock or coin. The test trade (`/trade_test`) does not count here, because no agent analysed it.
2. A request with Approve / Reject arrives for each proposal. **Tap Approve in Telegram.**
   This step needs Telegram; the console's button works the same way but is not this step.
3. A message confirms the order is filled, with eToro's order ID.
4. `/trade_drill_exit NKE` and `/trade_drill_exit BTC`. Each adds a "price at or above"
   condition 1% below the current price and checks at once. The monitor's real alert arrives,
   and the close request with it. (Or wait for a real exit condition: the planned holding
   period ends within 1–48 hours; a `/trade_test` plans 24 hours.)
5. **Tap Approve** on each close request. A message confirms the close and the result.

## Part 2: the safety checks

Do these one at a time with `/trade_test BTC 10` (small, and coins trade 24/7), after the BTC position from Part 1 is closed (except the risk-engine one): the risk engine allows one position per instrument and one open request at a time. None of these sends an order.

| Check | What to do | What should happen |
| --- | --- | --- |
| Rejection | `/trade_test BTC 10`, tap **Reject** | "Rejected", no order |
| Risk-engine rejection | Do this one during Part 1, while the BTC position is still open: `/trade_test BTC 10` | "Rejected by the risk engine": one position per instrument. No request to approve |
| Expired approval | `/trade_test BTC 10`, do not answer for 16 minutes | The request turns "expired" and its buttons go away; no order |
| Duplicate click | `/trade_test BTC 10`; open the console's التداول tab so the request shows there; tap **Reject** in Telegram, then within 30 seconds tap **Reject** on the same request in the console | The console says "already decided"; nothing else happens |
| Quiet hours | `/trade_quiet` with a window that starts now and ends in 10 minutes (Dubai time), e.g. `/trade_quiet 18:00-18:10`, then `/trade_test BTC 10` | No request during the window; it arrives right after it. Tap **Reject**, then `/trade_quiet off` |
| Kill switch | `/trade_test BTC 10`; when the request arrives, `/trade_stop`, then tap **Approve** | "Refused: trading was stopped", no order. Then `/trade_resume` |

If a buy goes through by mistake, close it with `/trade_close BTC`.

## Results

`/trade_e2e` shows the live status. Run started 2026-11-17 12:27 UTC. Recorded from the owner's
`/trade_e2e` screenshots; every ✅ is a record the live desk wrote.

| Step | Stock — NKE | Crypto — BTC |
| --- | --- | --- |
| Monitoring: stored eToro price | ✅ bid 37.86, 11-17 12:18 UTC | ✅ bid 64823.06, 11-17 12:19 UTC |
| Analysis by the agent | ✅ 9a54ce64, **hold** (investor day that day: "a coin flip, not an edge") | ✅ bbd66a33, **avoid** |
| Proposal by the Portfolio Manager | no trade — not a failure; waiting for an agent buy | no trade — same |
| Risk → Telegram approval → order → lookup → alert → close proposal → approval → close | not reached yet | not reached yet |

Already proven on eToro DEMO before this run, outside the agents: a filled open order through
Approve (BTC $50 `/trade_test`, 2026-11-16) and a close through Approve (`/trade_close BTC`).

| Safety check | Result |
| --- | --- |
| Kill switch | ✅ 2026-11-17 13:02 UTC: `/trade_test BTC 10`, `/trade_stop`, Approve → refused ("trading was stopped"), no order |
| Owner rejection, risk-engine rejection, expiry, duplicate tap, quiet hours | not run live (optional); covered by the automated tests against a real database |

Found during the run and fixed:
- `/trade_e2e` went to the GM agent: the command pattern allowed no digits (PR #23).
- A refused order after Approve sent no message, only "Approved" (PR #25). Now "No order was sent" with the reason.
- The checklist ignored analyses that led to no trade (PR #24).
- The analyst's "look again when …" was not acted on: revisit watches (PR #26).

**Stage 8 is not finished** until an agent-made proposal goes through the whole chain to a close.
