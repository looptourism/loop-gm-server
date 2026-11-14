// ---------------------------------------------------------------------------
// What each agent must hand in, and the code that checks it.
//
// The schema tells the model the shape; the validator is what actually
// decides. Nothing an agent submits is saved unless it passes: required
// fields present, values in range, and — above all — every evidence tag is
// one a tool really issued in that run. The validator returns plain-English
// errors, which are sent back to the agent so it can correct itself.
// ---------------------------------------------------------------------------
const str = (description) => ({ type: "string", description });
const list = (description, items = { type: "string" }) => ({ type: "array", description, items });

const evidence = list("The data behind your conclusion. One item per claim.", {
  type: "object",
  properties: { ref: str("Reference tag from a tool result, e.g. R3 or N7"), claim: str("What this data shows, in one sentence") },
  required: ["ref", "claim"],
});
const exitConditions = list("Conditions for closing the position that the desk can monitor.", {
  type: "object",
  properties: {
    type: { type: "string", enum: ["price_below", "price_above", "date_after", "other"], description: "price_below = stop / invalidation level; price_above = target; date_after = time limit; other = described in words" },
    value: { type: ["number", "null"], description: "The price level for price_below / price_above; otherwise null" },
    date: { type: ["string", "null"], description: "YYYY-MM-DD for date_after; otherwise null" },
    description: str("The condition in plain words, and why"),
  },
  required: ["type", "description"],
});
const confidence = { type: "number", description: "0 to 1: how well the evidence supports your conclusion. Not a probability of profit." };

const SUBMIT = {
  analysis: {
    name: "submit_analysis",
    description: "Hand in your finished analysis. Call exactly once, after you have read the data you need.",
    input_schema: {
      type: "object",
      properties: {
        recommendation: { type: "string", enum: ["buy", "hold", "avoid"] },
        thesis: str("Your reasoning in a few short paragraphs"),
        evidence,
        entry_conditions: list("When to enter. Empty if you do not recommend buying."),
        exit_conditions: exitConditions,
        suggested_amount_usd: { type: ["number", "null"], description: "US dollars to invest if buying; null otherwise" },
        holding_period: str("Expected holding period, e.g. '2 to 6 weeks'. 'n/a' if not buying."),
        risks: list("The main risks"),
        analytical_confidence: confidence,
        assumptions: list("Assumptions your conclusion depends on"),
        data_gaps: list("Data you needed and did not have, or that was stale. Empty if none."),
      },
      required: ["recommendation", "thesis", "evidence", "entry_conditions", "exit_conditions", "suggested_amount_usd", "holding_period", "risks", "analytical_confidence", "assumptions", "data_gaps"],
    },
  },
  risk: {
    name: "submit_risk_review",
    description: "Hand in your critique of the analysis. Call exactly once.",
    input_schema: {
      type: "object",
      properties: {
        stance: { type: "string", enum: ["no_objection", "caution", "object"], description: "Your overall opinion of acting on the analysis" },
        summary: str("Your critique in a short paragraph"),
        concerns: list("Each concern separately.", {
          type: "object",
          properties: { topic: { type: "string", enum: ["downside", "concentration", "volatility", "data_quality", "reasoning", "other"] }, severity: { type: "string", enum: ["low", "medium", "high"] }, detail: str("What worries you and why") },
          required: ["topic", "severity", "detail"],
        }),
        claims_checked: list("Claims of the analysis you verified against the data, and what you found"),
        evidence,
        suggested_max_amount_usd: { type: ["number", "null"], description: "If you think the amount should be smaller, the most you would be comfortable with; null if you have no view" },
        analytical_confidence: confidence,
        assumptions: list("Assumptions your critique depends on"),
      },
      required: ["stance", "summary", "concerns", "claims_checked", "evidence", "suggested_max_amount_usd", "analytical_confidence", "assumptions"],
    },
  },
  decisions: {
    name: "submit_decisions",
    description: "Hand in one decision for every instrument you were given. Call exactly once.",
    input_schema: {
      type: "object",
      properties: {
        decisions: list("One entry per instrument, including those with no trade.", {
          type: "object",
          properties: {
            symbol: str("The instrument's ticker"),
            decision: { type: "string", enum: ["propose_buy", "no_trade"] },
            amount_usd: { type: ["number", "null"], description: "US dollars to invest; null for no_trade" },
            rationale: str("Why, in plain words the owner can read on a phone"),
            disagreements: list("Every point where the analyst and the risk reviewer differ. Empty only if they agree.", {
              type: "object",
              properties: { issue: str("What they disagree about"), analyst_position: str("The analyst's position"), risk_position: str("The risk reviewer's position"), my_view: str("Your own view and why — or that it remains open") },
              required: ["issue", "analyst_position", "risk_position", "my_view"],
            }),
            entry_conditions: list("When to enter. Empty for no_trade."),
            exit_conditions: exitConditions,
            holding_period: str("Expected holding period; 'n/a' for no_trade"),
            risks: list("The main risks"),
            evidence,
            analytical_confidence: confidence,
            assumptions: list("Assumptions the decision depends on"),
          },
          required: ["symbol", "decision", "amount_usd", "rationale", "disagreements", "entry_conditions", "exit_conditions", "holding_period", "risks", "evidence", "analytical_confidence", "assumptions"],
        }),
        portfolio_note: str("Your view of the set as a whole: overlap, exposure, anything the owner should know"),
      },
      required: ["decisions", "portfolio_note"],
    },
  },
};

