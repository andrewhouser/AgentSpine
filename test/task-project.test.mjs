/**
 * Tasks created inside a project's conversation belong to that project.
 * The run knows its project; these check the task tools actually use it.
 * Run with `node test/task-project.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-taskproj-${process.pid}.db`);
const projects = await import("../src/projects/store.ts");
const { taskAdd, taskList, taskUpdate } = await import("../src/tools/tasks.ts");
const { getTask, listTasks } = await import("../src/tasks/store.ts");

let failed = 0;
const check = (label, ok) => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

const pid = projects.createProject("Ai Automation Agency", "");
const other = projects.createProject("Other", "");
const inProject = { policy: {}, run: { conversational: true, goal: "g", projectId: pid } };
const outside = { policy: {}, run: { conversational: true, goal: "g", projectId: null } };
const idOf = (out) => Number(/#(\d+)/.exec(out)[1]);

const a = idOf(await taskAdd.run({ title: "Build demo" }, inProject));
check("a task added inside a project is filed under it", getTask(a).project_id === pid);
check("the listing says which project", (await taskList.run({}, inProject)).includes("{project: Ai Automation Agency}"));

const b = idOf(await taskAdd.run({ title: "Buy milk" }, outside));
check("outside a project it has none", getTask(b).project_id === null);

const c = idOf(await taskAdd.run({ title: "Explicit none", project: "none" }, inProject));
check('"none" opts out inside a project', getTask(c).project_id === null);

check('"this" outside a project is refused', (await taskAdd.run({ title: "x", project: "this" }, outside)).startsWith("ERROR"));
check("a made-up project id is refused, not guessed", (await taskAdd.run({ title: "x", project: 999 }, inProject)).startsWith("ERROR"));
check("and nothing was created by the refusals", listTasks({ status: "all" }).length === 3);

await taskUpdate.run({ id: b, project: "this" }, inProject);
check('task_update project "this" classifies an earlier task', getTask(b).project_id === pid);
await taskUpdate.run({ id: b, project: "none" }, inProject);
check('...and "none" takes it back out', getTask(b).project_id === null);
await taskUpdate.run({ id: b, title: "Buy oat milk" }, inProject);
check("an update that names no project leaves it alone", getTask(b).project_id === null && getTask(b).title === "Buy oat milk");

await taskUpdate.run({ id: a, project: other }, inProject);
check("a real project id is accepted", getTask(a).project_id === other);

const mine = await taskList.run({ project: "this" }, inProject);
check('list with project "this" shows only that project', !mine.includes("Build demo") && !mine.includes("Buy oat milk"));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
