/**
 * Heads-up outcomes (docs/PLAN-open-work.md section 3, workstream B): what became of each offer, so a
 * kind you keep ignoring gets quieter, and eventually gets proposed off.
 *
 * One row per heads-up, written when it is first offered and settled as it is answered. The ledger
 * (`headsups`) only keeps the LAST answer; this table is the history the telemetry and the tiers read.
 *
 * The rules, all of them in code and none in a prompt:
 *  - `yes`, `never` and `later` come from `answer()` in ledger.ts. `ignored` is written when an offered
 *    item reaches its due date with no answer at all, and only for items that were actually offered.
 *  - `later` is neutral. It is left out of the count entirely, and a later `yes` or `never` replaces it.
 *    An item answered `later` and then left to expire stays `later`: you did answer it.
 *  - Per kind over OUTCOME_WINDOW_DAYS: counted = yes + never + ignored, and
 *    dismissRate = (never + ignored) / counted. Items still open are not counted either.
 *  - Never by subject (the unit is the kind), never in the first weeks (the minimums), never disable
 *    without asking (the top tier only queues a proposal), and never touch a watch (this module has no
 *    reach into watches at all).
 *
 * This file imports only the store and the rules, so ledger.ts can call it without a cycle.
 */
import { queueConfirmation, rawDb } from "../memory/store.ts";
import {
  OFF_MIN_COUNTED,
  OFF_MIN_RATE,
  OFF_SUPPRESS_DAYS,
  OUTCOME_WINDOW_DAYS,
  QUIETEN_MIN_COUNTED,
  QUIETEN_MIN_RATE,
} from "./rules.ts";

export type OutcomeValue = "ignored" | "later" | "never" | "yes";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS headsup_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    headsup_id INTEGER NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    offered_at TEXT NOT NULL,
    outcome TEXT,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_headsup_outcomes_kind ON headsup_outcomes (kind, offered_at);
