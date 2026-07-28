/**
 * The capability broker — the one part that makes "mostly automated" safe.
 *
 * Every tool call the agent makes passes through here. The broker, NOT the tool
 * and NOT the model, decides what happens, using two independent gates:
 *
 *   1. Allowlist (deny by default). The tool classifies its target (app bundle id,
 *      domain, path) and checks it against policy.json. Off-allowlist => denied.
 *
 *   2. Reversibility tier. Reversible actions auto-execute. Irreversible ones
 *      (send, delete, create, purchase) are ALWAYS queued for human confirmation
 *      when policy.autoExecute.irreversibleAlwaysConfirm is set — even if the
 *      target is allowlisted. That is the "tiered by reversibility" default.
 *
 * Two further rails sit between those gates, both opt-in via policy.json:
 *
 *   - Budgets (checked after the allowlist, before anything happens). Per-run and per-day
 *     call caps, counted from the audit log. The allowlist answers "may it touch this at
 *     all"; a budget answers "how often" — the question that matters for a loop running
 *     unattended forever.
 *
 *   - Dry run (checked last). Report what every call WOULD do and do neither. The way to
 *     read a new schedule's task before letting it touch anything.
 *
 * Nothing here trusts the model's own claim about its intent; the classification
 * comes from code in the tool, and the decision comes from code here.
 */
import type { BrokerResult, ClassifiedAction, Policy, ToolCall } from "./types.ts";
import { registry } from "./tools/index.ts";
import * as store from "./memory/store.ts";
import { publish } from "./events.ts";
import { notify, confirmationActions } from "./notify.ts";
import { NOTIFY_ON_CONFIRMATION } from "./config.ts";

const startOfToday = (): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

/**
 * Budget check. Returns a denial reason, or null when the call is within its allowance.
 * A missing or zero cap means unlimited — you opt into a rail, you don't trip over one.
 */
const overBudget = (policy: Policy, tool: string, runId: number | null): string | null => {
  const b = policy.budgets;
  if (!b) return null;

  const capFor = (scope: { default?: number; tools?: Record<string, number> } | undefined): number =>
    scope?.tools?.[tool] ?? scope?.default ?? 0;

  const perRun = capFor(b.perRun);
  if (perRun > 0 && runId != null) {
    const used = store.countToolCallsInRun(runId, tool);
    if (used >= perRun)
      return `per-run budget for ${tool} exhausted (${used}/${perRun} this run). Finish with what you have, or work a different way.`;
  }

  const perDay = capFor(b.perDay);
  if (perDay > 0) {
    const used = store.countToolCallsSince(startOfToday(), tool);
    if (used >= perDay)
      return `per-day budget for ${tool} exhausted (${used}/${perDay} today). It will reset at midnight.`;
  }

  return null;
};

/**
 * Pairs a `tool_call` event with its `tool_result`, so a UI can match them up even when
 * the same tool is called twice in one run. Process-wide and monotonic; it identifies a
 * card on screen, nothing more.
 */
let callSeq = 0;

/**
 * @param runId       the run this call belongs to — what the audit row records.
 * @param budgetRunId the run per-RUN budgets are counted against. Identical to `runId`
 *   except inside a subagent, where the child has its own run row but must spend from the
 *   ROOT run's allowance. Without this split, `countToolCallsInRun` keys on the child's id
 *   and delegating silently resets every per-run cap — "budget: 3 web searches" would mean
 *   three per subagent, which is not a budget.
 */
export const executeCall = async (
  call: ToolCall,
  policy: Policy,
  runId: number | null,
  budgetRunId: number | null = runId,
): Promise<BrokerResult> => {
  const tool = registry[call.tool];
  const callId = ++callSeq;

  /**
   * Log the decision and tell any watcher about it, in that order — the audit log is the
   * record, the event is a view of it. Every exit from this function goes through here,
   * which is what guarantees the two can't disagree.
   */
  const record = (
    classified: ClassifiedAction | null,
    status: BrokerResult["status"],
    output: string,
  ): BrokerResult => {
    store.logAction(runId, call, classified, status, output);
    publish(runId, {
      callId,
      output: output.slice(0, 4000),
      reversibility: classified?.reversibility ?? null,
      status,
      summary: classified?.summary ?? null,
      target: classified?.target ?? null,
      tool: call.tool,
      type: "tool_result",
    });
    return { output, status };
  };

  // Announced before anything is decided, so a slow call (a browser fetch, a search) shows
  // up as in-flight rather than as nothing at all — the reason this bus exists.
  publish(runId, { args: call.args ?? null, callId, tool: call.tool, type: "tool_call" });

  if (!tool) return record(null, "denied", `DENIED: unknown tool ${JSON.stringify(call.tool)}.`);

  let classified;
  try {
    classified = tool.classify(call.args);
  } catch (err) {
    return record(null, "error", `ERROR: could not classify args: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Gate 1: allowlist.
  const decision = tool.checkPolicy(policy, call.args);
  if (!decision.allowed) return record(classified, "denied", `DENIED: ${decision.reason}`);

  // Budget rail. After the allowlist (a denied call shouldn't consume allowance) and
  // before anything happens, so an exhausted budget neither runs nor queues.
  const budgetDenial = overBudget(policy, call.tool, budgetRunId);
  if (budgetDenial) return record(classified, "denied", `DENIED: ${budgetDenial}`);

  // Gate 2: reversibility tier.
  const mustConfirm =
    classified.reversibility === "irreversible" && policy.autoExecute.irreversibleAlwaysConfirm;
  const canAutoRun =
    classified.reversibility === "reversible" ? policy.autoExecute.reversible : !mustConfirm;

  // Dry run. Report the decision that WOULD have been taken and stop short of both
  // executing and queueing — a dry run that filled the confirm queue would defeat its own
  // purpose. Logged as "dry-run" so the audit log never implies something happened.
  if (policy.autoExecute.dryRun) {
    return record(
      classified,
      "dry-run",
      `DRY RUN — nothing happened. This call would have been ${canAutoRun ? "EXECUTED" : "QUEUED for your confirmation"}: ` +
        `${classified.summary}. Continue planning as if it succeeded, but do not claim it is done.`,
    );
  }

  if (!canAutoRun) {
    const cid = store.queueConfirmation(call, classified.summary, runId);
    const result = record(
      classified,
      "queued",
      `QUEUED for your confirmation (#${cid}): ${classified.summary}. ` +
        `It will not run until you approve it (npm run confirm approve ${cid}). ` +
        `Continue with other work; do not claim this action is done.`,
    );

    // A separate event from the tool_result above, because it renders as a different
    // thing: not a record of what the agent tried, but a question waiting on you. This is
    // what puts an Approve/Reject card inline in the thread instead of behind a tab.
    publish(runId, {
      confirmationId: cid,
      summary: classified.summary,
      tool: call.tool,
      type: "confirmation",
    });

    // Reach the user. A queued action is the one thing that genuinely blocks progress
    // while you're away, so this is the highest-value push in the system. Deliberately
    // not awaited: the agent should keep working, and notify() never throws.
    if (NOTIFY_ON_CONFIRMATION) {
      const token = store.getApprovalToken(cid);
      void notify(`Approval needed (#${cid})`, classified.summary, {
        priority: 4,
        tags: ["warning"],
        actions: token ? confirmationActions(cid, token) : [],
      });
    }

    return result;
  }

  // Execute.
  try {
    return record(classified, "executed", await tool.run(call.args, { policy }));
  } catch (err) {
    return record(classified, "error", `ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
};
