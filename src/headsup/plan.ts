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
import type { HeadsupKind } from "./rules.ts";
import type { Candidate } from "./scan.ts";

export type OfferReason = "changed" | "new" | "reminder" | "snoozed";

export interface Offer {
  candidate: Candidate;
  reason: OfferReason;
  /** Index into the kind's lead-time list at the moment of the offer; record it with markOffered. */
  stage: number;
  /** The threshold in days that this offer crossed. This is what the ledger compares, not the index. */
  stageDays: null | number;
}

export interface PlanDeps {
  get: (dedupeKey: string) => HeadsupRow | undefined;
  /** The lead-time list for a kind (prefs.ts), largest first. Default: LEAD_DAYS. */
  lead?: (kind: string) => number[];
  muted: (kind: string, subject: string) => boolean;
  /**
   * Kinds you keep passing on (outcomes.ts): they keep their first mention but lose reminders, and sort
   * after everything else under the daily cap. Optional so a caller with no history changes nothing.
   */
  quiet?: (kind: string) => boolean;
}

export interface Plan {
  /** Due but held back by the daily cap or quiet hours. They roll forward, nothing is lost. */
  deferred: number;
  offers: Offer[];
}

type Lead = (kind: string) => number[];

/** The latest threshold crossed, as { index, days }, or null if none has been. The list is descending. */
const targetStage = (c: Candidate, lead: Lead): null | { days: number; index: number } => {
  const days = lead(c.kind);
  let target: null | { days: number; index: number } = null;
  for (let i = 0; i < days.length; i++) if (c.daysUntil <= days[i]) target = { days: days[i], index: i };
  return target;
};

/**
 * Where the ledger says this item got to, in days. A row from before `stage_days` existed is read through
 * the default list, which is what its index meant. null: nothing offered yet.
 */
const rowDays = (row: HeadsupRow): null | number =>
  row.stage_days !== undefined ? row.stage_days : row.stage >= 0 ? ((LEAD_DAYS as Record<string, number[] | undefined>)[row.kind]?.[row.stage] ?? null) : null;

/** Decide one candidate, or null for "nothing to say". */
const decide = (c: Candidate, row: HeadsupRow | undefined, now: Date, quiet: boolean, lead: Lead): Offer | null => {
  // Already engaged with, or finished with. An accepted offer is the user's now.
  if (row && ["accepted", "dismissed", "done", "expired", "researched"].includes(row.state)) return null;

  if (c.kind === "recurring") {
    const days = LEAD_DAYS.recurring[0];
    if (!row) return { candidate: c, reason: "new", stage: 0, stageDays: days };
    if (row.state === "snoozed" && row.snooze_until && new Date(row.snooze_until) <= now)
      return { candidate: c, reason: "snoozed", stage: 0, stageDays: days };
    if (row.state === "snoozed") return null;
    return row.fingerprint !== c.fingerprint ? { candidate: c, reason: "changed", stage: 0, stageDays: days } : null;
  }

  const target = targetStage(c, lead);
  if (!target) return null;

  if (row?.state === "snoozed") {
    // Snoozed: silent until the snooze runs out, then it comes back at its current stage.
    if (row.snooze_until && new Date(row.snooze_until) > now) return null;
    const was = rowDays(row);
    const days = was !== null && was < target.days ? was : target.days;
    const index = lead(c.kind).indexOf(days);
    return { candidate: c, reason: "snoozed", stage: index >= 0 ? index : target.index, stageDays: days };
  }
  if (!row) return { candidate: c, reason: "new", stage: target.index, stageDays: target.days };
  // A reminder is the second and later mention. A quietened kind has earned only the first.
  if (quiet) return null;
  // Compare thresholds in days, never indexes: the list may have been edited since the last mention.
  const was = rowDays(row);
  return was === null || target.days < was ? { candidate: c, reason: "reminder", stage: target.index, stageDays: target.days } : null;
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
    const o = decide(c, deps.get(c.dedupeKey), now, deps.quiet?.(c.kind) ?? false, deps.lead ?? ((k) => LEAD_DAYS[k as HeadsupKind] ?? []));
    if (o) due.push(o);
  }
  const isQuiet = (o: Offer): number => (deps.quiet?.(o.candidate.kind) ? 1 : 0);
  due.sort(
    (a, b) =>
      isQuiet(a) - isQuiet(b) ||
      a.candidate.daysUntil - b.candidate.daysUntil ||
      KIND_PRIORITY[a.candidate.kind] - KIND_PRIORITY[b.candidate.kind] ||
      a.candidate.subject.localeCompare(b.candidate.subject),
  );
  if (inQuietHours(now, quiet?.[0], quiet?.[1])) return { deferred: due.length, offers: [] };
  return { deferred: Math.max(0, due.length - cap), offers: due.slice(0, cap) };
};
