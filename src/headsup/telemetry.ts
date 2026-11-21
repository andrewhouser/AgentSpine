/**
 * Heads-up telemetry (docs/archive/PLAN-heads-up-next.md workstream F): the numbers that say whether
 * this feature helps, printed in `npm run digest`.
 *
 * Like the rest of the digest, every figure is a SQL count or a stored counter. No model is
 * involved, because a summary of a summary is exactly the artifact you cannot check.
 *
 * What it can and cannot say. Offers and answers come from the ledger as it stands now: an item
 * answered "later" and since expired shows its answer, not both. That is enough to see which
 * kinds you ignore, but it is a snapshot, not an event history. Workstream B's `headsup_outcomes`
 * would give the history; when it lands, switch the answers query to it.
 */
import { HEADSUP_FLIGHT_CALLS_PER_MONTH, HEADSUP_TRAVEL_CALLS_PER_DAY } from "../config.ts";
import { kvGet, kvSet, rawDb } from "../memory/store.ts";
import { dayKey, monthKey, used } from "./watch/budget.ts";

const FAIL_KEY = (d: Date): string => `headsup:calendar-failures:${monthKey(d)}`;
const FAIL_LAST = "headsup:calendar-failures:last";

/** Called when a calendar read fails. Never throws: counting a failure must not cause one. */
export const recordCalendarFailure = (message: string, now: Date = new Date()): void => {
  try {
    kvSet(FAIL_KEY(now), String(Number(kvGet(FAIL_KEY(now))?.value ?? 0) + 1));
    kvSet(FAIL_LAST, `${now.toISOString()} ${message}`.slice(0, 300));
  } catch {
    /* a counter that did not count is not worth a failure */
  }
};

/** Which rung of the research ladder a run ended on. Stored in the heads-up's payload. */
export type ResearchRung = "fallback" | "full" | "link-only";

export const rungOf = (cards: { kind: string }[], fallbackUsed: boolean): ResearchRung =>
  fallbackUsed ? "fallback" : cards.some((c) => c.kind !== "link") ? "full" : "link-only";

const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;

const num = (v: unknown): number => Number(v ?? 0);

/** The "Heads-up" section for the digest, as lines. Empty when there is nothing to report. */
export const headsupSection = (days = 7, now: Date = new Date()): string[] => {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const out: string[] = [];

  // Offers and what became of them, by kind.
  const rows = rawDb
    .prepare(
      `SELECT kind,
              COALESCE(answer, CASE state WHEN 'expired' THEN 'ignored' ELSE 'open' END) AS outcome,
              COUNT(*) AS n
         FROM headsups WHERE first_offered_at >= ? GROUP BY kind, outcome`,
    )
    .all(since) as unknown as { kind: string; n: number; outcome: string }[];
  const byKind = new Map<string, Record<string, number>>();
  for (const r of rows) byKind.set(r.kind, { ...(byKind.get(r.kind) ?? {}), [r.outcome]: r.n });
  if (byKind.size) {
    out.push(`  Offered, by kind (answers as they stand now):`);
    for (const [kind, o] of [...byKind.entries()].sort()) {
      const total = Object.values(o).reduce((a, b) => a + b, 0);
      const part = (k: string): string => (o[k] ? `${o[k]} ${k}` : "");
      out.push(`    ${kind.padEnd(12)} ${String(total).padStart(3)} offered — ${["yes", "later", "never", "ignored", "open"].map(part).filter(Boolean).join(", ")}`);
    }
  }

  // Research: how many runs, and where each ended.
  const research = rawDb
    .prepare(
      `SELECT json_extract(payload_json, '$.rung') AS rung, COUNT(*) AS n
         FROM headsups WHERE json_extract(payload_json, '$.researchedAt') >= ? GROUP BY rung`,
    )
    .all(since) as unknown as { n: number; rung: null | string }[];
  const errors = num(
    (rawDb.prepare(`SELECT COUNT(*) AS n FROM headsups WHERE json_extract(payload_json, '$.researchError') IS NOT NULL AND updated >= ?`).get(since) as { n: number }).n,
  );
  const runs = research.reduce((a, r) => a + r.n, 0);
  if (runs || errors) {
    const rung = (k: string): number => research.find((r) => r.rung === k)?.n ?? 0;
    const untracked = research.find((r) => r.rung == null)?.n ?? 0;
    out.push(
      `  Research: ${plural(runs, "run")} — ${rung("full")} full card, ${rung("link-only")} link-only, ${rung("fallback")} fallback link` +
        (untracked ? `, ${untracked} before rungs were recorded` : "") +
        (errors ? `, ${plural(errors, "error")}` : ""),
    );
  }

  // Watches.
  const w = rawDb
    .prepare(
      `SELECT SUM(created >= ?) AS started, SUM(active = 1) AS active,
              SUM(ended_at IS NOT NULL AND ended_at >= ?) AS ended,
              SUM(last_notified IS NOT NULL AND created >= ?) AS notified,
              SUM(note LIKE 'Paused%') AS paused
         FROM headsup_watches`,
    )
    .get(since, since, since) as Record<string, null | number>;
  if (num(w.started) || num(w.active)) {
    out.push(`  Watches: ${num(w.started)} started, ${num(w.notified)} of those have notified, ${num(w.ended)} ended, ${num(w.active)} active now` + (num(w.paused) ? `, ${num(w.paused)} paused on budget` : ""));
  }
  const flights = used("flight", monthKey(now));
  const drives = used("travel", dayKey(now));
  if (flights || drives) {
    out.push(`  Provider budget: flights ${flights}/${HEADSUP_FLIGHT_CALLS_PER_MONTH} this month, drives ${drives}/${HEADSUP_TRAVEL_CALLS_PER_DAY} today`);
  }

  const failures = num(kvGet(FAIL_KEY(now))?.value);
  if (failures) out.push(`  Calendar read failures this month: ${failures} (last: ${kvGet(FAIL_LAST)?.value ?? "unknown"})`);

  return out.length ? [`\nHeads-up (last ${plural(days, "day")}):`, ...out] : [];
};
