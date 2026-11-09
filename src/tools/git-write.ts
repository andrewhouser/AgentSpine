/**
 * git_write — the undo primitive for code.
 *
 * `write_file` backs a replaced file up to `backups/`, which is the right shape for "save my
 * business plan" and the wrong one for a forty-step refactor across nine files. The undo for
 * iterative code work is git: a branch to work on, a diff to review, and `git checkout main`
 * to make the whole attempt go away.
 *
 * ## The verb list is closed, and that is the gate
 *
 * The model names a VERB from the table below. It never supplies a git subcommand, a flag,
 * or a refspec. Same rule as `git_status` ("the model chooses a repo path, never a git
 * command") and `run_command`, for the same reason: an argument the model composes is an
 * argument an UNTRUSTED page can influence.
 *
 * Absent on purpose, and not an oversight to be fixed later: `reset`, `clean`, `rebase`,
 * `merge`, `cherry-pick`, `filter-branch`, `remote`, `config`, and every form of `--force`.
 * Those either destroy work that no backup caught or rewrite history, and neither is
 * something an unattended loop should be able to reach for.
 *
 * ## Reversible on its OWN branch, irreversible everywhere else
 *
 * | verb | classification |
 * |---|---|
 * | `diff` | reversible — it reads |
 * | `branch` | reversible — creates, destroys nothing |
 * | `switch` | reversible — git itself refuses when it would lose work, and `--force` is not reachable |
 * | `add` | reversible |
 * | `stash` | reversible — recoverable by definition |
 * | `commit` | reversible ONLY while HEAD is a branch this tool created; otherwise queued |
 * | `restore` | always queued — it discards uncommitted work, the one thing no backup caught |
 * | `push` | always queued, and only where policy opts in — it leaves the machine |
 *
 * The test for "its own branch" is `AGENT_BRANCH_PREFIX`, and it is deliberately not a
 * policy setting. A protected-branch LIST would have to enumerate every branch that matters
 * and would silently auto-commit to the one nobody thought of; a prefix inverts that — the
 * agent may commit without asking only to branches it made, and everything else, including a
 * default branch named something this code has never heard of, queues.
 *
 * ## Why `classify` runs git
 *
 * `classify(args)` is handed nothing but the model's arguments, and the classification turns
 * on which branch is checked out — a fact about the world, not a claim by the model. So it
 * reads the branch with a synchronous, read-only `git rev-parse`. The broker's contract is
 * that "the classification comes from code in the tool", and this is what honouring that
 * costs here: a few milliseconds and no shell. Asking the model to pass the branch name
 * would have let the party being gated choose its own tier.
 *
 * ## One thing worth knowing
 *
 * `git commit` runs the repository's own hooks, and a `pre-commit` hook is arbitrary code.
 * It is the user's code in the user's repo — the same trust that declaring a `test` command
 * in `policy.build` already states — but it is a code path that does not pass through
 * `run_command`'s declaration gate, and it should be on the record rather than discovered.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { expand, real } from "../fs-scope.ts";
import { clip } from "../stash.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";
import { findRepo } from "./run-command.ts";

const exec = promisify(execFile);

/**
 * Branches this tool may create, and the only branches it may commit to unattended.
 * A constant rather than configuration — see the header.
 */
export const AGENT_BRANCH_PREFIX = "agentspine/";

/** Verbs that change nothing a person would need to be asked about. */
const REVERSIBLE_VERBS = new Set(["add", "branch", "diff", "stash", "switch"]);
/** Verbs that always queue, whatever branch they are on. */
const ALWAYS_CONFIRM = new Set(["push", "restore"]);
export const VERBS = [...REVERSIBLE_VERBS, ...ALWAYS_CONFIRM, "commit"].sort();

/** Git refuses most of these itself; rejecting them here means the refusal is ours and legible. */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

const git = async (repo: string, args: string[]): Promise<string> => {
  const { stdout } = await exec("git", ["-C", repo, ...args], { maxBuffer: 8_000_000, timeout: 60_000 });
  return String(stdout ?? "").trim();
};

/**
 * The checked-out branch, read synchronously because `classify` is synchronous.
 * Returns null for a detached HEAD, an empty repo, or anything that is not a repo at all —
 * all of which mean "not a branch this tool created", which is the cautious answer.
 */
