/**
 * The private answer key (docs/PLAN-open-work.md, SL6).
 *
 * A learner can only claim to have made the agent better against something that does not move, so this is a
 * small set of real tasks with expected results. The checks are plain code on purpose: a judge on the local
 * model would be grading its own work, and would drift whenever the model changed.
 *
 * Real tasks carry private material, so the file lives outside the repository, must be readable by you
 * alone, and nothing here prints a task, a source or an expected phrase. Reports carry ids, counts and the
 * name of the check that failed (`mustSay[1]`), which you look up in your own file.
 *
 * Key format (JSON, kept outside git, chmod 600):
 *   { "tasks": [ {
 *       "id": "weekly-budget",
 *       "task": "What did we decide about the Q3 budget?",
 *       "context": "Source text the task works from, if any. It reaches the model as untrusted content.",
 *       "approved": true,
 *       "checks": {
 *         "mustSay": ["Thursday", ["$1,200", "1200"]],   every entry must appear; a list means any one of them
 *         "mustNotSay": ["cancelled"],
 *         "mustCall": ["memory_recall"],                 reached the point of running, in dry run
 *         "mustNotCall": ["draft"],                      not even attempted
 *         "maxSteps": 4
 *       } } ] }
 *
 * `approved` is the only way a row counts. A row made from a run starts false with no checks, and you turn it
 * on by editing this file, so a signal can suggest a row but never add one to the score.
 */
import fs from "node:fs";
import path from "node:path";

export interface AnswerChecks {
  maxSteps?: number;
  mustCall?: string[];
  mustNotCall?: string[];
  mustNotSay?: string[];
  mustSay?: (string | string[])[];
}

export interface AnswerRow {
  approved: boolean;
  checks: AnswerChecks;
  context?: string;
  id: string;
  task: string;
}

export interface AnswerKey {
  [other: string]: unknown;
  tasks: AnswerRow[];
}

/** What one run did, as the audit log and the loop reported it. */
export interface Observed {
  calls: { decision: string; tool: string }[];
  reply: string;
  steps: number;
}

export interface TaskResult {
  /** The error's class only. A message can quote the prompt it failed on. */
  error?: string;
  failed: string[];
  id: string;
  status: "error" | "fail" | "pass";
  steps: null | number;
}

export interface KeyReport {
  drafts: number;
  errors: number;
  failed: number;
  passed: number;
  /** Passed over completed runs. Null when nothing completed, so an outage cannot read as a score of 0%. */
  passRate: null | number;
  results: TaskResult[];
}

const CHECK_NAMES = new Set(["maxSteps", "mustCall", "mustNotCall", "mustNotSay", "mustSay"]);
const ROW_FIELDS = new Set(["approved", "checks", "context", "id", "task"]);

const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isText);

const validChecks = (id: string, raw: unknown, knownTools?: ReadonlySet<string>): AnswerChecks => {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`task ${id}: checks must be an object`);
  const checks = raw as Record<string, unknown>;
  // A misspelled check that was ignored would pass forever while checking nothing.
  for (const name of Object.keys(checks)) if (!CHECK_NAMES.has(name)) throw new Error(`task ${id}: unknown check "${name}"`);
  if (checks.maxSteps !== undefined && (!Number.isInteger(checks.maxSteps) || (checks.maxSteps as number) < 1)) {
    throw new Error(`task ${id}: maxSteps must be a whole number of at least 1`);
  }
  for (const name of ["mustCall", "mustNotCall", "mustNotSay"] as const) {
    if (checks[name] !== undefined && !isTextList(checks[name])) throw new Error(`task ${id}: ${name} must be a list of text`);
  }
  if (checks.mustSay !== undefined) {
    const ok = Array.isArray(checks.mustSay) && checks.mustSay.length > 0 && checks.mustSay.every((e) => isText(e) || isTextList(e));
    if (!ok) throw new Error(`task ${id}: mustSay must list text, or lists of alternatives`);
  }
  if (knownTools) {
    for (const name of ["mustCall", "mustNotCall"] as const) {
      for (const tool of (checks[name] as string[] | undefined) ?? []) {
        if (!knownTools.has(tool)) throw new Error(`task ${id}: ${name} names a tool that does not exist: ${tool}`);
      }
    }
  }
  return checks as AnswerChecks;
};

/** Refuse a malformed key whole. Errors name the row and the field, never the content. */
export const validateKey = (raw: unknown, knownTools?: ReadonlySet<string>): AnswerKey => {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as AnswerKey).tasks)) throw new Error('the key needs a "tasks" list');
  const key = raw as AnswerKey;
  const seen = new Set<string>();
  key.tasks.forEach((row, at) => {
    if (!row || typeof row !== "object" || !isText(row.id)) throw new Error(`task ${at + 1}: needs an id`);
    if (seen.has(row.id)) throw new Error(`task ${row.id}: the id is used twice`);
    seen.add(row.id);
    for (const field of Object.keys(row)) if (!ROW_FIELDS.has(field)) throw new Error(`task ${row.id}: unknown field "${field}"`);
    if (!isText(row.task)) throw new Error(`task ${row.id}: needs task text`);
    if (typeof row.approved !== "boolean") throw new Error(`task ${row.id}: approved must be true or false`);
    if (row.context !== undefined && typeof row.context !== "string") throw new Error(`task ${row.id}: context must be text`);
    const checks = validChecks(row.id, row.checks, knownTools);
    if (row.approved && !Object.keys(checks).length) throw new Error(`task ${row.id}: an approved task needs at least one check`);
  });
  return key;
};

