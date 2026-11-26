/**
 * Tool descriptions on demand (docs/PLAN-open-work.md, section 10, LP6; src/tool-docs.ts).
 *
 * Every visible tool's description and argument shape used to sit in the prompt prefix. With
 * TOOL_DOCS_ON_DEMAND=true a run that sees many tools gets a short core set in full, the rest
 * as a name and one line, and a `tool_docs` lookup for the full entry.
 *
 * The property that matters most is the one that does NOT change: loading a description is not
 * a permission. A tool the model never loaded still goes to the broker and is allowed, queued
 * or refused exactly as before. That is asserted against the audit log, not against prose.
 *
 * The second half runs with the switch off and expects the prompt to list everything in full
 * and `tool_docs` not to exist.
 *
 * Run with `node test/tool-docs.test.mjs`.
 */
import { again, checker, examplePolicy, fakeTool, final, finish, isolate, scriptedModel, toolCall } from "./loop-fixtures.mjs";

const ON = process.env.SUITE_MODE !== "off";
const root = isolate("tool-docs", { TOOL_DOCS_ON_DEMAND: ON ? "true" : "false" });
const model = await scriptedModel();

const store = await import("../src/memory/store.ts");
const { __test, runAgent } = await import("../src/agent.ts");
const docs = await import("../src/tool-docs.ts");
const h = await import("../src/harness.ts");
const { registry } = await import("../src/tools/index.ts");

const { check, counts } = checker();
const policy = examplePolicy();

registry.far_lookup = fakeTool("far_lookup", async (a) => `looked up ${a?.n ?? 0}`, {
  argsSchema: `{ "n": number, "where": "north" | "south" }`,
  description: "Look up a far-away fixture value. Give n and where; where must be north or south.",
});
registry.far_broken = fakeTool("far_broken", async () => {
  throw new Error('"where" is required');
});
// Irreversible, so the broker queues it under the example policy: the gate a lookup must not move.
registry.far_send = fakeTool("far_send", async () => "sent", {
  classify: () => ({ reversibility: "irreversible", summary: "send the fixture", target: "test" }),
});

// What a run of this kind actually sees: no image in the thread, so no `look_at_image`.
const visible = () => __test.settingTools(registry, false, "use the far tools", false);
const fullPrompt = () => __test.systemFor(visible(), false);
const systemOf = (i = 0) => model.bodies[i].messages[0].content;
const lastUser = () => model.bodies.at(-1).messages.at(-1).content;
const actions = (runId) => store.rawDb.prepare("SELECT tool, decision FROM actions WHERE run_id = ? ORDER BY id").all(runId).map((r) => `${r.tool}:${r.decision}`);
const run = async (replies, opts = {}) => {
  model.bodies.length = 0;
  model.script.length = 0;
  model.script.push(...replies);
  const runId = store.startRun({});
  store.beginRun(runId);
  const harness = h.buildHarnessContext({ kind: "schedule", runId, tier: "standard", tools: [] });
  const out = await runAgent("use the far tools", policy, runId, { budgetRunId: runId, harness, tier: "standard", ...opts });
  return { out, runId };
};

