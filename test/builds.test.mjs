/**
 * The build view — what it derives from the actions log, and the second gate on the diff.
 * Run with `node test/builds.test.mjs`.
 *
 * Rows are written through `store.logAction`, the same writer the broker uses, rather than
 * with raw SQL: the whole claim of src/builds.ts is that a build is a VIEW over what the
 * broker already recorded, and a test that inserted its own idea of those rows would not be
 * testing that claim.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-builds-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.AGENTSPINE_BACKUP_DIR = path.join(root, "backups");

const repo = path.join(root, "repo");
const undeclared = path.join(root, "elsewhere");
fs.mkdirSync(repo);
fs.mkdirSync(undeclared);

// policy.json is read by loadPolicy() at the moment buildDiff runs, so it has to exist on
// disk before the import — and it is what decides whether the diff is served at all.
const policyPath = path.join(root, "policy.json");
fs.writeFileSync(
  policyPath,
  JSON.stringify({
    autoExecute: { irreversibleAlwaysConfirm: true, reversible: true },
    build: { enabled: true, repos: { [repo]: { defaultBranch: "main", gitWrite: true } } },
    fs: { readableDirs: [root], writableDirs: [root] },
    version: 1,
  }),
);
process.env.POLICY_PATH = policyPath;

const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
git("config", "user.email", "test@example.invalid");
git("config", "user.name", "Test");
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
git("add", "-A");
git("commit", "-m", "initial");
// The branch a build loop would have made, with one commit on it.
git("switch", "-c", "agentspine/add-flag");
fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
git("add", "-A");
git("commit", "-m", "add a second line");
// And something left uncommitted, which must be reported apart from the committed work.
fs.writeFileSync(path.join(repo, "b.txt"), "scratch\n");

const store = await import("../src/memory/store.ts");
const { recordDeliverable } = await import("../src/deliverables.ts");
const { buildDiff, listBuilds, verdictOf } = await import("../src/builds.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const log = (runId, tool, args, target, decision, output) =>
  store.logAction(runId, { args, tool }, { reversibility: "reversible", summary: "", target }, decision, output);

console.log("\nverdictOf reads what run_command wrote\n");
check("a pass", verdictOf("executed", "$ npm test\nin /r — PASSED (exit 0) in 1.2s"), "PASSED (exit 0)");
check("a failure keeps the code", verdictOf("executed", "$ cargo test\nin /r — FAILED (exit 101) in 9.9s"), "FAILED (exit 101)");
check("a timeout stops at the em dash", verdictOf("executed", "in /r — TIMED OUT after 120s — killed, so nothing here is a verdict on the code."), "TIMED OUT after 120s");
// A denied call is not a failing build, and must not be reported as one.
check("denied is its own thing", verdictOf("denied", 'DENIED: "deploy" is not declared'), "DENIED");
check("queued is its own thing", verdictOf("queued", "QUEUED for your confirmation (#4)"), "QUEUED");
check("an executed call with no verdict line", verdictOf("executed", "something else"), "ran");

console.log("\na build is derived from the rows the broker already wrote\n");
const runId = store.startRun({ kind: "subagent", task: "add a --json flag" });
log(runId, "git_write", { branch: "agentspine/add-flag", repo, verb: "branch" }, `${repo}@main`, "executed", "created and switched");
log(runId, "run_command", { name: "test", repo }, `${repo}#test`, "executed", "$ npm test\nin ${repo} — FAILED (exit 1) in 3.0s");
log(runId, "run_command", { name: "test", repo }, `${repo}#test`, "executed", "$ npm test\nin ${repo} — PASSED (exit 0) in 3.1s");
log(runId, "git_write", { message: "add a second line", repo, verb: "commit" }, `${repo}@agentspine/add-flag`, "executed", "committed");
log(runId, "run_command", { name: "deploy", repo }, `${repo}#deploy`, "denied", 'DENIED: "deploy" is not declared');
recordDeliverable(path.join(repo, "a.txt"), "edit", runId);
store.finishRun(runId, "ok", "Added the flag and the tests pass.");

// A run that touched nothing buildish must not appear at all.
const other = store.startRun({ kind: "chat", task: "what is the weather" });
log(other, "weather", { location: "here" }, "here", "executed", "sunny");

const builds = listBuilds();
check("only the build run is listed", builds.length, 1);
const b = builds[0];
check("the run id", b.run_id, runId);
check("the repo comes from the target", b.repo, repo);
check("the branch prefers the one the loop created", b.branch, "agentspine/add-flag");
check("every build call is listed, in order", b.commands.map((c) => c.name), ["git branch", "test", "test", "git commit", "deploy"]);
check("verdicts are read per call", b.commands.map((c) => c.verdict), ["ran", "FAILED (exit 1)", "PASSED (exit 0)", "ran", "DENIED"]);
check("commits are counted", b.commits, 1);
check("ok follows the LAST command that ran", b.ok, true);
check("files written are joined from the ledger", b.files, ["a.txt"]);
check("the run's own task is carried", b.task, "add a --json flag");
check("and its summary", b.summary, "Added the flag and the tests pass.");

console.log("\nok is three-valued, because 'no command ran' is not 'failed'\n");
const branchOnly = store.startRun({ kind: "do", task: "just branch" });
log(branchOnly, "git_write", { branch: "agentspine/x", repo, verb: "branch" }, `${repo}@main`, "executed", "created");
check("a run that only branched has no verdict", listBuilds().find((x) => x.run_id === branchOnly)?.ok, null);

const failing = store.startRun({ kind: "do", task: "break it" });
log(failing, "run_command", { name: "test", repo }, `${repo}#test`, "executed", "in r — FAILED (exit 1) in 1s");
check("a failing run says so", listBuilds().find((x) => x.run_id === failing)?.ok, false);
check("newest first", listBuilds()[0].run_id, failing);

console.log("\nthe diff is re-authorised against policy, not trusted from the log\n");
const diff = await buildDiff(runId);
check("a declared repo is served", "error" in diff, false);
check("it diffs the branch against the default", [diff.branch, diff.base], ["agentspine/add-flag", "main"]);
check("the stat names the changed file", /a\.txt/.test(diff.stat), true);
check("the patch has the change", /\+two/.test(diff.patch), true);
// b.txt was written and never added, so `git diff` cannot see it — it has to come from
// `ls-files --others`, or a new file the loop wrote would be invisible in every view.
check("an untracked file is reported", diff.untracked, ["b.txt"]);
check("it is not folded into the patch", /scratch/.test(diff.patch), false);

// Staged work is uncommitted work: a bare `git diff` would show nothing here.
git("add", "b.txt");
const staged = await buildDiff(runId);
check("staged-but-uncommitted shows up", /b\.txt/.test(staged.uncommitted), true);
check("and is no longer listed as untracked", staged.untracked, []);

check("a run with no build is refused", "error" in (await buildDiff(999999)), true);

// The repo path in an actions row is data out of a log. A log is not an authorisation.
const sneaky = store.startRun({ kind: "do", task: "elsewhere" });
log(sneaky, "run_command", { name: "test", repo: undeclared }, `${undeclared}#test`, "executed", "in u — PASSED (exit 0) in 1s");
const refused = await buildDiff(sneaky);
check("a repo that is NOT declared is refused", "error" in refused, true);
check("and the refusal names the policy section", /policy\.build\.repos/.test(refused.error ?? ""), true);

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
