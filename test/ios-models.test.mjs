/**
 * The iOS models against real server output — a contract test across a language boundary.
 * Run with `node test/ios-models.test.mjs`.
 *
 * ## The failure this exists to catch
 *
 * `/api/builds` is produced by src/builds.ts and consumed by `Build` in
 * ios/AgentSpine/Core/Models.swift, and nothing connects the two but a field name. Rename a
 * column on the server, or make a nullable one non-optional in Swift, and **both sides still
 * compile**: the app type-checks, the server type-checks, and `JSONDecoder` throws on a real
 * device with a real user watching. Xcode cannot catch it, `tsc` cannot catch it, and the
 * iOS app has no test target of its own.
 *
 * So this runs the actual decode. The structs are **extracted from Models.swift**, never
 * retyped here — a copy would drift from the app and then pass forever while the app broke.
 * If the extraction markers go missing it throws rather than quietly testing nothing.
 *
 * ## Why it may skip
 *
 * It needs `swiftc`, which not every machine running `npm test` has. Without it the test
 * prints SKIP and exits 0: a missing compiler is not a failing contract. `Codable` needs no
 * SwiftUI macros, so this works where a full `-typecheck` of the app does not — which is the
 * whole reason this check is possible at all in a sandbox.
 *
 * It also compiles those structs against Foundation ALONE. If a future field drags SwiftUI
 * into `Build`, this fails at the compile step. That is intentional: a wire model should be
 * plain data.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.dirname(import.meta.dirname);

/**
 * How to invoke the compiler.
 *
 * On a Mac it has to go THROUGH `xcrun`, not via the path `xcrun --find` returns: that path
 * is real and executable, but running it directly leaves SDKROOT unset and the compiler
 * cannot load the standard library — `unable to load standard library for target …`, which
 * reads like a broken toolchain and is really a missing environment. Elsewhere (a Linux
 * toolchain, say) there is no xcrun and a plain `swiftc` on PATH is invoked directly.
 */
