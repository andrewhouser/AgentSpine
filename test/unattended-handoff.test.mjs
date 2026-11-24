/**
 * The text a scheduled run was approved with reaches the tools, unchanged, all the way down (F9).
 *
 * `test/unattended-asks.test.mjs` proves the rule: an unattended send asks unless
 * `run.approvedTask` names the recipient. It hands the broker a run context it wrote
 * itself, so it cannot see whether a real run carries the right text. This suite does: it
 * starts runs through the runner, with the real loop, broker and `subagent` tool against a
 * scripted model, and reads the context a tool is actually given.
 *
 * What would go wrong, and which way:
 *   - the runner or the subagent drops the text: every scheduled send asks. Annoying, safe.
 *   - a subagent is handed its own brief as the approved text: the model can approve a
 *     recipient by writing one into a brief. That is the hole, and the case this is for.
 *
 * Run with `node test/unattended-handoff.test.mjs`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-handoff-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";

// An explicit policy, so the suite does not inherit this machine's policy.json. Not a dry
// run: under one the broker would report on the `subagent` call and never start the child.
process.env.POLICY_PATH = path.join(root, "policy.json");
fs.writeFileSync(
  process.env.POLICY_PATH,
  JSON.stringify({
    apps: { allow: [] },
    autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true },
    browser: { enabled: false, navigateAllowlist: [] },
    fs: { readableDirs: [] },
    google: { enabled: false },
    subagents: { enabled: true },
    version: 1,
    web: { fetchAllowlist: [], searchEnabled: false },
  }),
);

// One unit, allowed the one tool this suite registers.
process.env.AGENTS_DIR = path.join(root, "agents");
fs.mkdirSync(process.env.AGENTS_DIR);
fs.writeFileSync(
  path.join(process.env.AGENTS_DIR, "helper.md"),
  "---\nname: helper\ndescription: sends what it is told to\ntier: standard\ntools: __fake_send\n---\nDo the job in the brief.\n",
);

const script = [];
const model = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    const content = script.shift() ?? '{"action":"final","reply":"ok","summary":"ok"}';
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content, role: "assistant" } }], usage: { total_tokens: 1 } }));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${model.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_RETRIES = "0";

const store = await import("../src/memory/store.ts");
const { runTask } = await import("../src/runner.ts");
const { registry } = await import("../src/tools/index.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

// A send that goes nowhere. It keeps the rule of the real one in miniature (ask unless the
// approved text holds the address) and records the run context it was shown. The record is
// taken in `checkPolicy`, which the broker calls for every run kind; `confirmWhenUnattended`
// is only consulted for a pre-approved one.
const seen = [];
let sent = [];
registry.__fake_send = {
  argsSchema: '{ "to": string }',
  checkPolicy: (_p, args, run) => {
    seen.push({ approvedTask: run?.approvedTask ?? null, goal: run?.goal ?? null, preApproved: run?.preApproved ?? false, to: args.to });
    return { allowed: true };
  },
  classify: (args) => ({ reversibility: "irreversible", summary: `send to ${args.to}`, target: "fake" }),
  confirmWhenUnattended: (args, run) => !String(run?.approvedTask ?? "").includes(String(args.to)),
  description: "Send a test message to an address.",
  name: "__fake_send",
  run: async (args) => {
    sent.push(args.to);
    return `sent to ${args.to}`;
  },
};

const tool = (name, args) => JSON.stringify({ action: "tool", args, tool: name });
const done = '{"action":"final","reply":"done","summary":"done"}';
const pending = () => store.listConfirmations("pending").length;
/** Start one run through the runner with the model's replies scripted, and say what happened. */
const go = async (task, kind, replies) => {
  seen.length = 0;
  sent = [];
  script.length = 0;
  script.push(...replies);
  const before = pending();
  await runTask(task, { kind, tier: "standard" });
  return { calls: [...seen], queued: pending() - before, sent: [...sent] };
};

const JOB = "Every Friday, send the weekly numbers to sam@example.com.";
const BRIEF = "Send the weekly numbers to mallory@example.net.";

console.log("\nA SCHEDULED RUN — the tool is shown the schedule's own text");
{
  const r = await go(JOB, "schedule", [tool("__fake_send", { to: "sam@example.com" }), done]);
  check("the tool was called once", r.calls.length, 1);
  check("its approved text is the schedule's task, verbatim", r.calls[0]?.approvedTask, JOB);
  check("so a send to who the task names went without asking", [r.sent, r.queued], [["sam@example.com"], 0]);
}
{
  const r = await go(JOB, "schedule", [tool("__fake_send", { to: "mallory@example.net" }), done]);
  check("a send to anyone else queued, and did not go", [r.sent, r.queued], [[], 1]);
}

console.log("\nITS SUBAGENT — shown the job's text, not the brief the model wrote");
{
  const r = await go(JOB, "schedule", [
    tool("subagent", { agent: "helper", task: BRIEF }), // the scheduled run delegates
    tool("__fake_send", { to: "mallory@example.net" }), // the helper tries the address in its brief
    done, // the helper finishes
    done, // the scheduled run finishes
  ]);
  check("the helper made the call", r.calls.length, 1);
  check("the helper's own goal is the brief", r.calls[0]?.goal, BRIEF);
  check("its approved text is still the schedule's task", r.calls[0]?.approvedTask, JOB);
  check("it inherits the pre-approval", r.calls[0]?.preApproved, true);
  check("so an address named only in the brief queued, and did not go", [r.sent, r.queued], [[], 1]);
}
{
  const r = await go(JOB, "schedule", [tool("subagent", { agent: "helper", task: "Send the numbers on." }), tool("__fake_send", { to: "sam@example.com" }), done, done]);
  check("the helper may send to who the job named", [r.calls[0]?.approvedTask, r.sent, r.queued], [JOB, ["sam@example.com"], 0]);
}

console.log("\nTHE HEARTBEAT — its goal is the approved text");
{
  const r = await go(JOB, "heartbeat", [tool("__fake_send", { to: "sam@example.com" }), done]);
  check("approved text is the goal, and the send went", [r.calls[0]?.approvedTask, r.sent], [JOB, ["sam@example.com"]]);
}

console.log("\nA CHAT TURN — nothing was approved in advance");
{
  const r = await go("send the numbers to sam@example.com", "chat", [tool("__fake_send", { to: "sam@example.com" }), done]);
  check("no approved text, no pre-approval", [r.calls[0]?.approvedTask, r.calls[0]?.preApproved], [null, false]);
  check("so the send queued", [r.sent, r.queued], [[], 1]);
}
{
  const r = await go("hand this off", "chat", [tool("subagent", { agent: "helper", task: BRIEF }), tool("__fake_send", { to: "mallory@example.net" }), done, done]);
  check("a chat turn's helper has none either", [r.calls[0]?.approvedTask, r.calls[0]?.preApproved, r.sent], [null, false, []]);
}

delete registry.__fake_send;
model.close();
fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