`);

/**
 * Rows offered before this table existed: take what the ledger knows. An answered item gets its answer,
 * an expired one is `ignored`, anything else is still open. Idempotent: it only adds rows that are missing.
 *
 * Called by ledger.ts once the `headsups` table exists. It cannot run when this file is imported,
 * because ledger.ts imports this file first and has not created its table yet.
 */
export const backfillOutcomes = (): void => {
  rawDb.exec(`
    INSERT INTO headsup_outcomes (headsup_id, kind, offered_at, outcome, resolved_at)
    SELECT id, kind, first_offered_at,
           COALESCE(answer, CASE state WHEN 'expired' THEN 'ignored' END),
           CASE WHEN answer IS NOT NULL OR state = 'expired' THEN updated END
      FROM headsups
     WHERE first_offered_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM headsup_outcomes o WHERE o.headsup_id = headsups.id);
  `);
};

const iso = (d: Date): string => d.toISOString();

/** A heads-up was offered for the first time. Later reminders for the same row do not add another. */
export const recordOffer = (headsupId: number, kind: string, now: Date): void => {
  rawDb
    .prepare("INSERT OR IGNORE INTO headsup_outcomes (headsup_id, kind, offered_at) VALUES (?,?,?)")
    .run(headsupId, kind, iso(now));
};

/** You answered. `yes` and `never` settle it for good; `later` only stands until a final answer replaces it. */
export const recordAnswer = (headsupId: number, answer: "later" | "never" | "yes", now: Date): void => {
  rawDb
    .prepare("UPDATE headsup_outcomes SET outcome = ?, resolved_at = ? WHERE headsup_id = ?")
    .run(answer, iso(now), headsupId);
};

/**
 * Items whose date has passed with no answer at all become `ignored`. Called by `expirePast` BEFORE it
 * flips the state, because the rows it will expire are the ones this selects. An item you snoozed
 * keeps `later`, and one you accepted keeps `yes`, so neither is touched here.
 */
export const recordIgnoredBefore = (localDate: string, now: Date): number => {
  const r = rawDb
    .prepare(
      `UPDATE headsup_outcomes SET outcome = 'ignored', resolved_at = ?
        WHERE outcome IS NULL
          AND headsup_id IN (SELECT id FROM headsups
                              WHERE state IN ('offered','snoozed') AND substr(due_at, 1, 10) < ?)`,
    )
    .run(iso(now), localDate);
  return Number(r.changes);
};

export interface KindStats {
  /** Offered in the window, whatever became of them. What Settings shows. */
  offered: number;
  /** yes + never + ignored: the offers that count towards a rate. */
  counted: number;
  ignored: number;
  kind: string;
  later: number;
  never: number;
  open: number;
  /** (never + ignored) / counted, or 0 when nothing is counted. */
  rate: number;
  yes: number;
}

const since = (now: Date): string => iso(new Date(now.getTime() - OUTCOME_WINDOW_DAYS * 86_400_000));

/** Per kind over the window, newest data only. Outcomes older than the window stop counting. */
export const statsByKind = (now: Date = new Date()): KindStats[] => {
  const rows = rawDb
    .prepare(
      `SELECT kind, COALESCE(outcome, 'open') AS outcome, COUNT(*) AS n
         FROM headsup_outcomes WHERE offered_at >= ? GROUP BY kind, outcome`,
    )
    .all(since(now)) as unknown as { kind: string; n: number; outcome: string }[];
  const by = new Map<string, KindStats>();
  for (const r of rows) {
    const s =
      by.get(r.kind) ??
      ({ counted: 0, ignored: 0, kind: r.kind, later: 0, never: 0, offered: 0, open: 0, rate: 0, yes: 0 } as KindStats);
    s.offered += r.n;
    if (r.outcome === "yes") s.yes += r.n;
    else if (r.outcome === "never") s.never += r.n;
    else if (r.outcome === "ignored") s.ignored += r.n;
    else if (r.outcome === "later") s.later += r.n;
    else s.open += r.n;
    by.set(r.kind, s);
  }
  for (const s of by.values()) {
    s.counted = s.yes + s.never + s.ignored;
    s.rate = s.counted ? (s.never + s.ignored) / s.counted : 0;
  }
  return [...by.values()].sort((a, b) => a.kind.localeCompare(b.kind));
};

export type Tier = "none" | "off" | "quiet";

// A tiny slack so 7 of 10 meets 0.7 whatever the float division says.
const EPS = 1e-9;

/** What a kind's numbers earn. Pure: tested at every boundary. */
export const tierOf = (s: Pick<KindStats, "counted" | "rate">): Tier => {
  if (s.counted >= OFF_MIN_COUNTED && s.rate + EPS >= OFF_MIN_RATE) return "off";
  if (s.counted >= QUIETEN_MIN_COUNTED && s.rate + EPS >= QUIETEN_MIN_RATE) return "quiet";
  return "none";
};

/** The kinds to quieten right now: the planner drops their reminders and sorts them last. */
export const quietKinds = (now: Date = new Date()): Set<string> =>
  new Set(statsByKind(now).filter((s) => tierOf(s) !== "none").map((s) => s.kind));

/** For Settings: the line per kind, with where it stands. */
export interface KindLearning extends KindStats {
  tier: Tier;
}
export const learningForClient = (now: Date = new Date()): KindLearning[] =>
  statsByKind(now).map((s) => ({ ...s, tier: tierOf(s) }));

export const KIND_SET_TOOL = "headsup_kind_set";

const percent = (r: number): string => `${Math.round(r * 100)}%`;

/**
 * Queue ONE proposal per kind that has earned the top tier, and never again within OFF_SUPPRESS_DAYS
 * of any earlier proposal for that kind, in any state: pending is not repeated every morning, a
 * rejected one keeps the kind quiet-but-on for 90 days, and an approved one has already turned it off.
 * A reason-less rejection is also tallied by the confirmation queue's own rejection counter.
 * Returns the confirmation ids queued. Never throws: a tidy-up that failed must not stop the morning.
 */
export const proposeKindsOff = (now: Date, enabled: (kind: string) => boolean): number[] => {
  const queued: number[] = [];
  try {
    const cutoff = iso(new Date(now.getTime() - OFF_SUPPRESS_DAYS * 86_400_000));
    for (const s of statsByKind(now)) {
      if (tierOf(s) !== "off" || !enabled(s.kind)) continue;
      const asked = rawDb
        .prepare("SELECT 1 FROM confirmations WHERE tool = ? AND ts >= ? AND json_extract(args, '$.kind') = ? LIMIT 1")
        .get(KIND_SET_TOOL, cutoff, s.kind);
      if (asked) continue;
      queued.push(
        queueConfirmation(
          { args: { enabled: false, kind: s.kind }, tool: KIND_SET_TOOL },
          `STOP OFFERING ${s.kind.toUpperCase()} HEADS-UPS?\n` +
            `Over the last ${OUTCOME_WINDOW_DAYS} days you passed on ${s.never + s.ignored} of ${s.counted} (${percent(s.rate)}).\n` +
            `Approving turns the ${s.kind} kind off. Anything already being watched keeps going, and you can turn the kind back on in Settings.`,
          null,
        ),
      );
    }
  } catch (err) {
    console.warn(`[headsup] kind proposal failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return queued;
};
