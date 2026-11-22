/**
 * Version history and after-checks for scheduled tasks (docs/PLAN-open-work.md, SL8).
 *
 * Approving a change to a standing instruction is a prediction that it will work. Nothing used to check the
 * prediction. So every change to a job's task keeps the text it replaced (`store.updateSchedule`), and a few
 * weeks later code compares the job's runs on either side of the change and says what it sees.
 *
 * The comparison is arithmetic on the ledger, with no model in it. It reports and never acts: going back is one
 * click, but the click queues an ordinary `schedule_update` confirmation showing the diff, because restored text
 * is still a prompt an unattended agent will follow, and old text may be old for a good reason.
 */
import { AUDIT_RETENTION_DAYS } from "../config.ts";
import * as store from "../memory/store.ts";
import type { ScheduleVersionRow } from "../memory/store.ts";
import { diffLines } from "./rewrite.ts";

/**
 * Starting values to check on real weeks. Three weeks on each side covers about three runs of a weekly job and
 * twenty of a daily one, and five runs is the fewest where one bad day does not decide the median. A quarter more
 * calls, or at least one, is past the wobble of a job that usually takes three; fifteen points of failure rate is
 * about one extra failed run in seven.
 */
export const AFTER_CHECK = {
  callsChange: 0.25,
  failureChange: 0.15,
  minRuns: 5,
  windowDays: 21,
} as const;

const WINDOW_MS = AFTER_CHECK.windowDays * 86_400_000;

export type Verdict = "better" | "mixed" | "same" | "worse";

export interface RunStats {
  failureRate: null | number;
  medianCalls: null | number;
  runs: number;
}

export interface AfterCheck {
  /** The numbers behind the headline, or null until there are numbers worth showing. */
  detail: null | string;
  headline: string;
  status: "not_enough" | "ready" | "superseded" | "waiting";
  verdict: null | Verdict;
}

const median = (xs: number[]): null | number => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * What a job's runs cost and how often they failed, between two moments. Subagents count, or a rewrite that
 * moved its work into one would look cheaper while doing the same work. A run you stopped is left out: that is
 * your decision and says nothing about the text. An `ok` run with an errored call counts as failed, because a
 * watcher whose fetch broke usually still finishes politely.
 */
export const runStats = (scheduleId: number, fromIso: string, toIso: string): RunStats => {
  const rows = store.rawDb
    .prepare(
      "SELECT id, status FROM runs WHERE schedule_id = ? AND parent_run_id IS NULL AND finished IS NOT NULL " +
        "AND status <> 'stopped' AND started >= ? AND started < ?",
    )
    .all(scheduleId, fromIso, toIso) as unknown as { id: number; status: string }[];
  const tree = store.rawDb.prepare(
    "WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id) " +
      "SELECT COUNT(*) AS calls, COALESCE(SUM(decision = 'error'), 0) AS errors FROM actions WHERE run_id IN (SELECT id FROM tree)",
  );
  const calls: number[] = [];
  let failures = 0;
  for (const run of rows) {
    const t = tree.get(run.id) as unknown as { calls: number; errors: number };
    calls.push(t.calls);
    if (run.status !== "ok" || t.errors > 0) failures += 1;
  }
  return { failureRate: rows.length ? failures / rows.length : null, medianCalls: median(calls), runs: rows.length };
};

/** Compare two windows that both have enough runs. */
export const judge = (before: RunStats, after: RunStats): Verdict => {
  // Rounded so that 0.2 - 0.05 lands on the threshold rather than a hair to one side of it.
  const failDelta = Math.round(((after.failureRate ?? 0) - (before.failureRate ?? 0)) * 1e6) / 1e6;
  const callDelta = (after.medianCalls ?? 0) - (before.medianCalls ?? 0);
  const callLimit = Math.max(1, (before.medianCalls ?? 0) * AFTER_CHECK.callsChange);
  const worse = failDelta >= AFTER_CHECK.failureChange || callDelta >= callLimit;
  const better = failDelta <= -AFTER_CHECK.failureChange || callDelta <= -callLimit;
  if (worse && better) return "mixed";
  if (worse) return "worse";
  return better ? "better" : "same";
};

const HEADLINES: Record<Verdict, string> = {
  better: "Looks better since this change",
  mixed: "Mixed since this change",
  same: "No clear difference since this change",
  worse: "Looks worse since this change",
};

const pct = (n: null | number): string => `${Math.round((n ?? 0) * 100)}%`;

/** The check for one change. `all` is the job's versions, oldest first. */
export const afterCheck = (version: ScheduleVersionRow, all: ScheduleVersionRow[], nowMs = Date.now()): AfterCheck => {
  const at = all.findIndex((v) => v.id === version.id);
  const changedMs = Date.parse(version.changed);
  const endMs = changedMs + WINDOW_MS;
  const next = all[at + 1];
  // A second change inside the window means the runs after it were following different text.
  if (next && Date.parse(next.changed) < endMs) {
    return { detail: null, headline: "Changed again before it could be measured", status: "superseded", verdict: null };
  }
  if (nowMs < endMs) {
    return { detail: null, headline: `Still measuring, until ${new Date(endMs).toISOString().slice(0, 10)}`, status: "waiting", verdict: null };
  }
  const prev = at > 0 ? Date.parse(all[at - 1].changed) : 0;
  const fromMs = Math.max(changedMs - WINDOW_MS, prev);
  // Audit rows age out on their own clock, and a run whose calls were pruned reads as a run that made none. Left
  // alone, an unanswered check would slowly turn into "looks worse" just because its "before" had been deleted.
  if (AUDIT_RETENTION_DAYS > 0 && nowMs - fromMs > AUDIT_RETENTION_DAYS * 86_400_000) {
    return { detail: "The earlier runs have aged out of the ledger.", headline: "Not enough runs to compare", status: "not_enough", verdict: null };
  }
  const before = runStats(version.schedule_id, new Date(fromMs).toISOString(), version.changed);
  const after = runStats(version.schedule_id, version.changed, new Date(endMs).toISOString());
  const counts = `From ${before.runs} runs before and ${after.runs} after.`;
  if (before.runs < AFTER_CHECK.minRuns || after.runs < AFTER_CHECK.minRuns) {
    return { detail: counts, headline: "Not enough runs to compare", status: "not_enough", verdict: null };
  }
  const verdict = judge(before, after);
  return {
    detail: `Tool calls per run: ${before.medianCalls} to ${after.medianCalls}. Failed runs: ${pct(before.failureRate)} to ${pct(after.failureRate)}. ${counts}`,
    headline: HEADLINES[verdict],
    status: "ready",
    verdict,
  };
};

