/**
 * task_add / task_list / task_update / task_done — the assistant's own to-do list.
 *
 * All reversible and always allowed: they touch only the local `tasks` table, and a task is
 * undone by deleting or reopening it. The point is capture without friction — "remind me to
 * call the dentist Friday" should be one tool call and no confirmation, which is why this is
 * its own list and not a Reminders.app write (that one is irreversible and gated).
 */
import { describeTask, addTask, getTask, listTasks, updateTask } from "../tasks/store.ts";
import type { TaskKind, TaskStatus } from "../tasks/store.ts";
import { parseWhen } from "../tasks/when.ts";
import { getProject } from "../projects/store.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const classify = (summary: string) => (): ClassifiedAction => ({ reversibility: "reversible", summary, target: "tasks" });
const allow = (_p: Policy): PolicyDecision => ({ allowed: true, reason: "local task list" });

/**
 * Which project a call means. `"this"` (or nothing, on creation) is the project the current
 * conversation belongs to; `"none"` takes a task out of its project; a number must be a real
 * project. The model is never asked for a numeric id it cannot know — it was not told one,
 * and a guessed id would file work under the wrong project without anyone noticing.
 * `undefined` means "leave it as it is"; an Error names what went wrong.
 */
const projectOf = (raw: unknown, ctxProject: null | number | undefined, defaultToContext: boolean): null | number | undefined => {
  if (raw === undefined || raw === null || raw === "") return defaultToContext ? (ctxProject ?? null) : undefined;
  if (raw === "none") return null;
  if (raw === "this" || raw === true) {
    if (ctxProject == null) throw new Error('this conversation is not inside a project, so "this" has no meaning here');
    return ctxProject;
  }
  const id = Number(raw);
  if (Number.isInteger(id) && getProject(id)) return id;
  throw new Error(`no project ${JSON.stringify(raw)}; use "this" for the current project or "none" for no project`);
};

const idOf = (a: any): number => Number(a?.id ?? a?.task_id);

/** `undefined` = not given, `null` = explicitly cleared, string = ISO; throws on unreadable. */
const dueOf = (raw: unknown): null | string | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "" || raw === "none") return null;
  const iso = parseWhen(raw);
  if (!iso) throw new Error(`could not read the due time ${JSON.stringify(raw)}; use an ISO date/time like 2026-11-14T15:00 or "tomorrow 3pm"`);
  return iso;
};

export const taskAdd: Tool = {
  name: "task_add",
  description:
    "Add a to-do or a follow-up to the user's task list. Use kind \"followup\" with waiting_on for " +
    "something they are waiting on someone else for. due can be an ISO date/time or plain words " +
    "(\"tomorrow 3pm\", \"friday\", \"in 2 days\"); it triggers a reminder notification when it passes. " +
    "Inside a project's conversation the task is filed under that project automatically.",
  argsSchema: '{ "title": string, "due"?: string, "notes"?: string, "kind"?: "task" | "followup", "waiting_on"?: string, "project"?: "this" | "none" }',
  classify: classify("Add a task"),
  checkPolicy: allow,
  run: async (a: any, ctx) => {
    const title = String(a?.title ?? "").trim();
    if (!title) return 'ERROR: task_add needs a "title".';
    let due: null | string | undefined;
    try {
      due = dueOf(a?.due);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    let projectId: null | number | undefined;
    try {
      projectId = projectOf(a?.project ?? a?.project_id, ctx?.run?.projectId, true);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    const id = addTask({
      clientId: a?.client_id ?? null,
      due: due ?? null,
      kind: (a?.kind === "followup" ? "followup" : "task") as TaskKind,
      notes: a?.notes ?? null,
      projectId: projectId ?? null,
      sourceRun: ctx?.runId ?? null,
      title,
      waitingOn: a?.waiting_on ?? null,
    });
    return `Added: ${describeTask(getTask(id)!)}`;
  },
};

export const taskList: Tool = {
  name: "task_list",
  description:
    "List the user's tasks and follow-ups, overdue and soonest-due first. status defaults to \"open\"; " +
    "due_within_days limits to what is due (or overdue) by then.",
  argsSchema: '{ "status"?: "open" | "done" | "dropped" | "all", "due_within_days"?: number, "project"?: "this" }',
  classify: classify("List tasks"),
  checkPolicy: allow,
  run: async (a: any, ctx) => {
    let projectId: null | number | undefined;
    try {
      projectId = a?.project === "this" ? projectOf("this", ctx?.run?.projectId, false) ?? undefined : undefined;
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    const status = (["open", "done", "dropped", "all"].includes(a?.status) ? a.status : "open") as "all" | TaskStatus;
    const rows = listTasks({
      dueWithinDays: a?.due_within_days != null ? Number(a.due_within_days) : undefined,
      projectId,
      status,
    });
    return rows.length ? rows.map(describeTask).join("\n") : `No ${status === "all" ? "" : `${status} `}tasks.`;
  },
};

export const taskUpdate: Tool = {
  name: "task_update",
  description:
    "Change a task by id: title, due (\"none\" clears it), notes, waiting_on, or status " +
    "(\"open\" | \"done\" | \"dropped\"). Moving the due date schedules a fresh reminder. " +
    "project: \"this\" files it under the current conversation's project (to classify tasks " +
    "created earlier), \"none\" takes it out of its project.",
  argsSchema: '{ "id": number, "title"?: string, "due"?: string, "notes"?: string, "waiting_on"?: string, "status"?: "open" | "done" | "dropped", "project"?: "this" | "none" }',
  classify: classify("Update a task"),
  checkPolicy: allow,
  run: async (a: any, ctx) => {
    const id = idOf(a);
    if (!Number.isFinite(id) || !getTask(id)) return `No task #${a?.id ?? "?"}. task_list shows valid ids.`;
    let due: null | string | undefined;
    try {
      due = dueOf(a?.due);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    const status = ["open", "done", "dropped"].includes(a?.status) ? (a.status as TaskStatus) : undefined;
    let projectId: null | number | undefined;
    try {
      projectId = projectOf(a?.project, ctx?.run?.projectId, false);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    const t = updateTask(id, { due, notes: a?.notes, projectId, status, title: a?.title, waitingOn: a?.waiting_on });
    return `Updated: ${describeTask(t!)}`;
  },
};

export const taskDone: Tool = {
  name: "task_done",
  description: "Mark a task or follow-up done, by id.",
  argsSchema: '{ "id": number }',
  classify: classify("Complete a task"),
  checkPolicy: allow,
  run: async (a: any) => {
    const id = idOf(a);
    if (!Number.isFinite(id) || !getTask(id)) return `No task #${a?.id ?? "?"}. task_list shows valid ids.`;
    return `Done: ${describeTask(updateTask(id, { status: "done" })!)}`;
  },
};
