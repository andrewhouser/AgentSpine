/**
 * run_command — what it may run, where, what the child inherits, and how output is reduced.
 * Run with `node test/run-command.test.mjs`.
 *
 * The declared commands here are real binaries (`/bin/echo`, `/usr/bin/false`) rather than
 * mocks, because the property under test is that argv comes from policy and reaches execFile
 * unaltered. A mocked spawn would pass while the real one shelled out.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-cmd-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
// A secret the dashboard really does hold, so the env-scrubbing assertion below is testing
// the thing that matters rather than a variable invented for the test.
process.env.DASHBOARD_TOKEN = "tok-must-not-leak";

const repo = path.join(root, "repo");
const nested = path.join(repo, "src", "deep");
const outside = path.join(root, "elsewhere");
fs.mkdirSync(nested, { recursive: true });
fs.mkdirSync(outside);

const { runCommand, commandsList, findRepo, childEnv } = await import("../src/tools/run-command.ts");
const { parseCargoJson, parseEslint, parseGeneric, parseTap, parseTsc, parseXcodebuild, summarise } = await import(
  "../src/tools/command-output.ts"
);

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const commands = {
  env: { argv: ["/usr/bin/env"] },
  fail: { argv: ["/usr/bin/false"] },
  missing: { argv: ["/nonexistent/binary"] },
  ok: { argv: ["/bin/echo", "hello-from-policy"] },
  slow: { argv: ["/bin/sleep", "5"], timeoutMs: 1000 },
};
const policy = { build: { enabled: true, repos: { [repo]: { commands, gitWrite: true } } } };
const ctx = { policy, runId: null };
const gate = (a, p = policy) => runCommand.checkPolicy(p, a);

console.log("\nthe gate\n");
check("a declared command in a declared repo is allowed", gate({ name: "ok", repo }).allowed, true);
check("build disabled denies everything", gate({ name: "ok", repo }, { build: { enabled: false, repos: { [repo]: { commands } } } }).allowed, false);
check("no build section at all denies everything", gate({ name: "ok", repo }, {}).allowed, false);
check("an undeclared repo is denied", gate({ name: "ok", repo: outside }).allowed, false);
check("an undeclared command name is denied", gate({ name: "deploy", repo }).allowed, false);
check("the denial lists what IS declared", /env, fail, missing, ok, slow/.test(gate({ name: "deploy", repo }).reason), true);
check("the denial says it cannot create one", /cannot create one/.test(gate({ name: "deploy", repo }).reason), true);
check("no name given is denied", gate({ repo }).allowed, false);
check("no repo given is denied", gate({ name: "ok" }).allowed, false);
check("a command with no argv is denied", gate({ name: "broken", repo }, { build: { enabled: true, repos: { [repo]: { commands: { broken: {} } } } } }).allowed, false);

console.log("\nresolving a repo from a path inside it\n");
check("a file inside the repo resolves to the repo", findRepo(policy, nested)?.root, repo);
check("the repo itself resolves", findRepo(policy, repo)?.root, repo);
check("a path outside resolves to nothing", findRepo(policy, outside), null);
check("naming a subdirectory is allowed", gate({ name: "ok", repo: nested }).allowed, true);
// Two declarations, one nested in the other: the more specific one must win, or a command
// declared for a sub-package would be run from the monorepo root.
const twoRepos = { build: { enabled: true, repos: { [repo]: { commands }, [path.join(repo, "src")]: { commands } } } };
check("the longest declared prefix wins", findRepo(twoRepos, nested)?.root, path.join(repo, "src"));

console.log("\nclassification\n");
check("always reversible", runCommand.classify({ name: "ok", repo }).reversibility, "reversible");
check("the target names repo and command", runCommand.classify({ name: "ok", repo }).target, `${repo}#ok`);
check("the summary is readable", runCommand.classify({ name: "ok", repo }).summary, `Run "ok" in ${repo}`);

console.log("\nrunning\n");
const okOut = await runCommand.run({ name: "ok", repo }, ctx);
check("a passing command says PASSED", /PASSED \(exit 0\)/.test(okOut), true);
check("the echoed output is there", /hello-from-policy/.test(okOut), true);
check("the command line is shown", /\$ \/bin\/echo hello-from-policy/.test(okOut), true);

const failOut = await runCommand.run({ name: "fail", repo }, ctx);
check("a failing command says FAILED with the code", /FAILED \(exit 1\)/.test(failOut), true);

const missingOut = await runCommand.run({ name: "missing", repo }, ctx);
check("a missing binary is a plain message, not a stack", /ERROR: could not run \/nonexistent\/binary/.test(missingOut), true);

const slowOut = await runCommand.run({ name: "slow", repo }, ctx);
check("a command past its timeout is killed and says so", /TIMED OUT after 1s/.test(slowOut), true);
check("a timeout does not claim anything about the code", /nothing here is a verdict on the code/.test(slowOut), true);

console.log("\nthe child's environment is an allowlist, not an inheritance\n");
const envOut = await runCommand.run({ name: "env", repo }, ctx);
check("the dashboard token does not reach the child", /tok-must-not-leak/.test(envOut), false);
check("DASHBOARD_TOKEN is not even named", /DASHBOARD_TOKEN/.test(envOut), false);
check("PATH is passed through", /^PATH=/m.test(envOut), true);
// Asserted on childEnv rather than on the child's printed env: a passing command's output is
// capped (COMMAND_OUTPUT_PASS_CHARS) and a full environment dump runs past it, so grepping
// the visible slice tests the cap rather than the environment.
const forced = childEnv({ argv: ["/usr/bin/env"] });
check("CI is forced on", forced.CI, "1");
check("colour is forced off", [forced.NO_COLOR, forced.FORCE_COLOR], ["1", "0"]);
check("TERM is dumb, so no escape codes", forced.TERM, "dumb");
const built = childEnv({ argv: ["/usr/bin/env"], env: { PATH: "/overridden", RUSTFLAGS: "-D warnings" } });
check("a declared env var is added", built.RUSTFLAGS, "-D warnings");
check("a declaration may override a passthrough", built.PATH, "/overridden");
check("nothing else is inherited", Object.keys(built).includes("DASHBOARD_TOKEN"), false);

console.log("\ncommands_list\n");
const listed = await commandsList.run({}, ctx);
check("it names the repo", listed.includes(repo), true);
check("it names a command and its argv", /ok: \/bin\/echo hello-from-policy/.test(listed), true);
check("it says where git_write is allowed", /\[git_write allowed\]/.test(listed), true);
console.log("\nrepo defaulting and denial hints\n");
{
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-other-"));
  const two = { build: { enabled: true, repos: { [repo]: { commands: { test: commands.test ?? Object.values(commands)[0] } }, [other]: { commands: { build: Object.values(commands)[0] } } } } };
  const denied = gate({ name: "build", repo }, two);
  check("wrong repo is denied", denied.allowed, false);
  check("denial names the repo that has it", denied.reason.includes(other), true);
  const { setWriteDefault } = await import("../src/tools/write-file.ts");
  setWriteDefault(other);
  check("omitted repo defaults to the project folder", gate({ name: "build" }, two).allowed, true);
  setWriteDefault(null);
}
check("it is denied when build is off", commandsList.checkPolicy({ build: { enabled: false } }).allowed, false);
check("it is reversible", commandsList.classify({}).reversibility, "reversible");

console.log("\noutput parsers\n");
const asResult = (stdout, code = 1) => ({ code, signal: null, stderr: "", stdout, timedOut: false });

const tsc = asResult(
  "src/a.ts(12,3): error TS2345: Argument of type 'string' is not assignable.\nsrc/b.ts(4,1): error TS2304: Cannot find name 'foo'.",
);
check("tsc counts the errors", /2 type errors:/.test(parseTsc(tsc)), true);
check("tsc shows the first one", /src\/a\.ts\(12,3\)/.test(parseTsc(tsc)), true);
check("tsc tells it to fix the first", /Fix the first one/.test(parseTsc(tsc)), true);
check("tsc on clean output finds nothing", parseTsc(asResult("no errors here", 0)), null);

const cargo = asResult(
  [
    '{"reason":"compiler-artifact","target":{"name":"x"}}',
    'not json at all',
    '{"reason":"compiler-message","message":{"level":"warning","message":"unused variable","spans":[]}}',
    '{"reason":"compiler-message","message":{"level":"error","message":"mismatched types","spans":[{"is_primary":true,"file_name":"src/lib.rs","line_start":42}]}}',
  ].join("\n"),
);
check("cargo finds the error", /1 compile error:/.test(parseCargoJson(cargo)), true);
check("cargo gives file and line", /src\/lib\.rs:42/.test(parseCargoJson(cargo)), true);
check("cargo counts warnings separately", /1 warning\./.test(parseCargoJson(cargo)), true);
check("a non-JSON line does not stop it", /mismatched types/.test(parseCargoJson(cargo)), true);
check("cargo reports a test result line", /test result: FAILED/.test(parseCargoJson(asResult("test result: FAILED. 1 passed; 2 failed"))), true);

check("tap counts failing assertions", /2 failing assertions:/.test(parseTap(asResult("ok 1 fine\nnot ok 2 broken\nnot ok 3 also broken"))), true);
check("tap reads this repo's own FAIL lines", /1 failing assertion:/.test(parseTap(asResult("  PASS  a\nFAIL  b expected 1"))), true);
check("tap on a clean run finds nothing", parseTap(asResult("ok 1\nok 2", 0)), null);

check("eslint prefers its own summary", /3 problems/.test(parseEslint(asResult("/x/a.ts\n  1:1  error  Bad  rule\n\n✖ 3 problems (2 errors, 1 warning)"))), true);

const generic = parseGeneric(asResult("line one\nsomething failed badly\nline three\nlast line"));
check("generic surfaces the failure line", /something failed badly/.test(generic), true);
check("generic also shows the tail", /last line/.test(generic), true);

console.log("\nthe xcodebuild parser\n");

// The diagnostic and gutter lines below are copied from real output captured from Xcode 27.2
// on this machine — the snippet Swift echoes under each error repeats the message verbatim,
// which is what made the first version of this parser report every error twice.
const XC_COMPILE = asResult(
  [
    "2026-11-09 12:26:19.927 xcodebuild[64255:2621228] Logging connecton invalid: <OS_xpc_error:",
    "[-[SimServiceContext initWithDeveloperDir:connectionType:error:]:504] WARN  : Unable to discover any Simulator runtimes.",
    "DVTFilePathFSEvents: Failed to start fs event stream.",
    "/Users/me/App/Sources/Demo/main.swift:1:14: error: cannot convert value of type 'String' to specified type 'Int'",
    "1 | let n: Int = \"not an int\"",
    "  |              `- error: cannot convert value of type 'String' to specified type 'Int'",
    "2 | print(undefinedThing)",
    "/Users/me/App/Sources/Demo/util.swift:9:3: warning: variable 'x' was never used",
    "** BUILD FAILED **",
  ].join("\n"),
  65,
);
const xc = parseXcodebuild(XC_COMPILE);
check("the banner leads", /^\*\* BUILD FAILED \*\*/.test(xc), true);
check("ONE compile error, not two", /1 compile error:/.test(xc), true);
check("the echoed snippet is not counted again", /2 compile errors/.test(xc), false);
check("the file is shortened to its last two segments", /Demo\/main\.swift:1:14/.test(xc), true);
check("the long DerivedData-style prefix is dropped", /\/Users\/me\/App/.test(xc), false);
check("the message survives", /cannot convert value of type/.test(xc), true);
check("warnings are counted, not listed as errors", /1 warning\./.test(xc), true);
check("CoreSimulator noise is dropped", /SimServiceContext|Logging connecton|DVTFilePath/.test(xc), false);

