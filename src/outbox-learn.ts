/**
 * Outbox Phase 4 (docs/archive/PLAN-outbox.md): a kind of message you keep skipping gets listed in the
 * weekly review, and a schedule you almost always skip gets ONE proposal to switch it off.
 *
 * Mirrors src/headsup/outcomes.ts. Rules this is built around:
 *   1. **No model.** Counts from the outbox table, a threshold from outbox-rules.ts, a sentence built by code.
 *   2. **Nothing turns itself off.** The proposal is a `schedule_update` (enabled=false) in the confirmation
 *      queue, which is irreversible-tier and so waits for you. A reason-less rejection is tallied by the
 *      queue's own `noteSilentRejection`; this module adds the 90-day silence on top.
 *   3. **Fail soft.** A bookkeeping error must not stop the sweep that called it.
 */
import { rawDb } from "./memory/store.ts";
import * as store from "./memory/store.ts";
import { outcomeOf } from "./outbox.ts";
import {
  PROPOSABLE_SOURCES,
  REVIEWED_SOURCES,
  SKIP_MIN_COUNTED,
  SKIP_PROPOSE_RATE,
  SKIP_QUIETEN_RATE,
  SKIP_SUPPRESS_DAYS,
  SKIP_WINDOW_DAYS,
  topicOf,
} from "./outbox-rules.ts";

export interface SkipStats {
  /** Messages whose outcome is known: opened, dismissed, ignored, or answered in the review. */
  counted: number;
  kind: string;
  /** skipped / counted, or 0 when nothing is counted. */
  rate: number;
  sent: number;
  skipped: number;
  source: string;
  topic: string;
}

export type SkipTier = "none" | "off" | "quiet";

// So that 7 of 10 meets 0.7 whatever the float division says.
const EPS = 1e-9;

/** What a kind's numbers earn. Pure: tested at every boundary. */
export const skipTierOf = (s: Pick<SkipStats, "counted" | "rate">): SkipTier => {
  if (s.counted < SKIP_MIN_COUNTED) return "none";
  if (s.rate + EPS >= SKIP_PROPOSE_RATE) return "off";
  if (s.rate + EPS >= SKIP_QUIETEN_RATE) return "quiet";
  return "none";
};

interface Row {
  created: string;
  decision: string;
  delivered: null | number;
  dismissed_at: null | string;
  feedback: null | string;
  kind: null | string;
  opened_at: null | string;
  source: string;
  via: null | string;
}

/** Per source and kind over the window. Reviewed sources only, and a run with no schedule is not a kind. */
export const skipStats = (now: Date = new Date()): SkipStats[] => {
  const since = new Date(now.getTime() - SKIP_WINDOW_DAYS * 86_400_000).toISOString();
  const sources = [...REVIEWED_SOURCES];
  const rows = rawDb
    .prepare(
      `SELECT created, source, kind, decision, via, delivered, opened_at, dismissed_at, feedback
         FROM outbox WHERE decision = 'sent' AND created >= ? AND source IN (${sources.map(() => "?").join(",")})
          AND COALESCE(kind, '') != ''`,
    )
    .all(since, ...sources) as unknown as Row[];
  const by = new Map<string, SkipStats>();
  for (const r of rows) {
    const kind = String(r.kind);
    const key = `${r.source}\u0000${kind}`;
    const s = by.get(key) ?? { counted: 0, kind, rate: 0, sent: 0, skipped: 0, source: r.source, topic: topicOf(r.source, kind) };
    s.sent += 1;
    const out = outcomeOf(r, now);
    const known = r.feedback === "skip" || r.feedback === "useful" || out === "opened" || out === "dismissed" || out === "ignored";
    if (known) {
      s.counted += 1;
      // Skip is explicit and Useful is explicit; silence only counts when you have not answered.
      if (r.feedback === "skip" || (r.feedback !== "useful" && (out === "dismissed" || out === "ignored"))) s.skipped += 1;
    }
    by.set(key, s);
  }
  for (const s of by.values()) s.rate = s.counted ? s.skipped / s.counted : 0;
  return [...by.values()].sort((a, b) => a.topic.localeCompare(b.topic));
};

/** The kinds the weekly review lists as ones you mostly skip (both upper tiers). */
export const mostlySkipped = (now: Date = new Date()): (SkipStats & { tier: SkipTier })[] =>
  skipStats(now)
    .map((s) => ({ ...s, tier: skipTierOf(s) }))
    .filter((s) => s.tier !== "none");

const percent = (r: number): string => `${Math.round(r * 100)}%`;

/**
 * Queue ONE proposal per schedule you have earned the top tier on, and never again within
 * SKIP_SUPPRESS_DAYS of any earlier proposal for that schedule, in any state: a pending one is not
 * repeated, a rejected one keeps the schedule on for 90 days, an approved one has already switched it off.
 *
 * Only a schedule that exists, is enabled, and is the only one with that name is proposed: the kind is
 * the schedule's name, so two jobs sharing a name would be a guess about which one you meant.
 * Returns the confirmation ids queued. Never throws.
 */
export const proposeSchedulesOff = (now: Date = new Date()): number[] => {
  const queued: number[] = [];
  try {
    const cutoff = new Date(now.getTime() - SKIP_SUPPRESS_DAYS * 86_400_000).toISOString();
    const schedules = store.listSchedules();
    for (const s of skipStats(now)) {
      if (skipTierOf(s) !== "off" || !PROPOSABLE_SOURCES.has(s.source as never)) continue;
      const same = schedules.filter((x) => x.name === s.kind);
      if (same.length !== 1 || !same[0].enabled) continue;
      const job = same[0];
      const asked = rawDb
        .prepare("SELECT 1 FROM confirmations WHERE tool = 'schedule_update' AND ts >= ? AND json_extract(args, '$.id') = ? AND json_extract(args, '$.enabled') = 0 LIMIT 1")
        .get(cutoff, job.id);
      if (asked) continue;
      queued.push(
        store.queueConfirmation(
          { args: { enabled: false, id: job.id }, tool: "schedule_update" },
          `STOP "${job.name.toUpperCase()}"?\n` +
            `Over the last ${SKIP_WINDOW_DAYS} days you skipped, dismissed or ignored ${s.skipped} of ${s.counted} of its messages (${percent(s.rate)}).\n` +
            `Approving switches the scheduled job off. It is not deleted, and you can turn it back on under Schedules.`,
          null,
        ),
      );
    }
  } catch (err) {
    console.warn(`[outbox] skip proposal failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return queued;
};
