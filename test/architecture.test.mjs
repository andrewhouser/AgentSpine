/**
 * The architecture test. Run with `node test/architecture.test.mjs`.
 *
 * It reads the source, runs nothing, and needs no network or database. It asserts the structural
 * promises that the rest of the system leans on, in one place, so that breaking one is a failing test
 * and not something a reviewer has to notice:
 *
 *   1. No tool can write AgentSpine's own control files (policy.json, profile.md, goals.md, agents/*.md).
 *      docs/LEARNING.md invariant 1: the write happens in the server, from a person's click, never from
 *      a tool. test/write-file.test.mjs proves the behaviour of the file tool; this proves nothing else
 *      has found a way round it.
 *   2. The Google write token (docs/SPEC.md section 5, amendment of 2026-11-21) is held by src/google/write.ts
 *      alone, that module is reached only by the two tools built for it, and it has no way to send mail
 *      or delete anything permanently.
 *   3. The gate files (src/protected-paths.ts) are a pinned list, every route by which a tool could change
 *      one checks it, only the approval code can mark a call as approved, the code map is read by one
 *      module and written by none, and one door leads to the builder (PLAN-open-work section 10, SC3, SC5, SC6).
 *
 * These are tripwires, not proofs. A static scan cannot see a shell command that redirects into a file,
 * so the set of tools that can run commands is pinned too: adding one fails this test until a person
 * has looked at what it can reach. When a list below has to change, change it on purpose and say why in
 * the commit.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.join(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

// ---- Reading the source ---------------------------------------------------------------------

/** Remove comments, so prose that names a file is not read as code. The TypeScript compiler does this,
 * not a regex, because a regex cannot tell a `/*` inside a line comment (as in "src/google/*") or a `//`
 * inside a string from the real thing. Imports are kept even when unused, so an unused import of
 * write.ts still counts as reaching it. */
const stripComments = (text) =>
  ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, removeComments: true, target: ts.ScriptTarget.ESNext, verbatimModuleSyntax: true } }).outputText;

const sources = {};
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (full.endsWith(".ts")) sources[path.relative(ROOT, full).split(path.sep).join("/")] = stripComments(fs.readFileSync(full, "utf8"));
  }
};
walk(SRC);

/** The repo-relative paths of every source file whose code matches `re`, sorted. */
const filesMatching = (re) => Object.keys(sources).filter((f) => re.test(sources[f])).sort();

