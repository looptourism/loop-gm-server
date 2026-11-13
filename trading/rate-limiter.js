// ---------------------------------------------------------------------------
// Keeps the monitoring job far below eToro's request quota.
//
// Three brakes, all applied before a request is sent:
//   1. never more than `perMinute` requests in any rolling 60 seconds;
//   2. at least `minGapMs` between two requests;
//   3. if eToro's own RateLimit-Remaining header says fewer than `reserve`
//      requests are left (someone else is using the same quota), wait until
//      eToro's window resets.
// After a 429 the limiter is paused: take() refuses until the pause is over.
// ---------------------------------------------------------------------------
class RateBudgetError extends Error {
  constructor(message, resumeAt) {
    super(message);
    this.name = "RateBudgetError";
    this.code = "RateBudgetPaused";
    this.resumeAt = resumeAt;
  }
}

function createLimiter({ perMinute, minGapMs, reserve, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const WINDOW = 60000;
  let sent = [];          // times of the requests in the last 60 s
  let holdUntil = 0;      // from eToro's headers: wait for the window to reset
  let pausedUntil = 0;    // after a 429
  let total = 0;

  async function take() {
    for (;;) {
      const t = now();
      if (t < pausedUntil) throw new RateBudgetError("paused after eToro answered 429", new Date(pausedUntil).toISOString());
      sent = sent.filter((x) => t - x < WINDOW);
      let wait = 0;
      if (sent.length >= perMinute) wait = Math.max(wait, sent[0] + WINDOW - t);
      if (sent.length) wait = Math.max(wait, sent[sent.length - 1] + minGapMs - t);
      wait = Math.max(wait, holdUntil - t);
      if (wait <= 0) { sent.push(t); total++; return; }
      await sleep(wait);
    }
  }

  // Feed in the rateLimit object the eToro client returns with every answer.
  function observe(rateLimit) {
    const remaining = rateLimit?.remaining, resetSec = rateLimit?.resetSec;
    if (typeof remaining === "number" && remaining < reserve) {
      holdUntil = Math.max(holdUntil, now() + (typeof resetSec === "number" && resetSec > 0 ? Math.min(resetSec, 60) : 60) * 1000);
    }
  }

  function pause(ms) { pausedUntil = Math.max(pausedUntil, now() + ms); }

  return {
    take, observe, pause,
    state: () => ({ perMinute, minGapMs, reserve, sentLast60s: sent.filter((x) => now() - x < WINDOW).length, totalSent: total, pausedUntil: pausedUntil > now() ? new Date(pausedUntil).toISOString() : null }),
  };
}

module.exports = { createLimiter, RateBudgetError };
