// ---------------------------------------------------------------------------
// eToro DEMO order client — the ONLY file in this codebase that can place an
// order, and the only requests it can make are these two:
//
//     POST https://public-api.etoro.com/api/v2/trading/execution/demo/orders
//     POST https://public-api.etoro.com/api/v1/trading/execution/demo/market-close-orders/positions/{positionId}
//
// The second (Stage 6) closes a WHOLE position: "Close demo position by
// units", Trading - Demo, checked against the official reference on
// 2026-11-17. UnitsToDeduct is always null (= the full position). eToro's
// guide shows this path without /demo/ too — the real account.
// Checked against the official reference on 2026-11-16 ("Create an order",
// Trading - Demo, OpenAPI v1.415.0): v2 is the current synchronous path; v1
// was withdrawn on 18 Aug 2026; v3 is the asynchronous variant. eToro's own
// "market orders" guide shows the path WITHOUT /demo/ — that is the real
// account, and this file cannot send to it: the path is a constant, not a
// parameter, and it is checked again before every request.
//
// It can only OPEN a LONG position at LEVERAGE 1 with a MARKET order for a
// US-dollar AMOUNT. Anything else is refused before the network is touched.
// It is called from one place: trading/execution/gateway.js.
//
// The x-request-id header is the idempotency key. eToro echoes it back as
// referenceId, and the order can be looked up by it if the answer is lost.
//
// An error says whether the request can have reached eToro:
//   sent: false — refused here, or the connection was never made: no order.
//   sent: true  — eToro may have received it: the result is UNKNOWN and must
//                 be looked up. It is never sent again.
// ---------------------------------------------------------------------------
const { readConfig } = require("../config");

