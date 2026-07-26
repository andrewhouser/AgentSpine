/**
 * Shared approve/reject logic for the confirmation queue, used by both the `confirm` CLI
 * and the dashboard API. Approving re-checks policy at approval time and runs the action
 * through the queue so it never overlaps a running agent cycle.
 */
import { loadPolicy } from "./config.ts";
import { registry } from "./tools/index.ts";
import { enqueue } from "./queue.ts";
import { remember } from "./memory/rag.ts";
import * as store from "./memory/store.ts";

export const PREFERENCE_KIND = "preference";

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
  }

  return {
    ok: true,
    message: why ? `#${id} rejected — noted: ${why}` : `#${id} rejected.`,
  };
};
