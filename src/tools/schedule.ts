/**
 * Self-management: AgentSpine's own scheduler, from the inside.
 *
 * Every other tool in this registry acts on the world. These act on the application the
 * agent is running in — they are how "look up new movie trailers every day at noon"
 * becomes a row in the `schedules` table instead of a thing done once and described in a
 * summary. Without them the model has no idea the thing it lives in even has a scheduler,
 * and the only honest answer to a standing request is "open Automations and add it
 * yourself", which is precisely the seam this closes.
 *
 * Every write here is classified **irreversible**, and not because a row is hard to
 * delete. It is about what a schedule *is*: a task string that a future, unattended run
 * will be handed as its goal, with the full tool registry and this same broker behind it.
 * Writing one is writing a prompt for an agent that will act while nobody is watching —
 * which makes it the one place where a sentence picked up from an UNTRUSTED web page could
 * become a standing instruction that outlives the conversation that introduced it. Routing
 * every write through the confirmation queue puts the exact task text in front of you
 * before it can ever run. That is the same job `policy.autoExecute.dryRun` does for a
 * schedule you wrote by hand, and the same shape `draft.ts` uses: a proposal, parked,
 * waiting on a human who can read the whole thing.
 *
 * Note what is deliberately absent: nothing here can touch `policy.json`. The scheduler
 * decides *when* the agent acts; the policy decides *what it may do*, and a run that could
 * widen its own permissions would make deny-by-default a suggestion.
 *
 * `schedule_list` reads AgentSpine's own database and is reversible.
 */
import * as store from "../memory/store.ts";
import { canonicalSpec, isOneShot, nextRun } from "../schedule-spec.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const MAX_NAME = 80;
const MAX_TASK = 4000;
const MAX_SPEC = 120;

/** The grammar `schedule-spec.ts` accepts, stated the way the model needs to see it. */
const SPEC_HELP =
  'RECURRING: "every 30 minutes", "every 2 hours", "every day", "daily at 12:00pm", ' +
  '"weekdays at 8:00am", "weekends at 10am", "mon,wed,fri at 6pm", "tue-thu at 17:00, 21:00". ' +
  'ONCE, then it retires itself: "in 30 minutes", "today at 5pm", "tomorrow at 9am", ' +
  '"next tuesday at 9am", "aug 15 at 9am", "on 2026-08-15 at 14:00". ' +
  'Note that "tuesday at 9am" is EVERY Tuesday — a single occurrence must say "next tuesday" ' +
  "or name a date. Cron syntax is not accepted.";

/**
 * Why a spec was refused, in words the model can act on.
 *
 * `nextRun` returning null is two different failures wearing the same face — a syntax it
 * cannot read, and a moment that has already gone by — and they want opposite fixes. Told
 * "could not parse", a model handed a stale time will rewrite perfectly good syntax and
 * fail again the same way.
 */
const specProblem = (spec: string): string | null => {
  if (!canonicalSpec(spec)) return `could not parse the schedule "${spec}". ${SPEC_HELP}`;
  if (!nextRun(canonicalSpec(spec)!))
    return `"${spec}" is already in the past. Say a time that is still ahead — check the current time given to you at the top of this conversation.`;
  return null;
};

const gate = (p: Policy): PolicyDecision =>
  p.schedules?.enabled
    ? { allowed: true, reason: "scheduler access" }
    : {
        allowed: false,
        reason: 'the scheduler is not enabled. Add "schedules": { "enabled": true } to policy.json.',
      };

const text = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);

/** Local models send booleans as strings often enough that reading only `true` loses jobs. */
const bool = (v: unknown, fallback: boolean): boolean =>
  v == null || v === "" ? fallback : !(v === false || v === "false" || v === 0 || v === "0" || v === "no");

const nameOf = (a: any): string => text(a?.name, MAX_NAME);
const taskOf = (a: any): string => text(a?.task ?? a?.goal, MAX_TASK);
/** `schedule` is documented; `spec` and `when` are what a local model reaches for anyway. */
const specOf = (a: any): string => text(a?.schedule ?? a?.spec ?? a?.when, MAX_SPEC);
const idOf = (a: any): number => Number(a?.id ?? a?.schedule_id ?? a?.scheduleId);

const describe = (s: store.ScheduleRow): string =>
  `#${s.id} "${s.name}" — ${s.spec ?? `every ${s.interval_minutes} minutes`}`;

/**
 * The proposal you actually read in the approvals queue.
 *
 * It carries the task VERBATIM rather than a description of it, for the reason `draft.ts`
 * spells out: a one-line preview turns approving into a rubber stamp, and here the text
 * being previewed is the standing instruction an unattended agent will follow every day.
 */
