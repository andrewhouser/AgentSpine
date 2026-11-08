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
const { writeFile, editFile, moveFile, makeDir, setWriteDefault, resolveTarget, BACKUP_DIR } = await import("../src/tools/write-file.ts");
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
check("with no project the default is <repo>/docs", resolveTarget({ path: "PLAN.md" }).endsWith(path.join("AgentSpine", "docs", "PLAN.md")), true);
setWriteDefault(allowed);

console.log("\nthe gate\n");
check("creating inside writableDirs is allowed", gate({ content: "hi", path: "a.md" }).allowed, true);
check("outside writableDirs is denied", gate({ content: "hi", path: path.join(outside, "a.md") }).allowed, false);
check("a symlink cannot carry a write out", gate({ content: "hi", path: "escape/a.md" }).allowed, false);
check("no writableDirs at all means no writing", gate({ content: "hi", path: "a.md" }, { fs: { readableDirs: [root] } }).allowed, false);
check("scripts are refused", gate({ content: "x", path: "run.sh" }).allowed, false);
check("plists are refused", gate({ content: "x", path: "a.plist" }).allowed, false);
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

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
