// ---------------------------------------------------------------------------
// Turns eToro's demo PnL response into the few figures the Trading Desk
// needs. Plain arithmetic, following eToro's own published formulas:
//
//   available cash = credit − (Σ ordersForOpen.amount where mirrorID = 0
//                              + Σ orders.amount)
//   unrealized PnL = Σ positions.unrealizedPnL.pnL   (manual positions)
//
// Fail closed: if a figure the formula needs is missing or not a number,
// this throws. It never substitutes zero — a wrong balance is worse than
// no balance.
// ---------------------------------------------------------------------------
class AccountDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "AccountDataError";
  }
}

function need(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AccountDataError(`eToro response is missing a usable "${name}"`);
  }
  return value;
}

function needArray(value, name) {
  if (!Array.isArray(value)) throw new AccountDataError(`eToro response is missing the "${name}" list`);
  return value;
}

const round2 = (n) => Math.round(n * 100) / 100;

// `pnl` is the result of client.getDemoPnl(): { data, source, fetchedAt, … }
function summarizeDemoAccount(pnl) {
  const p = pnl?.data?.clientPortfolio;
  if (!p || typeof p !== "object") throw new AccountDataError('eToro response has no "clientPortfolio"');

  const credit = need(p.credit, "credit");
  const positions = needArray(p.positions, "positions");
  const ordersForOpen = needArray(p.ordersForOpen, "ordersForOpen");
  const orders = needArray(p.orders, "orders");
  const mirrors = Array.isArray(p.mirrors) ? p.mirrors : [];

  const pendingOpen = ordersForOpen
    .filter((o) => o.mirrorID === 0)
    .reduce((sum, o) => sum + need(o.amount, "ordersForOpen.amount"), 0);
  const pendingLimit = orders.reduce((sum, o) => sum + need(o.amount, "orders.amount"), 0);

  const manual = positions.filter((x) => x.mirrorID === 0 || x.mirrorID === undefined || x.mirrorID === null);
  const list = manual.map((x) => ({
    positionId: x.positionID,
    instrumentId: x.instrumentID,
    direction: x.isBuy === true ? "buy" : x.isBuy === false ? "sell" : "unknown",
    amountUsd: need(x.amount, "positions.amount"),
    units: typeof x.units === "number" ? x.units : null,
    leverage: typeof x.leverage === "number" ? x.leverage : null,
    openRate: typeof x.openRate === "number" ? x.openRate : null,
    openedAt: x.openDateTime || null,
    unrealizedPnlUsd: need(x.unrealizedPnL?.pnL, "positions.unrealizedPnL.pnL"),
  }));

  return {
    environment: "demo",
    currency: "USD",
    creditUsd: round2(credit),
    pendingOrdersUsd: round2(pendingOpen + pendingLimit),
    availableCashUsd: round2(credit - (pendingOpen + pendingLimit)),
    investedUsd: round2(list.reduce((sum, x) => sum + x.amountUsd, 0)),
    unrealizedPnlUsd: round2(list.reduce((sum, x) => sum + x.unrealizedPnlUsd, 0)),
    openPositions: list.length,
    pendingOrders: ordersForOpen.length + orders.length,
    copyPortfolios: mirrors.length, // copy trading is outside the Trading Desk; only counted so it is visible
    positions: list,
    source: pnl.source,
    fetchedAt: pnl.fetchedAt,
  };
}

module.exports = { summarizeDemoAccount, AccountDataError };