const DEMO_ORDER_PATH = "/api/v2/trading/execution/demo/orders";
const DEMO_CLOSE_PATH_PREFIX = "/api/v1/trading/execution/demo/market-close-orders/positions/";
const TIMEOUT_MS = 20000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class OrderError extends Error {
  constructor(message, { sent, status = null, code = null, body = null } = {}) {
    super(message);
    this.name = "OrderError";
    this.sent = sent;       // could eToro have received the request?
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

// The exact body sent to eToro for one approved proposal. Throws on anything
// that is not a long, unleveraged, market, dollar-amount open order.
function buildOpenOrder({ instrumentId, amountUsd, direction, leverage, orderType, action }) {
  const refuse = (m) => { throw new OrderError(`order refused before sending: ${m}`, { sent: false, code: "NotAllowed" }); };
  if (action !== "open") refuse("only orders that open a position are supported");
  if (direction !== "buy") refuse("only buy (long) orders are allowed");
  if (leverage !== 1) refuse("leverage must be 1");
  if (orderType !== "market") refuse("only market orders are supported");
  if (!Number.isInteger(instrumentId) || instrumentId <= 0) refuse("invalid instrument");
  if (!(typeof amountUsd === "number" && Number.isFinite(amountUsd) && amountUsd > 0)) refuse("invalid amount");
  return { action: "open", transaction: "buy", instrumentId, orderType: "mkt", leverage: 1, amount: Math.round(amountUsd * 100) / 100, orderCurrency: "usd" };
}

// The exact body that closes one whole position. Nothing else can be built.
function buildCloseOrder({ etoroPositionId, instrumentId }) {
  const refuse = (m) => { throw new OrderError(`close refused before sending: ${m}`, { sent: false, code: "NotAllowed" }); };
  if (!Number.isSafeInteger(etoroPositionId) || etoroPositionId <= 0) refuse("invalid position");
  if (!Number.isInteger(instrumentId) || instrumentId <= 0) refuse("invalid instrument");
  return { InstrumentID: instrumentId, UnitsToDeduct: null };
}

function createOrderClient({ config = readConfig(), fetchImpl = globalThis.fetch } = {}) {
  const redact = (text) => { let out = String(text ?? ""); for (const s of [config.apiKey, config.userKey]) if (s && s.length >= 8) out = out.split(s).join("[redacted]"); return out; };

  async function placeDemoOrder(body, { idempotencyKey }) {
    const path = DEMO_ORDER_PATH;
    if (!path.includes("/demo/")) throw new OrderError("blocked: not a demo path", { sent: false, code: "NotDemoPath" });
    if (!config.hasKeys) throw new OrderError("ETORO_API_KEY / ETORO_USER_KEY are not set", { sent: false, code: "MissingKeys" });
    if (!UUID.test(String(idempotencyKey || ""))) throw new OrderError("order refused before sending: no idempotency key", { sent: false, code: "NoIdempotencyKey" });
    const checked = buildOpenOrder({ instrumentId: body?.instrumentId, amountUsd: body?.amount, direction: body?.transaction, leverage: body?.leverage, orderType: body?.orderType === "mkt" ? "market" : body?.orderType, action: body?.action });
    if (JSON.stringify(checked) !== JSON.stringify(body)) throw new OrderError("order refused before sending: the body is not exactly an allowed open order", { sent: false, code: "NotAllowed" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res, text;
    try {
      res = await fetchImpl(new URL(config.baseUrl + path), {
        method: "POST",
        headers: { "x-request-id": idempotencyKey, "x-api-key": config.apiKey, "x-user-key": config.userKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      // A timeout or a dropped connection: eToro may or may not have the order.
      throw new OrderError(e.name === "AbortError" ? `eToro did not answer within ${TIMEOUT_MS / 1000}s` : redact(`network error: ${e.message}`), { sent: true, code: e.name === "AbortError" ? "Timeout" : "Network" });
    } finally { clearTimeout(timer); }

    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
    const at = new Date().toISOString();
    if (res.status === 200 && json && Number.isInteger(json.orderId)) {
      return { accepted: true, orderId: json.orderId, referenceId: json.referenceId ?? null, token: json.token ?? null, response: json, source: `eToro Public API POST ${path}`, fetchedAt: at };
    }
    const detail = json?.detail || json?.title || json?.errorMessage || json?.message || "";
    // 400 / 404 are eToro saying it did not take the order. Everything else —
    // a 401 (eToro has answered stray 401s), a 429, a 5xx, a 200 with no
    // order ID — leaves the result unknown.
    const definite = res.status === 400 || res.status === 404;
    throw new OrderError(redact(`eToro ${res.status}${detail ? `: ${detail}` : ""}`), { sent: !definite, status: res.status, code: definite ? "Rejected" : "UnclearAnswer", body: json });
  }

  // Closes one whole demo position. Same rules as placeDemoOrder: refused
  // before sending unless the body is exactly a full close; an unclear
  // answer means the result is unknown and the close is NEVER resent.
  async function placeDemoClose(etoroPositionId, body, { idempotencyKey }) {
    const checked = buildCloseOrder({ etoroPositionId, instrumentId: body?.InstrumentID });
    if (JSON.stringify(checked) !== JSON.stringify(body)) throw new OrderError("close refused before sending: the body is not exactly a full close", { sent: false, code: "NotAllowed" });
    const path = DEMO_CLOSE_PATH_PREFIX + String(etoroPositionId);
    if (!path.includes("/demo/") || !/^\/api\/v1\/trading\/execution\/demo\/market-close-orders\/positions\/\d+$/.test(path)) throw new OrderError("blocked: not a demo close path", { sent: false, code: "NotDemoPath" });
    if (!config.hasKeys) throw new OrderError("ETORO_API_KEY / ETORO_USER_KEY are not set", { sent: false, code: "MissingKeys" });
    if (!UUID.test(String(idempotencyKey || ""))) throw new OrderError("close refused before sending: no idempotency key", { sent: false, code: "NoIdempotencyKey" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res, text;
    try {
      res = await fetchImpl(new URL(config.baseUrl + path), {
        method: "POST",
        headers: { "x-request-id": idempotencyKey, "x-api-key": config.apiKey, "x-user-key": config.userKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      throw new OrderError(e.name === "AbortError" ? `eToro did not answer within ${TIMEOUT_MS / 1000}s` : redact(`network error: ${e.message}`), { sent: true, code: e.name === "AbortError" ? "Timeout" : "Network" });
    } finally { clearTimeout(timer); }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
    const o = json?.orderForClose;
    if (res.status === 200 && o && Number.isInteger(o.orderID)) {
      return { accepted: true, orderId: o.orderID, statusId: o.statusID ?? null, response: json, source: `eToro Public API POST ${DEMO_CLOSE_PATH_PREFIX}{positionId}`, fetchedAt: new Date().toISOString() };
    }
    const detail = json?.detail || json?.title || json?.errorMessage || json?.message || "";
    const definite = res.status === 400 || res.status === 404;
    throw new OrderError(redact(`eToro ${res.status}${detail ? `: ${detail}` : ""}`), { sent: !definite, status: res.status, code: definite ? "Rejected" : "UnclearAnswer", body: json });
  }

  return { placeDemoOrder, placeDemoClose, redact };
}

module.exports = { createOrderClient, buildOpenOrder, buildCloseOrder, OrderError, DEMO_ORDER_PATH, DEMO_CLOSE_PATH_PREFIX };
