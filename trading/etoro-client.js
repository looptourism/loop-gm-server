// ---------------------------------------------------------------------------
// eToro Public API — READ-ONLY, DEMO-ONLY client.
//
// Every path, header and parameter below was checked against the official
// docs (api-portal.etoro.com, OpenAPI v1.415.0, read 2026-11-12); the
// findings are written up in docs/trading-desk-etoro-api.md.
//
// Three guards make this file incapable of trading or of touching a live
// account, whatever the caller passes in:
//   1. Only GET is ever sent — there is no method parameter.
//   2. A path must match ALLOWED_PATHS exactly, or nothing is sent.
//   3. Any account path must contain /demo/; a path without it is refused
//      even if someone later adds it to the list by mistake.
//
// Every result carries `source` and `fetchedAt`, so a figure can always be
// traced to the call it came from. A failed call throws — it never returns
// an empty or default value that could be mistaken for real data.
// ---------------------------------------------------------------------------
const crypto = require("crypto");
const { readConfig } = require("./config");

const TIMEOUT_MS = 20000;

const CANDLE_INTERVALS = new Set([
  "OneMinute", "FiveMinutes", "TenMinutes", "FifteenMinutes", "ThirtyMinutes",
  "OneHour", "FourHours", "OneDay", "OneWeek",
]);

// Account data (demo) — quota: 60 requests / 60 s, shared within the group.
// Market data — quota: 120 requests / 60 s, shared across all market-data
// endpoints. Market-data paths have no demo/live variant: they are the same
// read-only prices for every account.
const ALLOWED_PATHS = [
  /^\/api\/v1\/trading\/info\/demo\/pnl$/,
  /^\/api\/v1\/trading\/info\/demo\/portfolio$/,
  /^\/api\/v2\/trading\/info\/demo\/orders:lookup$/,
  /^\/api\/v1\/market-data\/search$/,
  /^\/api\/v2\/market-data\/instruments$/,
  /^\/api\/v2\/market-data\/rates$/,
  /^\/api\/v1\/market-data\/instruments\/\d+\/history\/candles\/(asc|desc)\/[A-Za-z]+\/\d+$/,
];

class EtoroError extends Error {
  constructor(message, { status = null, code = null, path = null, retryAfterSec = null } = {}) {
    super(message);
    this.name = "EtoroError";
    this.status = status;
    this.code = code;
    this.path = path;
    this.retryAfterSec = retryAfterSec;
  }
}

function assertAllowedPath(path) {
  if (typeof path !== "string" || !ALLOWED_PATHS.some((re) => re.test(path))) {
    throw new EtoroError("blocked: path is not on the read-only allowlist", { code: "PathNotAllowed", path });
  }
  if (!path.includes("/market-data/") && !path.includes("/demo/")) {
    throw new EtoroError("blocked: account paths must be demo paths", { code: "NotDemoPath", path });
  }
}

function toInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new EtoroError(`invalid ${name}`, { code: "BadInput" });
  return n;
}