const SOURCE_LABELS: Record<store.ScheduleChange, string> = {
  agent: "Changed through an approval",
  edit: "You edited it",
  system: "App update",
};

export interface VersionView {
  after: string;
  before: string;
  canRestore: boolean;
  changed: string;
  /** Only the newest change has one: an older one's runs were followed by another change. */
  check: AfterCheck | null;
  id: number;
  restored: boolean;
  sourceLabel: string;
}

/** A job's changes, newest first. */
export const scheduleHistory = (scheduleId: number, nowMs = Date.now()): null | { versions: VersionView[] } => {
  const job = store.getSchedule(scheduleId);
  if (!job) return null;
  const all = store.listScheduleVersions(scheduleId);
  const versions = all
    .map((v, i): VersionView => ({
      after: v.after_task,
      before: v.before_task,
      canRestore: v.before_task !== job.task,
      changed: v.changed,
      check: i === all.length - 1 ? afterCheck(v, all, nowMs) : null,
      id: v.id,
      restored: store.isRestoredVersion(v, all),
      sourceLabel: SOURCE_LABELS[v.source] ?? v.source,
    }))
    .reverse();
  return { versions };
};

export type RestoreResult = { confirmationId: number; message: string } | { error: string };

/**
 * Queue the text a change replaced for your approval. Applies nothing. The call names the version rather than
 * carrying the text, so what lands is exactly what was stored, and it carries the fingerprint of the task you
 * were shown so an approval given after the job moved on is refused instead of overwriting the newer text.
 */
export const queueRestore = (scheduleId: number, versionId: number): RestoreResult => {
  const job = store.getSchedule(scheduleId);
  const version = store.getScheduleVersion(versionId);
  if (!job || !version || version.schedule_id !== scheduleId) return { error: "no such version of this job" };
  if (version.before_task === job.task) return { error: "the job already says this" };
  const waiting = store.listConfirmations("pending").find((c) => {
    if (c.tool !== "schedule_update") return false;
    try {
      const a = JSON.parse(c.args ?? "{}");
      return Number(a?.id) === scheduleId && Number(a?.restore_version) === versionId;
    } catch {
      return false;
    }
  });
  if (waiting) return { confirmationId: waiting.id, message: "That restore is already waiting in Approvals." };
  const summary =
    `RESTORE earlier text of job #${scheduleId} "${job.name}". Review the DIFF below; the text changes only if you approve.\n\n` +
    `(- removed, + added, unchanged lines unmarked)\n\n${diffLines(job.task, version.before_task)}`;
  const confirmationId = store.queueConfirmation(
    { args: { id: scheduleId, if_current: store.taskFingerprint(job.task), restore_version: versionId }, tool: "schedule_update" },
    summary,
    null,
  );
  return { confirmationId, message: "Queued in Approvals. Nothing changes until you approve it." };
};

export interface AfterCheckCard {
  changed: string;
  detail: null | string;
  headline: string;
  id: number;
  name: string;
  scheduleId: number;
  verdict: Verdict;
}

/** Finished checks you have not answered, for the weekly review. Only a job's newest change can be open. */
export const openAfterChecks = (nowMs = Date.now()): AfterCheckCard[] => {
  const cards: AfterCheckCard[] = [];
  for (const job of store.listSchedules()) {
    const all = store.listScheduleVersions(job.id);
    const latest = all.at(-1);
    if (!latest || latest.check_answer || Date.parse(latest.changed) + WINDOW_MS > nowMs) continue;
    const check = afterCheck(latest, all, nowMs);
    if (check.status !== "ready" || !check.verdict) continue;
    cards.push({
      changed: latest.changed,
      detail: check.detail,
      headline: check.headline,
      id: latest.id,
      name: job.name,
      scheduleId: job.id,
      verdict: check.verdict,
    });
  }
  return cards;
};

/** Keep the change, or queue the old text for approval. Null when the card is not open. */
export const answerAfterCheck = (
  versionId: number,
  answer: "keep" | "revert",
  nowMs = Date.now(),
): { message: string; queued: null | number } | null => {
  const card = openAfterChecks(nowMs).find((c) => c.id === versionId);
  if (!card) return null;
  if (answer === "keep") {
    store.answerScheduleCheck(versionId, "kept");
    return { message: "Kept.", queued: null };
  }
  const result = queueRestore(card.scheduleId, versionId);
  // A refused restore leaves the card open, so the question is still there to answer.
  if ("error" in result) return { message: result.error, queued: null };
  store.answerScheduleCheck(versionId, "revert");
  return { message: result.message, queued: result.confirmationId };
};
