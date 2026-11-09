/**
 * git_write — the closed verb list, the branch prefix that makes "reversible" mean
 * something, and the containment check on paths.
 * Run with `node test/git-write.test.mjs`.
 *
 * Against a real temporary repository, because the classification depends on which branch is
 * checked out and that is read from git rather than taken from the model's arguments.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-git-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");

const repo = path.join(root, "repo");
const outside = path.join(root, "elsewhere");
fs.mkdirSync(repo);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "secret.txt"), "not yours");

const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
git("config", "user.email", "test@example.invalid");
git("config", "user.name", "Test");
git("config", "commit.gpgsign", "false");
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
git("add", "-A");
git("commit", "-m", "initial");

const { gitWrite, AGENT_BRANCH_PREFIX, VERBS, currentBranch } = await import("../src/tools/git-write.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(60)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const policy = { build: { enabled: true, repos: { [repo]: { defaultBranch: "main", gitWrite: true } } } };
const ctx = { policy, runId: null };
const gate = (a, p = policy) => gitWrite.checkPolicy(p, a);
const branchName = `${AGENT_BRANCH_PREFIX}test-change`;

console.log("\nthe verb list is closed\n");
check("the verbs are exactly these", VERBS, ["add", "branch", "commit", "diff", "push", "restore", "stash", "switch"]);
for (const verb of ["reset", "clean", "rebase", "merge", "cherry-pick", "filter-branch", "remote", "config", "gc"]) {
  check(`"${verb}" is not reachable`, gate({ repo, verb }).allowed, false);
}
check("the refusal says they will not be added", /will not be added by asking/.test(gate({ repo, verb: "reset" }).reason), true);
check("no verb at all is denied", gate({ repo }).allowed, false);

console.log("\nthe gate\n");
check("build disabled denies everything", gate({ repo, verb: "diff" }, { build: { enabled: false, repos: { [repo]: { gitWrite: true } } } }).allowed, false);
check("an undeclared repo is denied", gate({ repo: outside, verb: "diff" }).allowed, false);
check("a declared repo without gitWrite is denied", gate({ repo, verb: "diff" }, { build: { enabled: true, repos: { [repo]: {} } } }).allowed, false);
check("the denial points at git_status", /git_status still works/.test(gate({ repo, verb: "diff" }, { build: { enabled: true, repos: { [repo]: {} } } }).reason), true);
check("gitWrite true allows a read verb", gate({ repo, verb: "diff" }).allowed, true);

console.log("\nbranches it may create and switch to\n");
check("a prefixed branch is allowed", gate({ branch: branchName, repo, verb: "branch" }).allowed, true);
check("an unprefixed branch is refused", gate({ branch: "feature/x", repo, verb: "branch" }).allowed, false);
check("the refusal names the prefix", gate({ branch: "feature/x", repo, verb: "branch" }).reason.includes(AGENT_BRANCH_PREFIX), true);
check("main is not creatable", gate({ branch: "main", repo, verb: "branch" }).allowed, false);
check("a branch name with shell metacharacters is refused", gate({ branch: `${AGENT_BRANCH_PREFIX}a;rm -rf /`, repo, verb: "branch" }).allowed, false);
check("no branch name is refused", gate({ repo, verb: "branch" }).allowed, false);
check("switching to its own branch is allowed", gate({ branch: branchName, repo, verb: "switch" }).allowed, true);
check("switching to the declared default is allowed", gate({ branch: "main", repo, verb: "switch" }).allowed, true);
check("switching to any other branch is refused", gate({ branch: "release/2.0", repo, verb: "switch" }).allowed, false);

console.log("\nwhat always waits for approval\n");
check("commit needs a message", gate({ repo, verb: "commit" }).allowed, false);
check("restore needs explicit paths", gate({ repo, verb: "restore" }).allowed, false);
check("restore will not revert the whole tree", /will not revert the whole tree/.test(gate({ repo, verb: "restore" }).reason), true);
check("push is denied without allowPush", gate({ repo, verb: "push" }).allowed, false);
check("push is allowed with allowPush", gate({ repo, verb: "push" }, { build: { enabled: true, repos: { [repo]: { allowPush: true, gitWrite: true } } } }).allowed, true);
check("restore is irreversible", gitWrite.classify({ paths: ["a.txt"], repo, verb: "restore" }).reversibility, "irreversible");
check("push is irreversible", gitWrite.classify({ repo, verb: "push" }).reversibility, "irreversible");

console.log("\npaths stay inside the repo\n");
check("a path inside is allowed", gate({ paths: ["a.txt"], repo, verb: "add" }).allowed, true);
check("an absolute path outside is refused", gate({ paths: [path.join(outside, "secret.txt")], repo, verb: "add" }).allowed, false);
check("traversal out is refused", gate({ paths: ["../elsewhere/secret.txt"], repo, verb: "add" }).allowed, false);
check(".git is refused", gate({ paths: [".git/config"], repo, verb: "add" }).allowed, false);
check("a nested .git path is refused", gate({ paths: ["sub/.git/hooks/pre-commit"], repo, verb: "add" }).allowed, false);

console.log("\nclassification follows the checked-out branch, not the arguments\n");
check("starting on main", currentBranch(repo), "main");
check("a commit on main is irreversible", gitWrite.classify({ message: "x", repo, verb: "commit" }).reversibility, "irreversible");
check("the summary names the branch", /on main/.test(gitWrite.classify({ message: "x", repo, verb: "commit" }).summary), true);
for (const verb of ["add", "branch", "diff", "stash", "switch"]) {
  check(`"${verb}" is reversible`, gitWrite.classify({ repo, verb }).reversibility, "reversible");
}

console.log("\nrunning: branch, edit, add, commit, diff\n");
const made = await gitWrite.run({ branch: branchName, repo, verb: "branch" }, ctx);
check("the branch was created", /created and switched to/.test(made), true);
check("git agrees we are on it", currentBranch(repo), branchName);
check("a commit on its own branch is now reversible", gitWrite.classify({ message: "x", repo, verb: "commit" }).reversibility, "reversible");

const nothing = await gitWrite.run({ message: "nothing yet", repo, verb: "commit" }, ctx);
check("committing an empty index says so plainly", /nothing to commit/.test(nothing), true);
check("and it does not read as a crash", /ERROR/.test(nothing), false);

fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
const diffBefore = await gitWrite.run({ repo, verb: "diff" }, ctx);
check("the diff shows the change", /\+two/.test(diffBefore), true);
check("the diff is tagged untrusted", /UNTRUSTED CONTENT/.test(diffBefore), true);

const staged = await gitWrite.run({ paths: ["a.txt"], repo, verb: "add" }, ctx);
check("add reports what it staged", /a\.txt/.test(staged), true);
const committed = await gitWrite.run({ message: "add a second line", repo, verb: "commit" }, ctx);
check("the commit landed", /committed on agentspine\/test-change/.test(committed), true);
check("the new head is shown", /add a second line/.test(committed), true);
check("git log agrees", git("log", "-n1", "--pretty=format:%s"), "add a second line");
check("main is untouched", git("log", "main", "-n1", "--pretty=format:%s"), "initial");

console.log("\nrunning: switch back, and restore\n");
fs.writeFileSync(path.join(repo, "a.txt"), "clobbered\n");
const restored = await gitWrite.run({ paths: ["a.txt"], repo, verb: "restore" }, ctx);
check("restore discards the edit", /discarded uncommitted changes/.test(restored), true);
check("the file is back", fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\ntwo\n");
const back = await gitWrite.run({ branch: "main", repo, verb: "switch" }, ctx);
check("switching back to main works", /switched to main/.test(back), true);
check("the branch's work is not in main", fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\n");

console.log("\nerrors come back as git explained them\n");
const bad = await gitWrite.run({ branch: `${AGENT_BRANCH_PREFIX}nope`, repo, verb: "switch" }, ctx);
check("a missing branch is a readable failure", /ERROR: git switch/.test(bad), true);
check("git's own wording survives", /invalid reference|match any file|did not match/.test(bad), true);

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
