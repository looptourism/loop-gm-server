// ---------------------------------------------------------------------------
// Runs ONE agent: sends the prompt to Claude, answers its tool calls from the
// toolbox, and stops when the agent hands in a submission that passes the
// validator. Fails closed — a refusal, a cut-off answer, an API error, too
// many rounds, or a submission that is still invalid after two corrections
// all end with { ok: false } and nothing to save.
//
// The conversation is append-only: Claude's own content (including its
// thinking blocks) is sent back unchanged every round.
// ---------------------------------------------------------------------------
const MAX_CORRECTIONS = 2;

async function runAgent({ anthropic, settings, system, task, tools, submit, toolbox, validate, redact = (t) => t }) {
  const usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  const messages = [{ role: "user", content: task }];
  const allTools = [...tools, submit];
  const toolCalls = [];
  let corrections = 0, nudged = false, model = settings.model;
  const fail = (error, extra = {}) => ({ ok: false, error: redact(error), usage, model, toolCalls, ...extra });

  for (let turn = 0; turn < settings.maxTurns; turn++) {
    let res;
    try {
      res = await anthropic.messages.create({ model: settings.model, max_tokens: settings.maxTokens, system, messages, tools: allTools }, { timeout: settings.timeoutMs });
    } catch (e) {
      return fail(`Claude API error${e?.status ? ` ${e.status}` : ""}: ${e?.message || e}`);
    }
    usage.requests++;
    const u = res.usage || {};
    usage.inputTokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    usage.outputTokens += u.output_tokens || 0;
    if (res.model) model = res.model;

    if (res.stop_reason === "refusal") return fail("Claude declined the request", { stopReason: "refusal" });
    if (res.stop_reason === "max_tokens") return fail("Claude's answer was cut off (max_tokens)", { stopReason: "max_tokens" });
    const content = Array.isArray(res.content) ? res.content : [];
    messages.push({ role: "assistant", content });

    const calls = content.filter((b) => b.type === "tool_use");
    if (calls.length === 0) {
      if (nudged) return fail(`the agent ended without calling ${submit.name}`);
      nudged = true;
      messages.push({ role: "user", content: `You have not handed in your result. Call ${submit.name} now.` });
      continue;
    }

    const results = [];
    let accepted = null;
    for (const call of calls) {
      if (call.name === submit.name) {
        const errors = validate(call.input);
        if (errors.length === 0) { accepted = call.input; results.push({ type: "tool_result", tool_use_id: call.id, content: "accepted" }); }
        else { results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Not accepted. Fix these and call ${submit.name} again:\n- ${errors.join("\n- ")}` }); corrections++; }
        continue;
      }
      toolCalls.push(call.name);
      try { results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(await toolbox.execute(call.name, call.input)) }); }
      catch (e) { results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: redact(e?.message || String(e)) }); }
    }
    if (accepted) return { ok: true, output: accepted, usage, model, toolCalls, turns: turn + 1 };
    if (corrections > MAX_CORRECTIONS) return fail(`the submission was still invalid after ${MAX_CORRECTIONS} corrections`);
    messages.push({ role: "user", content: results });
  }
  return fail(`no valid submission within ${settings.maxTurns} rounds`);
}

module.exports = { runAgent };
