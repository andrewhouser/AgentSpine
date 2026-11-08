/**
 * write_file — where it may write, what it may write, and what waits for approval.
 * Run with `node test/write-file.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-write-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
const allowed = path.join(root, "allowed");
const outside = path.join(root, "outside");
fs.mkdirSync(allowed);
fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(allowed, "escape"));

const store = await import("../src/memory/store.ts");
const { writeFile, setWriteDefault, resolveTarget } = await import("../src/tools/write-file.ts");
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
check("an existing file is irreversible (needs approval)", writeFile.classify({ content: "hi", path: "old.md" }).reversibility, "irreversible");

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

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
