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
import type { BrokerResult, Policy, ToolCall } from "./types.ts";
import { registry } from "./tools/index.ts";
import * as store from "./memory/store.ts";
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

export const executeCall = async (
  call: ToolCall,
  policy: Policy,
  runId: number | null,
): Promise<BrokerResult> => {
  const tool = registry[call.tool];

  if (!tool) {
    const out = `DENIED: unknown tool ${JSON.stringify(call.tool)}.`;
    store.logAction(runId, call, null, "denied", out);
    return { status: "denied", output: out };
  }

  let classified;
  try {
    classified = tool.classify(call.args);
  } catch (err) {
    const out = `ERROR: could not classify args: ${err instanceof Error ? err.message : String(err)}`;
    store.logAction(runId, call, null, "error", out);
    return { status: "error", output: out };
  }

  // Gate 1: allowlist.
  const decision = tool.checkPolicy(policy, call.args);
  if (!decision.allowed) {
    const out = `DENIED: ${decision.reason}`;
    store.logAction(runId, call, classified, "denied", out);
    return { status: "denied", output: out };
  }

  // Budget rail. After the allowlist (a denied call shouldn't consume allowance) and
  // before anything happens, so an exhausted budget neither runs nor queues.
  const budgetDenial = overBudget(policy, call.tool, runId);
  if (budgetDenial) {
    const out = `DENIED: ${budgetDenial}`;
    store.logAction(runId, call, classified, "denied", out);
    return { status: "denied", output: out };
  }

  // Gate 2: reversibility tier.
  const mustConfirm =
    classified.reversibility === "irreversible" && policy.autoExecute.irreversibleAlwaysConfirm;
  const canAutoRun =
    classified.reversibility === "reversible" ? policy.autoExecute.reversible : !mustConfirm;

  // Dry run. Report the decision that WOULD have been taken and stop short of both
  // executing and queueing — a dry run that filled the confirm queue would defeat its own
  // purpose. Logged as "dry-run" so the audit log never implies something happened.
  if (policy.autoExecute.dryRun) {
    const out =
      `DRY RUN — nothing happened. This call would have been ${canAutoRun ? "EXECUTED" : "QUEUED for your confirmation"}: ` +
      `${classified.summary}. Continue planning as if it succeeded, but do not claim it is done.`;
    store.logAction(runId, call, classified, "dry-run", out);
    return { status: "dry-run", output: out };
  }

  if (!canAutoRun) {
    const cid = store.queueConfirmation(call, classified.summary, runId);
    const out =
      `QUEUED for your confirmation (#${cid}): ${classified.summary}. ` +
      `It will not run until you approve it (npm run confirm approve ${cid}). ` +
      `Continue with other work; do not claim this action is done.`;
    store.logAction(runId, call, classified, "queued", out);

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

    return { status: "queued", output: out };
  }

  // Execute.
  try {
    const output = await tool.run(call.args, { policy });
    store.logAction(runId, call, classified, "executed", output);
    return { status: "executed", output };
  } catch (err) {
    const out = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    store.logAction(runId, call, classified, "error", out);
    return { status: "error", output: out };
  }
};