// The fix for each of these is in a different place, so they are reported separately.
const XC_INVOCATION = asResult(
  ["xcodebuild: error: Unable to find a destination matching the provided destination specifier:", "** BUILD FAILED **"].join("\n"),
  70,
);
check("a bad invocation is named as one", /problem with the xcodebuild invocation/.test(parseXcodebuild(XC_INVOCATION)), true);
check("and it points at the declaration, not the code", /policy\.json, not the code/.test(parseXcodebuild(XC_INVOCATION)), true);

const XC_SIGNING = asResult(
  [
    "error: Signing for \"AgentSpine\" requires a development team. Select a development team in the Signing & Capabilities editor. (in target 'AgentSpine')",
    "** BUILD FAILED **",
  ].join("\n"),
  65,
);
check("a signing failure is a build setting, not a compile error", /build-setting error/.test(parseXcodebuild(XC_SIGNING)), true);
check("and it says a code change will not fix it", /not a code change/.test(parseXcodebuild(XC_SIGNING)), true);
check("it is not miscounted as a compile error", /compile error/.test(parseXcodebuild(XC_SIGNING)), false);

const XC_LINK = asResult(
  ["ld: symbol(s) not found for architecture arm64", "clang: error: linker command failed with exit code 1 (use -v to see invocation)", "** BUILD FAILED **"].join("\n"),
  65,
);
check("link errors are their own kind", /2 link errors:/.test(parseXcodebuild(XC_LINK)), true);

