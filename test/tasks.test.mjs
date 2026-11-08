/**
 * Tasks: due-time parsing, the store, the tools, and when a task is nudged.
 * Run with `node test/tasks.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-tasks-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;

const { parseWhen } = await import("../src/tasks/when.ts");
const tasks = await import("../src/tasks/store.ts");
const { taskAdd, taskList, taskUpdate, taskDone } = await import("../src/tools/tasks.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

// Wednesday 2026-11-11 10:00 local
const now = new Date(2026, 10, 11, 10, 0, 0, 0);
const local = (iso) => {
  const d = new Date(iso);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

console.log("\nparsing a due time\n");
check("tomorrow defaults to 9am", local(parseWhen("tomorrow", now)), [2026, 11, 12, 9, 0]);
check("tomorrow 3pm", local(parseWhen("tomorrow 3pm", now)), [2026, 11, 12, 15, 0]);
check("friday is the coming friday", local(parseWhen("friday", now)), [2026, 11, 13, 9, 0]);
check("wednesday said on a wednesday means next week", local(parseWhen("wednesday", now)), [2026, 11, 18, 9, 0]);
check("in 2 days keeps the time of day", local(parseWhen("in 2 days", now)), [2026, 11, 13, 10, 0]);
check("in 90 minutes", local(parseWhen("in 90 minutes", now)), [2026, 11, 11, 11, 30]);
check("an ISO date means 9am", local(parseWhen("2026-12-01", now)), [2026, 12, 1, 9, 0]);
check("an ISO timestamp is kept", local(parseWhen("2026-12-01T14:30", now)), [2026, 12, 1, 14, 30]);
check("'month' is not Monday", parseWhen("next month sometime", now), null);
check("nonsense is null, not a guess", parseWhen("whenever", now), null);
check("empty is null", parseWhen("", now), null);

console.log("\nthe store\n");
const a = tasks.addTask({ title: "Call the dentist", due: new Date(Date.now() - 3_600_000).toISOString() });
const b = tasks.addTask({ kind: "followup", title: "Invoice reply", waitingOn: "Jeff", due: new Date(Date.now() + 5 * 86_400_000).toISOString() });
const c = tasks.addTask({ title: "Someday thing" });
check("open list is ordered by due, undated last", tasks.listTasks().map((t) => t.id), [a, b, c]);
check("due_within_days drops far-off and undated", tasks.listTasks({ dueWithinDays: 1 }).map((t) => t.id), [a]);
check("only the overdue task needs a nudge", tasks.dueForNudge().map((t) => t.id), [a]);
tasks.markNudged(a);
check("a nudged task is quiet until the renudge window", tasks.dueForNudge().length, 0);
check("but returns after 24h", tasks.dueForNudge(24, new Date(Date.now() + 25 * 3_600_000)).map((t) => t.id).includes(a), true);
tasks.updateTask(a, { due: new Date(Date.now() - 60_000).toISOString() });
check("moving the due date earns a fresh nudge", tasks.dueForNudge().map((t) => t.id), [a]);
tasks.updateTask(a, { status: "done" });
check("done tasks leave the open list", tasks.listTasks().map((t) => t.id), [b, c]);
check("and record when", typeof tasks.getTask(a).completed, "string");
tasks.updateTask(a, { status: "open" });
check("reopening clears completion", tasks.getTask(a).completed, null);

console.log("\nthe tools\n");
check("task_add parses natural due", /Added: #\d+ \[task\] Pay rent/.test(await taskAdd.run({ due: "friday 5pm", title: "Pay rent" }, {})), true);
check("task_add rejects an unreadable due", (await taskAdd.run({ due: "whenever", title: "x" }, {})).startsWith("ERROR"), true);
check("task_add needs a title", (await taskAdd.run({}, {})).startsWith("ERROR"), true);
check("task_list shows the follow-up's waiting-on", (await taskList.run({}, {})).includes("waiting on Jeff"), true);
check("task_update on a missing id explains", /No task/.test(await taskUpdate.run({ id: 9999 }, {})), true);
check("task_done completes", /\[task, done\]/.test(await taskDone.run({ id: c }, {})), true);
check("all four tools are always allowed", [taskAdd, taskList, taskUpdate, taskDone].every((t) => t.checkPolicy({}, {}).allowed), true);
check("and reversible", [taskAdd, taskList, taskUpdate, taskDone].every((t) => t.classify({}).reversibility === "reversible"), true);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
