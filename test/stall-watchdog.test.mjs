/**
 * The stall watchdog for unattended runs (src/stall.ts, PLAN-open-work section 13 H6).
 *
 * Two halves. The first drives the watchdog directly with a clock the test owns, for the
 * arithmetic: what counts as activity, when a call in flight is still inside its own time
 * limit, and when a run that will not stop is given up on. The second starts real runs
 * through the runner with small thresholds, for what the arithmetic is wired to: the status
 * and note a stalled run ends with, the queue moving on, and the runs it must leave alone.
 *
 * The thresholds here are milliseconds so the suite takes seconds. The gaps between them are
 * wide on purpose (a tool that must outlast a limit does so by hundreds of milliseconds).
 *
 * Run with: node test/stall-watchdog.test.mjs
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-stall-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.NOTIFY_ON_FAILURE = "false"; // a real push from a test would land on this Mac
process.env.CHAT_AUTO_TITLE = "false";
process.env.REFLECT_ENABLED = "false";
process.env.STALL_IDLE_MS = "200";
process.env.STALL_MODEL_MARGIN_MS = "100";
process.env.STALL_TOOL_MS = "600";
process.env.STALL_GRACE_MS = "600";
process.env.STALL_SWEEP_MS = "25";
delete process.env.CHAT_FIRST;

process.env.POLICY_PATH = path.join(root, "policy.json");
fs.writeFileSync(
  process.env.POLICY_PATH,
  JSON.stringify({
    apps: { allow: [] },
    autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true },
    browser: { enabled: false, navigateAllowlist: [] },
    fs: { readableDirs: [] },
    google: { enabled: false },
    version: 1,
    web: { fetchAllowlist: [], searchEnabled: false },
  }),
);

// A model that answers at once from a script, or after a delay the test sets.
const script = [];
let asked = 0;
let modelDelayMs = 0;
const model = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    asked++;
    const content = script.shift() ?? '{"action":"final","reply":"done","summary":"done"}';
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content, role: "assistant" } }], usage: { total_tokens: 1 } }));
    }, modelDelayMs);
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${model.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_RETRIES = "0";

const config = await import("../src/config.ts");
const store = await import("../src/memory/store.ts");
const { publish, replay } = await import("../src/events.ts");
const queue = await import("../src/queue.ts");
const { startTask, STOPPED_NOTE } = await import("../src/runner.ts");
const stall = await import("../src/stall.ts");
const stop = await import("../src/stop.ts");
const { registry } = await import("../src/tools/index.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const IDLE = config.STALL_IDLE_MS;
const TOOL = config.STALL_TOOL_MS;
const GRACE = config.STALL_GRACE_MS;
const MARGIN = config.STALL_MODEL_MARGIN_MS;

console.log("\nTHE NUMBERS THE CODE SHIPS WITH");
{
  // Read from a clean environment, in a child, because this process has shrunk them.
  const { execFileSync } = await import("node:child_process");
  const env = { ...process.env, SPINE_DB_PATH: path.join(root, "defaults.db") };
  for (const k of ["STALL_IDLE_MS", "STALL_MODEL_MARGIN_MS", "STALL_TOOL_MS", "STALL_GRACE_MS", "STALL_SWEEP_MS", "COMMAND_MAX_TIMEOUT_MS"]) delete env[k];
  const out = execFileSync(
    process.execPath,
    ["-e", 'import("./src/config.ts").then((c) => console.log(JSON.stringify([c.STALL_IDLE_MS, c.STALL_TOOL_MS, c.STALL_GRACE_MS, c.LLM_TIMEOUT_MAX_MS, c.COMMAND_MAX_TIMEOUT_MS])))'],
    { cwd: path.join(import.meta.dirname, ".."), env },
  );
  const [idle, tool, grace, llmMax, commandMax] = JSON.parse(String(out).trim().split("\n").at(-1));
  check("600 seconds idle", idle, 600_000);
  check("a tool is allowed the longest a declared command may run, plus a minute", tool, commandMax + 60_000);
  check("a run that will not stop is given up on after a minute", grace, 60_000);
  check("the idle limit is not shorter than a model call's own timeout", idle >= llmMax, true);
}

// ---------------------------------------------------------------------------------------
// The arithmetic, on a clock the test owns.
// ---------------------------------------------------------------------------------------
let t = 1_000_000;
const restoreClock = stall.__test.setClock(() => t);
const abandoned = [];
const watch = (runId) => stall.watchRun(runId, (note) => abandoned.push({ note, runId }));
const sweep = () => stall.sweepStalls();
const forget = (runId) => {
  stall.unwatchRun(runId);
  stop.clearStop(runId);
};

console.log("\nIDLE TIME");
{
  const run = 700_001;
  watch(run);
  t += IDLE;
  check("exactly the limit is not yet a stall", sweep().stopped, []);
  t += 1;
  check("past it, the run is asked to stop", sweep().stopped, [run]);
  check("through the ordinary stop machinery", stop.isStopRequested(run), true);
  check("with a note that says it stalled", stall.stallNote(run)?.startsWith("Stalled: no model or tool activity"), true);
  check("which is not the note a person's stop leaves", stall.stallNote(run) === STOPPED_NOTE, false);
  check("it is asked once, not on every sweep", sweep().stopped, []);
  forget(run);
}
{
  const run = 700_002;
  watch(run);
  t += IDLE - 10;
  publish(run, { step: 2, type: "step_start" });
  t += IDLE - 10;
  check("any event of the run restarts the clock", sweep().stopped, []);
  t += 20;
  check("and the limit is measured from that event", sweep().stopped, [run]);
  forget(run);
}
{
  const run = 700_003;
  const child = 700_004;
  watch(run);
  stop.linkRun(child, run);
  t += IDLE - 10;
  publish(child, { step: 1, type: "step_start" });
  t += IDLE - 10;
  check("a subagent's work counts for its turn", sweep().stopped, []);
  check("and a stall note is the turn's, whichever run asks", [stall.stallNote(child), stall.stallNote(run)], [null, null]);
  t += 20;
  sweep();
  check("the turn is what stalls", [stall.stallNote(child) === stall.stallNote(run), stop.isStopRequested(child)], [true, true]);
  forget(run);
}

console.log("\nA CALL IN FLIGHT IS JUDGED BY ITS OWN LIMIT");
{
  const run = 700_010;
  watch(run);
  publish(run, { callId: 1, tool: "run_command", type: "tool_call" });
  t += IDLE + 50;
  check("a tool still running past the idle limit is slow, not stalled", sweep().stopped, []);
  t = t - (IDLE + 50) + TOOL;
  check("right up to the longest a tool may take", sweep().stopped, []);
  t += 1;
  check("past that it is a stall", sweep().stopped, [run]);
  forget(run);
}
{
  const run = 700_011;
  watch(run);
  publish(run, { callId: 7, tool: "web_read", type: "tool_call" });
  t += 50;
  publish(run, { callId: 7, status: "executed", tool: "web_read", type: "tool_result" });
  t += IDLE;
  check("a finished tool no longer shields the run, but its result was activity", sweep().stopped, []);
  t += 1;
  check("so the idle limit runs from the result", sweep().stopped, [run]);
  forget(run);
}
{
  const run = 700_012;
  watch(run);
  const budget = IDLE * 3; // a model call allowed longer than the idle limit, as the real one is
  const ended = stall.modelCall(run, budget);
  t += budget + MARGIN;
  check("a model call is the model layer's to time out, for its whole budget and a margin", sweep().stopped, []);
  ended();
  t += IDLE;
  check("its ending is activity", sweep().stopped, []);
  t += 1;
  check("and the idle limit runs from there", sweep().stopped, [run]);
  forget(run);
}
{
  const run = 700_013;
  watch(run);
  stall.modelCall(run, 20);
  t += 20 + MARGIN + 1;
  check("a short call that outlived its own budget does not shield the run on its own", sweep().stopped, []);
  t += IDLE;
  check("once the idle limit has passed too, the run is stalled", sweep().stopped, [run]);
  forget(run);
}
check("a run that is not watched is nobody's to time", typeof stall.modelCall(700_099, 100), "function");
check("and has no note", stall.stallNote(700_099), null);

console.log("\nA PERSON'S STOP IS NOT A STALL");
{
  const run = 700_020;
  watch(run);
  stop.requestStop(run);
  t += IDLE * 5;
  check("a run someone already stopped is left to that stop", sweep().stopped, []);
  check("and is never relabelled", stall.stallNote(run), null);
  forget(run);
}

console.log("\nA RUN THAT WILL NOT STOP IS GIVEN UP ON");
{
  const run = 700_030;
  abandoned.length = 0;
  watch(run);
  t += IDLE + 1;
  sweep();
  t += GRACE - 1;
  check("inside the grace period it is left to end by itself", [sweep().abandoned, abandoned.length], [[], 0]);
  t += 1;
  check("after it, the run is closed out", sweep().abandoned, [run]);
  check("its owner is told once, with the note", [abandoned.length, abandoned[0]?.runId, abandoned[0]?.note === stall.stallNote(run)], [1, run, true]);
  check("and the note says it had to be left behind", stall.stallNote(run)?.includes("did not stop when asked"), true);
  t += GRACE * 3;
  check("it is not given up on twice", [sweep().abandoned, abandoned.length], [[], 1]);
  forget(run);
}
check("nothing is left watched", stall.__test.watchedCount(), 0);
restoreClock();

// ---------------------------------------------------------------------------------------
// Real runs through the runner, on the real clock.
// ---------------------------------------------------------------------------------------
let toolMs = 0;
let toolReturned = 0;
registry.__slow = {
  argsSchema: "{}",
  checkPolicy: () => ({ allowed: true, reason: "ok" }),
  classify: () => ({ reversibility: "reversible", summary: "wait", target: "test" }),
  description: "Wait a while.",
  name: "__slow",
  run: async () => {
    await new Promise((r) => setTimeout(r, toolMs));
    toolReturned++;
    return "waited";
  },
};
const SLOW = JSON.stringify({ action: "tool", args: {}, tool: "__slow" });
const DONE = JSON.stringify({ action: "final", reply: "done", summary: "done" });
const opts = (kind) => ({ kind, noMemory: true, tier: "standard" });
const row = (runId) => store.getRun(runId);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const outcome = (started) => started.done.then((r) => ({ ok: r.summary }), (e) => ({ threw: e.message }));

console.log("\nSLOW BUT WORKING IS LEFT ALONE");
{
  toolMs = 400; // twice the idle limit, inside the tool limit
  script.push(SLOW, DONE);
  const run = startTask("tidy the folder", opts("schedule"));
  const result = await outcome(run);
  check("a scheduled run whose tool outlasts the idle limit finishes", [result, row(run.runId).status], [{ ok: "done" }, "ok"]);
}
{
  modelDelayMs = 400; // a model reply slower than the idle limit, inside its own timeout
  script.push(DONE);
  const run = startTask("write the brief", opts("schedule"));
  const result = await outcome(run);
  modelDelayMs = 0;
  check("and one whose model call does", [result, row(run.runId).status], [{ ok: "done" }, "ok"]);
}

console.log("\nA STALLED RUN THAT STOPS WHEN ASKED");
{
  toolMs = 850; // past the tool limit (600), back before the grace period ends (1200)
  script.push(SLOW, DONE);
  const before = asked;
  const run = startTask("check the page", opts("schedule"));
  const result = await outcome(run);
  const r = row(run.runId);
  check("it ends as failed, not stopped", r.status, "failed");
  check("with the note that says it stalled", String(r.note).startsWith("Stalled: no model or tool activity"), true);
  check("and not the one for a run that had to be left behind", String(r.note).includes("did not stop when asked"), false);
  check("its caller hears a failure with the same words", result, { threw: r.note });
  check("the model was not asked for another step", asked - before, 1);
  const events = replay(run.runId).map((e) => e.type);
  check("a watching client is told it failed", [events.includes("error"), replay(run.runId).at(-1)?.status], [true, "failed"]);
  check("it is no longer watched", stall.__test.watchedCount(), 0);
}

console.log("\nA STALLED RUN THAT NEVER RETURNS");
{
  toolMs = 2600; // far past the tool limit and the grace period after it
  toolReturned = 0;
  script.length = 0; // the run above stalled before it could ask for its second step
  script.push(SLOW, DONE);
  const run = startTask("fetch the report", opts("schedule"));
  const result = await outcome(run);
  const r = row(run.runId);
  check("it is closed out while its tool is still running", [toolReturned, r.status], [0, "failed"]);
  check("the note says it stalled and was left behind", [String(r.note).startsWith("Stalled:"), String(r.note).includes("did not stop when asked")], [true, true]);
  check("its caller hears that", result, { threw: r.note });
  check("the queue has let go of it", queue.queueStatus(), { depth: 0, running: false });
  // The next job does not wait for the hung tool.
  const before = asked;
  script.length = 0;
  const next = startTask("what is on today", opts("chat"));
  const nextResult = await outcome(next);
  check("the next job runs while the tool is still hung", [nextResult, toolReturned, asked - before], [{ ok: "done" }, 0, 1]);
  // When the tool does come back, its run is already over: nothing changes and nothing more is asked.
  const askedBefore = asked;
  while (toolReturned === 0) await wait(50);
  await wait(200);
  const after = row(run.runId);
  check("when the tool finally returns, the record is unchanged", [after.status, after.note === r.note], ["failed", true]);
  check("and the run takes no further step", asked - askedBefore, 0);
  check("it is no longer watched", stall.__test.watchedCount(), 0);
}

console.log("\nRUNS A PERSON IS WATCHING ARE NOT ITS BUSINESS");
{
  toolMs = 850; // the same tool that stalled the scheduled run above
  script.push(SLOW, DONE);
  const run = startTask("look this up for me", opts("chat"));
  const result = await outcome(run);
  check("a chat turn is never interrupted", [result, row(run.runId).status], [{ ok: "done" }, "ok"]);
}

console.log("\nWAITING IS NOT STALLING");
{
  // The second job sits in the queue for longer than the idle limit while the first one works.
  toolMs = 450;
  script.push(SLOW, DONE, DONE);
  const first = startTask("tidy the folder", opts("schedule"));
  const second = startTask("write the brief", opts("schedule"));
  const results = [await outcome(first), await outcome(second)];
  check("time in the queue is not counted", [results, row(second.runId).status], [[{ ok: "done" }, { ok: "done" }], "ok"]);
}
{
  // Parked for a chat turn whose model call takes longer than the idle limit.
  queue.__test.setChatFirst(true);
  toolMs = 100;
  script.push(SLOW); // the background run's first step; it parks at the boundary after its tool
  const bg = startTask("tidy the folder", opts("schedule"));
  await wait(40); // its model call has been answered and its tool is running
  modelDelayMs = 500;
  script.push(DONE, DONE);
  const chat = startTask("what is on today", opts("chat"));
  const chatResult = await outcome(chat);
  modelDelayMs = 0;
  const bgResult = await outcome(bg);
  queue.__test.setChatFirst(false);
  check("the chat turn finishes first", chatResult, { ok: "done" });
  check("time parked for it is not counted against the background run", [bgResult, row(bg.runId).status], [{ ok: "done" }, "ok"]);
}

model.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
