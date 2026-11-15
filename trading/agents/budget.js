// ---------------------------------------------------------------------------
// The monthly Claude API budget — a hard stop in code.
//
// Every Claude request an agent makes is written to trading.api_usage with
// its estimated cost. Before every agent step the month's total is read; if
// the step would take the month over the budget, the step is refused and the
// run stops there.
//
// Fail closed: if the ledger cannot be read, no agent may run; if a request's
// usage cannot be written, that agent stops at once. An unrecorded request
// would be money spent that the budget cannot see.
//
// Two honest limits:
//   * Costs are ESTIMATES at list price from the token counts Claude reports,
//     not the invoice. All input tokens are counted at the full input price.
//   * A step is checked before it starts, with a reserve for what it is
//     expected to cost; one step can still overshoot slightly. The spend
//     limit set on the Anthropic workspace is the backstop outside this code.
// The month is the calendar month in UTC.
// ---------------------------------------------------------------------------
class BudgetError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BudgetError";
    this.code = code; // "BudgetReached" or "LedgerUnavailable"
  }
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const round2 = (n) => Math.round(n * 100) / 100;

function createBudget({ db, settings, now = () => new Date(), redact = (t) => String(t ?? "") }) {
  // A model that is not in the price list is charged at the most expensive
  // listed price, so an unexpected model can only make the budget stricter.
  const dearest = Object.values(settings.pricesPerMTok).reduce((a, b) => (b.output > a.output ? b : a));
  const priceOf = (model) => settings.pricesPerMTok[model] || dearest;
  const costOf = (model, inputTokens, outputTokens) => { const p = priceOf(model); return round6((inputTokens * p.input + outputTokens * p.output) / 1e6); };
  const monthStart = () => { const t = now(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)); };
  const monthName = () => monthStart().toISOString().slice(0, 7);

  async function spent() {
    const r = await db.query("select coalesce(sum(estimated_cost_usd), 0) as usd, count(*) as n from trading.api_usage where occurred_at >= $1", [monthStart().toISOString()]);
    return { usd: Number(r.rows[0].usd), requests: Number(r.rows[0].n) };
  }

  // Refuses the step unless the ledger is readable and there is room for it.
  async function assertRoom(purpose) {
    let s;
    try { s = await spent(); }
    catch (e) { throw new BudgetError(`the usage ledger could not be read, so no agent may run (${redact(e?.message)}). If the table is missing, apply migration 004_api_usage.`, "LedgerUnavailable"); }
    const reserve = settings.stepReserveUsd[purpose] ?? Math.max(...Object.values(settings.stepReserveUsd));
    if (s.usd + reserve > settings.monthlyBudgetUsd) {
      throw new BudgetError(`monthly budget reached: about $${round2(s.usd)} of $${settings.monthlyBudgetUsd} used in ${monthName()}, and the next ${purpose} step needs up to $${reserve}`, "BudgetReached");
    }
  }

  // Writes one request to the ledger. Throws if it cannot.
  async function record({ purpose, model, inputTokens, outputTokens, instrumentId = null }) {
    const cost = costOf(model, inputTokens, outputTokens);
    await db.query(
      "insert into trading.api_usage (occurred_at, purpose, model, input_tokens, output_tokens, estimated_cost_usd, instrument_id) values ($1, $2, $3, $4, $5, $6, $7)",
      [now().toISOString(), purpose, model, inputTokens, outputTokens, cost, instrumentId]
    );
    return cost;
  }

  async function status() {
    try {
      const s = await spent();
      const by = await db.query("select purpose, model, count(*) as n, sum(input_tokens) as i, sum(output_tokens) as o, sum(estimated_cost_usd) as usd from trading.api_usage where occurred_at >= $1 group by purpose, model order by usd desc", [monthStart().toISOString()]);
      return {
        available: true, month: monthName(), budgetUsd: settings.monthlyBudgetUsd, spentUsd: round2(s.usd), remainingUsd: round2(Math.max(0, settings.monthlyBudgetUsd - s.usd)), requests: s.requests,
        warning: s.usd >= settings.monthlyBudgetUsd * settings.warnAtFraction ? `${Math.round((s.usd / settings.monthlyBudgetUsd) * 100)}% of the monthly budget is used` : null,
        reached: s.usd + Math.min(...Object.values(settings.stepReserveUsd)) > settings.monthlyBudgetUsd,
        byAgent: by.rows.map((r) => ({ agent: r.purpose, model: r.model, requests: Number(r.n), inputTokens: Number(r.i), outputTokens: Number(r.o), estimatedCostUsd: round2(Number(r.usd)) })),
        note: "estimates at list price, calendar month in UTC; the Anthropic invoice is the real figure",
      };
    } catch (e) {
      return { available: false, budgetUsd: settings.monthlyBudgetUsd, error: `the usage ledger could not be read: ${redact(e?.message)}`, effect: "no agent may run until it can" };
    }
  }

  return { assertRoom, record, status, costOf, spent };
}

module.exports = { createBudget, BudgetError };
