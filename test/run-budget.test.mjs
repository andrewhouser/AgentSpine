/**
 * LP3 (PLAN-open-work section 10): budgets by tokens and time, with compaction. The compactor on its own first, then
 * the real agent loop against a stand-in model: a run that never finishes stops on its token or time budget, is warned
 * once before that, does not spend its time budget while paused for a person, and has old tool results swapped for
 * stubs that read_more brings back.
 *
 * Run with `node test/run-budget.test.mjs`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-budget-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.COMPACT_AT_TOKENS = "3000";
process.env.POLICY_PATH = path.join(root, "policy.json");
fs.writeFileSync(
  process.env.POLICY_PATH,
  JSON.stringify({ apps: { allow: [] }, autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true }, browser: { enabled: false, navigateAllowlist: [] }, fs: { readableDirs: [] }, google: { enabled: false }, version: 1, web: { fetchAllowlist: [], searchEnabled: false } }),
);

// The stand-in model replies from a script; when the script runs out it calls the test tool again, so a run only
// ends by budget unless the script says final. It reports usage like the real host does.
let script = [];
let promptTokens = 100;
const prompts = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    prompts.push(body);
    const content = script.length ? script.shift() : JSON.stringify({ action: "tool", args: { n: prompts.length }, tool: "__lp3_tool" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content, role: "assistant" } }], usage: { completion_tokens: 10, prompt_tokens: promptTokens, total_tokens: promptTokens + 10 } }));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${model.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_RETRIES = "0";

const store = await import("../src/memory/store.ts");
const { runAgent } = await import("../src/agent.ts");
const { registry } = await import("../src/tools/index.ts");
const { compactMessages, estimateTokens } = await import("../src/compact.ts");
const { holdText, readMore } = await import("../src/stash.ts");
const { enqueue } = await import("../src/queue.ts");
const { loadPolicy } = await import("../src/config.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

let toolDelayMs = 0;
let onTool = null;
const BIG = "x".repeat(8000);
registry.__lp3_tool = {
  argsSchema: '{ "n"?: number }',
  checkPolicy: () => ({ allowed: true }),
  classify: () => ({ reversibility: "reversible", summary: "look something up", target: "lp3" }),
  description: "Look something up for the LP3 test.",
  name: "__lp3_tool",
  run: async (args) => {
    if (onTool) await onTool();
    if (toolDelayMs) await new Promise((r) => setTimeout(r, toolDelayMs));
    return `result ${args?.n ?? ""} ${BIG}`;
  },
};
const policy = loadPolicy();
const run = async (goal, opts = {}) => {
  const runId = store.startRun({ kind: "chat", task: goal });
  return runAgent(goal, policy, runId, { conversational: false, tier: "standard", ...opts });
};

console.log("\nTHE COMPACTOR");
{
  const result = (n) => ({ content: `tool result [executed]:\nresult ${n} ${"y".repeat(4000)}`, role: "user" });
  const base = () => [
    { content: "system prompt", role: "system" },
    { content: "the goal", role: "user" },
    { content: '{"action":"tool"}', role: "assistant" }, result(1),
    { content: '{"action":"tool"}', role: "assistant" }, result(2),
    { content: '{"action":"tool"}', role: "assistant" }, result(3),
    { content: '{"action":"tool"}', role: "assistant" }, result(4),
  ];
  const held = [];
  const hold = (t) => (held.push(t), `ref${held.length}`);
  const small = base();
  check("under the threshold nothing changes", compactMessages(small, { atTokens: 100_000, from: 2, hold, keepRecent: 2, toFraction: 0.6 }).stubs, 0);
  const msgs = base();
  const r = compactMessages(msgs, { atTokens: 3000, from: 2, hold, keepRecent: 2, toFraction: 0.6 });
  check("the oldest results become stubs", [msgs[3].content.includes("Compacted"), msgs[5].content.includes("Compacted")], [true, true]);
  check("the newest two stay whole", [msgs[7].content.includes("Compacted"), msgs[9].content.includes("Compacted")], [false, false]);
  check("the prefix is untouched", [msgs[0].content, msgs[1].content], ["system prompt", "the goal"]);
  check("a stub keeps the status line and names its ref", /^tool result \[executed\]:\n\[agentspine\] Compacted .* ref ref1\./.test(msgs[3].content), true);
  check("and the full text is what was held", held[0].startsWith("tool result [executed]:\nresult 1 "), true);
  check("the estimate fell", r.after < r.before, true);
  compactMessages(msgs, { atTokens: 3000, from: 2, hold, keepRecent: 2, toFraction: 0.6 });
  check("a stub is never stubbed again", held.length, 2);
  const nohold = base();
  check("nothing is dropped when it cannot be held", compactMessages(nohold, { atTokens: 3000, from: 2, hold: () => null, keepRecent: 2, toFraction: 0.6 }).stubs, 0);
  check("the estimate counts characters over four", estimateTokens([{ content: "abcdefgh", role: "user" }]), 2);
  const runId = store.startRun({ kind: "chat", task: "hold" });
  const ref = holdText(runId, "an earlier tool result", "the whole earlier result");
  check("a held result reads back through read_more, tagged", /the whole earlier result/.test(readMore(runId, ref, 0).text) && /UNTRUSTED/.test(readMore(runId, ref, 0).text), true);
  check("and only by its own run", readMore(runId + 999, ref, 0).ok, false);
}

console.log("\nTHE TOKEN BUDGET");
{
  script = [];
  promptTokens = 5000;
  // 22,000 so one step lands in the warning band (80%) before the next one crosses the budget.
  const r = await run("Look things up forever.", { maxSteps: 30, tokenBudget: 22_000 });
  check("a run that never finishes stops on tokens, well before the step ceiling", r.steps < 30, true);
  check("it stops at the step where the budget ran out (five calls of 5,010)", r.steps, 5);
  const warnedAt = r.trace.findIndex((m) => typeof m.content === "string" && m.content.includes("used most of this run's budget"));
  check("and was warned once before that", [warnedAt > 0, r.trace.filter((m) => typeof m.content === "string" && m.content.includes("used most of this run's budget")).length], [true, 1]);
  promptTokens = 100;
}

console.log("\nTHE TIME BUDGET");
{
  script = [];
  toolDelayMs = 120;
  const r = await run("Look things up slowly.", { maxSteps: 30, timeBudgetMs: 400 });
  check("a slow run stops on time, before the ceiling", r.steps < 30 && r.steps >= 2, true);
  toolDelayMs = 0;
}

console.log("\nTIME PAUSED FOR A PERSON DOES NOT COUNT");
{
  // A background run's tool lets a person in; the person holds the model for longer than the whole time budget.
  script = [JSON.stringify({ action: "tool", args: { n: 1 }, tool: "__lp3_tool" }), '{"action":"final","summary":"job finished"}'];
  let person;
  onTool = async () => {
    onTool = null;
    person = enqueue(() => new Promise((r) => setTimeout(r, 700)), "person");
  };
  const r = await enqueue(() => run("A background job.", { maxSteps: 10, timeBudgetMs: 500 }), "background");
  await person;
  check("the job finished after the pause instead of running out of time", r.summary, "job finished");
}

console.log("\nCOMPACTION IN A REAL RUN");
{
  script = [];
  const r = await run("Read four long things, then stop.", { maxSteps: 5, tokenBudget: 10_000_000 });
  const stubs = r.trace.filter((m) => typeof m.content === "string" && m.content.includes("[agentspine] Compacted"));
  check("older long results were swapped for stubs", stubs.length > 0, true);
  const lastTwo = r.trace.filter((m) => typeof m.content === "string" && /^tool result \[/.test(m.content)).slice(-2);
  check("the newest two results are whole", lastTwo.every((m) => !m.content.includes("Compacted")), true);
  const ref = /ref ([0-9a-f]{12})/.exec(stubs[0]?.content ?? "")?.[1];
  check("a stub names a real held ref", typeof ref === "string", true);
  // Counted in what the model was actually sent on the run's last step (the request carrying the most tool results;
  // the closing call after it sends a summary, not the history): at most the newest two in full.
  const mine = prompts.filter((p) => p.includes("Read four long things"));
  const results = (p) => (p.match(/tool result \[/g) ?? []).length;
  const lastStep = mine.reduce((a, b) => (results(b) >= results(a) ? b : a), "");
  check("the last step sent every result read, but at most two of them in full", [results(lastStep) > 2, (lastStep.match(/x{8000}/g) ?? []).length <= 2], [true, true]);
}

console.log("\nA RUN WITHOUT read_more IS NEVER COMPACTED");
{
  script = [];
  const r = await run("Read long things with a narrow tool set.", { maxSteps: 4, tokenBudget: 10_000_000, tools: ["__lp3_tool"] });
  check("no stubs, because nothing could be read back", r.trace.some((m) => typeof m.content === "string" && m.content.includes("[agentspine] Compacted")), false);
}

delete registry.__lp3_tool;
model.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
