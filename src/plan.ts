/**
 * The plan card: the steps a run is working through, each waiting, in progress or done.
 *
 * Built from the run's own tool calls (docs/PLAN-open-work.md §5), not from a plan
 * the model writes. That costs no model tokens, adds nothing to the JSON protocol a small
 * local model has to get right, and works the same for scheduled runs as for chat. Code owns
 * every status here; the model never marks its own progress.
 *
 * This is a pure fold over run events. `events.ts` feeds it every event it publishes and, when
 * the plan changes, publishes a `plan` event carrying the whole snapshot. Clients only draw the
 * newest snapshot, so the web, Mac and iPhone apps can't drift on what advances a step: there is
 * one state machine and it is tested here (test/plan.test.mjs).
 *
 * Shape decisions:
 *   - Consecutive calls with the same label merge into one step with a count ("Searching the
 *     web ×3"). A label that comes back after a different step is a new step, because reopening
 *     a step already shown as done reads as the run going backwards.
 *   - A trailing "Writing the reply" step is added with the first tool step, pending until the
 *     final answer lands. A run that answers without any tool call has no plan at all, so the
 *     card never appears for a one-step reply.
 *   - A subagent is one step ("Handing off to researcher"), from the caller's `subagent` tool
 *     call. The child's own calls publish under the child's run id and never reach this plan.
 */
import type { RunEvent } from "./events.ts";

export type PlanStepStatus = "active" | "done" | "failed" | "pending" | "waiting";

/** One row of the card as clients see it. */
export interface PlanStep {
  /** How many calls this step merged. Clients show "×n" when it is over 1. */
  count: number;
  label: string;
  status: PlanStepStatus;
}

interface ToolStep {
  failed: number;
  inFlight: number;
  label: string;
  ok: number;
  queued: number;
}

export interface PlanState {
  answer: PlanStepStatus;
  /** callId → index into `steps`. */
  calls: Readonly<Record<string, number>>;
  steps: readonly ToolStep[];
}

export const emptyPlan = (): PlanState => ({ answer: "pending", calls: {}, steps: [] });

export const ANSWER_LABEL = "Writing the reply";

const LABELS: Record<string, string> = {
  browser: "Browsing",
  calendar_find: "Checking the calendar",
  calendar_upcoming: "Checking the calendar",
  calendar_write: "Adding to the calendar",
  conversation_detail: "Looking back through chats",
  date_remember: "Saving to memory",
  digest: "Building a digest",
  draft: "Drafting",
  edit_file: "Editing files",
  find_past_output: "Looking back through past work",
  generate_image: "Generating an image",
  git_status: "Checking git",
  git_write: "Committing",
  gmail_search: "Searching mail",
  gmail_triage: "Sorting mail",
  gmail_unsubscribe: "Unsubscribing",
  knowledge_claims: "Checking the knowledge base",
  knowledge_search: "Searching the knowledge base",
  list_dir: "Reading files",
  look_at_file: "Reading files",
  look_at_image: "Looking at an image",
  mac_control: "Using the Mac",
  make_dir: "Editing files",
  meeting_list: "Reading meetings",
  meeting_tag: "Filing a meeting",
  memory_recall: "Searching memory",
  memory_save: "Saving to memory",
  move_file: "Editing files",
  notify: "Sending a notification",
  profile_save: "Saving to memory",
  read_file: "Reading files",
  read_more: "Reading a page",
  recall_output: "Looking back through past work",
  run_command: "Running a command",
  scaffold_ios_app: "Creating an app",
  search_files: "Searching files",
  schedule_list: "Checking schedules",
  source_read: "Reading sources",
  sources_list: "Reading sources",
  task_list: "Checking tasks",
  time_report: "Checking time logged",
  weather: "Checking the weather",
  weather_alerts: "Checking the weather",
  web_read: "Reading a page",
  web_search: "Searching the web",
  write_file: "Editing files",
};

/** Tool families that share one label, matched by name prefix. */
const PREFIXES: [string, string][] = [
  ["client_", "Looking up clients"],
  ["headsup_", "Checking heads-up"],
  ["recipe_", "Using a recipe"],
  ["schedule_", "Changing a schedule"],
  ["state_", "Checking saved state"],
  ["study_", "Studying"],
  ["style_", "Checking writing style"],
  ["task_", "Updating tasks"],
  ["time_", "Logging time"],
];