const proposal = (name: string, task: string, spec: string, enabled: boolean): string => {
  const next = nextRun(spec);
  const once = isOneShot(spec);
  return [
    `NEW ${once ? "ONE-OFF" : "SCHEDULED"} JOB — nothing is scheduled and nothing runs until you approve this.`,
    "",
    `Name:     ${name}`,
    `Runs:     ${once ? "once only" : spec}${enabled ? "" : "  (created disabled)"}`,
    `${once ? "At:      " : "First at:"} ${next ? next.toLocaleString() : "(unknown)"}`,
    "",
    `${once ? "The run is" : "Every run is"} handed exactly this task, with the full tool registry and the same broker gates:`,
    "",
    task,
  ].join("\n");
};

export const scheduleList: Tool = {
  name: "schedule_list",
  description:
    "List AgentSpine's scheduled jobs — id, name, when it runs, whether it is enabled, when " +
    "it next fires, and the task each run is given. Read this before changing or removing " +
    "one, and before creating a job that may already exist.",
  argsSchema: "{}",
  classify: (): ClassifiedAction => ({
    reversibility: "reversible",
    target: "schedules",
    summary: "List scheduled jobs",
  }),
  checkPolicy: (p) => gate(p),
  run: async () => {
    const rows = store.listSchedules();
    if (!rows.length) return "No scheduled jobs exist yet.";
    return rows
      .map((s) => {
        const task = s.task.replace(/\s+/g, " ");
        // A retired one-shot is neither "enabled" nor something you'd want to switch on, so
        // it says what actually happened rather than presenting itself as a paused job.
        const spent = s.spec && isOneShot(s.spec) && !s.next_run;
        const state = spent ? `already ran ${s.last_run}` : s.enabled ? "enabled" : "disabled";
        return (
          `${describe(s)} — ${state}` +
          `${!spent && s.next_run ? `, next ${s.next_run}` : ""}\n` +
          `    task: ${task.slice(0, 300)}${task.length > 300 ? "…" : ""}`
        );
      })
      .join("\n");
  },
};

export const scheduleCreate: Tool = {
  name: "schedule_create",
  description:
    "Create a job that runs later on its own, either repeatedly or exactly once. Use this " +
    "whenever the user asks for something that is not immediate — 'every morning', 'each day " +
    "at noon', 'weekly', 'keep an eye on', and equally 'remind me tomorrow at 9', 'check back " +
    "in an hour', 'on the 15th'. Doing the thing now and describing it is the wrong answer to " +
    "both. The task is handed VERBATIM to a future run that has no memory " +
    "of this conversation, so write it as complete standing instructions, not as a reference " +
    "to what was just discussed. A job that should only speak up when something CHANGED must " +
    "compare against state_get and notify only on a real difference, or it fires every run. " +
    "Queued for the user's confirmation, so say it is proposed, never that it is scheduled.",
  argsSchema:
    '{ "name": string, "task": string, "schedule": string, "enabled"?: boolean } — ' + SPEC_HELP,
  classify: (a): ClassifiedAction => ({
    reversibility: "irreversible",
    target: "schedules",
    summary: proposal(
      nameOf(a) || "(unnamed)",
      taskOf(a) || "(empty task)",
      specOf(a) || "(no schedule)",
      bool(a?.enabled, true),
    ),
  }),
  /**
   * Argument validation lives in the policy gate rather than in `run`, because this is the
   * last hook that fires BEFORE the call is queued. A bad spec caught here comes straight
   * back to the model with the grammar attached and is fixed on the next step; caught in
   * `run` it would instead sit in the queue until you approved a job that then failed.
   */
  checkPolicy: (p, a) => {
    const g = gate(p);
    if (!g.allowed) return g;
    if (!nameOf(a)) return { allowed: false, reason: "schedule_create needs a short name." };
    if (!taskOf(a)) return { allowed: false, reason: "schedule_create needs the task each run will be given." };
    const spec = specOf(a);
    if (!spec) return { allowed: false, reason: `schedule_create needs a schedule. ${SPEC_HELP}` };
    const problem = specProblem(spec);
    if (problem) return { allowed: false, reason: problem };
    return g;
  },
  run: async (a) => {
    const id = store.createSchedule(nameOf(a), taskOf(a), specOf(a), bool(a?.enabled, true));
    const s = store.getSchedule(id)!;
    return isOneShot(s.spec ?? "")
      ? `Created ${describe(s)}. It runs once, at ${s.next_run}, and then retires itself.`
      : `Created ${describe(s)}. Next run ${s.next_run}.`;
  },
};

