/**
 * Signals of a bad answer (docs/PLAN-open-work.md, SL3).
 *
 * Reflection learns only from your own words, and that stays. These are the things you do without typing
 * a complaint: stop a run, ask again straight away, edit a draft, reject a proposal. Code counts them for
 * the weekly retrospective (SL2).
 *
 * This is a read of the ledger and nothing else. It calls no model and writes no memory, because a stop
 * can mean "I changed my mind" as easily as "that was wrong": one signal is a reason to look, not a fact
 * about you. It returns ids and counts, never task text, so a report of it cannot carry private content.
 */
import fs from "node:fs";
import path from "node:path";
import { loadPolicy } from "../config.ts";
import { insideAny } from "../fs-scope.ts";
import { rawDb } from "../memory/store.ts";
import { STOPWORDS } from "../projects/search.ts";
import { draftsDir } from "../tools/draft.ts";
import type { Policy } from "../types.ts";

/**
 * Starting values to check against real weeks. Three minutes is about how long it takes to read an answer
 * and try again. Three content words keeps "continue" twice, or "yes" twice, from looking like a re-ask.
 */
export const SIGNAL_LIMITS = {
  draftEditGraceMs: 5000,
  reAskMinWords: 3,
  reAskOverlap: 0.6,
  reAskWindowMs: 180_000,
} as const;

export interface ReAsk {
  /** The later run that asked again. */
  followedBy: number;
  /** The run whose answer was asked over. */
  runId: number;
}

export interface BadAnswerSignals {
  editedDrafts: number[];
  reAsks: ReAsk[];
  rejectedProposals: { confirmationId: number; kind: string }[];
  /** Runs with at least one run-level signal, so a stop followed by a re-ask counts once here. */
  runs: number[];
  since: string;
  stops: number[];
}

const contentWords = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]/gu) ?? []).filter((w) => !STOPWORDS.has(w)),
  );

/** Whether two requests are close enough in wording to be the same request. Crude on purpose, like `taskKey`. */
export const isSameAsk = (a: string, b: string): boolean => {
  const left = contentWords(a);
  const right = contentWords(b);
  if (left.size < SIGNAL_LIMITS.reAskMinWords || right.size < SIGNAL_LIMITS.reAskMinWords) return false;
  const shared = [...left].filter((w) => right.has(w)).length;
  return shared / (left.size + right.size - shared) >= SIGNAL_LIMITS.reAskOverlap;
};

interface ChatRun {
  conversation_id: null | number;
  finished: null | string;
  id: number;
  started: string;
  status: null | string;
  task: null | string;
}

const findReAsks = (rows: ChatRun[]): ReAsk[] => {
  const out: ReAsk[] = [];
  const lastInThread = new Map<number, ChatRun>();
  for (const run of rows) {
    if (run.conversation_id == null) continue;
    const before = lastInThread.get(run.conversation_id);
    lastInThread.set(run.conversation_id, run);
    if (!before?.finished || !before.task || !run.task) continue;
    const gap = Date.parse(run.started) - Date.parse(before.finished);
    if (gap <= SIGNAL_LIMITS.reAskWindowMs && isSameAsk(before.task, run.task)) {
      out.push({ followedBy: run.id, runId: before.id });
    }
  }
  return out;
};

const SAVED_DRAFT = /^Draft saved to (.+?\.md)\. Nothing was sent/;
const DRAFT_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/;

/**
 * Drafts changed after the tool wrote them. You edit a draft outside the app, so the file is the only
 * witness. Its name carries the moment it was written, and modified time survives an editor that saves by
 * replacing the file, which comparing it to the creation time would not. A `touch` reads as an edit; that
 * is acceptable for a signal that is only ever counted.
 */
