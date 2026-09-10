/**
 * Anticipation: propose standing jobs from recurring intent (LEARNING.md Phase 4.1 & 4.2).
 *
 * The scheduler and watchers ARE the initiative mechanism; nothing here needs a new
 * actuator. What was missing is anything that decides what to point them at. This mines the
 * run ledger for intent that recurs — a question asked the same way three times is a
 * standing job waiting to be named — and turns it into a *proposal*: pre-written task text
 * that lands in the confirmation queue, exactly as if the agent had called `schedule_create`.
 *
 * ## Why this is safe, and why it lives outside src/tools/
 *
 * `schedule_create` is already classified irreversible, so every proposal below lands in the
 * confirmation queue with its full task text in front of you before it can ever run — the
 * rails are built (see `tools/schedule.ts`). This module does not call the model and is not
 * a tool the model can invoke; it reads the ledger and queues a confirmation directly. A
 * human reads the task text and approves, or it never installs. That is the whole safety
 * story, and it is the same one the schedule tool already relies on.
 *
 * ## Clustering is deliberately crude
 *
 * Two runs of the same recurring ask differ only in casing or punctuation, so the cluster
 * key is a normalized task string — the same approach the digest's steps-per-repeat-task
 * metric uses. Anything cleverer would be a similarity model masquerading as a group-by, and
 * this needs to be inference-free to satisfy Phase 1's invariant that a learner cannot be
 * argued into anything.
 */
import { PROPOSE_MIN_RECURRENCE } from "../config.ts";
import * as store from "./../memory/store.ts";

/** Collapse a task to a clustering key — lowercased, whitespace-flattened, depunctuated tail. */
export const taskKey = (task: string): string =>
  String(task ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?…\s]+$/, "")
    .trim();

export interface IntentProposal {
  /** The normalized shape that recurred. */
  key: string;
  /** How many times it was seen. */
  count: number;
  /** A representative verbatim task from the cluster — what a proposed job would run. */
  sample: string;
}

/**
 * Chat-task shapes that recur at least `PROPOSE_MIN_RECURRENCE` times and are not already
 * covered by an existing schedule. Pure read — the caller decides whether to queue them.
 */
export const recurringIntent = (): IntentProposal[] => {
  if (PROPOSE_MIN_RECURRENCE <= 0) return [];

  const existing = new Set(store.listSchedules().map((s) => taskKey(s.task)));
  const clusters = new Map<string, { count: number; sample: string }>();

  for (const task of store.tasksByKind("chat")) {
    const key = taskKey(task);
    if (!key || existing.has(key)) continue;
    const c = clusters.get(key) ?? { count: 0, sample: task };
    c.count++;
    clusters.set(key, c);
  }

  return [...clusters.entries()]
    .filter(([, c]) => c.count >= PROPOSE_MIN_RECURRENCE)
    .map(([key, c]) => ({ count: c.count, key, sample: c.sample }))
    .sort((a, b) => b.count - a.count);
};

/**
 * Queue a proposed schedule for one recurring shape, as a `schedule_create` confirmation the
 * user reviews and approves. Returns the confirmation id. The task text is the observed
 * request, handed verbatim to the future run; the schedule defaults to daily and the job is
 * created disabled, so approving it does not immediately start firing something unattended
 * before the user has watched it once.
 *
 * Deduped against the pending queue by task shape, so running the proposer repeatedly does
 * not pile up identical cards.
 */
export const queueIntentProposal = (p: IntentProposal, schedule = "every day at 9:00am"): null | number => {
  const alreadyPending = store
    .listConfirmations("pending")
    .some((c) => c.tool === "schedule_create" && taskKey(JSON.parse(c.args ?? "{}")?.task ?? "") === p.key);
  if (alreadyPending) return null;

  const call = {
    tool: "schedule_create",
    args: {
      name: p.sample.slice(0, 60),
      task: p.sample,
      schedule,
      enabled: false,
    },
  };
  const summary =
    `PROPOSED JOB from a request you have made ${p.count} times.\n\n` +
    `Runs (disabled until you enable it): ${schedule}\n\n` +
    `Task, handed verbatim to each run:\n\n${p.sample}`;
  return store.queueConfirmation(call, summary, null);
};

/**
 * The proposer job body: find recurring intent and queue a proposal for each new shape.
 * Returns the confirmation ids queued. Never throws — a proposer that failed is worth less
 * than the runs it read. Intended to be run from a weekly schedule.
 */
export const runProposer = (): number[] => {
  try {
    const queued: number[] = [];
    for (const p of recurringIntent()) {
      const id = queueIntentProposal(p);
      if (id != null) queued.push(id);
    }
    if (queued.length) console.log(`[propose] queued ${queued.length} schedule proposal(s) for review`);
    return queued;
  } catch (err) {
    console.warn(`[propose] skipped: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
};

/**
 * Turn a standing-intent phrase caught in conversation (Phase 4.2) into the same kind of
 * proposal. `reflect.ts` may surface a `standing` field — "keep an eye on X", "let me know
 * when Y ships" — and this queues it as a watcher-shaped job. Deduped like the mined ones.
 */
export const queueStandingIntent = (task: string, schedule = "every day at 9:00am"): null | number => {
  const trimmed = String(task ?? "").trim();
  if (!trimmed) return null;
  return queueIntentProposal({ count: 1, key: taskKey(trimmed), sample: trimmed }, schedule);
};

// --- CLI: npm run propose  (dry run: npm run propose -- --dry) ---
// Runs the ledger miner and queues a proposal per new recurring shape. --dry lists what it
// would propose without queuing anything (pass it after `--` so npm forwards it). Meant for
// a weekly schedule, or a manual look.
if (import.meta.filename === process.argv[1]) {
  const dry = process.argv.includes("--dry") || process.argv.includes("--dry-run");
  const found = recurringIntent();
  if (!found.length) {
    console.log("No recurring chat intent above the threshold. Nothing to propose.");
  } else if (dry) {
    console.log(`Would propose ${found.length} job(s):`);
    for (const p of found) console.log(`  ${p.count}×  ${p.sample.slice(0, 100)}`);
  } else {
    const ids = runProposer();
    console.log(`Queued ${ids.length} proposal(s) for review: ${ids.map((i) => `#${i}`).join(", ") || "(none new)"}`);
  }
  process.exit(0);
}