// A file-writing call of any kind: the fs module's writers, deleters and renamers.
const FS_WRITE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|copyFileSync|copyFile|createWriteStream|unlinkSync|unlink|rmSync|rm|truncateSync|truncate|openSync)\s*\(/;
const FS_WRITE_STRICT = /\bfs\.(promises\.)?(writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|copyFileSync|copyFile|createWriteStream|unlinkSync|unlink|rmSync|rm|truncateSync|truncate|openSync)\s*\(/;

// ---- The scanner has to be able to fail -----------------------------------------------------
// Without this, a typo in a regex above would turn every check below into a pass that proves nothing.

console.log("\nTHE SCANNER CAN SEE A VIOLATION");
check("a comment that contains /* does not swallow the code after it", /const k = 1/.test(stripComments("// see src/google/*.\nconst k = 1;")), true);
const stripped = stripComments('// POLICY_PATH\nconst u = "https://x.test"; /* GOALS_PATH */');
check("comments are stripped, https:// in a string is not", [stripped.includes('const u = "https://x.test"'), /POLICY_PATH|GOALS_PATH/.test(stripped)], [true, false]);
check("a write to the policy path is detected", FS_WRITE_STRICT.test("fs.writeFileSync(POLICY_PATH, x)"), true);
check("a read of the policy path is not a write", FS_WRITE_STRICT.test("fs.readFileSync(POLICY_PATH, 'utf8')"), false);
check("the source set is not empty", Object.keys(sources).length > 50, true);
check("the control-file constants are found where they are defined", filesMatching(/\bPOLICY_PATH\b/).includes("src/config.ts"), true);

// ---- 1. Control files -----------------------------------------------------------------------

console.log("\nCONTROL FILES: WHO CAN NAME THEM");
// The path constants for policy.json, goals.md, agents/ and profile.md. Each may be named only by config
// (which defines it) and by the one module that has a reason to. The three readers must never write.
const HOLDERS = {
  AGENTS_DIR: ["src/agents.ts", "src/config.ts"],
  GOALS_PATH: ["src/config.ts", "src/spine.ts"],
  POLICY_PATH: ["src/config.ts", "src/learn/promote.ts"],
  PROFILE_PATH: ["src/config.ts", "src/memory/profile.ts"],
};
for (const [name, expected] of Object.entries(HOLDERS)) {
  check(`${name} is named only by ${expected.map((f) => path.basename(f)).join(" and ")}`, filesMatching(new RegExp(`\\b${name}\\b`)), expected);
}

console.log("\nCONTROL FILES: THE READERS NEVER WRITE");
for (const file of ["src/agents.ts", "src/spine.ts", "src/memory/profile.ts"]) {
  check(`${file} makes no file-writing call`, FS_WRITE.test(sources[file]), false);
}

console.log("\nCONTROL FILES: POLICY IS CHANGED ONLY BY A PERSON'S CLICK");
// applyProposal is the one function that writes policy from a proposal. It lives in learn/promote.ts and
// is reachable only from server.ts, from the single authenticated mutating route.
check("applyProposal is named only by promote.ts and server.ts", filesMatching(/\bapplyProposal\b/), ["src/learn/promote.ts", "src/server.ts"]);
check("server.ts calls applyProposal from exactly one place", (sources["src/server.ts"].match(/\bapplyProposal\s*\(/g) ?? []).length, 1);
check("promote.ts writes policy in exactly one place", (sources["src/learn/promote.ts"].match(new RegExp(FS_WRITE_STRICT.source, "g")) ?? []).length, 1);
check("no tool names applyProposal or promote.ts", filesMatching(/\bapplyProposal\b|learn\/promote/).filter((f) => f.startsWith("src/tools/")), []);

console.log("\nCONTROL FILES: THE TOOLS THAT TOUCH THE DISK, AND THE ONES THAT RUN COMMANDS");
// Every tool that writes a file. write_file and scaffold_ios take a path from the model, so both must go
// through textTargetGate (which refuses control files: see test/write-file.test.mjs). draft and
// generate_image build their own file names inside a fixed directory. So does site_audit (2026-11-26):
// its one write is the report, named in code from the audited host and the day, under data/site-audits.
check("the tools with a file-writing call are exactly these five", filesMatching(FS_WRITE_STRICT).filter((f) => f.startsWith("src/tools/")), [
  "src/tools/draft.ts",
  "src/tools/generate-image.ts",
  "src/tools/scaffold-ios.ts",
  "src/tools/site-audit.ts",
  "src/tools/write-file.ts",
]);
check("site-audit.ts writes in exactly one place, and never takes a path from the model", [(sources["src/tools/site-audit.ts"].match(new RegExp(FS_WRITE_STRICT.source, "g")) ?? []).length, /args\??\.(path|file|dir)\b/.test(sources["src/tools/site-audit.ts"])], [1, false]);
for (const file of ["src/tools/write-file.ts", "src/tools/scaffold-ios.ts"]) {
  check(`${path.basename(file)} takes a model-supplied path through textTargetGate`, /\btextTargetGate\s*\(/.test(sources[file]), true);
}
check("write-file.ts refuses control files in its gate", /\bisControlFile\s*\(/.test(sources["src/tools/write-file.ts"]), true);
// A shell can redirect into any file, which no scan of the tools can see. The broker is what gates these;
// this list only makes sure a new command-running tool is noticed.
check("the tools that can run a command are exactly these six", filesMatching(/from\s+"(node:)?child_process"/).filter((f) => f.startsWith("src/tools/")), [
  "src/tools/apple.ts",
  "src/tools/git-status.ts",
  "src/tools/git-write.ts",
  "src/tools/mac-control.ts",
  "src/tools/run-command.ts",
  "src/tools/scaffold-ios.ts",
]);

// ---- 2. The Google write token --------------------------------------------------------------

console.log("\nTHE GOOGLE WRITE TOKEN: WHO CAN NAME IT");
check("only config, auth and write.ts name GOOGLE_WRITE_TOKEN_PATH", filesMatching(/\bGOOGLE_WRITE_TOKEN_PATH\b/), ["src/config.ts", "src/google/auth.ts", "src/google/write.ts"]);
check("the token's file name appears only where config sets it", filesMatching(/google-write-token/), ["src/config.ts"]);
check("only config and auth name the write scopes", filesMatching(/\bGOOGLE_WRITE_SCOPES\b/), ["src/config.ts", "src/google/auth.ts"]);

console.log("\nTHE GOOGLE WRITE TOKEN: WHO CAN REACH THE MODULE THAT HOLDS IT");
// The draft tool joined them on 2026-11-25 (SPEC section 5, third amendment, CP2): Gmail drafts and timed events.
check("only the three tools built for it import src/google/write.ts", filesMatching(/from\s+"[^"]*google\/write(\.ts)?"/), ["src/tools/calendar-write.ts", "src/tools/draft.ts", "src/tools/gmail-triage.ts"]);
check("nothing imports it dynamically", filesMatching(/import\s*\(\s*["'`][^"'`]*google\/write/), []);

console.log("\nTHE GOOGLE WRITE TOKEN: WHAT THE MODULE CANNOT DO");
const writeTs = sources["src/google/write.ts"];
check("it has no send endpoint, a draft's included", /\/send\b|messages\/send|drafts\/send/.test(writeTs), false);
// Since CP2 it may save a draft: exactly one drafts endpoint, the plain create, and nothing under it.
check("its only drafts endpoint is the plain create", [...writeTs.matchAll(/drafts[^`"'\s]*/g)].map((m) => m[0]).filter((d) => d !== "drafts"), []);
check("no event it creates carries attendees", /attendees/.test(writeTs), false);
check("an event is created with no notifications sent", /events\?sendUpdates=none/.test(writeTs), true);
check("it has no permanent delete or empty-trash call", /batchDelete|trash\/empty|emptyTrash|["'`]DELETE["'`]/.test(writeTs), false);
// The type annotation is gone from the stripped text, so the signature is read from the raw file, and the
// methods actually used are read from the stripped code.
const writeRaw = fs.readFileSync(path.join(ROOT, "src/google/write.ts"), "utf8");
check("its request helper is typed to GET, PATCH and POST only", /call\s*=\s*async\s*\(\s*method:\s*"GET"\s*\|\s*"PATCH"\s*\|\s*"POST"\s*,/.test(writeRaw), true);
check("every call it makes uses GET, PATCH or POST", [...new Set([...writeTs.matchAll(/\bcall\(\s*"([A-Z]+)"/g)].map((m) => m[1]))].filter((m) => !["GET", "PATCH", "POST"].includes(m)), []);
check("it makes at least one call, so the line above is not vacuous", [...writeTs.matchAll(/\bcall\(\s*"[A-Z]+"/g)].length > 0, true);
check("it never calls the calendar's delete or the mail's delete", /\bcall\(\s*"DELETE"/.test(writeTs), false);
check("it names no export that sends, deletes or purges", [...writeTs.matchAll(/export const (\w+)/g)].map((m) => m[1]).filter((n) => /send|delete|empty|purge|remove(Message|Event)/i.test(n)), []);

console.log("\nTHE GOOGLE READ PATH STAYS READ-ONLY");
const clientTs = sources["src/google/client.ts"];
check("client.ts has no mail or calendar write endpoint", /\/modify\b|\/trash\b|\/untrash\b|\/batchModify|\/send\b|\/insert\b|["'`](PATCH|PUT|DELETE)["'`]/.test(clientTs), false);
check("the Gmail and Calendar APIs are called only from src/google and config", filesMatching(/(gmail|www)\.googleapis\.com\/(gmail|calendar)/), ["src/google/client.ts", "src/google/write.ts"]);

// ---- 3. Instagram: the token, and the two writes --------------------------------------------
// docs/INSTAGRAM.md. Publishing is a write to a public account, so the same kind of tripwires as the
// Google write token: who can name the token, who can reach the module that sends it, and what that
// module is able to ask Meta for.

console.log("\nTHE INSTAGRAM TOKEN: WHO CAN NAME IT");
check("only config and token.ts name INSTAGRAM_TOKEN_PATH", filesMatching(/\bINSTAGRAM_TOKEN_PATH\b/), ["src/config.ts", "src/instagram/token.ts"]);
check("the token's file name appears only where config sets it", filesMatching(/instagram-token/), ["src/config.ts"]);
check("token.ts is imported only inside src/instagram", filesMatching(/from\s+"[^"]*\/token(\.ts)?"/).filter((f) => /instagram/.test(sources[f])), ["src/instagram/index.ts", "src/instagram/insights.ts", "src/instagram/runner.ts"]);
check("no tool imports the token module or the API client", filesMatching(/from\s+"[^"]*instagram\/(token|api)(\.ts)?"/).filter((f) => f.startsWith("src/tools/")), []);
check("no tool can store a token", filesMatching(/\b(storeToken|saveToken)\b/).filter((f) => f.startsWith("src/tools/")), []);
check("the token is written in exactly one place", filesMatching(/\bsaveToken\s*\(/).filter((f) => f !== "src/instagram/token.ts"), ["src/instagram/index.ts"]);

console.log("\nTHE INSTAGRAM API: WHAT THE CLIENT CAN ASK FOR");
const igApi = sources["src/instagram/api.ts"];
const igApiRaw = fs.readFileSync(path.join(ROOT, "src/instagram/api.ts"), "utf8");
check("its request helper is typed to GET and POST only", /const call = async \(\s*method:\s*"GET"\s*\|\s*"POST"\s*,/.test(igApiRaw), true);
check("every call it makes uses GET or POST", [...new Set([...igApi.matchAll(/\bcall\(\s*"([A-Z]+)"/g)].map((m) => m[1]))].sort(), ["GET", "POST"]);
check("it has exactly two writes: create a container, and publish one", [...igApi.matchAll(/\bcall\(\s*"POST",\s*"([^"]+)"/g)].map((m) => m[1]), ["create container", "publish"]);
check("it has no delete, comment, message or profile call", /["'`]DELETE["'`]|\/comments\b|\/messages\b|\/replies\b|comment_enabled/.test(igApi), false);
check("the API host is named in one place", filesMatching(/graph\.instagram\.com/), ["src/instagram/rules.ts"]);
check("the client is built only inside src/instagram", filesMatching(/\bcreateClient\s*\(/), ["src/instagram/index.ts", "src/instagram/insights.ts", "src/instagram/runner.ts"]);

console.log("\nTHE INSTAGRAM RUNNER: ONE PLACE PUBLISHES, AND IT CLAIMS FIRST");
const igRunner = sources["src/instagram/runner.ts"];
check("publishContainer is called from the runner alone", filesMatching(/\.publishContainer\s*\(/), ["src/instagram/runner.ts"]);
check("and from exactly one line of it", (igRunner.match(/\.publishContainer\s*\(/g) ?? []).length, 1);
check("a container is created from exactly one line too", [filesMatching(/\.createImageContainer\s*\(/), (igRunner.match(/\.createImageContainer\s*\(/g) ?? []).length], [["src/instagram/runner.ts"], 1]);
const claimAt = igRunner.search(/transition\(r\.id,\s*"container",\s*"publishing"/);
check("the row is claimed as 'publishing' before the publish request is sent", claimAt > 0 && claimAt < igRunner.search(/\.publishContainer\s*\(/), true);
check("the tools reach publishing only through the runner's publishNow", /\bpublishNow\b/.test(sources["src/tools/instagram.ts"]) && !/publishContainer|createImageContainer/.test(sources["src/tools/instagram.ts"]), true);

console.log("\nSC6: THE FILES THAT ENFORCE THE GATES ARE PROTECTED");
// A builder that cannot write policy.json could still edit the code that reads it. These files queue with the change
// shown (src/protected-paths.ts). The list is pinned here, so shortening it means editing this file, which is itself on it.
{
  const { PROTECTED_PATHS } = await import("../src/protected-paths.ts");
  // Widened 2026-11-26 from the gates themselves to the code around them: what reads the policy, what carries a
  // model's call to the broker, and the tools that can change a checkout (the write tools enforce this very list).
  const PINNED = [
    "src/agent.ts",
    "src/broker.ts",
    "src/config.ts",
    "src/confirmations.ts",
    "src/fs-scope.ts",
    "src/google/write.ts",
    "src/harness.ts",
    "src/instagram/api.ts",
    "src/instagram/token.ts",
    "src/learn/promote.ts",
    // The trust dials (section 15, R3): it decides whether the outgoing check refuses, so it is a gate.
    "src/modes.ts",
    "src/outgoing.ts",
    "src/projects/narrow-policy.ts",
    "src/protected-paths.ts",
    "src/runner.ts",
    "src/sensitivity.ts",
    "src/tools/browser.ts",
    "src/tools/git-write.ts",
    "src/tools/index.ts",
    "src/tools/propose-change.ts",
    "src/tools/run-command.ts",
    "src/tools/write-file.ts",
    "test/architecture.test.mjs",
  ];
  check("the protected list is exactly the pinned one", [...PROTECTED_PATHS], PINNED);
  check("every protected path exists, so a rename cannot quietly unprotect it", PINNED.filter((p) => !fs.existsSync(path.join(ROOT, p))), []);
  check("the write tools consult it", /protectedPathOf/.test(sources["src/tools/write-file.ts"]), true);
  check("a declared command runs inside keepingProtected, so code it runs cannot change one unseen", /\bkeepingProtected\s*\(/.test(sources["src/tools/run-command.ts"]), true);
}

console.log("\nTHE CODE MAP: READ BY ONE MODULE, WRITTEN BY NONE");
check("AREA_MAP_PATH is named only by area-map.ts and the control-file list", filesMatching(/\bAREA_MAP_PATH\b/), ["src/area-map.ts", "src/tools/write-file.ts"]);
check("area-map.ts makes no file-writing call", FS_WRITE.test(sources["src/area-map.ts"]), false);
check("the map is a control file", /real\(AREA_MAP_PATH\)/.test(sources["src/tools/write-file.ts"]), true);
check("only the runner asks for it", filesMatching(/\bareaMapFor\s*\(/).filter((f) => f !== "src/area-map.ts"), ["src/runner.ts"]);
check("the committed map exists", fs.existsSync(path.join(SRC, "area-map.md")), true);
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
