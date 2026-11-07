/**
 * Shared approve/reject logic for the confirmation queue, used by both the `confirm` CLI
 * and the dashboard API. Approving re-checks policy at approval time and runs the action
 * through the queue so it never overlaps a running agent cycle.
 */
import {
  CONFIRM_ESCALATE_AFTER_MIN,
  CONFIRM_EXPIRE_AFTER_MIN,
  CONFIRM_REMIND_AFTER_MIN,
  loadPolicy,
  NOTIFY_ON_CONFIRMATION,
  REJECT_PROMOTE_AFTER,
} from "./config.ts";
import { registry } from "./tools/index.ts";
import { enqueue } from "./queue.ts";
import { remember } from "./memory/rag.ts";
import * as store from "./memory/store.ts";
import { confirmationActions, confirmationPush, notify } from "./notify.ts";
import type { NotifyResult } from "./notify.ts";

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

  // Expire at approval time as well as in the sweep, because the sweep is not guaranteed to
  // have run: the watchdog lives in the dashboard and the heartbeat, and `npm run confirm`
  // works with neither of them up. A row old enough to expire must not execute merely
  // because nothing happened to be running to close it — that would make the window a
  // property of the process uptime instead of a property of the question.
  const stale = expiredAt(row.ts);
  if (stale) {
    store.setConfirmation(id, "expired", stale);
    return { ok: false, message: `#${id} ${stale}` };
  }

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

// --- the watchdog ---
/**
 * The clock on the approval queue.
 *
 * `src/broker.ts` pushes once, at the moment a question is queued. That is the right push
 * and it was the only one: if you were asleep, in a meeting, or simply looking at a
 * different screen, nothing ever asked again. The row carried a `ts` that no code read.
 *
 * What makes this worth real care rather than a `setInterval` and a second push is that
 * both failure directions are bad in different ways. Nudge too eagerly and the queue
 * becomes noise, which costs the one thing the confirmation gate depends on — that you
 * actually read the summary before approving. Never nudge and the system's unattended half
 * silently stops, looking exactly like "there was nothing to do". The rungs in config.ts
 * are spaced for the first risk; the existence of an expiry answers the second.
 *
 * See CONFIRM_REMIND_AFTER_MIN in config.ts for the rungs and why expiry defaults to 72h.
 */
const MINUTE_MS = 60_000;

/** Minutes since `iso`, or null if it cannot be parsed — an unreadable clock acts on nothing. */
const ageMinutes = (iso: string, nowMs: number): number | null => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (nowMs - t) / MINUTE_MS : null;
};

/** "4h", "2d 3h" — how long it has been waiting, for the push body. */
const describeWait = (mins: number): string => {
  const h = Math.floor(mins / 60);
  if (h < 1) return `${Math.max(1, Math.round(mins))}m`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};

/**
 * The expiry verdict on a question queued at `ts`: the reason string to record, or null if
 * it is still live. Exported for the approval path, which applies the same window without
 * waiting for a sweep.
 */
export const expiredAt = (ts: string, nowMs = Date.now()): null | string => {
  if (CONFIRM_EXPIRE_AFTER_MIN <= 0) return null;
  const age = ageMinutes(ts, nowMs);
  if (age === null || age < CONFIRM_EXPIRE_AFTER_MIN) return null;
  return (
    `expired after ${describeWait(age)} without an answer — it was never run. ` +
    `Ask again if you still want it; the world it was proposed in has moved on.`
  );
};

export interface SweepResult {
  reminded: number;
  escalated: number;
  expired: number;
}

