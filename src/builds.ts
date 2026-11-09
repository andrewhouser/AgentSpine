/**
 * The build view — what the loop did to a repository, and the diff to prove it.
 *
 * ## There is no builds table, on purpose
 *
 * Everything this module reports was already recorded. `broker.ts` writes a row to `actions`
 * for every call it decides on — tool, args, target, reversibility, decision, output — and
 * `deliverables` holds every file written. A build is therefore a QUERY, not a new kind of
 * object, and adding a table would mean a second record of the same events that can disagree
 * with the first. The audit log is the record; this is a view of it.
 *
 * That is also why a build appears retroactively. Runs from before this file existed show up
 * in it, because the data was always there.
 *
 * ## Why the repo and branch are read from `target` and not from `args`
 *
 * `args` is what the MODEL passed. `target` is what the tool's own `classify()` derived from
 * it in code — expanded, and in `git_write`'s case carrying the branch git itself reported.
 * The broker's contract is that classification comes from code rather than from the model's
 * claim about its own call, so `target` is the field that inherits that property. `args` is
 * still shown for the command name, which is the one thing the model does choose.
 *
 * ## The diff is gated twice
 *
 * A run's actions name a path, and a path out of a log is not an authorisation. So
 * `buildDiff` re-checks the repo against `policy.build.repos` through the same `findRepo`
 * the tools use — not a second implementation of containment, for the reason fs-scope.ts
 * gives — and refuses anything that is not a declared repo. The git subcommands it runs are
 * fixed strings; nothing from the log reaches an argv except the repo root and a branch name
 * that has already been matched against a conservative pattern.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { loadPolicy } from "./config.ts";
import { listDeliverables } from "./deliverables.ts";
import { rawDb } from "./memory/store.ts";
import { AGENT_BRANCH_PREFIX } from "./tools/git-write.ts";
import { findRepo } from "./tools/run-command.ts";

const exec = promisify(execFile);

/** The tools whose presence in a run makes that run a build. */
const BUILD_TOOLS = ["run_command", "git_write"];

export interface BuildCommand {
  /** The broker's verdict: executed, denied, queued, error, dry-run. */
  decision: string;
  /** The declared name the model chose, e.g. "test". */
  name: string;
  ts: string;
  /** PASSED (exit 0) / FAILED (exit 1) / TIMED OUT … or the decision, when it never ran. */
  verdict: string;
}

export interface Build {
  branch: null | string;
  commands: BuildCommand[];
  commits: number;
  /** Files this run wrote, from the deliverables ledger. */
  files: string[];
  finished: null | string;
  kind: null | string;
  /** True when the last command that actually ran passed. Null when none did. */
  ok: boolean | null;
  repo: null | string;
  run_id: number;
  started: string;
  status: null | string;
  summary: null | string;
  task: null | string;
}

/**
 * Pull the verdict out of a `run_command` result.
 *
 * The tool writes it on the second line — `in <repo> — FAILED (exit 1) in 12.4s` — so this
 * reads that rather than re-deriving anything. A call that never ran has no verdict of its
 * own and reports the broker's decision instead, which is the honest answer: "denied" is not
 * a failing build.
 */
export const verdictOf = (decision: string, output: string): string => {
  if (decision !== "executed") return decision.toUpperCase();
  const m = /\b(PASSED \(exit \d+\)|FAILED \(exit -?\d+\)|TIMED OUT after \d+s|TIMED OUT|KILLED by [^\n.—]*|KILLED)/.exec(String(output ?? ""));
  return m ? m[1].trim() : "ran";
};

/** The command name a row refers to: from args, which is the part the model chooses. */
const nameOf = (tool: string, argsJson: string): string => {
  let args: any = null;
  try {
    args = JSON.parse(String(argsJson ?? "null"));
  } catch {
    /* a row with unparseable args still deserves a line */
  }
  if (tool === "git_write") return `git ${args?.verb ?? "?"}`;
  return String(args?.name ?? "?");
};

/** `/path/to/repo#test` -> `/path/to/repo`; `/path/to/repo@branch` -> `/path/to/repo`. */
const repoFromTarget = (tool: string, target: null | string): null | string => {
  const t = String(target ?? "");
  if (!t) return null;
  const sep = tool === "git_write" ? "@" : "#";
  const at = t.lastIndexOf(sep);
  return at > 0 ? t.slice(0, at) : t;
};

const branchFromTarget = (target: null | string): null | string => {
  const t = String(target ?? "");
  const at = t.lastIndexOf("@");
  if (at < 0) return null;
  const branch = t.slice(at + 1);
  return !branch || branch === "(no branch)" ? null : branch;
};

/**
 * Recent builds, newest first.
 *
 * One row per run that called a build tool, with its commands in the order they happened.
 */
