/**
 * Per-turn model usage for the thread inspector: calls, tokens in and out, by model.
 *
 * Run with `node test/run-usage.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-run-usage-${process.pid}.db`);

const store = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(60)} ${ok ? "" : JSON.stringify(actual)}`);
};

console.log("A turn and its child run");
store.logLlmCall({ completionTokens: 20, model: "big", ms: 1000, promptTokens: 100, runId: 9001, tier: "standard" });
store.logLlmCall({ completionTokens: 5, model: "big", ms: 500, promptTokens: 50, runId: 9001, tier: "standard" });
store.logLlmCall({ completionTokens: 7, model: "small", ms: 200, promptTokens: 30, runId: 9002, tier: "fast" });
const u = store.usageForRuns([9001, 9002]);
check("totals add up across both runs", [u.calls, u.promptTokens, u.completionTokens], [3, 180, 32]);
check("grouped by model and tier", u.byModel.map((m) => [m.model, m.tier, m.calls, m.promptTokens, m.completionTokens, m.ms]), [
  ["big", "standard", 2, 150, 25, 1500],
  ["small", "fast", 1, 30, 7, 200],
]);

console.log("A call whose server reported no usage");
store.logLlmCall({ model: "big", ms: 300, runId: 9003, tier: "standard" });
const n = store.usageForRuns([9003]);
check("counts as a call, adds no tokens, and is flagged", [n.calls, n.promptTokens, n.unreported], [1, 0, 1]);

check("its time stays out of the speed calculation", store.usageForRuns([9001, 9003]).reportedMs, 1500);

console.log("A run with no calls");
check("is empty rather than an error", store.usageForRuns([424242]).calls, 0);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
