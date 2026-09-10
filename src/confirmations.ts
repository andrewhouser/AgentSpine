/**
 * Shared approve/reject logic for the confirmation queue, used by both the `confirm` CLI
 * and the dashboard API. Approving re-checks policy at approval time and runs the action
 * through the queue so it never overlaps a running agent cycle.
 */
import { loadPolicy, REJECT_PROMOTE_AFTER } from "./config.ts";
import { registry } from "./tools/index.ts";
import { enqueue } from "./queue.ts";
import { remember } from "./memory/rag.ts";
import * as store from "./memory/store.ts";

export const PREFERENCE_KIND = "preference";

/**
 * The (tool, target) shape of a proposed action, for counting silent rejections
 * (LEARNING Phase 1.3). Built from the tool's own classifier — the same code the broker
 * and `approveConfirmation` use — so the shape a rejection is counted against is exactly
 * the shape a future proposal will present. Falls back to the tool name alone if the args
 * cannot be classified (a tool that no longer exists, malformed args), which still groups
 * usefully. Never throws.
 */
const rejectShapeKey = (tool: string, argsJson: string): string => {
  let target = "";
  try {
    const t = registry[tool];
    if (t) target = t.classify(JSON.parse(argsJson)).target ?? "";
  } catch {
    /* fall back to the tool alone */
  }
  return `reject:shape:${tool}:${target}`;
};

export interface ConfirmOutcome {
  ok: boolean;
  message: string;
}

export const approveConfirmation = async (id: number): Promise<ConfirmOutcome> => {
  const row = store.getConfirmation(id);
  if (!row) return { ok: false, message: `No confirmation #${id}.` };
  if (row.state !== "pending") return { ok: false, message: `#${id} is already '${row.state}'.` };

  const tool = registry[row.tool];
  if (!tool) return { ok: false, message: `Tool '${row.tool}' no longer exists.` };

  const args = JSON.parse(row.args);
  const policy = loadPolicy();

  // Re-check the allowlist at approval time — policy may have changed since it was queued.
  const decision = tool.checkPolicy(policy, args);
  if (!decision.allowed) {
    store.setConfirmation(id, "rejected", `policy now denies it: ${decision.reason}`);
    return { ok: false, message: `#${id} denied by current policy: ${decision.reason}` };
  }

  try {
    const output = await enqueue(() => tool.run(args, { policy }));
    store.setConfirmation(id, "done", output);
    return { ok: true, message: `#${id} executed: ${output}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.setConfirmation(id, "error", msg);
    return { ok: false, message: `#${id} failed: ${msg}` };
  }
};

/**
 * Reject a queued action, optionally saying why.
 *
 * The reason is what turns a rejection from a one-off veto into something the assistant
 * carries forward: it's stored as a `preference` memory, and since `runner.ts` auto-recalls
 * relevant memories before every run, a similar proposal later arrives with your own past
 * objection already in context. Saying no twice for the same reason is the thing this is
 * meant to stop.
 *
 * Deliberately optional. Requiring a reason would tax exactly the case you want to be
 * cheap — the quick no — so a bare reject behaves precisely as it always did. (The
 * phone's Reject button has nowhere to type, which is the same case.)
 */
export const rejectConfirmation = async (id: number, reason = ""): Promise<ConfirmOutcome> => {
  const row = store.getConfirmation(id);
  if (!row) return { ok: false, message: `No confirmation #${id}.` };
  if (row.state !== "pending") return { ok: false, message: `#${id} is already '${row.state}'.` };

  const why = reason.trim().slice(0, 300);
  store.setConfirmation(id, "rejected", why ? `rejected by user: ${why}` : "rejected by user");

  if (why) {
    try {
      await remember(
        `The user rejected this proposed action: "${row.summary}" (tool: ${row.tool}). ` +
          `Their reason: ${why}. Respect this when considering similar actions.`,
        PREFERENCE_KIND,
      );
    } catch (err) {
      // The rejection itself already succeeded and is what matters; failing to learn from
      // it must not turn a successful "no" into an error.
      console.warn(`[confirmations] could not save preference: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    // Rejection symmetry (LEARNING Phase 1.3). A bare "no" must stay cheap — requiring a
    // reason taxes exactly the case we want free — but it should not teach nothing. Count
    // silent rejections of the same shape in kv, and on the Nth promote to a `preference`
    // memory written by code: three silent noes are a preference even when nobody typed one.
    // Best-effort; a bare reject that already succeeded must not fail on the bookkeeping.
    try {
      await noteSilentRejection(row.tool, row.args, row.summary);
    } catch (err) {
      console.warn(`[confirmations] silent-reject bookkeeping skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: true,
    message: why ? `#${id} rejected — noted: ${why}` : `#${id} rejected.`,
  };
};

/**
 * Tally one reason-less rejection against its shape, and promote to a preference once the
 * shape has been silently rejected `REJECT_PROMOTE_AFTER` times. The count lives in `kv`
 * (structured state, not prose) until it crosses the threshold; only then does it become a
 * memory recall will surface. Promotion writes the preference once and resets the counter,
 * so a fourth silent reject starts a fresh tally rather than re-writing the same memory.
 */
const noteSilentRejection = async (tool: string, argsJson: string, summary: string): Promise<void> => {
  const key = rejectShapeKey(tool, argsJson);
  const count = Number(store.kvGet(key)?.value ?? "0") + 1;

  if (REJECT_PROMOTE_AFTER > 0 && count >= REJECT_PROMOTE_AFTER) {
    await remember(
      `The user has silently rejected the proposed action "${summary}" (tool: ${tool}) ` +
        `${count} times without giving a reason. Do not propose this again without new justification.`,
      PREFERENCE_KIND,
    );
    store.kvDelete(key);
    return;
  }

  store.kvSet(key, String(count));
};