const findSwiftc = () => {
  try {
    const found = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: ["swiftc"], cmd: "xcrun" };
  } catch {
    /* no xcrun — fall through to a bare toolchain */
  }
  try {
    const found = execFileSync("which", ["swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: [], cmd: found };
  } catch {
    /* no swiftc at all */
  }
  return null;
};

const swiftc = findSwiftc();
if (!swiftc) {
  console.log("\n  SKIP  no swiftc on this machine — the iOS models cannot be checked here\n");
  process.exit(0);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-ios-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.AGENTSPINE_BACKUP_DIR = path.join(root, "backups");

// --- a repository with a branch, a commit, and an untracked file ---
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
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

const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
git("config", "user.email", "test@example.invalid");
git("config", "user.name", "Test");
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
git("add", "-A");
git("commit", "-m", "initial");
git("switch", "-c", "agentspine/demo");
fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
git("add", "-A");
git("commit", "-m", "second line");
fs.writeFileSync(path.join(repo, "new.rs"), "fn main() {}\n");

const store = await import("../src/memory/store.ts");
const { recordDeliverable } = await import("../src/deliverables.ts");
const { buildDiff, listBuilds } = await import("../src/builds.ts");

const log = (runId, tool, args, target, decision, output) =>
  store.logAction(runId, { args, tool }, { reversibility: "reversible", summary: "", target }, decision, output);

// A full build…
const full = store.startRun({ kind: "subagent", task: "add a --json flag" });
log(full, "git_write", { branch: "agentspine/demo", repo, verb: "branch" }, `${repo}@main`, "executed", "created");
log(full, "run_command", { name: "test", repo }, `${repo}#test`, "executed", "$ cargo test\nin r — FAILED (exit 101) in 9.2s");
log(full, "run_command", { name: "test", repo }, `${repo}#test`, "executed", "$ cargo test\nin r — PASSED (exit 0) in 9.4s");
log(full, "git_write", { message: "second line", repo, verb: "commit" }, `${repo}@agentspine/demo`, "executed", "committed");
log(full, "run_command", { name: "deploy", repo }, `${repo}#deploy`, "denied", "DENIED: not declared");
recordDeliverable(path.join(repo, "a.txt"), "edit", full);
store.finishRun(full, "ok", "Done.");

// …and the null cases, which are the ones an optional in Swift gets wrong.
const branchOnly = store.startRun({ kind: "do", task: null });
log(branchOnly, "git_write", { branch: "agentspine/x", repo, verb: "branch" }, `${repo}@main`, "executed", "created");

const noTarget = store.startRun({ kind: "do", task: "unresolvable" });
log(noTarget, "run_command", { name: "test" }, "", "error", "ERROR: could not run");

fs.writeFileSync(path.join(root, "builds.json"), JSON.stringify(listBuilds()));
fs.writeFileSync(path.join(root, "diff.json"), JSON.stringify(await buildDiff(full)));

// --- the models, taken from the app rather than restated ---
const modelsPath = path.join(REPO, "ios", "AgentSpine", "Core", "Models.swift");
const models = fs.readFileSync(modelsPath, "utf8");
const START = "// MARK: - Builds";
const END = "/// A file the assistant wrote for you.";
const from = models.indexOf(START);
const to = models.indexOf(END);
if (from < 0 || to < 0 || to < from) {
  throw new Error(`could not find the Builds section in ${modelsPath} (markers: "${START}" … "${END}")`);
}
const section = models.slice(from, to);
for (const needle of ["struct BuildCommand", "struct Build:", "struct BuildDiff"]) {
  if (!section.includes(needle)) throw new Error(`the extracted section is missing ${needle} — markers moved?`);
}

const main = [
  "",
  "let dec = JSONDecoder()",
  'func load(_ p: String) -> Data { try! Data(contentsOf: URL(fileURLWithPath: p)) }',
  "var failed = 0",
  "var passed = 0",
  'func check(_ label: String, _ ok: Bool, _ detail: String = "") {',
  '    print("  \\(ok ? "PASS" : "FAIL")  \\(label.padding(toLength: 54, withPad: " ", startingAt: 0))\\(ok ? "" : detail)")',
  "    if ok { passed += 1 } else { failed += 1 }",
  "}",
  "do {",
  "    let builds = try dec.decode([Build].self, from: load(CommandLine.arguments[1]))",
  '    check("the list decodes at all", builds.count == 3, "got \\(builds.count)")',
  '    let b = builds.first(where: { $0.branch == "agentspine/demo" })!',
  '    check("run_id maps onto runID", b.runID > 0, "\\(b.runID)")',
  '    check("id is the run id", b.id == b.runID)',
  '    check("every command survives the wire", b.commands.count == 5, "\\(b.commands.count)")',
  '    check("a verdict string arrives intact", b.commands[2].verdict == "PASSED (exit 0)", b.commands[2].verdict)',
  '    check("a denial keeps its decision", b.commands[4].decision == "denied", b.commands[4].decision)',
  '    check("ok true renders as passed", b.verdict == "passed", b.verdict)',
  '    check("repoName shortens the path", b.repoName == "repo", b.repoName)',
  '    check("commits are a number", b.commits == 1, "\\(b.commits)")',
  '    check("files written", b.files == ["a.txt"], "\\(b.files)")',
  '    check("the task comes through", b.task == "add a --json flag", b.task ?? "nil")',
  "    let none = builds.first(where: { $0.ok == nil })",
  '    check("a null ok decodes to nil, not false", none != nil)',
  '    check("and stays three-valued in the UI", none?.verdict == "no command ran", none?.verdict ?? "nil")',
  '    check("a null task decodes to nil", builds.contains { $0.task == nil })',
  '    check("a null repo never breaks repoName", builds.allSatisfy { !$0.repoName.isEmpty })',
  "",
  "    let diff = try dec.decode(BuildDiff.self, from: load(CommandLine.arguments[2]))",
  '    check("the diff decodes", diff.branch == "agentspine/demo", diff.branch ?? "nil")',
  '    check("against the right base", diff.base == "main", diff.base ?? "nil")',
  '    check("stat is populated", diff.stat.contains("a.txt"), diff.stat)',
  '    check("the patch carries the change", diff.patch.contains("+two"))',
  '    check("untracked is a list of names", diff.untracked == ["new.rs"], "\\(diff.untracked)")',
  "} catch {",
  '    print("  FAIL  decoding threw: \\(error)")',
  "    failed += 1",
  "}",
  'print("RESULT \\(passed) \\(failed)")',
  "exit(failed == 0 ? 0 : 1)",
].join("\n");

const swiftFile = path.join(root, "decode.swift");
fs.writeFileSync(swiftFile, "import Foundation\n\n" + section + main);

// --- compile and run ---
const binary = path.join(root, "decode");
try {
  execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(root, "mc"), swiftFile, "-o", binary], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (err) {
  console.log("\n  FAIL  the models do not compile against Foundation alone\n");
  console.log(String(err.stderr ?? err.message).split("\n").slice(0, 20).join("\n"));
  fs.rmSync(root, { force: true, recursive: true });
  process.exit(1);
}

let output = "";
let code = 0;
try {
  output = execFileSync(binary, [path.join(root, "builds.json"), path.join(root, "diff.json")], { encoding: "utf8" });
} catch (err) {
  output = String(err.stdout ?? "");
  code = 1;
}

console.log("\nthe app's own Build/BuildCommand/BuildDiff, decoding real /api/builds output\n");
console.log(output.split("\n").filter((l) => !l.startsWith("RESULT")).join("\n").trimEnd());

const tally = /RESULT (\d+) (\d+)/.exec(output);
const [, passed, failed] = tally ? tally : [null, "0", code ? "1" : "0"];
console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(Number(failed) ? 1 : 0);
