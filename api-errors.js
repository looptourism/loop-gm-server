// ---------------------------------------------------------------------------
// When the Anthropic account runs out of credit, every agent fails with the
// same English 400. Instead of one raw alert per agent, the owner gets ONE
// clear Arabic alert (at most every 6 hours while it lasts), and the console
// shows the same Arabic sentence wherever an agent's answer would have been.
// ---------------------------------------------------------------------------
const CREDIT_CODE = "credit_exhausted";
const CREDIT_MESSAGE = "رصيد Anthropic API خلص، فالمدير والأقسام ما يقدرون يردون. اشحن الرصيد من console.anthropic.com ← Settings ← Billing ← Buy credits (ويفضّل تفعيل Auto-reload). بعد الشحن يرجع كل شي يشتغل بدون أي خطوة ثانية.";
const CREDIT_ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

function isCreditExhausted(err) {
  if (!err) return false;
  if (err.code === CREDIT_CODE) return true;
  const text = `${err.message || ""} ${JSON.stringify(err.error || "")}`;
  return /credit balance is too low/i.test(text);
}

// The error to throw on: the original for anything else, an Arabic one (with
// the original kept as `cause`) when the credit has run out.
function friendlyApiError(err) {
  if (!isCreditExhausted(err) || err.code === CREDIT_CODE) return err;
  const e = new Error(CREDIT_MESSAGE);
  e.code = CREDIT_CODE;
  e.status = err.status;
  e.cause = err;
  return e;
}

// One alert for the whole outage, not one per agent: true when this failure
// should be sent, false when the owner was already told recently.
function createCreditAlertGate({ now = () => Date.now(), everyMs = CREDIT_ALERT_EVERY_MS } = {}) {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < everyMs) return false;
    last = t;
    return true;
  };
}

module.exports = { CREDIT_CODE, CREDIT_MESSAGE, isCreditExhausted, friendlyApiError, createCreditAlertGate };