const findEditedDrafts = (sinceIso: string, policy: Policy): number[] => {
  const rows = rawDb
    .prepare(
      "SELECT run_id, output AS text FROM actions WHERE tool = 'draft' AND ts >= ? AND output LIKE 'Draft saved to %' " +
        "UNION ALL SELECT run_id, result AS text FROM confirmations WHERE tool = 'draft' AND state = 'done' AND ts >= ? " +
        "AND result LIKE 'Draft saved to %'",
    )
    .all(sinceIso, sinceIso) as unknown as { run_id: null | number; text: string }[];
  const dir = draftsDir(policy);
  const edited = new Set<number>();
  for (const row of rows) {
    if (row.run_id == null) continue;
    const file = SAVED_DRAFT.exec(row.text)?.[1];
    const stamp = file ? DRAFT_STAMP.exec(path.basename(file)) : null;
    if (!file || !stamp || !insideAny([dir], file)) continue;
    const written = Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`);
    try {
      if (fs.statSync(file).mtimeMs > written + SIGNAL_LIMITS.draftEditGraceMs) edited.add(row.run_id);
    } catch {
      // A draft you deleted is gone, and deleting one says nothing about whether it was good.
    }
  }
  return [...edited].sort((a, b) => a - b);
};

/** Count the signals since a moment. A policy that cannot be read costs the draft count and nothing else. */
export const badAnswerSignals = (since: Date, policy?: Policy): BadAnswerSignals => {
  const sinceIso = since.toISOString();
  // Top-level chat only: a subagent's task is written by the model, and a schedule repeats by design.
  const rows = rawDb
    .prepare(
      "SELECT id, conversation_id, status, task, started, finished FROM runs " +
        "WHERE kind = 'chat' AND parent_run_id IS NULL AND started >= ? ORDER BY id",
    )
    .all(sinceIso) as unknown as ChatRun[];
  const stops = rows.filter((r) => r.status === "stopped").map((r) => r.id);
  const reAsks = findReAsks(rows);

  let editedDrafts: number[] = [];
  try {
    editedDrafts = findEditedDrafts(sinceIso, policy ?? loadPolicy());
  } catch (err) {
    console.warn(`[signals] drafts not counted: ${err instanceof Error ? err.message : String(err)}`);
  }

  const rejectedProposals = (
    rawDb
      .prepare(
        "SELECT confirmation_id, kind FROM proposal_log WHERE outcome = 'rejected' AND decided >= ? ORDER BY confirmation_id",
      )
      .all(sinceIso) as unknown as { confirmation_id: number; kind: string }[]
  ).map((r) => ({ confirmationId: r.confirmation_id, kind: r.kind }));

  const runs = [...new Set([...stops, ...reAsks.map((r) => r.runId), ...editedDrafts])].sort((a, b) => a - b);
  return { editedDrafts, reAsks, rejectedProposals, runs, since: sinceIso, stops };
};

// --- CLI: npm run signals  (another window: npm run signals -- --days 30) ---
// Read-only, and prints only counts and ids.
if (import.meta.filename === process.argv[1]) {
  const at = process.argv.indexOf("--days");
  const asked = at >= 0 ? Number(process.argv[at + 1]) : 7;
  const days = Number.isFinite(asked) && asked > 0 ? asked : 7;
  const s = badAnswerSignals(new Date(Date.now() - days * 86_400_000));
  const ids = (list: number[]): string => (list.length ? `  (runs ${list.join(", ")})` : "");
  console.log(`Signals of a bad answer in the last ${days} days:`);
  console.log(`  Stopped runs:        ${s.stops.length}${ids(s.stops)}`);
  console.log(`  Asked again at once: ${s.reAsks.length}${ids(s.reAsks.map((r) => r.runId))}`);
  console.log(`  Edited drafts:       ${s.editedDrafts.length}${ids(s.editedDrafts)}`);
  console.log(`  Rejected proposals:  ${s.rejectedProposals.length}`);
  console.log(`  Distinct runs:       ${s.runs.length}`);
  process.exit(0);
}
