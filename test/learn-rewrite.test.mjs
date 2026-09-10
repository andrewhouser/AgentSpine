/**
 * Self-editing task text (LEARNING Phase 5), the parts that don't need a live model.
 *
 * The DECISION to propose a rewrite is inference-free: a watcher whose recent runs cost more
 * than a watcher should is measurable in the audit log. That detection, and the line diff the
 * confirmation shows, are what this asserts. The rewrite itself is a model call, exercised
 * only against a live model; here we confirm the identification and the diff rendering, plus
 * that a non-watcher schedule is never a candidate.
 *
 * Run with `node test/learn-rewrite.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-rewrite-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
process.env.WATCHER_CALL_BUDGET = "3";
process.env.REWRITE_MIN_OVER_BUDGET = "3";

const store = await import("../src/memory/store.ts");
const { looseWatchers, diffLines } = await import("../src/learn/rewrite.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(54)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// Create a schedule, then give it `n` finished runs each with `calls` action rows.
const scheduleWithRuns = (name, task, runs) => {
  const sid = store.createSchedule(name, task, "every 6 hours", true);
  for (const calls of runs) {
    const rid = store.startRun({ kind: "schedule", scheduleId: sid, task });
    for (let i = 0; i < calls; i++) store.logAction(rid, { args: {}, tool: "web_read" }, null, "executed", "ok");
    store.finishRun(rid, "ok", "done");
  }
  return sid;
};

const WATCHER_TASK = "Check the page. Read a fingerprint. Call state_get with key watch:x. If it differs, state_set and notify.";
const PLAIN_TASK = "Summarize my unread email and tell me what needs a reply.";

console.log("\nDETECTION — only a watcher consistently over budget qualifies");
{
  // A tight watcher: costs at or under budget.
  scheduleWithRuns("tight watcher", WATCHER_TASK, [2, 3, 2, 3]);
  check("a within-budget watcher is not loose", looseWatchers().length, 0);

  // A loose watcher: several runs over the budget of 3.
  const loose = scheduleWithRuns("loose watcher", WATCHER_TASK, [7, 8, 6, 9]);
  const found = looseWatchers();
  check("an over-budget watcher is flagged", found.length, 1);
  check("it is the loose one", found[0].id, loose);
  check("it counts the over-budget runs", found[0].overBudget, 4);
}

console.log("\nNOT A WATCHER — a plain schedule is never a rewrite candidate");
{
  // A plain (non-watcher) schedule that is expensive is still not a watcher, so not touched.
  scheduleWithRuns("plain job", PLAIN_TASK, [9, 9, 9, 9]);
  const found = looseWatchers();
  check("plain schedules are excluded", found.some((w) => w.name === "plain job"), false);
}

console.log("\nBELOW THE RUN-COUNT FLOOR — one bad run is not a pattern");
{
  scheduleWithRuns("occasionally slow", WATCHER_TASK, [8, 2, 2]); // only 1 over budget
  const found = looseWatchers();
  check("a single over-budget run does not qualify", found.some((w) => w.name === "occasionally slow"), false);
}

console.log("\nDIFF — a human-readable comparison, not the new text alone");
{
  const before = "line one\nline two\nline three";
  const after = "line one\nline two changed\nline three";
  const d = diffLines(before, after);
  check("unchanged lines are unmarked", d.includes("  line one"), true);
  check("removed line is marked -", d.includes("- line two"), true);
  check("added line is marked +", d.includes("+ line two changed"), true);
  check("a shared line is not duplicated as add+remove", d.split("line three").length - 1, 1);
}

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
