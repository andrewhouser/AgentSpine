/**
 * LP6 (PLAN-open-work section 10): tool descriptions on demand. With TOOL_DOCS_MODE=core, a core set keeps its full
 * description, the rest are one line each, and tool_help reads the rest; the default ("all") is unchanged. Then the
 * real loop against a stand-in model: it reads a tool's instructions before using it, and a failed call to an unread
 * tool is told how to read them.
 *
 * Run with `node test/tool-docs.test.mjs`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-tooldocs-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.POLICY_PATH = path.join(root, "policy.json");
fs.writeFileSync(process.env.POLICY_PATH, JSON.stringify({ apps: { allow: [] }, autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true }, browser: { enabled: false, navigateAllowlist: [] }, fs: { readableDirs: [] }, google: { enabled: false }, version: 1, web: { fetchAllowlist: [], searchEnabled: false } }));

let script = [];
const prompts = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    prompts.push(body);
    const content = script.shift() ?? '{"action":"final","summary":"done"}';
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content, role: "assistant" } }], usage: { completion_tokens: 5, prompt_tokens: 50 } }));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${model.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_RETRIES = "0";

const store = await import("../src/memory/store.ts");
const { registry } = await import("../src/tools/index.ts");
const { CORE_TOOLS, SHOW_ALL_UNDER, toolDocs } = await import("../src/tool-docs.ts");
const { __test, runAgent } = await import("../src/agent.ts");
const { loadPolicy } = await import("../src/config.ts");
const { registerHarness } = await import("../src/harness.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const setMode = (m) => (m ? (process.env.TOOL_DOCS_MODE = m) : delete process.env.TOOL_DOCS_MODE);

console.log("\nTHE DEFAULT IS UNCHANGED");
{
  setMode(undefined);
  const all = toolDocs(registry);
  check("every tool is described in full", Object.values(registry).every((t) => all.includes(`- ${t.name}: ${t.description}`)), true);
  check("there is no one-line index", all.includes("More tools you can use"), false);
  check("and a chat is not offered tool_help", "tool_help" in __test.settingTools(registry, true, "hi"), false);
}

console.log("\nCORE MODE");
{
  setMode("core");
  const all = (setMode(undefined), toolDocs(registry));
  setMode("core");
  const core = toolDocs(registry);
  check("core tools keep their full description", [...CORE_TOOLS].filter((n) => registry[n]).every((n) => core.includes(`- ${n}: ${registry[n].description}`)), true);
  check("the rest are one line, with their name", core.includes("- draft: Write a proposed email reply") && !core.includes(registry.draft.description), true);
  check("the index says how to read a tool's instructions", core.includes('"tool":"tool_help","args":{"names":["<name>"]}'), true);
  check("every tool is still named", Object.keys(registry).every((n) => core.includes(`- ${n}:`)), true);
  check("it is much shorter: under half the characters", core.length < all.length / 2, true);
  check("the same each time, so the cached prefix holds", toolDocs(registry), core);
  check("a chat in core mode is offered tool_help", "tool_help" in __test.settingTools(registry, true, "hi"), true);
  const few = Object.fromEntries(Object.entries(registry).slice(0, SHOW_ALL_UNDER));
  check("a small tool set (a unit) is shown in full", toolDocs(few).includes("More tools you can use"), false);
  console.log(`  (tool descriptions: ${all.length} characters in full, ${core.length} in core mode)`);
}

console.log("\ntool_help");
{
  const help = registry.tool_help;
  const one = await help.run({ names: ["draft"] }, { runId: null });
  check("it returns the full instructions", one.includes(registry.draft.description) && one.includes("args:"), true);
  check("an unknown name says so", await help.run({ names: ["teleport"] }, { runId: null }), "- teleport: not a tool you can use here.");
  check("no names is refused, worded to fix", (await help.run({}, { runId: null })).startsWith('ERROR: tool_help needs "names"'), true);
  const runId = store.startRun({ kind: "subagent", task: "unit" });
  registerHarness({ conversational: false, rootRunId: runId, runId, tools: ["read_file", "tool_help"] });
  check("only for tools this run can use", await help.run({ names: ["draft"] }, { runId }), "- draft: not a tool you can use here.");
  check("it is read-only and always allowed", [help.classify({}).reversibility, help.checkPolicy({}).allowed], ["reversible", true]);
}

console.log("\nIN THE LOOP");
{
  setMode("core");
  let ran = 0;
  registry.__lp6_tool = {
    argsSchema: '{ "colour": "red" | "blue" }',
    checkPolicy: (_p, a) => (a?.colour === "red" || a?.colour === "blue" ? { allowed: true } : { allowed: false, reason: "colour must be red or blue" }),
    classify: () => ({ reversibility: "reversible", summary: "paint", target: "lp6" }),
    description: "Paint the test fence. The colour must be red or blue, nothing else.",
    name: "__lp6_tool",
    run: async () => (ran++, "painted"),
  };
  const policy = loadPolicy();
  const go = async (replies) => {
    script = [...replies];
    prompts.length = 0;
    const runId = store.startRun({ kind: "chat", task: "paint" });
    return runAgent("Paint the fence.", policy, runId, { conversational: false, tier: "standard" });
  };
  const r1 = await go([
    JSON.stringify({ action: "tool", args: { names: ["__lp6_tool"] }, tool: "tool_help" }),
    JSON.stringify({ action: "tool", args: { colour: "red" }, tool: "__lp6_tool" }),
    '{"action":"final","summary":"painted it red"}',
  ]);
  check("the first prompt lists the tool in one line only", prompts[0].includes("- __lp6_tool: Paint the test fence.") && !prompts[0].includes("The colour must be red or blue"), true);
  check("tool_help put its full instructions in the history", prompts[1].includes("The colour must be red or blue, nothing else."), true);
  check("and the system prompt itself did not change", JSON.parse(prompts[0]).messages[0].content === JSON.parse(prompts[1]).messages[0].content, true);
  check("then the tool ran, and the run finished", [ran, r1.summary], [1, "painted it red"]);
  const r2 = await go([JSON.stringify({ action: "tool", args: { colour: "green" }, tool: "__lp6_tool" }), '{"action":"final","summary":"gave up"}']);
  const told = r2.trace.some((m) => typeof m.content === "string" && m.content.includes("You called __lp6_tool without reading its instructions"));
  check("a failed call to an unread tool is told to read its instructions", told, true);
  await go([
    JSON.stringify({ action: "tool", args: { names: ["__lp6_tool"] }, tool: "tool_help" }),
    JSON.stringify({ action: "tool", args: { colour: "green" }, tool: "__lp6_tool" }),
    '{"action":"final","summary":"gave up"}',
  ]);
  check("but not once it has read them", prompts.at(-1).includes("without reading its instructions"), false);
  setMode(undefined);
  const r4 = await go([JSON.stringify({ action: "tool", args: { colour: "green" }, tool: "__lp6_tool" }), '{"action":"final","summary":"gave up"}']);
  check("in the default mode there is no such hint", r4.trace.some((m) => typeof m.content === "string" && m.content.includes("without reading")), false);
  delete registry.__lp6_tool;
}

model.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