export const scheduleUpdate: Tool = {
  name: "schedule_update",
  description:
    "Change an existing scheduled job: rename it, reword its task, move when it runs, or " +
    "turn it off with enabled=false. Call schedule_list first to get the id and to see what " +
    "the job currently says. Prefer enabled=false over deleting when the user just wants it " +
    "to stop — a disabled job can be turned back on. Only the fields you pass change. " +
    "Queued for the user's confirmation.",
  argsSchema:
    '{ "id": number, "name"?: string, "task"?: string, "schedule"?: string, "enabled"?: boolean } — ' + SPEC_HELP,
  classify: (a): ClassifiedAction => {
    const id = idOf(a);
    const cur = Number.isFinite(id) ? store.getSchedule(id) : undefined;
    const lines = [`Change scheduled job ${cur ? describe(cur) : `#${a?.id}`}:`, ""];
    if (nameOf(a)) lines.push(`Name:     ${cur?.name ?? "?"}  ->  ${nameOf(a)}`);
    if (specOf(a)) lines.push(`Runs:     ${cur?.spec ?? "?"}  ->  ${specOf(a)}`);
    if (a?.enabled != null) lines.push(`Enabled:  ${cur?.enabled ? "yes" : "no"}  ->  ${bool(a.enabled, true) ? "yes" : "no"}`);
    // The task in full, for the same reason `proposal` carries it: this is the standing
    // instruction, and a summary of it is not something you can judge.
    if (taskOf(a)) lines.push("", "New task, handed verbatim to every future run:", "", taskOf(a));
    return { reversibility: "irreversible", target: "schedules", summary: lines.join("\n") };
  },
  checkPolicy: (p, a) => {
    const g = gate(p);
    if (!g.allowed) return g;
    const id = idOf(a);
    if (!Number.isFinite(id)) return { allowed: false, reason: "schedule_update needs the id of an existing job (schedule_list shows them)." };
    const cur = store.getSchedule(id);
    if (!cur) return { allowed: false, reason: `there is no scheduled job #${id}. Call schedule_list to see what exists.` };
    const spec = specOf(a);
    if (spec) {
      const problem = specProblem(spec);
      if (problem) return { allowed: false, reason: problem };
    }
    if (!nameOf(a) && !taskOf(a) && !spec && a?.enabled == null)
      return { allowed: false, reason: "schedule_update needs at least one of name, task, schedule, or enabled." };
    // A one-shot that has already fired has no time left to run at, so switching it back on
    // would either do nothing or — but for the guard in the store — fire it again on the
    // spot. Neither is what "turn it back on" means, so say what it does mean instead.
    if (!spec && bool(a?.enabled, true) && a?.enabled != null && cur.spec && isOneShot(cur.spec) && !nextRun(cur.spec))
      return {
        allowed: false,
        reason: `#${id} was a one-off and has already run (${cur.last_run}). Give it a new time with the schedule field, or create a new job.`,
      };
    return g;
  },
  run: async (a) => {
    const id = idOf(a);
    const fields: store.ScheduleFields = {};
    if (nameOf(a)) fields.name = nameOf(a);
    if (taskOf(a)) fields.task = taskOf(a);
    if (specOf(a)) fields.spec = specOf(a);
    if (a?.enabled != null) fields.enabled = bool(a.enabled, true);
    store.updateSchedule(id, fields);
    const s = store.getSchedule(id);
    return `Updated ${describe(s!)} — ${s!.enabled ? `enabled, next run ${s!.next_run}` : "disabled"}.`;
  },
};

export const scheduleDelete: Tool = {
  name: "schedule_delete",
  description:
    "Remove a scheduled job permanently. Prefer schedule_update with enabled=false unless " +
    "the user actually wants it gone — disabling is reversible and deleting is not. Anything " +
    "the job stored with state_set is left behind. Queued for the user's confirmation.",
  argsSchema: '{ "id": number }',
  classify: (a): ClassifiedAction => {
    const id = idOf(a);
    const cur = Number.isFinite(id) ? store.getSchedule(id) : undefined;
    return {
      reversibility: "irreversible",
      target: "schedules",
      summary: cur
        ? [
            `Delete scheduled job ${describe(cur)} permanently.`,
            "",
            "It currently runs this task:",
            "",
            cur.task,
          ].join("\n")
        : `Delete scheduled job #${a?.id}`,
    };
  },
  checkPolicy: (p, a) => {
    const g = gate(p);
    if (!g.allowed) return g;
    const id = idOf(a);
    if (!Number.isFinite(id)) return { allowed: false, reason: "schedule_delete needs the id of an existing job (schedule_list shows them)." };
    if (!store.getSchedule(id)) return { allowed: false, reason: `there is no scheduled job #${id}. Call schedule_list to see what exists.` };
    return g;
  },
  run: async (a) => {
    const id = idOf(a);
    const s = store.getSchedule(id);
    if (!s) return `Scheduled job #${id} no longer exists.`;
    store.deleteSchedule(id);
    return `Deleted ${describe(s)}. Any state it stored is untouched.`;
  },
};
