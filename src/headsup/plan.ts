/**
 * Decide what to offer right now. Pure: the ledger is passed in as two lookup functions, so
 * this is tested with plain objects and no database.
 *
 * Inputs are candidates (scan.ts) and what has already been said (ledger.ts); the output is the
 * short list for the morning heads-up. Every rule that decides "is this the moment?" is here and
 * in rules.ts, in code, never in a prompt.
 */
import type { HeadsupRow } from "./ledger.ts";
import { DAILY_CAP, inQuietHours, KIND_PRIORITY, LEAD_DAYS } from "./rules.ts";
import type { Candidate } from "./scan.ts";

export type OfferReason = "changed" | "new" | "reminder" | "snoozed";

export interface Offer {
  candidate: Candidate;
  reason: OfferReason;
  /** Index into LEAD_DAYS[kind]; record it with markOffered. */
  stage: number;
}

export interface PlanDeps {
  get: (dedupeKey: string) => HeadsupRow | undefined;
  muted: (kind: string, subject: string) => boolean;
}

export interface Plan {
  /** Due but held back by the daily cap or quiet hours. They roll forward, nothing is lost. */
  deferred: number;
  offers: Offer[];
}

/** The latest stage whose threshold has been crossed, or -1 if none has. LEAD_DAYS is descending. */
const targetStage = (c: Candidate): number => {
  const days = LEAD_DAYS[c.kind];
  let target = -1;
  for (let i = 0; i < days.length; i++) if (c.daysUntil <= days[i]) target = i;
  return target;
};

/** Decide one candidate, or null for "nothing to say". */
const decide = (c: Candidate, row: HeadsupRow | undefined, now: Date): Offer | null => {
  // Already engaged with, or finished with. An accepted offer is the user's now.
  if (row && ["accepted", "dismissed", "done", "expired", "researched"].includes(row.state)) return null;

  if (c.kind === "recurring") {
    if (!row) return { candidate: c, reason: "new", stage: 0 };
    if (row.state === "snoozed" && row.snooze_until && new Date(row.snooze_until) <= now)
      return { candidate: c, reason: "snoozed", stage: 0 };
    if (row.state === "snoozed") return null;
    return row.fingerprint !== c.fingerprint ? { candidate: c, reason: "changed", stage: 0 } : null;
  }

  const target = targetStage(c);
  if (target < 0) return null;

  if (row?.state === "snoozed") {
    // Snoozed: silent until the snooze runs out, then it comes back at its current stage.
    if (row.snooze_until && new Date(row.snooze_until) > now) return null;
    return { candidate: c, reason: "snoozed", stage: Math.max(target, row.stage) };
  }
  if (!row) return { candidate: c, reason: "new", stage: target };
  return target > row.stage ? { candidate: c, reason: "reminder", stage: target } : null;
};

/**
 * What to put in the heads-up at `now`. Soonest first, then by kind priority, capped at
 * `cap`. During quiet hours nothing is offered: the scanner only produces calendar items, and
 * none of those is worth waking anyone for.
 */
export const planOffers = (
  candidates: Candidate[],
  deps: PlanDeps,
  now: Date,
  cap: number = DAILY_CAP,
  quiet?: [number, number],
): Plan => {
  const due: Offer[] = [];
  for (const c of candidates) {
    if (deps.muted(c.kind, c.subject)) continue;
    const o = decide(c, deps.get(c.dedupeKey), now);
    if (o) due.push(o);
  }
  due.sort(
    (a, b) =>
      a.candidate.daysUntil - b.candidate.daysUntil ||
      KIND_PRIORITY[a.candidate.kind] - KIND_PRIORITY[b.candidate.kind] ||
      a.candidate.subject.localeCompare(b.candidate.subject),
  );
  if (inQuietHours(now, quiet?.[0], quiet?.[1])) return { deferred: due.length, offers: [] };
  return { deferred: Math.max(0, due.length - cap), offers: due.slice(0, cap) };
};