export const currentBranch = (repo: string): null | string => {
  try {
    const out = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const branch = String(out ?? "").trim();
    return !branch || branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
};

const onAgentBranch = (repo: string): boolean => (currentBranch(repo) ?? "").startsWith(AGENT_BRANCH_PREFIX);

/**
 * Is `p` inside `root`, and not inside its `.git`?
 *
 * The absolute/relative test is made on the RAW string, not on `expand(p)`. `expand` ends in
 * `path.resolve`, which resolves a relative path against the dashboard process's cwd — so
 * asking `path.isAbsolute(expand(p))` is asking a question whose answer is always yes, and
 * every relative path the model gave ("a.txt", "src/foo.rs") resolved outside the repo and
 * was refused. Relative paths are the common case, so that bug refused nearly everything.
 */
const insideRepo = (root: string, p: string): boolean => {
  const raw = String(p ?? "");
  if (!raw) return false;
  // A leading ~ is the user's home, which `expand` knows how to read; anything else relative
  // is relative to the REPO, which is the only base that makes sense for a path in a diff.
  const abs = real(raw.startsWith("/") || raw.startsWith("~") ? expand(raw) : path.resolve(root, raw));
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  const rel = path.relative(root, abs);
  return !rel.split(path.sep).includes(".git");
};

/** Paths the model named, resolved against the repo root. `[]` means "everything". */
const pathArgs = (a: any): string[] =>
  (Array.isArray(a?.paths) ? a.paths : a?.path ? [a.path] : []).map((p: unknown) => String(p ?? "")).filter(Boolean);

export const gitWrite: Tool = {
  name: "git_write",
  description:
    `Work with git in a declared repo: ${VERBS.join(", ")}. ` +
    `"branch" starts a new ${AGENT_BRANCH_PREFIX}… branch to work on — do that FIRST, before editing, ` +
    `so your work can be reviewed as a diff and undone in one step. "commit" runs without asking while ` +
    `you are on a branch you created, and waits for approval anywhere else. "diff" shows what you changed. ` +
    `Cannot reset, clean, rebase, merge, or force anything.`,
  argsSchema:
    '{ "repo": string, "verb": "add"|"branch"|"commit"|"diff"|"push"|"restore"|"stash"|"switch", ' +
    '"branch"?: string, "message"?: string, "paths"?: string[], "staged"?: boolean }',
  classify: (a): ClassifiedAction => {
    const verb = String(a?.verb ?? "");
    const repo = expand(a?.repo ?? "");
    const branch = String(a?.branch ?? "");

    let reversibility: ClassifiedAction["reversibility"] = "irreversible";
    if (REVERSIBLE_VERBS.has(verb)) reversibility = "reversible";
    else if (verb === "commit" && onAgentBranch(repo)) reversibility = "reversible";

    const where = verb === "commit" ? ` on ${currentBranch(repo) ?? "(no branch)"}` : "";
    const detail =
      verb === "branch" || verb === "switch"
        ? ` ${branch}`
        : verb === "commit"
          ? ` "${String(a?.message ?? "").slice(0, 120)}"`
          : pathArgs(a).length
            ? ` ${pathArgs(a).slice(0, 5).join(" ")}`
            : "";

    return {
      reversibility,
      summary: `git ${verb || "(no verb)"}${detail} in ${repo}${where}`,
      target: `${repo}@${currentBranch(repo) ?? "(no branch)"}`,
    };
  },
  checkPolicy: (policy, a): PolicyDecision => {
    if (!policy.build?.enabled)
      return { allowed: false, reason: "policy.build.enabled is not set — git_write is denied (deny by default)." };

    const verb = String(a?.verb ?? "");
    if (!verb) return { allowed: false, reason: `no verb given. One of: ${VERBS.join(", ")}.` };
    if (!VERBS.includes(verb))
      return {
        allowed: false,
        reason:
          `"${verb}" is not a verb this tool has. One of: ${VERBS.join(", ")}. ` +
          `reset, clean, rebase, merge and --force are deliberately absent and will not be added by asking.`,
      };

    const repoArg = String(a?.repo ?? "");
    if (!repoArg) return { allowed: false, reason: "no repo given." };
    const found = findRepo(policy, repoArg);
    if (!found)
      return {
        allowed: false,
        reason: `${expand(repoArg)} is not inside any repo declared in policy.build.repos (deny by default).`,
      };
    if (found.conf.gitWrite !== true)
      return {
        allowed: false,
        reason: `${found.root} does not have "gitWrite": true in policy.build.repos (deny by default). git_status still works.`,
      };

    // A new branch may only be created under the prefix, which is also what makes the
    // "reversible on its own branch" classification mean something.
    if (verb === "branch") {
      const branch = String(a?.branch ?? "");
      if (!branch) return { allowed: false, reason: `no branch name given. It must start with "${AGENT_BRANCH_PREFIX}".` };
      if (!branch.startsWith(AGENT_BRANCH_PREFIX))
        return { allowed: false, reason: `a new branch must start with "${AGENT_BRANCH_PREFIX}" — got "${branch}".` };
      if (!BRANCH_NAME.test(branch)) return { allowed: false, reason: `"${branch}" is not a usable branch name.` };
    }

    // Switching is limited to branches this tool made plus the repo's declared default, so
    // it cannot wander onto a release branch and commit there.
    if (verb === "switch") {
      const branch = String(a?.branch ?? "");
      const fallback = found.conf.defaultBranch ?? "main";
      if (!branch) return { allowed: false, reason: "no branch name given." };
      if (!BRANCH_NAME.test(branch)) return { allowed: false, reason: `"${branch}" is not a usable branch name.` };
      if (!branch.startsWith(AGENT_BRANCH_PREFIX) && branch !== fallback)
        return {
          allowed: false,
          reason: `may only switch to a "${AGENT_BRANCH_PREFIX}…" branch or to "${fallback}" (policy.build.repos[…].defaultBranch).`,
        };
    }

    if (verb === "commit" && !String(a?.message ?? "").trim())
      return { allowed: false, reason: "a commit needs a message." };

    // `restore` discards work. Requiring explicit paths means it can never be the blanket
    // "throw away everything I did" that a stuck loop would reach for.
    if (verb === "restore" && !pathArgs(a).length)
      return { allowed: false, reason: "restore needs the paths to discard — it will not revert the whole tree." };

    if (verb === "push" && found.conf.allowPush !== true)
      return {
        allowed: false,
        reason: `${found.root} does not have "allowPush": true in policy.build.repos (deny by default). Commit locally; pushing is the user's call.`,
      };

    for (const p of pathArgs(a)) {
      if (!insideRepo(found.root, p))
        return { allowed: false, reason: `${p} is outside ${found.root}, or inside its .git — refused.` };
    }

    return { allowed: true, reason: `git ${verb} in ${found.root}` };
  },
  run: async (a, ctx) => {
    const found = findRepo(ctx.policy, String(a?.repo ?? ""));
    if (!found) return "DENIED: no declared repo for that path.";
    const root = found.root;
    const verb = String(a?.verb ?? "");

    if (!fs.existsSync(path.join(root, ".git"))) return `${root} is not a git repository (no .git).`;

    try {
      switch (verb) {
        case "add": {
          const paths = pathArgs(a);
          const out = await git(root, ["add", "--", ...(paths.length ? paths : [root])]);
          const staged = await git(root, ["diff", "--cached", "--stat"]).catch(() => "");
          return `staged ${paths.length ? paths.join(" ") : "all changes"} in ${root}\n${staged || "(nothing staged)"}${out ? `\n${out}` : ""}`;
        }

        case "branch": {
          const branch = String(a?.branch ?? "");
          await git(root, ["switch", "-c", branch]);
          return `created and switched to ${branch} in ${root}. Work here; the whole attempt can be undone by switching away.`;
        }

        case "commit": {
          const message = String(a?.message ?? "").trim();
          const branch = currentBranch(root) ?? "(no branch)";
          // --only would need pathspecs; the index is what `add` already shaped.
          const out = await git(root, ["commit", "-m", message]).catch((err: any) => {
            const text = String(err?.stdout ?? err?.message ?? "");
            // "nothing to commit" is a fact about the tree, not a failure worth a stack trace.
            return /nothing to commit|no changes added/i.test(text) ? "NOTHING TO COMMIT" : Promise.reject(err);
          });
          if (out === "NOTHING TO COMMIT")
            return `nothing to commit in ${root} — the index is empty. Use git_write "add" first, or check git_status.`;
          const head = await git(root, ["log", "-n1", "--pretty=format:%h %s"]).catch(() => "");
          return `committed on ${branch} in ${root}\n${head}`;
        }

        case "diff": {
          const paths = pathArgs(a);
          const base = a?.staged ? ["diff", "--cached"] : ["diff"];
          const stat = await git(root, [...base, "--stat", ...(paths.length ? ["--", ...paths] : [])]);
          const patch = await git(root, [...base, ...(paths.length ? ["--", ...paths] : [])]);
          if (!stat && !patch) return `no ${a?.staged ? "staged " : ""}changes in ${root}.`;
          // A diff is file contents, and a repo may hold code written by anyone.
          return clip(
            { max: 6000, runId: ctx?.runId ?? null, source: `git diff in ${root}`, tool: "git_write" },
            `${stat}\n\n${patch}`,
          );
        }

        case "push": {
          const branch = currentBranch(root);
          if (!branch) return `cannot push from a detached HEAD in ${root}.`;
          // The refspec is built here from the branch git reports, never from an argument.
          const out = await git(root, ["push", "--set-upstream", "origin", branch]);
          return `pushed ${branch} to origin from ${root}\n${out}`;
        }

        case "restore": {
          const paths = pathArgs(a);
          await git(root, ["restore", "--", ...paths]);
          return `discarded uncommitted changes to ${paths.join(" ")} in ${root}.`;
        }

        case "stash": {
          const message = String(a?.message ?? "").trim() || "agentspine";
          const out = await git(root, ["stash", "push", "-u", "-m", message]);
          return `${out || "stashed"} (in ${root}). Recover it with git stash pop, by hand.`;
        }

        case "switch": {
          const branch = String(a?.branch ?? "");
          await git(root, ["switch", branch]);
          return `switched to ${branch} in ${root}.`;
        }

        default:
          return `DENIED: unknown verb "${verb}".`;
      }
    } catch (err: any) {
      // git writes its real explanation to stderr — "would be overwritten by checkout", "not
      // a valid object name". Passing that through is the difference between a fixable error
      // and "ERROR: Command failed".
      const detail = String(err?.stderr ?? "").trim() || String(err?.message ?? err);
      return `ERROR: git ${verb} in ${root} failed — ${detail}`;
    }
  },
};
