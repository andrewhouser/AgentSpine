/**
 * The system prompt is a contract, and this pins its bytes (docs/PLAN-open-work.md, section 13, H1).
 *
 * Prefill is the slowest thing on the model host, and the server only reuses its cache for the
 * part of a prompt that is byte-for-byte what it saw last time. So one reworded sentence near the
 * top of `system()` makes every thread pay for the whole prefix again, and nothing in a diff says
 * so. This suite makes that a reviewed change: it renders the prompt for a FIXED set of stand-in
 * tools, in both modes, and fails until the committed snapshot is updated with it.
 *
 * The tools are stand-ins on purpose. They carry the real names the prompt branches on
 * (`schedule_create`, `draft`, `notify`, `recall_output`, `web_search`), so every conditional
 * paragraph is in the snapshot, but their descriptions are fixed here: rewording one real tool's
 * description is that tool's business and should not fail this suite.
 *
 * To accept a change you meant to make:
 *
 *   UPDATE_SNAPSHOT=1 node test/prompt-snapshot.test.mjs
 *
 * then read the diff of test/fixtures/prompt-snapshot/ before committing it.
 *
 * Run with `node test/prompt-snapshot.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-prompt-snapshot-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
// Every loop switch at its default, set here because config.ts loads .env and a value already in
// the environment wins: a machine whose .env turns one on must not change what this pins.
Object.assign(process.env, { LOCAL_DEEP_THINKING: "false", TOOL_DOCS_MODE: "all" });

const { __test } = await import("../src/agent.ts");
const { recordFriction } = await import("../src/learn/friction.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const stub = (name) => ({
  argsSchema: `{ "input": string }`,
  checkPolicy: () => ({ allowed: true, reason: "test" }),
  classify: () => ({ reversibility: "reversible", summary: name, target: "test" }),
  description: `Stand-in description for ${name}.`,
  name,
  run: async () => "ok",
});
// Order is part of the contract too: the prompt lists tools in registry order.
const NAMES = ["memory_recall", "memory_save", "web_search", "web_read", "read_more", "recall_output", "draft", "notify", "schedule_create"];
const tools = Object.fromEntries(NAMES.map((n) => [n, stub(n)]));

// The clock is the one line that is meant to move. It is replaced here and counted below.
const CLOCK = /^Current local time: .*$/m;
const render = (conversational, set = tools) => __test.systemFor(set, conversational).replace(CLOCK, "Current local time: <clock>");

const dir = path.join(import.meta.dirname, "fixtures", "prompt-snapshot");
const UPDATE = process.env.UPDATE_SNAPSHOT === "1";

/** Where two texts first differ, as one readable line, so a failure names the sentence. */
const firstDifference = (a, b) => {
  const [x, y] = [a.split("\n"), b.split("\n")];
  const at = x.findIndex((line, i) => line !== y[i]);
  const i = at === -1 ? Math.min(x.length, y.length) : at;
  return `line ${i + 1}: now ${JSON.stringify((x[i] ?? "<end>").slice(0, 120))}, snapshot ${JSON.stringify((y[i] ?? "<end>").slice(0, 120))}`;
};

console.log("\nthe system prompt snapshot\n");

console.log("THE PROMPT MATCHES WHAT WAS COMMITTED");
for (const [mode, conversational] of [["chat", true], ["job", false]]) {
  const file = path.join(dir, `${mode}.txt`);
  const now = render(conversational);
  if (UPDATE) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, now);
    console.log(`  wrote ${path.relative(process.cwd(), file)} (${now.length} characters)`);
    continue;
  }
  const committed = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (committed === null) {
    check(`${mode}: a snapshot exists (run with UPDATE_SNAPSHOT=1 to create it)`, false, true);
    continue;
  }
  const same = now === committed;
  check(`${mode}: byte-identical to test/fixtures/prompt-snapshot/${mode}.txt`, same, true);
  if (!same) {
    console.log(`        ${firstDifference(now, committed)}`);
    console.log("        If you meant this, rerun with UPDATE_SNAPSHOT=1 and commit the fixture with the change.");
  }
}

console.log("\nWHAT IS ALLOWED TO MOVE, AND WHAT IS NOT");
check("the same tools render the same bytes twice", render(true) === render(true), true);
check("exactly one line carries the clock", __test.systemFor(tools, true).split("\n").filter((l) => CLOCK.test(l)).length, 1);
check("chat and job prompts are different contracts", render(true) === render(false), false);

// The two things H1 names as moving the prefix today. Pinned as they ARE, not as they should be:
// bench/h1-prefix.mjs measures what each costs, and whoever moves one out changes these lines.
{
  const { notify: _notify, ...withoutNotify } = tools;
  const [full, less] = [render(true), render(true, withoutNotify)];
  check("dropping notify changes the prompt (settingTools does this per turn)", full === less, false);
  check("  and the two prompts part ways inside the tool list, not after it", less.indexOf("- schedule_create:") < full.indexOf("- schedule_create:"), true);
}
{
  const before = render(true);
  recordFriction("web_read", "ERROR: fetch timed out after 30000ms", 1);
  const after = render(true);
  check("a tool error changes the prompt for every later run (friction notes)", before === after, false);
  check("  by one line, under the tool that failed", after.includes("Stand-in description for web_read.\n    Recent failures with this tool: timeout."), true);
  check("  and nothing before that tool's entry moved", after.slice(0, after.indexOf("- web_read:")), before.slice(0, before.indexOf("- web_read:")));
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
