/** A project meeting's work items land on the project's task list; late filing moves pending ones. */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-mtasks-${process.pid}.db`);
const store = await import("../src/meetings/store.ts");
const { fileQueuedItems } = await import("../src/meetings/extract.ts");
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

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
