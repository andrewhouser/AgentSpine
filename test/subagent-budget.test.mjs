/**
 * Budgets must be counted across a delegation tree, not per run.
 *
 * This is the constraint most likely to regress silently: `countToolCallsInRun` keys on a
 * run id, and a subagent gets its own run row. Pass the child's id as the budget id and
 * "3 web searches per run" quietly becomes three *per unit* — an unbounded allowance
 * dressed as a cap. Nothing visibly breaks; the budget just stops being one.
 *
 * Uses the broker directly against a scratch database, so it needs no model.
 * Run with `node test/subagent-budget.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-budget-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;

const { executeCall } = await import("../src/broker.ts");
const store = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${actual}${ok ? "" : `  (expected ${expected})`}`);
};

// A cap of 2 on a reversible, always-allowed tool that touches nothing.
const policy = {
  autoExecute: { irreversibleAlwaysConfirm: true, reversible: true },
  apps: { allow: [] },
  browser: { enabled: false, navigateAllowlist: [] },
  budgets: { perRun: { tools: { state_set: 2 } } },
  fs: { readableDirs: [] },
  google: { enabled: false },
  version: 1,
  web: { fetchAllowlist: [], searchEnabled: false },
};

const call = (n) => ({ args: { key: `k${n}`, value: "v" }, tool: "state_set" });

const parent = store.startRun({ kind: "do", task: "parent" });
const child = store.startRun({ kind: "subagent", parentRunId: parent, task: "child" });

console.log("\nPER-RUN BUDGET, cap of 2, spent by parent then child");

// Parent spends both.
check("parent call 1", (await executeCall(call(1), policy, parent, parent)).status, "executed");
check("parent call 2", (await executeCall(call(2), policy, parent, parent)).status, "executed");
check("parent call 3 over cap", (await executeCall(call(3), policy, parent, parent)).status, "denied");

// The child has its own run id but must spend from the ROOT run's allowance, which is
// already exhausted. This is the assertion the fix exists for.
check(
  "child inherits exhausted budget",
  (await executeCall(call(4), policy, child, parent)).status,
  "denied",
);

// And the bug it replaces: billing the child's own id would hand it a fresh allowance.
check(
  "billing the child's own id would reset it (the bug)",
  (await executeCall(call(5), policy, child, child)).status,
  "executed",
);

console.log("\nAUDIT ROWS still belong to the run that made the call");
const parentRows = store.listActions(parent).length;
const childRows = store.listActions(child).length;
check("parent rows", parentRows, 3);
check("child rows", childRows, 2);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