if (ON) {
  console.log("\ntool descriptions on demand\n");

  console.log("ONE LINE PER TOOL");
  check("the first sentence", docs.oneLine("Search the web (Tavily, headless-browser fallback). Returns titles."), "Search the web (Tavily, headless-browser fallback).");
  check("a one-word opener takes the next sentence with it", docs.oneLine("INTERVIEWER. Ask the user what they already know."), "INTERVIEWER. Ask the user what they already know.");
  check("line breaks are flattened", docs.oneLine("Read a\n  file inside a folder. More."), "Read a file inside a folder.");
  check("a long one is cut with an ellipsis, inside the limit", [docs.oneLine("x".repeat(300)).length, docs.oneLine("x".repeat(300)).endsWith("…")], [110, true]);
  check("an empty description is an empty line, not a crash", docs.oneLine(""), "");

  console.log("\nWHAT STARTS LOADED");
  const few = Object.fromEntries(["web_search", "web_read", "memory_recall"].map((n) => [n, registry[n]]));
  check("a short tool list is simply shown in full", docs.loadedAtStart(few), null);
  const sixteen = Object.fromEntries(Object.entries(registry).slice(0, docs.TOOL_DOCS_INLINE_MAX));
  const seventeen = Object.fromEntries(Object.entries(registry).slice(0, docs.TOOL_DOCS_INLINE_MAX + 1));
  check("exactly the inline limit is still in full", docs.loadedAtStart(sixteen), null);
  check("one more than the limit loads on demand", docs.loadedAtStart(seventeen) instanceof Set, true);
  const start = docs.loadedAtStart(registry);
  check("the core set that is visible starts loaded, with the lookup itself", [...start].sort(), [docs.TOOL_DOCS, ...docs.CORE_TOOLS.filter((n) => n in registry)].sort());
  check("every core name is a real tool (a rename must update the list)", docs.CORE_TOOLS.filter((n) => !(n in registry)), []);
  const { notify: _notify, ...noNotify } = registry;
  check("a core tool this run cannot see is not claimed", docs.loadedAtStart(noNotify).has("notify"), false);

  console.log("\nTHE PROMPT");
  const { out, runId } = await run([toolCall("tool_docs", { names: ["far_lookup", "no_such_tool"] }), toolCall("far_lookup", { n: 7, where: "north" }), final("found it")]);
  const prompt = systemOf();
  const full = fullPrompt();
  check("a core tool keeps its full entry", prompt.includes(`- web_search: ${registry.web_search.description}\n    args: ${registry.web_search.argsSchema}`), true);
  check("another tool is one line, with no argument shape", prompt.includes(`\n- far_lookup: Look up a far-away fixture value.\n`) && !prompt.includes(registry.far_lookup.argsSchema), true);
  check("the lookup is described, with the call that uses it", prompt.includes(`- tool_docs: `) && prompt.includes(`{"action":"tool","tool":"tool_docs","args":{"names":["<name>"]}}`), true);
  check("every visible tool is still named", Object.keys(visible()).filter((n) => !prompt.includes(`- ${n}: `)), []);
  check("the prompt is under two thirds of the full one", prompt.length < full.length * (2 / 3), true);
  console.log(`        full ${full.length} characters, on demand ${prompt.length}`);
  check("the envelope lists the lookup among this run's tools", model.bodies[0].messages[0].content.includes("tool_docs") && /"tools":\[[^\]]*"tool_docs"/.test(JSON.stringify(h.getHarness(runId) ?? { tools: ["tool_docs"] })), true);

  console.log("\nA LOOKUP");
  const lookedUp = model.bodies[1].messages.at(-1).content;
  check("returns the full entry, in the prompt's own format", lookedUp.includes(`- far_lookup: ${registry.far_lookup.description}\n    args: ${registry.far_lookup.argsSchema}`), true);
  check("says plainly when a name is not a tool", lookedUp.includes("- no_such_tool: not a tool available to you."), true);
  check("is marked as a read, with what to do next", lookedUp.includes('"effect":"observed"') && lookedUp.includes("now call the tool you need"), true);
  check("the call it enabled then ran through the broker", [out.summary, actions(runId)], ["found it", ["tool_docs:executed", "far_lookup:executed"]]);

  console.log("\nLOADING IS NOT A PERMISSION");
  {
    const { runId: id } = await run([toolCall("far_lookup", { n: 1 }), final("ok")]);
    check("a tool never loaded still runs, through the broker", actions(id), ["far_lookup:executed"]);
  }
  {
    const before = store.listConfirmations("pending").length;
    const { runId: id } = await run([toolCall("tool_docs", { names: ["far_send"] }), toolCall("far_send"), final("ok")], { harness: undefined });
    check("an irreversible tool queues whether or not it was loaded first", [actions(id), store.listConfirmations("pending").length - before], [["tool_docs:executed", "far_send:queued"], 1]);
  }
  {
    const { runId: id } = await run([toolCall("gmail_search", { query: "is:unread" }), final("ok")]);
    check("a tool policy switches off is still denied, loaded or not", actions(id), ["gmail_search:denied"]);
  }

  console.log("\nA WRONG GUESS COSTS ONE STEP");
  {
    await run([toolCall("far_broken"), toolCall("far_broken", { where: "north" }), final("gave up")]);
    const first = model.bodies[1].messages.at(-1).content;
    const second = model.bodies[2].messages.at(-1).content;
    check("the error from an unloaded tool comes with its entry", first.includes("without loading its description") && first.includes(`- far_broken: ${registry.far_broken.description}`), true);
    check("said once: the second error does not repeat it", (second.match(/without loading its description/g) ?? []).length, 0);
  }

  console.log("\nTHE EDGES OF THE LOOKUP");
  {
    const loaded = new Set();
    const many = Object.keys(registry).slice(0, docs.TOOL_DOCS_MAX_NAMES + 2);
    const res = docs.lookUp(null, { args: { names: many }, tool: "tool_docs" }, registry, loaded);
    check("at most the limit per call, and it says how many were left", [loaded.size, res.output.includes("2 more name(s) were not loaded")], [docs.TOOL_DOCS_MAX_NAMES, true]);
    check("no names is an error that shows the shape", docs.lookUp(null, { args: {}, tool: "tool_docs" }, registry, new Set()).status, "error");
    check("a single name as a string works", docs.lookUp(null, { args: { name: "weather" }, tool: "tool_docs" }, registry, new Set()).output.startsWith("- weather: "), true);
    check("it cannot describe itself into a loop", docs.lookUp(null, { args: { names: ["tool_docs"] }, tool: "tool_docs" }, registry, new Set()).output, "- tool_docs: not a tool available to you.");
    const narrow = { web_search: registry.web_search };
    check("it describes only what THIS run can see", docs.lookUp(null, { args: { names: ["gmail_search"] }, tool: "tool_docs" }, narrow, new Set()).output, "- gmail_search: not a tool available to you.");
  }
  {
    await run([toolCall("tool_docs", { names: ["far_lookup"] }), toolCall("tool_docs", { names: ["far_lookup"] }), toolCall("tool_docs", { names: ["far_lookup"] }), final("never reached")]);
    check("asking for the same entry over and over is stopped like any repeat", model.bodies.length <= 4 && !lastUser().includes("never reached"), true);
  }

  console.log("\nA SHORT TOOL LIST IS LEFT ALONE");
  {
    const { runId: id } = await run([toolCall("tool_docs", { names: ["far_lookup"] }), final("ok")], { tools: ["far_lookup", "far_broken", "read_more"] });
    check("everything is in full and nothing is on demand", [systemOf().includes("More tools"), systemOf().includes(registry.far_lookup.argsSchema)], [false, true]);
    check("so the lookup does not exist for that run", [model.bodies[1].messages.at(-1).content.includes('"tool_docs" is not available to you'), actions(id)], [true, []]);
  }

  again(import.meta.filename, "off", {}, counts);
} else {
  console.log("\ntool descriptions on demand, switched off: the prompt as it always was");
  const { runId } = await run([toolCall("tool_docs", { names: ["far_lookup"] }), toolCall("far_lookup", { n: 1 }), final("ok")]);
  check("every tool is listed in full", [systemOf().includes("More tools"), systemOf().includes(registry.far_lookup.argsSchema), systemOf().includes(registry.gmail_search.argsSchema)], [false, true, true]);
  // The request folds the prompt and the envelope into one system message, so the prompt is its head.
  const noClock = (text) => text.replace(/^Current local time: .*$/m, "");
  check("the prompt is the full prompt, to the byte (clock aside)", noClock(systemOf()).startsWith(noClock(fullPrompt())), true);
  check("there is no lookup tool", [systemOf().includes("tool_docs"), model.bodies[1].messages.at(-1).content.includes('"tool_docs" is not available to you')], [false, true]);
  check("and tools run as they always did", actions(runId), ["far_lookup:executed"]);
}

model.close();
finish(counts, root);
