/**
 * Proposals that learn from their own outcomes (docs/PLAN-open-work.md, SL4).
 *
 * Two rules, both decided here in code and neither visible to the model. A proposal you rejected is not
 * made again. A kind you mostly reject is made less often, and it recovers by itself: the record is a
 * sliding window, so one accepted proposal or a quiet few months lets it back up.
 *
 * Only your own "no" counts. An expiry means you did not get to it, and a policy refusal at approval time
 * says nothing about whether you wanted it. The trigger in `memory/store.ts` makes that distinction.
 *
 * The log keeps a hash of each proposal's shape rather than its text, because it outlives the run ledger:
 * remembering that you declined something should not mean keeping the words past their retention window.
 */
import { createHash } from "node:crypto";
import { rawDb } from "../memory/store.ts";

export type ProposalKind =
  | "code_change"
  | "retro_auto_approval"
  | "retro_code_change"
  | "retro_memory_correction"
  | "retro_missing_capability"
  | "retro_recipe"
  | "retro_routine"
  | "rewrite"
  | "schedule"
  | "standing";

/**
 * Starting values, not measurements: the same shape as Heads-up B's quieting, which also waits for enough
 * answers before it believes a rate. Five answers is the fewest where 80% is more than one bad afternoon.
 */
export const PROPOSAL_QUIET = {
  gapDays: 30,
  minDecided: 5,
  rejectRate: 0.8,
  windowDays: 90,
} as const;

const DAY_MS = 86_400_000;

export const proposalHash = (shape: string): string => createHash("sha256").update(shape).digest("hex");

export const recordProposal = (kind: ProposalKind, shape: string, confirmationId: number, at: Date = new Date()): void => {
  rawDb
    .prepare("INSERT OR IGNORE INTO proposal_log (confirmation_id, kind, key_hash, made) VALUES (?,?,?,?)")
    .run(confirmationId, kind, proposalHash(shape), at.toISOString());
};

/**
 * Close a proposal that has no confirmation row, which is every retrospective card (SL2). Those are logged
 * under the negative of their own id, so they can never collide with a confirmation or fire its trigger.
 */
export const recordProposalOutcome = (logId: number, outcome: "accepted" | "rejected", at: Date = new Date()): void => {
  rawDb
    .prepare("UPDATE proposal_log SET outcome = ?, decided = ? WHERE confirmation_id = ? AND outcome IS NULL")
    .run(outcome, at.toISOString(), logId);
};

export interface KindRecord {
  accepted: number;
  decided: number;
  /** Share of decided proposals you rejected; 0 when none are decided. */
  rejectRate: number;
  rejected: number;
}

export const kindRecord = (kind: ProposalKind, now: Date = new Date()): KindRecord => {
  const since = new Date(now.getTime() - PROPOSAL_QUIET.windowDays * DAY_MS).toISOString();
  const rows = rawDb
    .prepare(
      "SELECT outcome, COUNT(*) AS n FROM proposal_log WHERE kind = ? AND decided >= ? " +
        "AND outcome IN ('accepted','rejected') GROUP BY outcome",
    )
    .all(kind, since) as unknown as { n: number; outcome: string }[];
  const accepted = rows.find((r) => r.outcome === "accepted")?.n ?? 0;
  const rejected = rows.find((r) => r.outcome === "rejected")?.n ?? 0;
  const decided = accepted + rejected;
  return { accepted, decided, rejected, rejectRate: decided ? rejected / decided : 0 };
};

export interface ProposalGate {
  allowed: boolean;
  reason: string;
}

/** Whether this proposal may be made now. A pure read, so a dry run can ask the same question. */
export const proposalGate = (kind: ProposalKind, shape: string, now: Date = new Date()): ProposalGate => {
  const declined = rawDb
    .prepare("SELECT 1 AS hit FROM proposal_log WHERE key_hash = ? AND outcome = 'rejected' LIMIT 1")
    .get(proposalHash(shape));
  if (declined) return { allowed: false, reason: "you rejected this proposal before" };

  const record = kindRecord(kind, now);
  const mostlyRejected = record.decided >= PROPOSAL_QUIET.minDecided && record.rejectRate >= PROPOSAL_QUIET.rejectRate;
  if (!mostlyRejected) return { allowed: true, reason: "no objection on record" };

  const last = rawDb.prepare("SELECT MAX(made) AS made FROM proposal_log WHERE kind = ?").get(kind) as
    | undefined
    | { made: null | string };
  const sinceLast = last?.made ? now.getTime() - Date.parse(last.made) : Number.POSITIVE_INFINITY;
  if (sinceLast < PROPOSAL_QUIET.gapDays * DAY_MS) {
    return {
      allowed: false,
      reason: `you rejected ${record.rejected} of the last ${record.decided}, so this kind waits ${PROPOSAL_QUIET.gapDays} days between proposals`,
    };
  }
  return { allowed: true, reason: "mostly rejected, but the waiting period has passed" };
};

/**
 * Bring job proposals queued before this log existed into it, so a no you already gave still counts.
 * Idempotent. Rewrites are left out: their old rows do not record the task text they were judged against.
 */
export const adoptPastJobProposals = (shapeOf: (task: string) => string): number => {
  const rows = rawDb
    .prepare(
      "SELECT c.id, c.args, c.state, c.result, c.ts, c.resolved FROM confirmations c " +
        "LEFT JOIN proposal_log p ON p.confirmation_id = c.id " +
        "WHERE p.confirmation_id IS NULL AND c.tool = 'schedule_create' AND c.summary LIKE 'PROPOSED JOB%'",
    )
    .all() as unknown as {
    args: string;
    id: number;
    resolved: null | string;
    result: null | string;
    state: string;
    ts: string;
  }[];
  const insert = rawDb.prepare(
    "INSERT OR IGNORE INTO proposal_log (confirmation_id, kind, key_hash, made, outcome, decided) VALUES (?,?,?,?,?,?)",
  );
  let adopted = 0;
  for (const r of rows) {
    let task = "";
    try {
      task = String(JSON.parse(r.args)?.task ?? "");
    } catch {
      continue;
    }
    if (!task) continue;
    const outcome =
      r.state === "pending"
        ? null
        : r.state === "rejected"
          ? String(r.result ?? "").startsWith("rejected by user")
            ? "rejected"
            : "refused"
          : r.state === "expired"
            ? "expired"
            : "accepted";
    insert.run(r.id, "schedule", proposalHash(shapeOf(task)), r.ts, outcome, outcome ? (r.resolved ?? r.ts) : null);
    adopted += 1;
  }
  return adopted;
};
