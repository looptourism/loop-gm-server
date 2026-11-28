// Out of Anthropic credit: one clear Arabic error instead of the raw 400, and one alert per outage.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isCreditExhausted, friendlyApiError, createCreditAlertGate, CREDIT_CODE } = require("../api-errors");

// what the SDK threw on 2026-11-28 (owner's Telegram screenshot)
const creditError = () => Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011ChUjktgXAT4YamjKZ18W4"}'), { status: 400 });

test("the out-of-credit 400 becomes one Arabic sentence that says what to do; other errors pass through untouched", () => {
  const raw = creditError();
  const e = friendlyApiError(raw);
  assert.equal(e.code, CREDIT_CODE);
  assert.match(e.message, /رصيد Anthropic API خلص/);
  assert.match(e.message, /console\.anthropic\.com/);
  assert.equal(e.cause, raw);
  assert.equal(friendlyApiError(e), e, "already friendly: unchanged");
  assert.ok(isCreditExhausted(e) && isCreditExhausted(raw));
  const other = Object.assign(new Error('400 {"type":"error","error":{"message":"messages.0: user messages must have non-empty content"}}'), { status: 400 });
  assert.equal(friendlyApiError(other), other);
  assert.equal(isCreditExhausted(other), false);
  assert.equal(isCreditExhausted(null), false);
});

test("one alert per outage: again only after 6 hours", () => {
  let t = 0;
  const due = createCreditAlertGate({ now: () => t });
  assert.deepEqual([due(), due(), due()], [true, false, false]);
  t = 6 * 3600 * 1000 - 1; assert.equal(due(), false);
  t = 6 * 3600 * 1000; assert.equal(due(), true);
});
