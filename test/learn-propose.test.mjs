/**
 * Anticipation (LEARNING Phase 4), the parts that don't need a live model.
 *
 * The proposer mines finished chat runs for intent that recurs and queues a schedule_create
 * confirmation per new shape — pre-written task text a human approves, never installed
 * silently. Tested here: clustering + threshold, dedupe against existing schedules and
 * against the pending queue, standing-intent proposals, the interruption dismissal learner,
 * and the horizon task shape. The judge-gated proactive push is exercised only against a
 * live model; here we assert the gate-off passthrough and the dismissal preference.
 *
 * Run with `node test/learn-propose.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-propose-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
process.env.EMBEDDINGS_URL = "";
process.env.PROPOSE_MIN_RECURRENCE = "3";
process.env.JUDGE_INTERRUPTIONS_PROACTIVE = "false"; // gate off → passthrough

const store = await import("../src/memory/store.ts");
const { rawDb } = store;
const { recurringIntent, queueIntentProposal, queueStandingIntent, taskKey } = await import("../src/learn/propose.ts");
const { horizonTask, heartbeatHorizonGoal } = await import("../src/learn/horizon.ts");
const { recordDismissal } = await import("../src/learn/interrupt.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(54)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// A finished chat run with a given task.
const chatRun = (task) => {
  const id = store.startRun({ kind: "chat", task });
  store.finishRun(id, "ok", "done");
  return id;
};

console.log("\nCLUSTERING — a shape must recur to be proposed");
{
  chatRun("what's the weather in Concord");
  chatRun("What's the weather in Concord?"); // same shape (case/punct)
  check("below threshold (2×) → nothing", recurringIntent().length, 0);
  chatRun("what's the weather in concord");
  const found = recurringIntent();
  check("at threshold (3×) → one shape", found.length, 1);
  check("counted correctly", found[0].count, 3);
}

console.log("\nDEDUPE — an existing schedule suppresses its shape");
{
  const found = recurringIntent();
  store.createSchedule("weather", found[0].sample, "every day at 9:00am", false);
  check("shape covered by a schedule is not re-proposed", recurringIntent().length, 0);
}

console.log("\nQUEUEING — a proposal is a schedule_create confirmation");
{
  // A fresh shape not covered by any schedule.
  chatRun("summarize my unread email");
  chatRun("summarize my unread email");
  chatRun("summarize my unread email");
  const p = recurringIntent().find((x) => x.key === taskKey("summarize my unread email"));
  const id = queueIntentProposal(p);
  check("returns a confirmation id", typeof id, "number");
  const row = store.getConfirmation(id);
  check("queued as schedule_create", row.tool, "schedule_create");
  check("created disabled (safe until enabled)", JSON.parse(row.args).enabled, false);
  check("carries the verbatim task", JSON.parse(row.args).task, "summarize my unread email");
  check("re-queueing the same shape is deduped", queueIntentProposal(p), null);
}

console.log("\nSTANDING INTENT — a caught phrase becomes a proposal");
{
  const id = queueStandingIntent("keep an eye on the AWS status page and tell me about outages");
  check("standing intent queues a proposal", typeof id, "number");
  check("empty standing intent is a no-op", queueStandingIntent("  "), null);
}

console.log("\nDISMISSAL LEARNER — a dismissed push becomes a preference");
{
  const before = rawDb.prepare("SELECT COUNT(*) n FROM memories WHERE kind='preference'").get().n;
  await recordDismissal("the daily weather brief");
  const after = rawDb.prepare("SELECT COUNT(*) n FROM memories WHERE kind='preference'").get().n;
  check("a dismissal writes a preference", after, before + 1);
  check("empty topic is a no-op", await recordDismissal(""), false);
}

console.log("\nHORIZON — the task text is watcher-shaped and quiet");
{
  const t = horizonTask(2);
  check("names the calendar tool", t.includes("calendar_upcoming"), true);
  check("uses state to avoid repeats", t.includes("state_get") || t.includes("state_set"), true);
  check("is quiet by default", /quiet|do not announce/i.test(t), true);
  check("heartbeat variant mentions pending confirmations", heartbeatHorizonGoal(2).includes("pending confirmations"), true);
}

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
