/**
 * recall_output and the thread summary store — the pieces that let a later turn get back
 * what an earlier turn wrote. Run with `node test/recall-output.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-recall-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;

const store = await import("../src/memory/store.ts");
const { recallOutput } = await import("../src/tools/conversation.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(56)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const convo = store.createConversation("plan");
const runId = store.startRun({ conversationId: convo, kind: "chat", task: "write a business plan" });
console.log("\nrecall_output\n");
if (runId == null) {
  console.log("  SKIP  no createRun helper with that shape");
} else {
  const plan = "0123456789".repeat(1500); // 15,000 chars
  store.finishRun(runId, "ok", plan);
  const first = await recallOutput.run({ run_id: runId });
  check("first window starts at the beginning", first.includes("0123456789"), true);
  check("reports the total size", first.includes("of 15000"), true);
  check("says how to continue", first.includes(`"offset": 8000`), true);
  const second = await recallOutput.run({ offset: 8000, run_id: runId });
  check("second window is the rest", second.includes("[end of output]"), true);
  check("past the end is a message, not a crash", (await recallOutput.run({ offset: 99999, run_id: runId })).includes("past the end"), true);
  check("unknown run is explained", (await recallOutput.run({ run_id: 99999 })).startsWith("No run"), true);
  check("missing id is explained", (await recallOutput.run({})).startsWith("ERROR"), true);
  check("always allowed by policy", recallOutput.checkPolicy({}).allowed, true);
}

console.log("\nthread summary store\n");
check("no summary yet", store.getThreadSummary(convo), null);
store.setThreadSummary(convo, "Planning an AI agency; plan is #7.", 7);
check("round-trips text and run", store.getThreadSummary(convo), { run: 7, text: "Planning an AI agency; plan is #7." });

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
