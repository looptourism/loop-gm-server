// ---------------------------------------------------------------------------
// The risk engine (Stage 5) — deterministic code, no AI.
//
// assess() is a pure function: the same inputs always give the same verdict.
// It reads no clock, no database and no network; trading/risk/context.js
// gathers the inputs. No agent can call it, change it or override it, and an
// agent's opinion is not one of its inputs.
//
// FAIL CLOSED: a check passes only when the fact it needs is present and
// inside the limit. A missing account, a missing price, a missing baseline —
// every "unknown" is a failed check. One failed check fails the proposal.
//
// Two phases use the same checks:
//   pre_approval   — before the owner is asked (stored price, must be fresh)
//   pre_execution  — after approval, immediately before the order is sent
//                    (live price, plus how far it moved since the request)
// ---------------------------------------------------------------------------
const ENGINE_VERSION = "risk-engine-2";
const DAY = 86400000;
const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => typeof v === "number" && Number.isFinite(v);

// A CLOSE reduces risk, so the opening limits (cash, exposure, positions,
// daily loss, the swing plan) do not apply to it: a limit must never keep a
// position open. What is checked is that this is exactly the position the
// owner approved closing, that it is still open, and that the switches and
// the price allow an order now. The price may have moved since the request:
// for a close that is not a reason to refuse, because refusing would leave
// the position open in a falling market.
function assessClose(input) {
  const { phase, now, policy, proposal, account, position, closeInFlight, price } = input;
  const checks = [], warnings = [];
  const check = (name, passed, message, extra = {}) => { checks.push({ name, passed: passed === true, message, ...extra }); return passed === true; };
  check("kill_switch", input.tradingEnabled === true && input.halted === false,
    input.tradingEnabled !== true ? "trading is switched off (TRADING_ENABLED is not \"true\")" : input.halted === false ? "trading is switched on" : "trading was stopped (/trade_stop), or the stop state could not be read");
  check("demo_only", policy.environment === "demo", "the desk trades the DEMO account only");
  check("not_expired", now.getTime() < new Date(proposal.expiresAt).getTime(), `the proposal expires at ${new Date(proposal.expiresAt).toISOString()}`);
  check("closes_a_position", proposal.action === "close" && proposal.direction === "buy" && proposal.leverage === 1 && proposal.orderType === "market",
    proposal.action === "close" ? "closes a long, unleveraged position with a market order" : "not a close proposal");
  check("position_on_record", !!position && position.status === "open" && position.instrumentId === proposal.instrumentId,
    !position ? "the position is not in the desk's records" : position.status !== "open" ? `the desk's record says the position is ${position.status}` : position.instrumentId !== proposal.instrumentId ? "the position belongs to another instrument" : `position ${position.etoroPositionId} is on record as open`);
  const acct = account && account.ok === true ? account : null;
  check("account_readable", !!acct, acct ? `demo account read at ${acct.fetchedAt}` : `the demo account could not be read${account?.reason ? `: ${account.reason}` : ""}`);
  const live = acct && position ? acct.positions.find((p) => p.positionId === position.etoroPositionId) : null;
  check("position_open_at_etoro", !!live, !acct ? "unknown: the account could not be read" : !position ? "unknown: no position on record" : live ? `eToro lists position ${position.etoroPositionId} as open` : `eToro no longer lists position ${position?.etoroPositionId}: it is already closed`);
  check("position_matches", !!live && live.instrumentId === proposal.instrumentId && live.direction === "buy" && live.leverage === 1,
    !live ? "unknown: the position is not listed" : live.instrumentId !== proposal.instrumentId ? "eToro lists the position under another instrument" : live.direction !== "buy" ? "eToro lists it as a short position" : live.leverage !== 1 ? `eToro lists it with leverage ${live.leverage}` : "a long, unleveraged position in this instrument");
  check("no_close_in_flight", !!closeInFlight && closeInFlight.ok === true && closeInFlight.count === 0,
    !closeInFlight || closeInFlight.ok !== true ? `unknown whether another close is in flight${closeInFlight?.reason ? `: ${closeInFlight.reason}` : ""}` : closeInFlight.count ? "another close order for this position is already at eToro" : "no other close order for this position is in flight");
  const px = price && price.ok === true && typeof price.bid === "number" && price.bid > 0 ? price : null;
  const maxAge = phase === "pre_execution" ? policy.execution.priceMaxAgeSec : input.storedPriceMaxAgeSec;
  check("fresh_price", !!px && px.quoteType === "realtime" && px.ageSec <= maxAge && px.ageSec >= -60,
    !px ? `no usable price${price?.reason ? `: ${price.reason}` : ""} (a stock can be closed while its market is open)` : px.quoteType !== "realtime" ? `the price is ${px.quoteType || "of unknown type"}, not realtime` : `the price is ${px.ageSec} s old by eToro's own timestamp (limit ${maxAge} s)`, { limit: maxAge, actual: px?.ageSec ?? null });
  if (live && typeof live.unrealizedPnlUsd === "number") warnings.push(`eToro shows ${live.unrealizedPnlUsd < 0 ? "a loss" : "a profit"} of $${Math.abs(Math.round(live.unrealizedPnlUsd * 100) / 100)} on this position now`);
  const failed = checks.filter((c) => !c.passed);
  return { engineVersion: ENGINE_VERSION, phase, passed: failed.length === 0, failed: failed.map((c) => c.name), checks, warnings };
}