/**
 * One pass over the pending queue: expire what is past the window, and push about what has
 * crossed a rung it has not climbed yet.
 *
 * Three properties make it safe to run unattended, every few minutes, from more than one
 * process:
 *
 *   1. **Idempotent per rung.** The rung reached is stored on the row, so a sweep every 5
 *      minutes re-pushes once per rung, not once per sweep — and the heartbeat and the
 *      dashboard both running it is harmless rather than double the notifications.
 *   2. **Rungs are skipped, not queued.** A row that is already past the escalation
 *      threshold the first time it is seen (the server was down for a day) climbs straight
 *      to rung 2 and pushes once, rather than firing a reminder it is far too late for.
 *   3. **It never throws and never resolves a question by accident.** A failed push leaves
 *      the rung unclimbed so the next sweep retries it; a row that errors is skipped, not
 *      expired.
 *
 * Expiring is deliberately NOT a rejection: no preference memory, no silent-rejection
 * tally. You did not decide against this — you never saw it, and teaching the assistant a
 * preference from your absence would put words in your mouth.
 *
 * `notifier` is injected for tests; everything else defaults to real time and real pushes.
 */
export const sweepConfirmations = async (
  opts: { notifier?: typeof notify; now?: number } = {},
): Promise<SweepResult> => {
  const nowMs = opts.now ?? Date.now();
  const push = opts.notifier ?? notify;
  const result: SweepResult = { escalated: 0, expired: 0, reminded: 0 };

  let rows: store.ConfirmationRow[];
  try {
    rows = store.pendingConfirmationsBefore(new Date(nowMs).toISOString());
  } catch (err) {
    console.warn(`[watchdog] could not read the queue: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  for (const row of rows) {
    try {
      const age = ageMinutes(row.ts, nowMs);
      if (age === null) continue;

      const stale = expiredAt(row.ts, nowMs);
      if (stale) {
        store.setConfirmation(row.id, "expired", stale);
        result.expired++;
        // Say so. An action that quietly stopped existing is the failure this whole module
        // was written against, and closing the question silently would reproduce it.
        if (NOTIFY_ON_CONFIRMATION) {
          await push(`Approval expired (#${row.id})`, `${row.summary}\n\nWaited ${describeWait(age)}. Nothing ran.`, {
            priority: 3,
            tags: ["hourglass"],
          });
        }
        continue;
      }

      // The highest rung this age has reached. Escalation is checked first so a long-cold
      // row climbs straight to it instead of spending a sweep on a reminder.
      const rung =
        CONFIRM_ESCALATE_AFTER_MIN > 0 && age >= CONFIRM_ESCALATE_AFTER_MIN
          ? 2
          : CONFIRM_REMIND_AFTER_MIN > 0 && age >= CONFIRM_REMIND_AFTER_MIN
            ? 1
            : 0;
      if (rung === 0 || rung <= (row.rung ?? 0)) continue;

      if (!NOTIFY_ON_CONFIRMATION) {
        // Pushes are off by configuration. Climb the rung anyway so that turning them back
        // on does not fire a backlog of nudges for questions that aged while they were off.
        store.setConfirmationRung(row.id, rung);
        continue;
      }

      const token = row.token ?? null;
      const sent: NotifyResult = await push(
        rung === 2 ? `Still waiting (#${row.id})` : `Approval needed (#${row.id})`,
        `${row.summary}\n\nQueued ${describeWait(age)} ago and still unanswered.`,
        {
          actions: token ? confirmationActions(row.id, token) : [],
          priority: rung === 2 ? 5 : 4,
          // A reminder shares the first push's collapse id, so three nudges about #12 are
          // one item on the lock screen rather than a stack you have to clear.
          push: token
            ? confirmationPush(row.id, token)
            : { category: "CONFIRMATION", collapseId: `confirmation-${row.id}`, confirmationId: row.id },
          tags: rung === 2 ? ["rotating_light"] : ["warning"],
        },
      );

      // Only record the rung if it actually went somewhere. A failed push that marked
      // itself delivered would turn a transient ntfy outage into a question you are never
      // reminded about again — the precise failure this is here to prevent.
      if (sent.ok) {
        store.setConfirmationRung(row.id, rung);
        if (rung === 2) result.escalated++;
        else result.reminded++;
      }
    } catch (err) {
      console.warn(`[watchdog] #${row.id} skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
};