// ---- validators -------------------------------------------------------------
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isList = (v, check = isStr) => Array.isArray(v) && v.every(check);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function checkEvidence(v, toolbox, errors, where, min) {
  if (!Array.isArray(v)) { errors.push(`${where}evidence must be a list`); return; }
  v.forEach((e, i) => {
    if (!e || !isStr(e.ref) || !isStr(e.claim)) errors.push(`${where}evidence[${i}] needs "ref" and "claim"`);
    else if (!toolbox.has(e.ref.trim())) errors.push(`${where}evidence[${i}] cites ${e.ref}, which no tool returned in this run. Cite only tags you received.`);
  });
  if (v.length < min) errors.push(`${where}needs at least ${min} evidence item(s) citing tool results`);
}
function checkExit(v, errors, where, required) {
  if (!Array.isArray(v)) { errors.push(`${where}exit_conditions must be a list`); return; }
  v.forEach((c, i) => {
    if (!c || !["price_below", "price_above", "date_after", "other"].includes(c.type) || !isStr(c.description)) { errors.push(`${where}exit_conditions[${i}] needs a valid "type" and a "description"`); return; }
    if ((c.type === "price_below" || c.type === "price_above") && !(isNum(c.value) && c.value > 0)) errors.push(`${where}exit_conditions[${i}] (${c.type}) needs a positive "value"`);
    if (c.type === "date_after" && !/^\d{4}-\d{2}-\d{2}$/.test(c.date || "")) errors.push(`${where}exit_conditions[${i}] (date_after) needs "date" as YYYY-MM-DD`);
  });
  if (required && v.length === 0) errors.push(`${where}needs at least one exit condition`);
}
const checkConfidence = (v, errors, where) => { if (!(isNum(v) && v >= 0 && v <= 1)) errors.push(`${where}analytical_confidence must be a number from 0 to 1`); };
const checkAmount = (v, buying, errors, where, name) => {
  if (buying && !(isNum(v) && v > 0)) errors.push(`${where}${name} must be a positive number when buying`);
  if (!buying && v !== null && v !== undefined && !isNum(v)) errors.push(`${where}${name} must be a number or null`);
};