export const listBuilds = (limit = 40): Build[] => {
  const runIds = rawDb
    .prepare(
      `SELECT DISTINCT run_id FROM actions WHERE run_id IS NOT NULL AND tool IN (${BUILD_TOOLS.map(() => "?").join(",")})
       ORDER BY run_id DESC LIMIT ?`,
    )
    .all(...BUILD_TOOLS, limit) as unknown as { run_id: number }[];

  if (!runIds.length) return [];

  const ids = runIds.map((r) => r.run_id);
  const placeholders = ids.map(() => "?").join(",");

  const runs = rawDb
    .prepare(`SELECT id, started, finished, status, kind, task, note FROM runs WHERE id IN (${placeholders})`)
    .all(...ids) as unknown as Record<string, any>[];
  const runById = new Map(runs.map((r) => [Number(r.id), r]));

  const actions = rawDb
    .prepare(
      `SELECT run_id, tool, args, target, decision, output, ts FROM actions
       WHERE run_id IN (${placeholders}) AND tool IN (${BUILD_TOOLS.map(() => "?").join(",")}) ORDER BY id`,
    )
    .all(...ids, ...BUILD_TOOLS) as unknown as Record<string, any>[];

  // One pass over the deliverables ledger rather than a query per run.
  const filesByRun = new Map<number, string[]>();
  for (const d of listDeliverables(500)) {
    if (d.run_id == null) continue;
    const list = filesByRun.get(d.run_id) ?? [];
    list.push(d.name);
    filesByRun.set(d.run_id, list);
  }

  const byRun = new Map<number, Record<string, any>[]>();
  for (const a of actions) {
    const list = byRun.get(Number(a.run_id)) ?? [];
    list.push(a);
    byRun.set(Number(a.run_id), list);
  }

  return ids.map((id) => {
    const rows = byRun.get(id) ?? [];
    const run = runById.get(id) ?? {};

    const commands: BuildCommand[] = rows.map((r) => ({
      decision: String(r.decision ?? ""),
      name: nameOf(String(r.tool), String(r.args ?? "")),
      ts: String(r.ts ?? ""),
      verdict: verdictOf(String(r.decision ?? ""), String(r.output ?? "")),
    }));

    // Prefer a branch this loop created: it is the one worth offering a diff of.
    const branches = rows
      .filter((r) => r.tool === "git_write")
      .map((r) => branchFromTarget(r.target))
      .filter((b): b is string => !!b);
    const branch = branches.findLast((b) => b.startsWith(AGENT_BRANCH_PREFIX)) ?? branches.at(-1) ?? null;

    const ran = commands.filter((c) => c.decision === "executed" && c.verdict !== "ran");
    const last = ran.at(-1);

    return {
      branch,
      commands,
      commits: rows.filter((r) => r.tool === "git_write" && r.decision === "executed" && /"verb":"commit"/.test(String(r.args ?? ""))).length,
      files: filesByRun.get(id) ?? [],
      finished: run.finished ?? null,
      kind: run.kind ?? null,
      ok: last ? last.verdict.startsWith("PASSED") : null,
      repo: rows.map((r) => repoFromTarget(String(r.tool), r.target)).find((x) => !!x) ?? null,
      run_id: id,
      started: String(run.started ?? ""),
      status: run.status ?? null,
      summary: run.note ?? null,
      task: run.task ?? null,
    };
  });
};

export interface BuildDiff {
  /** The branch the diff is of, or null when the work was never committed to one. */
  branch: null | string;
  /** Committed changes against `base`, as a patch. */
  patch: string;
  base: null | string;
  repo: string;
  /** `git diff --stat`, which is the part worth reading first. */
  stat: string;
  /** Changes still not committed — staged and unstaged both, as one patch. */
  uncommitted: string;
  /**
   * Paths git is not tracking at all.
   *
   * Reported as names rather than content, and separately from `uncommitted`, because
   * `git diff` cannot see an untracked file — and a brand-new source file the loop wrote and
   * never staged is precisely the thing a reviewer most needs to be told about. It would
   * otherwise be invisible in every view here while sitting in the working tree.
   */
  untracked: string[];
}

const git = async (repo: string, args: string[]): Promise<string> => {
  const { stdout } = await exec("git", ["-C", repo, ...args], { maxBuffer: 8_000_000, timeout: 30_000 });
  return String(stdout ?? "").trim();
};

/** Conservative, and the only value from the log that reaches an argv. */
const BRANCH_OK = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

/**
 * The diff for one build.
 *
 * Shown as the branch against its merge-base with the repo's default branch, which is what
 * someone reviewing the work wants — "what did this change", not "what has happened on main
 * since". Uncommitted changes are reported separately rather than folded in, because the
 * difference between "committed" and "still sitting in the working tree" is exactly what a
 * reviewer is checking.
 */
export const buildDiff = async (runId: number): Promise<{ error: string } | BuildDiff> => {
  const build = listBuilds(200).find((b) => b.run_id === runId);
  if (!build) return { error: "no build for that run" };
  if (!build.repo) return { error: "that build names no repository" };

  // The path came out of a log. Re-authorise it against policy before running anything.
  const policy = loadPolicy();
  const found = findRepo(policy, build.repo);
  if (!found) return { error: `${build.repo} is not a repo declared in policy.build.repos` };
  if (!fs.existsSync(path.join(found.root, ".git"))) return { error: `${found.root} is not a git repository` };

  const branch = build.branch && BRANCH_OK.test(build.branch) ? build.branch : null;
  const base = found.conf.defaultBranch ?? "main";

  let stat = "";
  let patch = "";
  if (branch) {
    // `base...branch` is the triple-dot form: the branch's own commits, not everything that
    // landed on base in the meantime.
    const range = `${base}...${branch}`;
    stat = await git(found.root, ["diff", "--stat", range]).catch(() => "");
    patch = await git(found.root, ["diff", range]).catch(() => "");
  }

  // `diff HEAD`, not `diff`: staged work is uncommitted work, and a bare `git diff` hides it.
  const uncommitted = await git(found.root, ["diff", "HEAD"]).catch(() => "");
  const untracked = (await git(found.root, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 100);

  return {
    base: branch ? base : null,
    branch,
    patch,
    repo: found.root,
    stat,
    uncommitted,
    untracked,
  };
};