/** The step label for a call. Short and present-tense, like Claude Code's own list. */
export const labelFor = (tool: string, args: unknown): string => {
  if (tool === "subagent") {
    const agent = (args as { agent?: unknown } | null)?.agent;
    return typeof agent === "string" && agent.trim() ? `Handing off to ${agent.trim()}` : "Handing off";
  }
  const exact = LABELS[tool];
  if (exact) return exact;
  for (const [prefix, label] of PREFIXES) if (tool.startsWith(prefix)) return label;
  // Remote MCP tools and anything added later: still a step, just a plainer name.
  return `Using ${tool}`;
};

const stepStatus = (s: ToolStep): PlanStepStatus => {
  if (s.inFlight > 0) return "active";
  if (s.queued > 0) return "waiting";
  if (s.ok > 0) return "done";
  return "failed";
};

/** What a broker result status counts as for the step it belongs to. */
const outcome = (status: unknown): "failed" | "ok" | "queued" => {
  if (status === "executed" || status === "dry-run") return "ok";
  if (status === "queued") return "queued";
  // denied, error, and anything unrecognised: the call did not do its job.
  return "failed";
};

/**
 * Apply one run event. Returns the same object when the event changes nothing, so the caller
 * can tell with `!==` whether there is a new snapshot to publish.
 */
export const foldPlan = (plan: PlanState, event: Pick<RunEvent, "type"> & Record<string, unknown>): PlanState => {
  switch (event.type) {
    case "tool_call": {
      const callId = String(event.callId ?? "");
      if (!callId || callId in plan.calls) return plan;
      const label = labelFor(String(event.tool ?? ""), event.args);
      const last = plan.steps[plan.steps.length - 1];
      if (last && last.label === label) {
        const steps = [...plan.steps.slice(0, -1), { ...last, inFlight: last.inFlight + 1 }];
        return { ...plan, calls: { ...plan.calls, [callId]: steps.length - 1 }, steps };
      }
      const steps = [...plan.steps, { failed: 0, inFlight: 1, label, ok: 0, queued: 0 }];
      return { ...plan, calls: { ...plan.calls, [callId]: steps.length - 1 }, steps };
    }
    case "tool_result": {
      const index = plan.calls[String(event.callId ?? "")];
      const step = index === undefined ? undefined : plan.steps[index];
      if (index === undefined || !step || step.inFlight === 0) return plan;
      const result = outcome(event.status);
      const next: ToolStep = { ...step, inFlight: step.inFlight - 1, [result]: step[result] + 1 };
      return { ...plan, steps: plan.steps.map((s, i) => (i === index ? next : s)) };
    }
    case "final":
      if (plan.steps.length === 0 || plan.answer === "done") return plan;
      return { ...plan, answer: "done" };
    case "run_end": {
      if (plan.steps.length === 0) return plan;
      if (event.status === "ok") return plan.answer === "done" ? plan : { ...plan, answer: "done" };
      // Failed or stopped: nothing is still running, so nothing may still look like it is.
      const steps = plan.steps.map((s) =>
        s.inFlight > 0 ? { ...s, failed: s.failed + s.inFlight, inFlight: 0 } : s,
      );
      const answer = plan.answer === "done" ? "done" : "failed";
      const changed = answer !== plan.answer || steps.some((s, i) => s !== plan.steps[i]);
      return changed ? { ...plan, answer, steps } : plan;
    }
    default:
      return plan;
  }
};

/** The rows clients draw, tool steps first and the reply last. Empty until the first tool call. */
export const planSnapshot = (plan: PlanState): PlanStep[] =>
  plan.steps.length === 0
    ? []
    : [
        ...plan.steps.map((s) => ({ count: s.inFlight + s.ok + s.failed + s.queued, label: s.label, status: stepStatus(s) })),
        { count: 1, label: ANSWER_LABEL, status: plan.answer },
      ];

/**
 * The finished plan of a stored run, rebuilt from its action rows. A reloaded thread has no
 * event stream to replay, and the chat now draws this card on every turn (the call-by-call
 * spine moved to the Trace tab), so the same fold runs over what the broker recorded. Each row
 * is one call and its verdict, so it is replayed as a call followed by its result.
 */
export const planFromActions = (
  actions: readonly { args: string; decision: string; id: number; tool: string }[],
  runStatus: string,
): PlanStep[] => {
  let plan = emptyPlan();
  for (const a of actions) {
    let args: unknown = a.args;
    try {
      args = JSON.parse(a.args);
    } catch {
      // Kept as the raw string; labelFor only peeks at it.
    }
    const callId = String(a.id);
    plan = foldPlan(plan, { args, callId, tool: a.tool, type: "tool_call" });
    plan = foldPlan(plan, { callId, status: a.decision, type: "tool_result" });
  }
  if (runStatus !== "running" && runStatus !== "queued") {
    plan = foldPlan(plan, { status: runStatus, type: "run_end" });
  }
  return planSnapshot(plan);
};
