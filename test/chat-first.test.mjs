/**
 * Chat goes ahead of background work (PLAN-open-work section 10, LP5): src/queue.ts,
 * src/turn-gate.ts and the one `yieldToChat` call in the agent loop.
 *
 * These start real runs through the runner, with the real loop and broker, against a model
 * that answers only when the test lets it. So the order the model is ASKED in is the thing
 * measured: that is what "who holds the model" means on a host that serves one request at a
 * time.
 *
 * What they guard:
 *   - switched off (the default), the queue is first-in first-out exactly as before;
 *   - switched on, a chat turn takes the model at a background run's next step boundary, and
 *     the background run then resumes and finishes;
 *   - chat turns keep their order, and a background run never goes ahead of anything;
 *   - a run stopped while it is parked ends as stopped and never asks the model again;
 *   - a subagent parks its whole turn.
 *
 * Run with: node test/chat-first.test.mjs
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-chatfirst-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.NOTIFY_ON_FAILURE = "false";
process.env.CHAT_AUTO_TITLE = "false";
process.env.REFLECT_ENABLED = "false";
process.env.STALL_IDLE_MS = "0"; // the watchdog has its own suite
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
    subagents: { enabled: true },
    version: 1,
    web: { fetchAllowlist: [], searchEnabled: false },
  }),
);
process.env.AGENTS_DIR = path.join(root, "agents");
fs.mkdirSync(process.env.AGENTS_DIR);
fs.writeFileSync(
  path.join(process.env.AGENTS_DIR, "helper.md"),
  "---\nname: helper\ndescription: does one small thing\ntier: standard\ntools: __tick\n---\nDo the job in the brief.\n",
);

// A model that holds every request until the test answers it, and says whose it is. Each
// task carries a marker word, which is how a request is matched to its run.
const MARKERS = ["BG-ONE", "BG-TWO", "CHAT-A", "CHAT-B", "SUB-JOB"];
const arrived = [];
let wake = null;
const model = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    // A helper is sent only its brief. Its parent's later prompts quote that brief back (it is
    // in the tool call the parent made), so a turn's own marker wins over the helper's.
    const own = MARKERS.filter((m) => m !== "SUB-JOB").find((m) => raw.includes(m));
    const who = own ?? (raw.includes("SUB-JOB") ? "SUB-JOB" : "?");
    arrived.push({
      answer: (content) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content, role: "assistant" } }], usage: { total_tokens: 1 } }));
      },
      who,
    });
    wake?.();
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
const { replay } = await import("../src/events.ts");
const queue = await import("../src/queue.ts");
const { startTask, STOPPED_NOTE } = await import("../src/runner.ts");
const stop = await import("../src/stop.ts");
const gate = await import("../src/turn-gate.ts");
const { registry } = await import("../src/tools/index.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

registry.__tick = {
  argsSchema: "{}",
  checkPolicy: () => ({ allowed: true, reason: "ok" }),
  classify: () => ({ reversibility: "reversible", summary: "tick", target: "test" }),
  description: "Do nothing, once.",
  name: "__tick",
  run: async () => "ticked",
};

const TICK = JSON.stringify({ action: "tool", args: {}, tool: "__tick" });
const DONE = JSON.stringify({ action: "final", reply: "done", summary: "done" });

/** The next request the model is asked, or "none" if it is not asked within a moment. */
const next = async (waitMs = 3000) => {
  if (!arrived.length) {
    await new Promise((r) => {
      const t = setTimeout(r, waitMs);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });
    wake = null;
  }
  return arrived.shift() ?? { answer: () => {}, who: "none" };
};
/** Long enough for a run to get from a model reply to its next request, if it is going to. */
const settle = () => new Promise((r) => setTimeout(r, 150));
const opts = (kind) => ({ kind, noMemory: true, tier: "standard" });
const background = (task) => startTask(`${task}: do the nightly tidy`, opts("schedule"));
const chat = (task) => startTask(`${task}: what is on today`, opts("chat"));
const waitEvent = (runId) => replay(runId).find((e) => e.type === "queue_wait");
const statusOf = (runId) => store.getRun(runId)?.status;

console.log("\nTHE SWITCH");
check("it is off unless asked for", config.CHAT_FIRST, false);

console.log("\nSWITCHED OFF: FIRST IN, FIRST OUT");
{
  const bg = background("BG-ONE");
  const first = await next();
  check("the background run has the model", first.who, "BG-ONE");
  const c = chat("CHAT-A");
  check("the chat turn is told it waits behind one job", waitEvent(c.runId)?.depth, 1);
  check("and not that the job will step aside", waitEvent(c.runId)?.yielding ?? false, false);
  first.answer(TICK);
  const second = await next();
  check("the background run keeps the model for its next step", second.who, "BG-ONE");
  check("it never parked", gate.pausedMs(bg.runId), 0);
  second.answer(DONE);
  const third = await next();
  check("the chat turn runs only after it has finished", [third.who, statusOf(bg.runId)], ["CHAT-A", "ok"]);
  third.answer(DONE);
  await Promise.all([bg.done, c.done]);
  check("both end ok", [statusOf(bg.runId), statusOf(c.runId)], ["ok", "ok"]);
}

queue.__test.setChatFirst(true);

