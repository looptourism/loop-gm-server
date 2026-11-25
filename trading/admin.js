// ---------------------------------------------------------------------------
// Admin step-up for the Trading Desk page. The console login lets you SEE the
// desk; changing the allowlists also needs an admin session, opened with a
// separate password (TRADING_ADMIN_PASSWORD) and valid for 15 minutes.
//
// - No TRADING_ADMIN_PASSWORD on the server → editing is off (fail closed).
// - The session is a signed expiry in an HttpOnly, SameSite=Strict cookie
//   scoped to /api/trading/desk. Never a query parameter or a header the page
//   could leak; JavaScript on the page cannot read it.
// - The signing key is random per process: a restart ends every admin
//   session, and nothing about it is stored.
// - Five wrong passwords from one address lock that address out for 15 min.
// ---------------------------------------------------------------------------
const crypto = require("crypto");

const COOKIE = "loop_desk_admin";
const COOKIE_PATH = "/api/trading/desk";
const TTL_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

function createAdmin({ password = "", now = () => Date.now(), ttlMs = TTL_MS } = {}) {
  const configured = typeof password === "string" && password.length > 0;
  const key = crypto.createHash("sha256").update(crypto.randomBytes(32)).update("desk-admin-v1:" + (password || "")).digest();
  const failures = new Map(); // ip -> { count, until }
  const sign = (exp) => crypto.createHmac("sha256", key).update("admin." + exp).digest("base64url");

  function issue() {
    const exp = now() + ttlMs;
    return { token: `${exp}.${sign(exp)}`, expiresAt: new Date(exp).toISOString() };
  }

  function verify(token) {
    if (!configured) return { ok: false };
    const [exp, sig] = String(token || "").split(".");
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) <= now()) return { ok: false };
    return safeEqual(sig, sign(exp)) ? { ok: true, expiresAt: new Date(Number(exp)).toISOString() } : { ok: false };
  }

  // Only from the cookie: never ?token= or a header.
  function tokenFrom(req) {
    const header = (req.get && req.get("Cookie")) || "";
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return "";
  }

  function cookie(req, token, maxAgeSec) {
    return `${COOKIE}=${token}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${req.secure ? "; Secure" : ""}`;
  }

  // { ok } on the right password; { locked, retryAfterSec } while locked out.
  function checkPassword(ip, attempt) {
    const t = now();
    const f = failures.get(ip);
    if (f && f.count >= MAX_FAILURES && f.until > t) return { ok: false, locked: true, retryAfterSec: Math.ceil((f.until - t) / 1000) };
    if (configured && typeof attempt === "string" && safeEqual(attempt, password)) { failures.delete(ip); return { ok: true }; }
    const prev = f && f.until > t ? f : { count: 0, until: 0 };
    failures.set(ip, { count: prev.count + 1, until: t + LOCKOUT_MS });
    if (failures.size > 5000) failures.clear();
    const left = MAX_FAILURES - (prev.count + 1);
    return { ok: false, locked: left <= 0, attemptsLeft: Math.max(0, left), retryAfterSec: left <= 0 ? Math.ceil(LOCKOUT_MS / 1000) : 0 };
  }

  function status(req) {
    const v = verify(tokenFrom(req));
    return { configured, active: v.ok, expiresAt: v.ok ? v.expiresAt : null };
  }

  return { configured, issue, verify, tokenFrom, cookie, checkPassword, status, ttlMs };
}

module.exports = { createAdmin, COOKIE, COOKIE_PATH };
