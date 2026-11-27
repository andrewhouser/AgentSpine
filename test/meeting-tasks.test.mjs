/**
 * A meeting's to-dos reach Tasks only when a person adds them from "To-dos found" (section 15, R12,
 * 2026-11-27); older queued approvals still move onto a project's list when the meeting is filed late.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-mtasks-${process.pid}-${Date.now()}.db`);
const store = await import("../src/meetings/store.ts");
const { answerWorkItem, fileQueuedItems } = await import("../src/meetings/extract.ts");
const memory = await import("../src/memory/store.ts");
const { listTasks } = await import("../src/tasks/store.ts");

let failed = 0;
const check = (label, ok) => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

const id = store.startMeeting("mic", null, "Sprint sync");
store.setTitle(id, "Roadmap review");
check("retitle sticks", store.getMeeting(id).title === "Roadmap review");

const w = store.addWorkItem(id, { owner: "Priya", quote: "draft the plan", startMs: 1000, task: "Draft the plan", verdict: "queued", verdictNote: null });
const c = memory.queueConfirmation({ args: { kind: "task", text: "x" }, tool: "memory_save" }, "Work item");
store.setWorkItemConfirmation(w, c);

check("nothing on the task list yet", listTasks().length === 0);
check("late filing moves one", fileQueuedItems(id, 7) === 1);
const t = listTasks();
check("task is on the project", t.length === 1 && t[0].project_id === 7 && t[0].title.includes("Draft the plan"));
check("approval resolved", memory.getConfirmation(c).state === "done");
check("work item marked filed", store.workItems(id)[0].verdict === "filed");
check("idempotent", fileQueuedItems(id, 7) === 0);

console.log("\nTO-DOS FOUND (R12)");
const m2 = store.startMeeting("mic", null, "Billing standup");
const add = store.addWorkItem(m2, { owner: "Kai", quote: "Kai will send the numbers", startMs: 2000, task: "send the numbers", verdict: "review", verdictNote: "future" });
const drop = store.addWorkItem(m2, { owner: null, quote: "we should think about it", startMs: 3000, task: "Think about it", verdict: "review", verdictNote: null });
store.addWorkItem(m2, { owner: null, quote: "shipped", startMs: 500, task: "Ship it", verdict: "already-done", verdictNote: "past" });
const before = listTasks().length;
check("waiting items sort first", store.workItems(m2).slice(0, 2).every((w) => w.verdict === "review"));
check("Today counts the meeting once, with two waiting", JSON.stringify(store.meetingsWithTodos().map((x) => [x.meetingId, x.count])) === JSON.stringify([[m2, 2]]));
check("nothing reaches Tasks before a person answers", listTasks().length === before);
const added = answerWorkItem(m2, add, "add", { task: "Send the billing numbers" });
const nowTasks = listTasks();
check("add puts it on Tasks, with the edited words and the owner", nowTasks.length === before + 1 && nowTasks.some((t) => t.id === added.taskId && t.title === "Send the billing numbers (Kai)" && t.project_id === null));
check("the row is marked filed", store.getWorkItem(add).verdict === "filed");
check("a second add is refused, so a double click adds nothing", answerWorkItem(m2, add, "add").error === "already answered" && listTasks().length === before + 1);
check("dismiss adds nothing and keeps the row", answerWorkItem(m2, drop, "dismiss").taskId === null && store.getWorkItem(drop).verdict === "dismissed" && listTasks().length === before + 1);
check("a refused item cannot be added", answerWorkItem(m2, store.workItems(m2).find((w) => w.verdict === "already-done").id, "add").error === "already answered");
check("another meeting's item is not found here", answerWorkItem(id, drop, "add").error === "no such to-do");
check("empty words are refused", (() => { const x = store.addWorkItem(m2, { owner: null, quote: "q", startMs: 1, task: "T", verdict: "review", verdictNote: null }); return answerWorkItem(m2, x, "add", { task: "  " }).error === "a to-do needs words"; })());
check("Today counts only what is still waiting", store.meetingsWithTodos().find((x) => x.meetingId === m2)?.count === 1);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