const VALIDATE = {
  analysis(x, toolbox) {
    const errors = [];
    if (!x || typeof x !== "object") return ["the submission must be an object"];
    const buying = x.recommendation === "buy";
    if (!["buy", "hold", "avoid"].includes(x.recommendation)) errors.push('recommendation must be "buy", "hold" or "avoid"');
    if (!isStr(x.thesis)) errors.push("thesis is required");
    checkEvidence(x.evidence, toolbox, errors, "", buying ? 3 : 1);
    if (!isList(x.entry_conditions)) errors.push("entry_conditions must be a list of strings");
    else if (buying && x.entry_conditions.length === 0) errors.push("a buy recommendation needs at least one entry condition");
    checkExit(x.exit_conditions, errors, "", buying);
    checkAmount(x.suggested_amount_usd, buying, errors, "", "suggested_amount_usd");
    if (!isStr(x.holding_period)) errors.push("holding_period is required");
    if (!isList(x.risks) || x.risks.length === 0) errors.push("risks must list at least one risk");
    checkConfidence(x.analytical_confidence, errors, "");
    if (!isList(x.assumptions)) errors.push("assumptions must be a list of strings");
    if (!isList(x.data_gaps)) errors.push("data_gaps must be a list of strings");
    return errors;
  },
  risk(x, toolbox) {
    const errors = [];
    if (!x || typeof x !== "object") return ["the submission must be an object"];
    if (!["no_objection", "caution", "object"].includes(x.stance)) errors.push('stance must be "no_objection", "caution" or "object"');
    if (!isStr(x.summary)) errors.push("summary is required");
    const okConcern = (c) => c && ["downside", "concentration", "volatility", "data_quality", "reasoning", "other"].includes(c.topic) && ["low", "medium", "high"].includes(c.severity) && isStr(c.detail);
    if (!isList(x.concerns, okConcern)) errors.push("each concern needs a valid topic, a severity and a detail");
    else if (x.stance !== "no_objection" && x.concerns.length === 0) errors.push("a stance of caution or object needs at least one concern");
    if (!isList(x.claims_checked)) errors.push("claims_checked must be a list of strings");
    checkEvidence(x.evidence, toolbox, errors, "", 1);
    checkAmount(x.suggested_max_amount_usd, false, errors, "", "suggested_max_amount_usd");
    checkConfidence(x.analytical_confidence, errors, "");
    if (!isList(x.assumptions)) errors.push("assumptions must be a list of strings");
    return errors;
  },
  // `symbols`: every instrument the Portfolio Manager was given.
  decisions(x, toolbox, { symbols }) {
    const errors = [];
    if (!x || typeof x !== "object" || !Array.isArray(x.decisions)) return ["the submission needs a decisions list"];
    if (!isStr(x.portfolio_note)) errors.push("portfolio_note is required");
    const seen = new Set();
    x.decisions.forEach((d, i) => {
      const where = `decisions[${i}]${d && isStr(d.symbol) ? ` (${d.symbol})` : ""}: `;
      if (!d || !isStr(d.symbol)) { errors.push(`${where}symbol is required`); return; }
      const s = d.symbol.trim().toUpperCase();
      if (!symbols.includes(s)) errors.push(`${where}${s} was not given to you`);
      if (seen.has(s)) errors.push(`${where}appears twice`);
      seen.add(s);
      const buying = d.decision === "propose_buy";
      if (!["propose_buy", "no_trade"].includes(d.decision)) errors.push(`${where}decision must be "propose_buy" or "no_trade"`);
      checkAmount(d.amount_usd, buying, errors, where, "amount_usd");
      if (!isStr(d.rationale)) errors.push(`${where}rationale is required`);
      const okDis = (g) => g && isStr(g.issue) && isStr(g.analyst_position) && isStr(g.risk_position) && isStr(g.my_view);
      if (!isList(d.disagreements, okDis)) errors.push(`${where}each disagreement needs issue, analyst_position, risk_position and my_view`);
      if (!isList(d.entry_conditions)) errors.push(`${where}entry_conditions must be a list of strings`);
      else if (buying && d.entry_conditions.length === 0) errors.push(`${where}a proposal needs at least one entry condition`);
      checkExit(d.exit_conditions, errors, where, buying);
      if (!isStr(d.holding_period)) errors.push(`${where}holding_period is required`);
      if (!isList(d.risks) || (buying && d.risks.length === 0)) errors.push(`${where}risks must be a list${buying ? " with at least one risk" : ""}`);
      checkEvidence(d.evidence, toolbox, errors, where, buying ? 2 : 1);
      checkConfidence(d.analytical_confidence, errors, where);
      if (!isList(d.assumptions)) errors.push(`${where}assumptions must be a list of strings`);
    });
    for (const s of symbols) if (!seen.has(s)) errors.push(`no decision was given for ${s}`);
    return errors;
  },
};

// Replaces each cited tag with the full record the toolbox holds for it:
// source and timestamp come from the desk's own data, not from the agent.
function expandEvidence(items, toolbox) {
  return items.map((e) => {
    const rec = toolbox.record(e.ref.trim());
    return { ref: e.ref.trim(), claim: e.claim, kind: rec.kind, source: rec.source, timestamp: rec.timestamp, label: rec.label, rowIds: rec.ids };
  });
}

module.exports = { SUBMIT, VALIDATE, expandEvidence };
