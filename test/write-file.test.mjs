/**
 * write_file — where it may write, what it may write, and what waits for approval.
 * Run with `node test/write-file.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-write-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.AGENTSPINE_BACKUP_DIR = path.join(root, "backups");
const allowed = path.join(root, "allowed");
const outside = path.join(root, "outside");
fs.mkdirSync(allowed);
fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(allowed, "escape"));

const store = await import("../src/memory/store.ts");
const { writeFile, editFile, moveFile, makeDir, setWriteDefault, resolveTarget, BACKUP_DIR, isControlFile, isManifest } = await import("../src/tools/write-file.ts");
const { listDeliverables, isDeliverable } = await import("../src/deliverables.ts");
const { readFile } = await import("../src/tools/read-file.ts");
const { narrowPolicy } = await import("../src/projects/narrow-policy.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const policy = { fs: { readableDirs: [root], writableDirs: [allowed] } };
const gate = (a, p = policy) => writeFile.checkPolicy(p, a);

console.log("\nwhere a bare filename lands\n");
setWriteDefault(allowed);
check("bare name goes to the default dir", resolveTarget({ path: "PLAN.md" }), path.join(allowed, "PLAN.md"));
check("absolute path is kept", resolveTarget({ path: "/x/y.md" }), "/x/y.md");
setWriteDefault(null);
// Derived, not spelled "AgentSpine": the checkout's folder name is the user's to choose,
// and hard-coding one made this fail on a clone named anything else.
const repoDocs = path.join(path.dirname(import.meta.dirname), "docs", "PLAN.md");
check("with no project the default is <repo>/docs", resolveTarget({ path: "PLAN.md" }), repoDocs);
setWriteDefault(allowed);

console.log("\nthe gate\n");
check("creating inside writableDirs is allowed", gate({ content: "hi", path: "a.md" }).allowed, true);
check("outside writableDirs is denied", gate({ content: "hi", path: path.join(outside, "a.md") }).allowed, false);
check("a symlink cannot carry a write out", gate({ content: "hi", path: "escape/a.md" }).allowed, false);
check("no writableDirs at all means no writing", gate({ content: "hi", path: "a.md" }, { fs: { readableDirs: [root] } }).allowed, false);
check("scripts are refused", gate({ content: "x", path: "run.sh" }).allowed, false);
check("plists are refused", gate({ content: "x", path: "a.plist" }).allowed, false);

// A "one page site" the agent cannot give a stylesheet or a script to is not a site, and
// the workaround — one giant inlined document in a single JSON string — is the call that
// overran the completion budget. Web source is writable; the things that run themselves
// later still are not.
for (const ext of ["html", "css", "js", "jsx", "mjs", "ts", "tsx", "vue", "svelte", "astro", "svg", "toml"]) {
  check(`a site can be built from .${ext}`, gate({ content: "x", path: `app.${ext}` }).allowed, true);
}
// Still refused, and each for a reason that is not "it is code": a shell script is what a
// double-click runs, .php is executed by a server already running, .plist is picked up by
// macOS itself. See CODE_EXTENSIONS in src/tools/write-file.ts.
for (const ext of ["sh", "bash", "zsh", "command", "php", "pl", "cgi", "scpt", "applescript", "plist"]) {
  check(`.${ext} is still refused`, gate({ content: "x", path: `thing.${ext}` }).allowed, false);
}
check("the refusal names what IS allowed", /web source/.test(gate({ content: "x", path: "a.sh" }).reason), true);

// Phase 4: program source, so a build loop can work in a real codebase rather than only in
// documents and web source.
for (const ext of ["rs", "swift", "go", "py", "rb", "java", "kt", "kts", "c", "cc", "cpp", "h", "hpp", "cs", "m", "mm", "sql", "proto", "zig"]) {
  check(`.${ext} can be written`, gate({ content: "x", path: `thing.${ext}` }).allowed, true);
}
check("no extension is refused", gate({ content: "x", path: "Makefile" }).allowed, false);
check("hidden files are refused", gate({ content: "x", path: ".hidden.md" }).allowed, false);
check("traversal out of the dir is refused", gate({ content: "x", path: "../outside/a.md" }).allowed, false);
check("empty call explains itself", /needs/.test(gate({ path: "a.md" }).reason), true);
check("oversize content is refused", gate({ content: "x".repeat(1_000_001), path: "a.md" }).allowed, false);

console.log("\nnew vs existing\n");
check("a new file is reversible", writeFile.classify({ content: "hi", path: "new.md" }).reversibility, "reversible");
fs.writeFileSync(path.join(allowed, "old.md"), "old");
check("an existing file is still reversible — it is backed up", writeFile.classify({ content: "hi", path: "old.md" }).reversibility, "reversible");

console.log("\nrunning it\n");
const out = await writeFile.run({ content: "hello", path: "sub/dir/note.md" });
check("writes and reports the path", out.endsWith(path.join(allowed, "sub/dir/note.md")), true);
check("content landed, parents created", fs.readFileSync(path.join(allowed, "sub/dir/note.md"), "utf8"), "hello");

const convo = store.createConversation("t");
const runId = store.startRun({ conversationId: convo, kind: "chat", task: "write a plan" });
const plan = "# Plan\n\n" + "line\n".repeat(2000);
store.finishRun(runId, "ok", plan);
check("from_run is allowed by the gate", gate({ from_run: runId, path: "BUSINESSPLAN.md" }).allowed, true);
await writeFile.run({ from_run: runId, path: "BUSINESSPLAN.md" });
check("from_run saves the stored text byte-for-byte", fs.readFileSync(path.join(allowed, "BUSINESSPLAN.md"), "utf8"), plan);
check("unknown from_run is denied with a reason", /No run/.test(gate({ from_run: 99999, path: "x.md" }).reason), true);

console.log("\nprojects can only narrow\n");
const narrowed = narrowPolicy({ ...policy, apps: { allow: [] }, web: {}, browser: {}, google: {} }, { fs: { writableDirs: [allowed] } });
check("an overlay keeps only entries the base already grants", narrowed.fs.writableDirs, [allowed]);
const none = narrowPolicy({ ...policy, apps: { allow: [] }, web: {}, browser: {}, google: {} }, { fs: { writableDirs: [] } });
check("an empty overlay list removes write access", none.fs.writableDirs, []);
const widened = narrowPolicy({ ...policy, apps: { allow: [] }, web: {}, browser: {}, google: {} }, { fs: { writableDirs: [root] } });
check("an overlay cannot widen it", widened.fs.writableDirs, []);

console.log("\nappend, edit, move, mkdir, backups\n");
const doc = path.join(allowed, "notes.md");
await writeFile.run({ content: "one\ntwo", path: "notes.md" });
await writeFile.run({ content: "three", mode: "append", path: "notes.md" });
check("append adds to the end on its own line", fs.readFileSync(doc, "utf8"), "one\ntwo\nthree");
const rep = await writeFile.run({ content: "fresh", path: "notes.md" });
check("replacing reports where the old version went", /previous version kept at/.test(rep), true);
check("the backup holds the old text", fs.readdirSync(BACKUP_DIR).some((f) => fs.readFileSync(path.join(BACKUP_DIR, f), "utf8") === "one\ntwo\nthree"), true);
await writeFile.run({ content: "alpha beta alpha", path: "e.md" });
check("edit refuses an ambiguous match", (await editFile.run({ find: "alpha", path: "e.md", replace: "X" })).startsWith("NOT CHANGED"), true);
check("edit replaces all when asked", /replaced 2/.test(await editFile.run({ all: true, find: "alpha", path: "e.md", replace: "X" })), true);
check("and the file reflects it", fs.readFileSync(path.join(allowed, "e.md"), "utf8"), "X beta X");
check("edit on a missing file is denied", editFile.checkPolicy(policy, { find: "a", path: "nope.md", replace: "b" }).allowed, false);
check("edit outside writableDirs is denied", editFile.checkPolicy(policy, { find: "a", path: path.join(outside, "a.md"), replace: "b" }).allowed, false);
check("move works", /Moved/.test(await moveFile.run({ from: "e.md", to: "moved/e2.md" })), true);
check("move will not clobber", moveFile.checkPolicy(policy, { from: "moved/e2.md", to: "notes.md" }).allowed, false);
check("move out of bounds is denied", moveFile.checkPolicy(policy, { from: "notes.md", to: path.join(outside, "n.md") }).allowed, false);
check("make_dir inside is allowed", makeDir.checkPolicy(policy, { path: "newdir/deeper" }).allowed, true);
check("make_dir outside is denied", makeDir.checkPolicy(policy, { path: path.join(outside, "d") }).allowed, false);
check("all file tools are reversible", [writeFile, editFile, moveFile, makeDir].every((t) => t.classify({ path: "notes.md", from: "notes.md", to: "z.md" }).reversibility === "reversible"), true);

console.log("\nthe deliverables ledger\n");
await writeFile.run({ content: "ledger", path: "ledger.md" }, { runId: 1 });
const listed = listDeliverables();
check("a write is recorded", listed.some((d) => d.name === "ledger.md" && d.exists && d.run_id === 1), true);
check("the ledger gates reads", isDeliverable(path.join(allowed, "ledger.md")) && !isDeliverable("/etc/hosts"), true);
check("each path appears once, newest first", new Set(listed.map((d) => d.path)).size, listed.length);

console.log("\nread_file understands rich formats\n");
const html = path.join(allowed, "rich.html");
fs.writeFileSync(html, "<html><body><h1>Quarterly Plan</h1><p>Ship the thing.</p></body></html>");
const got = await readFile.run({ path: html }, {});
check("html is read as plain text, not markup", /Quarterly Plan/.test(got) && !/<h1>/.test(got), true);
const pdf = "/System/Library/ProductDocuments/ProductGuides/ENERGY STAR.pdf";
if (fs.existsSync(pdf)) {
  const copy = path.join(allowed, "guide.pdf");
  fs.copyFileSync(pdf, copy);
  check("a PDF is read as text", /ENERGY STAR/.test(await readFile.run({ path: copy }, {})), true);
} else console.log("  SKIP  no sample PDF on this machine");

console.log("\nbuild manifests wait for approval\n");

// A manifest is the one write that pulls in code from outside the repo, or runs on a
// lifecycle hook. Source stays reversible — the diff is the review step for source.
for (const name of ["package.json", "Cargo.toml", "build.rs", "Package.swift", "pyproject.toml", "setup.py", "requirements.txt", "package-lock.json", "pnpm-lock.yaml", "build.gradle", "build.gradle.kts", "settings.gradle", "CMakeLists.txt", "conanfile.py"]) {
  check(`${name} is irreversible`, writeFile.classify({ content: "x", path: path.join(allowed, name) }).reversibility, "irreversible");
  check(`${name} is still allowed`, gate({ content: "x", path: path.join(allowed, name) }).allowed, true);
}
// A lockfile is generated by the package manager, never hand-written, so .lock is not a
// writable extension at all — two gates agreeing rather than one.
check("yarn.lock is a manifest", isManifest("/x/yarn.lock"), true);
check("but .lock is refused by extension", gate({ content: "x", path: path.join(allowed, "yarn.lock") }).allowed, false);
check("the case does not matter", writeFile.classify({ content: "x", path: path.join(allowed, "CARGO.TOML") }).reversibility, "irreversible");
check("any .gradle file counts", writeFile.classify({ content: "x", path: path.join(allowed, "app.gradle") }).reversibility, "irreversible");
check("the card says what approving it allows", /BUILD MANIFEST/.test(writeFile.classify({ content: "x", path: path.join(allowed, "package.json") }).summary), true);
check("ordinary source stays reversible", writeFile.classify({ content: "x", path: path.join(allowed, "main.rs") }).reversibility, "reversible");
check("a document stays reversible", writeFile.classify({ content: "x", path: path.join(allowed, "PLAN.md") }).reversibility, "reversible");
check("editing a manifest is irreversible too", editFile.classify({ find: "a", path: path.join(allowed, "package.json"), replace: "b" }).reversibility, "irreversible");
check("moving ONTO a manifest is irreversible", moveFile.classify({ from: path.join(allowed, "x.json"), to: path.join(allowed, "package.json") }).reversibility, "irreversible");
check("moving a manifest AWAY is irreversible", moveFile.classify({ from: path.join(allowed, "Cargo.toml"), to: path.join(allowed, "old.toml") }).reversibility, "irreversible");
check("an ordinary move stays reversible", moveFile.classify({ from: path.join(allowed, "a.md"), to: path.join(allowed, "b.md") }).reversibility, "reversible");

console.log("\nAgentSpine's own control files are not writable at all\n");

// These were reachable before Phase 4, which contradicted LEARNING.md invariant 1 — the
// model never widens its own permissions. policy.json is a .json file inside ~/Developer, so
// the extension allowlist and writableDirs both said yes and the write auto-executed.
const BASE = path.dirname(import.meta.dirname);
const ownPolicy = { fs: { readableDirs: [BASE], writableDirs: [BASE] } };
for (const name of ["policy.json", "profile.md", "goals.md"]) {
  check(`${name} is refused`, writeFile.checkPolicy(ownPolicy, { content: "x", path: path.join(BASE, name) }).allowed, false);
  check(`${name} is refused for edit too`, editFile.checkPolicy(ownPolicy, { find: "a", path: path.join(BASE, name), replace: "b" }).allowed, false);
}
check("an agent definition is refused", writeFile.checkPolicy(ownPolicy, { content: "x", path: path.join(BASE, "agents", "hauler.md") }).allowed, false);
check("a NEW agent definition is refused", writeFile.checkPolicy(ownPolicy, { content: "x", path: path.join(BASE, "agents", "evil.md") }).allowed, false);
check("moving onto policy.json is refused", moveFile.checkPolicy(ownPolicy, { from: path.join(BASE, "docs", "x.json"), to: path.join(BASE, "policy.json") }).allowed, false);
check("the refusal explains who may change them", /dashboard, by a person/.test(writeFile.checkPolicy(ownPolicy, { content: "x", path: path.join(BASE, "policy.json") }).reason), true);
check("isControlFile is exported and agrees", isControlFile(path.join(BASE, "policy.json")), true);
check("the repo's own source is NOT a control file", isControlFile(path.join(BASE, "src", "broker.ts")), false);
check("this project's code is still writable", writeFile.checkPolicy(ownPolicy, { content: "x", path: path.join(BASE, "src", "scratch.ts") }).allowed, true);
// package.json in this repo is a manifest, so it queues rather than being refused.
check("its own package.json queues, not refused", writeFile.checkPolicy(ownPolicy, { content: "x", path: path.join(BASE, "package.json") }).allowed, true);
check("and it is irreversible", writeFile.classify({ content: "x", path: path.join(BASE, "package.json") }).reversibility, "irreversible");
fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