function assess(input) {
  if (input?.proposal?.action === "close") return assessClose(input);
  const { phase, now, policy, proposal, allowlist, account, commitments = [], price, dailyLoss, referenceAsk = null, earnings = null } = input;
  const checks = [], warnings = [];
  const check = (name, passed, message, extra = {}) => { checks.push({ name, passed: passed === true, message, ...extra }); return passed === true; };
  const amount = proposal.amountUsd;
  const cls = proposal.assetClass;
  const countsAsCrypto = (x) => x.assetClass === "crypto" || (policy.cryptoCorrelatedCountsTowardCryptoCap && x.cryptoCorrelated === true);

  // ---- the switch and the shape of the trade --------------------------------
  check("kill_switch", input.tradingEnabled === true && input.halted === false,
    input.tradingEnabled !== true ? "trading is switched off (TRADING_ENABLED is not \"true\")" : input.halted === false ? "trading is switched on" : "trading was stopped (/trade_stop), or the stop state could not be read");
  check("demo_only", policy.environment === "demo", "the desk trades the DEMO account only");
  check("not_expired", now.getTime() < new Date(proposal.expiresAt).getTime(), `the proposal expires at ${new Date(proposal.expiresAt).toISOString()}`);
  check("opens_a_position", proposal.action === "open", proposal.action === "open" ? "opens a new position" : "closing through the desk is not built yet (Stage 6)");
  check("asset_class", policy.assetClasses.includes(cls), `asset class is ${cls}`);
  check("allowlisted", !!allowlist && allowlist.listed === true && allowlist.active === true && allowlist.verified === true && allowlist.assetClass === cls,
    !allowlist || !allowlist.listed ? "the instrument is not on an allowlist" : !allowlist.active ? "the instrument is switched off on the allowlist" : !allowlist.verified ? "the instrument is not verified on eToro" : allowlist.assetClass !== cls ? "the allowlist has it under another asset class" : "on the allowlist, active and verified");
  check("long_only", proposal.direction === policy.direction, `direction is ${proposal.direction}`);
  check("no_leverage", proposal.leverage === policy.leverage, `leverage is ${proposal.leverage}`, { limit: policy.leverage, actual: proposal.leverage });
  check("market_order", proposal.orderType === "market", `order type is ${proposal.orderType}; only market orders are supported`);
  const perTrade = policy.maxPerTradeUsd[cls];
  check("per_trade_limit", num(amount) && amount > 0 && num(perTrade) && amount <= perTrade, `$${amount} against a limit of $${perTrade} per ${cls} trade`, { limit: perTrade, actual: amount });

  // ---- the account ------------------------------------------------------------
  const acct = account && account.ok === true ? account : null;
  check("account_readable", !!acct, acct ? `demo account read at ${acct.fetchedAt}` : `the demo account could not be read${account?.reason ? `: ${account.reason}` : ""}`);
  const held = acct ? acct.positions : [];
  const pending = commitments.filter((c) => c.proposalId !== proposal.id);
  const sum = (xs) => xs.reduce((a, x) => a + x.amountUsd, 0);
  const pendingUsd = sum(pending);

  check("available_cash", !!acct && num(acct.availableCashUsd) && amount + pendingUsd <= acct.availableCashUsd,
    acct ? `needs $${r2(amount + pendingUsd)} (this trade plus trades awaiting execution); $${acct.availableCashUsd} is available` : "unknown: the account could not be read", { limit: acct?.availableCashUsd ?? null, actual: r2(amount + pendingUsd) });

  const total = acct ? r2(sum(held) + pendingUsd + amount) : null;
  check("total_exposure", !!acct && total <= policy.maxTotalExposureUsd, acct ? `total exposure would be $${total} against a limit of $${policy.maxTotalExposureUsd}` : "unknown: the account could not be read", { limit: policy.maxTotalExposureUsd, actual: total });

  const thisIsCrypto = countsAsCrypto({ assetClass: cls, cryptoCorrelated: allowlist?.cryptoCorrelated });
  // A held position whose instrument the desk does not know counts toward the crypto cap too: unknown is not "safe".
  const cryptoHeld = acct ? sum(held.filter((x) => countsAsCrypto(x) || x.assetClass === "unknown")) : 0;
  const crypto = acct ? r2(cryptoHeld + sum(pending.filter(countsAsCrypto)) + (thisIsCrypto ? amount : 0)) : null;
  check("crypto_exposure", !thisIsCrypto || (!!acct && crypto <= policy.maxCryptoExposureUsd),
    !thisIsCrypto ? "not a crypto or crypto-correlated instrument" : acct ? `crypto exposure would be $${crypto} against a limit of $${policy.maxCryptoExposureUsd}${cls === "stock" ? " (this stock is flagged crypto-correlated)" : ""}` : "unknown: the account could not be read", { limit: policy.maxCryptoExposureUsd, actual: crypto });

  const count = acct ? held.length + pending.length + 1 : null;
  check("open_positions", !!acct && count <= policy.maxOpenPositions, acct ? `there would be ${count} open positions against a limit of ${policy.maxOpenPositions}` : "unknown: the account could not be read", { limit: policy.maxOpenPositions, actual: count });

  const sameHeld = held.some((x) => x.instrumentId === proposal.instrumentId);
  check("no_duplicate_position", !!acct && !(policy.onePositionPerInstrument && sameHeld), !acct ? "unknown: the account could not be read" : sameHeld ? "a position in this instrument is already open" : "no position in this instrument is open");
  const samePending = pending.some((c) => c.instrumentId === proposal.instrumentId);
  check("no_duplicate_proposal", !samePending, samePending ? "another proposal for this instrument is already awaiting approval or execution" : "no other live proposal for this instrument");

  const dl = dailyLoss && dailyLoss.ok === true ? dailyLoss : null;
  check("daily_loss", !!dl && num(dl.lossUsd) && dl.lossUsd < policy.maxDailyLossUsd,
    dl ? `the account is ${dl.lossUsd > 0 ? `down $${r2(dl.lossUsd)}` : `up $${r2(-dl.lossUsd)}`} today (since ${dl.baselineAt}) against a daily loss limit of $${policy.maxDailyLossUsd}` : `today's loss is unknown${dailyLoss?.reason ? `: ${dailyLoss.reason}` : ""}`, { limit: policy.maxDailyLossUsd, actual: dl ? r2(dl.lossUsd) : null });

  // ---- the price ------------------------------------------------------------
  const px = price && price.ok === true && num(price.bid) && num(price.ask) && price.bid > 0 && price.ask >= price.bid ? price : null;
  const maxAge = phase === "pre_execution" ? policy.execution.priceMaxAgeSec : input.storedPriceMaxAgeSec;
  const freshNow = !!px && px.quoteType === "realtime" && num(px.ageSec) && px.ageSec <= maxAge && px.ageSec >= -60;
  check("fresh_price", freshNow, !px ? `no usable price${price?.reason ? `: ${price.reason}` : ""}` : px.quoteType !== "realtime" ? `the price is ${px.quoteType || "of unknown type"}, not realtime` : `the price is ${px.ageSec} s old by eToro's own timestamp (limit ${maxAge} s)`, { limit: maxAge, actual: px?.ageSec ?? null });
  if (phase === "pre_execution") {
    const drift = px && num(referenceAsk) && referenceAsk > 0 ? Math.abs(px.ask - referenceAsk) / referenceAsk * 100 : null;
    check("price_drift", drift !== null && drift <= policy.execution.maxPriceDriftPct, drift === null ? "unknown: no price from the approval request to compare with" : `the price moved ${r2(drift)}% since the approval request (limit ${policy.execution.maxPriceDriftPct}%)`, { limit: policy.execution.maxPriceDriftPct, actual: drift === null ? null : r2(drift) });
  }

  // ---- the swing-trade plan: 1 to 14 days, with exits that make sense ----------
  const d = proposal.details || {};
  const days = d.holding_days;
  const { min, max } = policy.holdingDays;
  check("holding_period", Number.isInteger(days) && days >= min && days <= max, `planned holding period is ${Number.isInteger(days) ? `${days} day(s)` : "not stated"}; the desk holds ${min} to ${max} days`, { limit: max, actual: Number.isInteger(days) ? days : null });
  const exits = Array.isArray(d.exit_conditions) ? d.exit_conditions : [];
  const stops = exits.filter((c) => c && c.type === "price_below" && num(c.value) && c.value > 0).map((c) => c.value);
  const stop = stops.length ? Math.max(...stops) : null; // the highest stop is the one reached first
  check("stop_level", stop !== null && !!px && stop < px.bid, stop === null ? "the proposal has no stop level" : !px ? "unknown: no price to compare the stop with" : stop < px.bid ? `stop at ${stop}, below the current bid of ${px.bid}` : `the stop at ${stop} is not below the current bid of ${px.bid}: the position would be at its exit the moment it opened`, { actual: stop });
  const plannedLoss = stop !== null && px && stop < px.ask ? r2(amount * (px.ask - stop) / px.ask) : null;
  check("loss_at_stop", plannedLoss !== null && plannedLoss <= policy.maxDailyLossUsd, plannedLoss === null ? "unknown: needs a stop level below the price" : `if the stop is reached the loss is about $${plannedLoss}; one trade may not plan to lose more than the daily loss limit of $${policy.maxDailyLossUsd}`, { limit: policy.maxDailyLossUsd, actual: plannedLoss });
  const targets = exits.filter((c) => c && c.type === "price_above").map((c) => c.value);
  check("targets_above_price", targets.every((t) => num(t) && !!px && t > px.ask), targets.length === 0 ? "no price target given" : !px ? "unknown: no price to compare the target with" : targets.every((t) => t > px.ask) ? `target(s) ${targets.join(", ")} above the current ask of ${px.ask}` : `a target (${targets.join(", ")}) is not above the current ask of ${px.ask}`);
  const horizonEnd = now.getTime() + max * DAY;
  const dates = exits.filter((c) => c && c.type === "date_after").map((c) => c.date);
  const dateOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && Date.parse(`${s}T23:59:59Z`) >= now.getTime() && Date.parse(`${s}T00:00:00Z`) <= horizonEnd;
  check("exit_dates_in_horizon", dates.every(dateOk), dates.length === 0 ? "no exit date given (the desk's own limit applies)" : dates.every(dateOk) ? `exit date(s) ${dates.join(", ")} fall within the next ${max} days` : `an exit date (${dates.join(", ")}) is in the past or more than ${max} days ahead`);

  // ---- notes for the owner: not limits, so they do not fail the proposal -------
  if (earnings?.nextDate && Number.isInteger(days)) {
    const e = Date.parse(`${earnings.nextDate}T00:00:00Z`);
    if (e >= now.getTime() - DAY && e <= now.getTime() + days * DAY) warnings.push(`earnings are due on ${earnings.nextDate}, inside the planned ${days}-day holding period`);
  }
  if (acct && acct.copyPortfolios > 0) warnings.push("the account has copy-trading portfolios; they are not counted in the exposure figures");
  if (acct && held.some((x) => x.assetClass === "unknown")) warnings.push("the account holds a position in an instrument that is not on your allowlists; it is counted toward both exposure limits");

  const failed = checks.filter((c) => !c.passed);
  return { engineVersion: ENGINE_VERSION, phase, passed: failed.length === 0, failed: failed.map((c) => c.name), checks, warnings };
}

module.exports = { assess, ENGINE_VERSION };
