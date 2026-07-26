/**
 * Read-only git: what branch a repo is on, what's uncommitted, what landed recently.
 *
 * The cheapest possible sense — no network, so no injection surface from a remote at all,
 * and nothing here can modify a repository. Every git subcommand used is read-only, and
 * that's enforced by this file listing them explicitly rather than by trusting an argument:
 * the model chooses a repo path, never a git command.
 *
 * Gated by policy.git.repoDirs with the same realpath containment check read-file.ts uses,
 * so a symlink inside an allowed directory can't be used to walk out of it.
 *
 * One thing that IS attacker-influenced: commit messages and branch names. Anyone who can
 * open a PR can put text in them, so the output is tagged UNTRUSTED like any other content
 * the agent didn't author.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homeDir } from "../config.ts";
import { tagUntrusted } from "../audit.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const run = promisify(execFile);

const expand = (p: string): string => path.resolve(String(p ?? "").replace(/^~(?=$|\/)/, homeDir));

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const insideAllowed = (policy: Policy, target: string): boolean => {
  const t = real(expand(target));
  return (policy.git?.repoDirs ?? []).some((d) => {
    const dir = real(expand(d));
    return t === dir || t.startsWith(dir + path.sep);
  });
};

/**
 * Run one read-only git subcommand. `-C <repo>` rather than a shell cwd, and execFile
 * rather than exec, so nothing in the path can be interpreted as shell syntax.
 */
const git = async (repo: string, args: string[]): Promise<string> => {
  const { stdout } = await run("git", ["-C", repo, ...args], {
    timeout: 15_000,
    maxBuffer: 2_000_000,
  });
  return stdout.trim();
};

export const gitStatus: Tool = {
  name: "git_status",
  description:
    "Read-only status of a local git repository: current branch, uncommitted changes, and " +
    "recent commits. Use it to answer what you were last working on, or what's left dirty " +
    "in a project. Cannot modify anything.",
  argsSchema: '{ "path": string, "commits"?: number }',
  classify: (a): ClassifiedAction => ({
    reversibility: "reversible",
    target: expand(a?.path ?? ""),
    summary: `Read git status of ${a?.path ?? ""}`,
  }),
  checkPolicy: (policy, a): PolicyDecision => {
    const p = a?.path ?? "";
    if (!p) return { allowed: false, reason: "no repository path given" };
    return insideAllowed(policy, p)
      ? { allowed: true, reason: "inside policy.git.repoDirs" }
      : {
          allowed: false,
          reason: `${expand(p)} is outside policy.git.repoDirs (deny by default). Add the directory to grant read access.`,
        };
  },
  run: async (a) => {
    const repo = expand(a?.path ?? "");
    const commits = Math.min(20, Math.max(1, Math.round(Number(a?.commits ?? 5)) || 5));

    if (!fs.existsSync(repo)) return `NOT FOUND: ${repo}`;
    if (!fs.existsSync(path.join(repo, ".git"))) return `${repo} is not a git repository (no .git).`;

    try {
      const [branch, porcelain, log] = await Promise.all([
        git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "(unknown)"),
        git(repo, ["status", "--porcelain"]),
        git(repo, ["log", `-n${commits}`, "--pretty=format:%h %ad %s", "--date=short"]).catch(
          () => "(no commits yet)",
        ),
      ]);

      // Tracking info is absent for a branch with no upstream — that's normal, not an error.
      const tracking = await git(repo, [
        "rev-list",
        "--left-right",
        "--count",
        "@{upstream}...HEAD",
      ]).catch(() => "");
      let sync = "no upstream configured";
      if (tracking) {
        const [behind, ahead] = tracking.split(/\s+/).map(Number);
        sync =
          ahead || behind
            ? `${ahead} ahead, ${behind} behind upstream`
            : "in sync with upstream";
      }

      const dirty = porcelain ? porcelain.split("\n") : [];
      const shown = dirty.slice(0, 50);
      const body = [
        `repo: ${repo}`,
        `branch: ${branch} (${sync})`,
        dirty.length
          ? `uncommitted (${dirty.length} file${dirty.length === 1 ? "" : "s"}):\n${shown.join("\n")}` +
            (dirty.length > shown.length ? `\n  …and ${dirty.length - shown.length} more` : "")
          : "working tree clean",
        `recent commits:\n${log}`,
      ].join("\n\n");

      // Branch names and commit messages are written by whoever can push here.
      return tagUntrusted(`git repo ${repo}`, body);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