function createClient({ config = readConfig(), fetchImpl = globalThis.fetch } = {}) {
  // Strips the keys out of any text before it can reach a log or a response.
  function redact(text) {
    let out = String(text ?? "");
    for (const secret of [config.apiKey, config.userKey]) {
      if (secret.length >= 8) out = out.split(secret).join("[redacted]");
    }
    return out;
  }

  async function get(path, query = {}) {
    assertAllowedPath(path);
    if (!config.hasKeys) {
      throw new EtoroError("ETORO_API_KEY / ETORO_USER_KEY are not set", { code: "MissingKeys", path });
    }
    const url = new URL(config.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res, text;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers: {
          "x-request-id": requestId,
          "x-api-key": config.apiKey,
          "x-user-key": config.userKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      if (e.name === "AbortError") throw new EtoroError(`eToro did not answer within ${TIMEOUT_MS / 1000}s`, { code: "Timeout", path });
      throw new EtoroError(redact(`network error: ${e.message}`), { code: "Network", path });
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* handled below */ }

    const header = (name) => (res.headers && typeof res.headers.get === "function" ? res.headers.get(name) : null);
    const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

    if (!res.ok) {
      const detail = body?.errorMessage || body?.message || body?.title || "";
      throw new EtoroError(redact(`eToro ${res.status}${detail ? `: ${detail}` : ""}`), {
        status: res.status,
        code: body?.errorCode || (res.status === 429 ? "RateLimited" : "HttpError"),
        path,
        retryAfterSec: num(header("Retry-After")),
      });
    }
    if (body === null || typeof body !== "object") {
      throw new EtoroError("eToro returned a response that is not JSON", { status: res.status, code: "BadResponse", path });
    }
    return {
      data: body,
      source: `eToro Public API GET ${path}`,
      fetchedAt: new Date().toISOString(),
      status: res.status, // 206 from /rates means only some instruments were returned
      requestId,
      rateLimit: {
        limit: num(header("RateLimit-Limit")),
        remaining: num(header("RateLimit-Remaining")),
        resetSec: num(header("RateLimit-Reset")),
      },
    };
  }

  return {
    // Demo account: credit (cash), open positions with unrealized PnL,
    // pending orders, mirrors. The official source for balance and PnL.
    getDemoPnl: () => get("/api/v1/trading/info/demo/pnl"),

    // Demo account: positions, pending orders, mirrors (no PnL figures).
    getDemoPortfolio: () => get("/api/v1/trading/info/demo/portfolio"),

    // Status of one demo order and the positions it opened or closed.
    // Exactly one of orderId (numeric) or referenceId (the x-request-id that
    // was sent when the order was submitted).
    getDemoOrder({ orderId, referenceId } = {}) {
      if ((orderId == null) === (referenceId == null)) {
        throw new EtoroError("provide exactly one of orderId or referenceId", { code: "BadInput" });
      }
      const query = orderId != null ? { orderId: toInt(orderId, "orderId") } : { referenceId: String(referenceId) };
      return get("/api/v2/trading/info/demo/orders:lookup", query);
    },

    // Resolves a ticker (e.g. AAPL, BTC) to instrument records. The caller
    // must still check for an exact internalSymbolFull match — the search can
    // return related instruments.
    searchInstruments(symbol) {
      const s = String(symbol || "").trim().toUpperCase();
      if (!/^[A-Z0-9._-]{1,20}$/.test(s)) throw new EtoroError("invalid symbol", { code: "BadInput" });
      return get("/api/v1/market-data/search", {
        internalSymbolFull: s,
        fields: "instrumentId,displayname,internalSymbolFull,instrumentType,instrumentTypeID,exchangeID,internalAssetClassName,internalExchangeName,isOpen",
        pageSize: 20,
      });
    },

    // Instrument metadata by ID (type, symbol, exchange).
    getInstruments(instrumentIds) {
      const ids = [].concat(instrumentIds).map((id) => toInt(id, "instrumentId"));
      if (!ids.length || ids.length > 100) throw new EtoroError("1 to 100 instrument IDs", { code: "BadInput" });
      return get("/api/v2/market-data/instruments", { instrumentsIds: ids.join(",") }); // "instrumentsIds" is eToro's spelling
    },

    // Current bid/ask per instrument; each rate says whether it is realtime
    // or delayed and carries eToro's own timestamp.
    getRates(instrumentIds) {
      const ids = [].concat(instrumentIds).map((id) => toInt(id, "instrumentId"));
      if (!ids.length || ids.length > 1000) throw new EtoroError("1 to 1000 instrument IDs", { code: "BadInput" });
      return get("/api/v2/market-data/rates", { instrumentIds: ids.join(",") });
    },

    // OHLCV candles, newest first by default. At most 1000 per call.
    getCandles(instrumentId, { interval = "OneDay", count = 100, direction = "desc" } = {}) {
      const id = toInt(instrumentId, "instrumentId");
      const n = toInt(count, "count");
      if (n > 1000) throw new EtoroError("count is limited to 1000 candles", { code: "BadInput" });
      if (!CANDLE_INTERVALS.has(interval)) throw new EtoroError("invalid interval", { code: "BadInput" });
      if (direction !== "asc" && direction !== "desc") throw new EtoroError("invalid direction", { code: "BadInput" });
      return get(`/api/v1/market-data/instruments/${id}/history/candles/${direction}/${interval}/${n}`);
    },

    redact,
  };
}

module.exports = { createClient, EtoroError, ALLOWED_PATHS, CANDLE_INTERVALS, assertAllowedPath };