const XC_TESTS = asResult(
  [
    "Test Case '-[AgentSpineTests testThreadRenders]' failed (0.002 seconds).",
    "Test case 'ThreadTests.testScroll()' failed on 'Clone 1 of iPhone 17' (0.1 seconds)",
    "Executed 12 tests, with 2 failures (0 unexpected) in 0.034 (0.040) seconds",
    "** TEST FAILED **",
  ].join("\n"),
  65,
);
const xct = parseXcodebuild(XC_TESTS);
check("both test-failure shapes are read", /2 failing tests:/.test(xct), true);
check("the Executed summary is kept", /Executed 12 tests, with 2 failures/.test(xct), true);

// A successful build still writes several lines containing the word ERROR on this machine.
const XC_OK = asResult(
  [
    "2026-11-09 12:26:41.576 xcodebuild[64299:2621689] Logging connecton invalid: <OS_xpc_error:",
    "[-[SimServiceContext sendRequest:]:2131] ERROR : Unable to deliver request ({",
    "** BUILD SUCCEEDED **",
  ].join("\n"),
  0,
);
const xcok = parseXcodebuild(XC_OK);
check("a clean build reports the banner", xcok, "** BUILD SUCCEEDED **");
check("and claims no failures at all", /error|failing|failed/i.test(xcok.replace("SUCCEEDED", "")), false);
// This is why Xcode needs its own parser: `generic` would call that build broken.
check("generic WOULD have been fooled by the noise", /mentioning a failure/.test(parseGeneric(XC_OK)), true);
check("but summarise uses the named parser", summarise("xcodebuild", XC_OK), "** BUILD SUCCEEDED **");

check("nothing recognisable yields nothing", parseXcodebuild(asResult("just some text", 0)), null);

console.log("\nsummarise picks a parser and falls back\n");
check("a named parser is used", /2 type errors/.test(summarise("tsc", tsc)), true);
check("an unknown parser name falls back to generic", /mentioning a failure/.test(summarise("nonsense", asResult("it failed"))), true);
check("a passing command needs no summary", summarise("tsc", asResult("fine", 0)), null);
check("a named parser that finds nothing still falls back on failure", /mentioning a failure/.test(summarise("tsc", asResult("build failed for other reasons"))), true);
check("a timeout is left to the caller", summarise("tsc", { code: null, signal: "SIGTERM", stderr: "", stdout: "", timedOut: true }), null);

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