console.log("\nSWITCHED ON: A CHAT TURN TAKES THE MODEL AT THE NEXT STEP BOUNDARY");
{
  const bg = background("BG-ONE");
  const first = await next();
  check("the background run has the model", first.who, "BG-ONE");
  const c = chat("CHAT-A");
  check("the chat turn waits behind one job", waitEvent(c.runId)?.depth, 1);
  check("and is told that job will step aside", waitEvent(c.runId)?.yielding, true);
  // The call in flight is not cut off: the background run gets its reply and runs its tool.
  first.answer(TICK);
  const second = await next();
  check("the chat turn is asked next, not the background run's second step", second.who, "CHAT-A");
  check("the background run is parked", gate.isRunParked(bg.runId), true);
  check("its tool call was not lost", store.erroredTools(bg.runId).length, 0);
  check("and it has not finished", statusOf(bg.runId), "running");
  await settle();
  second.answer(DONE);
  const chatResult = await c.done;
  check("the chat turn finishes while the background run is still open", [chatResult.summary, statusOf(bg.runId)], ["done", "running"]);
  const third = await next();
  check("then the background run resumes", third.who, "BG-ONE");
  check("its parked time is counted", gate.pausedMs(bg.runId) >= 100, true);
  check("and it is no longer parked", gate.isRunParked(bg.runId), false);
  third.answer(DONE);
  const bgResult = await bg.done;
  check("and finishes", [bgResult.summary, statusOf(bg.runId)], ["done", "ok"]);
  check("its parked time is forgotten once it ends", gate.pausedMs(bg.runId), 0);
}

console.log("\nCHAT TURNS KEEP THEIR ORDER, AND BACKGROUND WORK WAITS FOR ALL OF THEM");
{
  const bg1 = background("BG-ONE");
  const first = await next();
  const bg2 = background("BG-TWO"); // queued before either chat turn arrives
  const a = chat("CHAT-A");
  const b = chat("CHAT-B");
  check("the first chat turn waits behind the running job only", waitEvent(a.runId)?.depth, 1);
  check("the second behind that job and the first chat turn", waitEvent(b.runId)?.depth, 2);
  first.answer(TICK);
  const order = [first.who];
  for (let i = 0; i < 4; i++) {
    const r = await next();
    order.push(r.who);
    r.answer(DONE);
  }
  await Promise.all([bg1.done, bg2.done, a.done, b.done]);
  check("the model was asked in this order", order, ["BG-ONE", "CHAT-A", "CHAT-B", "BG-ONE", "BG-TWO"]);
  check("everything ends ok", [bg1, a, b, bg2].map((r) => statusOf(r.runId)), ["ok", "ok", "ok", "ok"]);
}

console.log("\nA BACKGROUND RUN NEVER GOES AHEAD OF ANYTHING");
{
  const c = chat("CHAT-A");
  const first = await next();
  const bg = background("BG-ONE");
  check("a background run waits behind the chat turn", [waitEvent(bg.runId)?.depth, waitEvent(bg.runId)?.yielding ?? false], [1, false]);
  first.answer(TICK);
  const second = await next();
  check("the chat turn keeps the model for its next step", second.who, "CHAT-A");
  check("a chat turn is never parked", gate.pausedMs(c.runId), 0);
  second.answer(DONE);
  const third = await next();
  check("the background run starts after it", third.who, "BG-ONE");
  third.answer(DONE);
  await Promise.all([c.done, bg.done]);
}

console.log("\nSTOP WHILE PARKED");
{
  const bg = background("BG-ONE");
  const first = await next();
  const c = chat("CHAT-A");
  first.answer(TICK);
  const second = await next();
  check("the background run parked for the chat turn", [second.who, gate.isRunParked(bg.runId)], ["CHAT-A", true]);
  stop.requestStop(bg.runId);
  const bgResult = await bg.done;
  check("it ends as stopped, without waiting for the chat turn", [bgResult.summary, statusOf(bg.runId)], [STOPPED_NOTE, "stopped"]);
  check("the chat turn is untouched", statusOf(c.runId), "running");
  second.answer(DONE);
  await c.done;
  const stray = await next(300);
  check("the stopped run never asks the model again", stray.who, "none");
  // The queue is not left holding a slot for it.
  const after = chat("CHAT-B");
  const r = await next();
  r.answer(DONE);
  await after.done;
  check("and the queue carries on", [r.who, statusOf(after.runId), queue.queueStatus()], ["CHAT-B", "ok", { depth: 0, running: false }]);
}

console.log("\nA SUBAGENT PARKS ITS WHOLE TURN");
{
  const bg = background("BG-ONE");
  const first = await next();
  first.answer(JSON.stringify({ action: "tool", args: { agent: "helper", task: "SUB-JOB: tick once" }, tool: "subagent" }));
  const child = await next();
  check("the helper has the model", child.who, "SUB-JOB");
  const c = chat("CHAT-A");
  child.answer(TICK);
  const second = await next();
  check("the chat turn is asked at the helper's step boundary", second.who, "CHAT-A");
  check("the turn is parked through its parent", gate.isRunParked(bg.runId), true);
  await settle();
  second.answer(DONE);
  await c.done;
  const third = await next();
  check("the helper resumes", third.who, "SUB-JOB");
  check("the parent's clock stopped too", gate.pausedMs(bg.runId) >= 100, true);
  third.answer(DONE);
  const fourth = await next();
  check("and hands back to its parent", fourth.who, "BG-ONE");
  fourth.answer(DONE);
  await bg.done;
  check("the turn finishes", statusOf(bg.runId), "ok");
}

model.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