/**
 * The key must be outside the repository and yours alone. Checked on every use because a file copied or
 * restored from a backup can come back with wider permissions than it left with.
 */
export const assertPrivatePath = (file: string, repoRoot: string): string => {
  const resolved = path.resolve(file);
  let dir = path.dirname(resolved);
  // The file may not exist yet, so resolve the nearest folder that does. A symlink must not hide the repo.
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const real = path.join(fs.realpathSync(dir), path.relative(dir, resolved));
  const root = fs.realpathSync(repoRoot);
  if (real === root || real.startsWith(root + path.sep)) throw new Error("the answer key must live outside the repository");
  if (fs.existsSync(resolved) && (fs.statSync(resolved).mode & 0o077) !== 0) {
    throw new Error("the answer key must be readable by you alone: chmod 600 it");
  }
  return resolved;
};

export const readKey = (file: string, knownTools?: ReadonlySet<string>): AnswerKey => {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    // JSON.parse quotes the text around a syntax error, and this text is private.
    if (err instanceof SyntaxError) throw new Error("the answer key is not valid JSON");
    throw err;
  }
  return validateKey(raw, knownTools);
};

/** Add one unapproved row. It scores nothing until you write its checks and set `approved`. */
export const addDraft = (file: string, runId: number, task: string): string => {
  const key: AnswerKey = fs.existsSync(file) ? readKey(file) : { tasks: [] };
  const id = `run-${runId}`;
  if (key.tasks.some((r) => r.id === id)) throw new Error(`task ${id} is already in the key`);
  key.tasks.push({ approved: false, checks: {}, id, task });
  // Renamed into place so that an interrupted write cannot cost you the key.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return id;
};

const plain = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Which checks a run failed, by name and position so the report carries no expected text. */
export const scoreRun = (checks: AnswerChecks, seen: Observed): string[] => {
  const reply = plain(seen.reply);
  const failed: string[] = [];
  (checks.mustSay ?? []).forEach((entry, i) => {
    const options = Array.isArray(entry) ? entry : [entry];
    if (!options.some((o) => reply.includes(plain(o)))) failed.push(`mustSay[${i}]`);
  });
  (checks.mustNotSay ?? []).forEach((phrase, i) => {
    if (reply.includes(plain(phrase))) failed.push(`mustNotSay[${i}]`);
  });
  // A denied call did not do the work, so it cannot satisfy mustCall. It was still attempted, so it does
  // break mustNotCall: "tried the forbidden thing and policy caught it" is not the behaviour being asked for.
  (checks.mustCall ?? []).forEach((tool, i) => {
    if (!seen.calls.some((c) => c.tool === tool && c.decision === "dry-run")) failed.push(`mustCall[${i}]`);
  });
  (checks.mustNotCall ?? []).forEach((tool, i) => {
    if (seen.calls.some((c) => c.tool === tool)) failed.push(`mustNotCall[${i}]`);
  });
  if (checks.maxSteps !== undefined && seen.steps > checks.maxSteps) failed.push("maxSteps");
  return failed;
};

/** Run every approved row, one at a time: the model host serves one request well and two badly. */
export const evaluateKey = async (key: AnswerKey, runOne: (row: AnswerRow) => Promise<Observed>): Promise<KeyReport> => {
  const approved = key.tasks.filter((r) => r.approved);
  const results: TaskResult[] = [];
  for (const row of approved) {
    try {
      const seen = await runOne(row);
      const failed = scoreRun(row.checks, seen);
      results.push({ failed, id: row.id, status: failed.length ? "fail" : "pass", steps: seen.steps });
    } catch (err) {
      results.push({ error: err instanceof Error ? err.name : "Error", failed: [], id: row.id, status: "error", steps: null });
    }
  }
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  return {
    drafts: key.tasks.length - approved.length,
    errors: results.length - passed - failed,
    failed,
    passed,
    passRate: passed + failed ? passed / (passed + failed) : null,
    results,
  };
};

export const renderReport = (r: KeyReport): string => {
  const score = r.passRate === null ? "no run completed" : `${r.passed} of ${r.passed + r.failed} passed (${(r.passRate * 100).toFixed(0)}%)`;
  const lines = [`Answer key: ${score}`, `  Run errors: ${r.errors}   Unapproved drafts skipped: ${r.drafts}`];
  const width = Math.max(0, ...r.results.map((x) => x.id.length));
  for (const x of r.results) {
    const detail = x.status === "error" ? `run failed (${x.error})` : `${x.steps} steps${x.failed.length ? `  ${x.failed.join(", ")}` : ""}`;
    lines.push(`  ${x.id.padEnd(width)}  ${x.status.toUpperCase().padEnd(5)}  ${detail}`);
  }
  return lines.join("\n");
};
