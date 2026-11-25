/**
 * LP5 (PLAN-open-work section 10): a person goes ahead of background work. The queue itself first, then a real
 * scheduled run through the runner with a stand-in model: a chat turn started while the job is working is answered
 * at the job's next step boundary, and the job then carries on and finishes.
 *
 * Run with `node test/queue-lanes.test.mjs`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-lanes-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.NOTIFY_ON_FAILURE = "false";
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

// The stand-in model answers by which run is asking, and records the order it was asked in.
const order = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const text = body;
    let content = '{"action":"final","reply":"ok","summary":"ok"}';
    if (text.includes("CHAT-QUESTION")) {
      order.push("chat");
      content = "The chat answer.";
    } else if (text.includes("NIGHTLY-JOB")) {
      const afterTool = text.includes("LP5-TOOL-DONE");
      order.push(afterTool ? "job:after-tool" : "job:first");
      content = afterTool ? '{"action":"final","reply":"job done","summary":"job done"}' : JSON.stringify({ action: "tool", args: {}, tool: "__lp5_tool" });
    }
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

const { enqueue, queueStatus, yieldToPerson } = await import("../src/queue.ts");
const { startTask } = await import("../src/runner.ts");
const { registry } = await import("../src/tools/index.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const tick = () => new Promise((r) => setImmediate(r));

console.log("\nTHE QUEUE: A PERSON GOES FIRST");
{
  const log = [];
  let releaseA;
  const a = enqueue(() => new Promise((r) => { log.push("A start"); releaseA = () => { log.push("A end"); r(); }; }), "background");
  const b = enqueue(async () => { log.push("B"); }, "background");
  const p = enqueue(async () => { log.push("P"); }, "person");
  await tick();
  check("the first background job holds the model", log, ["A start"]);
  releaseA();
  await Promise.all([a, b, p]);
  check("the person runs before background work that was waiting", log, ["A start", "A end", "P", "B"]);
  check("and the queue is empty after", queueStatus(), { depth: 0, paused: 0, running: false });
}

console.log("\nTHE QUEUE: A RUNNING BACKGROUND JOB HANDS OVER AT A STEP");
{
  const log = [];
  let gate;
  const job = enqueue(async () => {
    log.push("job step 1");
    await new Promise((r) => (gate = r)); // the step's model call, in flight
    log.push(`job yielded: ${await yieldToPerson()}`);
    log.push("job step 2");
  }, "background");
  const later = enqueue(async () => { log.push("other job"); }, "background");
  await tick();
  const person = enqueue(async () => { log.push("person"); }, "person");
  await tick();
  check("a call in flight is not interrupted", log, ["job step 1"]);
  gate();
  await Promise.all([job, later, person]);
  check("at the boundary the person goes, then the job resumes before other work", log, ["job step 1", "person", "job yielded: true", "job step 2", "other job"]);
}

console.log("\nTHE QUEUE: WHEN NOT TO YIELD");
{
  const log = [];
  await enqueue(async () => { log.push(`nobody waiting: ${await yieldToPerson()}`); }, "background");
  let inPerson = "";
  const p1 = enqueue(async () => { await tick(); inPerson = String(await yieldToPerson()); }, "person");
  const p2 = enqueue(async () => {}, "person");
  await Promise.all([p1, p2]);
  check("a background job with nobody waiting carries on", log, ["nobody waiting: false"]);
  check("a person's own run never yields, even with another person waiting", inPerson, "false");
  check("outside the queue it is a no-op", await yieldToPerson(), false);
}

console.log("\nTHE QUEUE: A SUBAGENT YIELDS WITH ITS PARENT");
{
  const log = [];
  let gate;
  const job = enqueue(async () => {
    await new Promise((r) => (gate = r));
    // Stands in for a subagent's loop: further down the same async chain, never told its lane.
    const child = async () => log.push(`child yielded: ${await yieldToPerson()}`);
    await child();
  }, "background");
  await tick();
  const person = enqueue(async () => { log.push("person"); }, "person");
  gate();
  await Promise.all([job, person]);
  check("the lane follows the async chain", log, ["person", "child yielded: true"]);
}

console.log("\nTHE QUEUE: A JOB THAT THROWS STRAIGHT AWAY STILL RELEASES THE MODEL");
{
  const bad = enqueue(() => { throw new Error("boom"); }, "background");
  const after = enqueue(async () => "next ran", "person");
  check("the error reaches the caller", await bad.then(() => "no error", (e) => e.message), "boom");
  check("and the next job still runs", await after, "next ran");
}

console.log("\nA REAL SCHEDULED RUN AND A CHAT TURN");
{
  let chatRun = null;
  registry.__lp5_tool = {
    argsSchema: "{}",
    checkPolicy: () => ({ allowed: true }),
    classify: () => ({ reversibility: "reversible", summary: "slow work", target: "lp5" }),
    description: "Slow work for the LP5 test.",
    name: "__lp5_tool",
    run: async () => {
      // The person sends a message while the job is in the middle of its work.
      chatRun = startTask("CHAT-QUESTION: what is on today?", { kind: "chat", tier: "standard" });
      await tick();
      return "LP5-TOOL-DONE";
    },
  };
  const job = startTask("NIGHTLY-JOB: do the slow work.", { kind: "schedule", tier: "standard" });
  const jobResult = await job.done;
  const chatResult = await chatRun.done;
  // Each run makes follow-up calls after its main answer, which carry its text too, so repeats are collapsed.
  const sequence = order.filter((x, i) => x !== order[i - 1]);
  check("the chat was answered at the job's next step, not after the whole job", sequence, ["job:first", "chat", "job:after-tool"]);
  check("the chat got its answer", chatResult.summary.includes("The chat answer"), true);
  check("the job was paused, not stopped, and finished", jobResult.summary, "job done");
  delete registry.__lp5_tool;
}

model.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
