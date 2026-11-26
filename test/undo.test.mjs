/**
 * Undo on the spine (PLAN-open-work section 15, R10): only for a few minutes, only once, only where the
 * tool has a clean inverse, never a protected or control file, and a file is backed up, never just deleted.
 *
 * Run with `node test/undo.test.mjs`.
 */
import "./helpers/example-policy.mjs";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spine-undo-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.AGENTSPINE_BACKUP_DIR = path.join(root, "backups");
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const tasks = await import("../src/tasks/store.ts");
const { undoAction, undoOffers, UNDO_MINUTES } = await import("../src/undo.ts");
const { backupFile } = await import("../src/tools/write-file.ts");
const { BASE } = await import("../src/config.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const NOW = new Date();
const action = (tool, args, output, ts = NOW.toISOString(), decision = "executed") =>
  Number(store.rawDb.prepare("INSERT INTO actions (ts, run_id, tool, args, decision, output) VALUES (?, NULL, ?, ?, ?, ?)").run(ts, tool, JSON.stringify(args), decision, output).lastInsertRowid);

console.log("\nTASKS");
const t1 = tasks.addTask({ title: "Book the incident review" });
const a1 = action("task_add", { title: "Book the incident review" }, `Added: ${tasks.describeTask(tasks.getTask(t1))}`);
check("a task just added is offered", undoOffers(NOW).find((o) => o.actionId === a1)?.undoLine, "Drop it");
check("undoing drops it, not deletes it", [undoAction(a1, NOW).ok, tasks.getTask(t1).status], [true, "dropped"]);
check("only once", undoAction(a1, NOW).ok, false);
check("and it is no longer offered", undoOffers(NOW).some((o) => o.actionId === a1), false);
const t2 = tasks.addTask({ title: "Send the dry-run report" });
tasks.updateTask(t2, { status: "done" });
const a2 = action("task_done", { id: t2 }, "Done");
check("a task just marked done can be reopened", [undoAction(a2, NOW).ok, tasks.getTask(t2).status], [true, "open"]);

console.log("\nTHE WINDOW");
const t3 = tasks.addTask({ title: "Old" });
const old = action("task_add", {}, `Added: ${tasks.describeTask(tasks.getTask(t3))}`, new Date(NOW.getTime() - (UNDO_MINUTES + 1) * 60_000).toISOString());
check("past the window, not offered and refused", [undoOffers(NOW).some((o) => o.actionId === old), undoAction(old, NOW).ok], [false, false]);
const queued = action("task_add", {}, `Added: ${tasks.describeTask(tasks.getTask(t3))}`, NOW.toISOString(), "queued");
check("an action that did not run is not offered", undoOffers(NOW).some((o) => o.actionId === queued), false);
const other = action("notify", { title: "x" }, "sent");
check("a tool with no inverse is not offered", undoOffers(NOW).some((o) => o.actionId === other), false);
tasks.updateTask(t3, { status: "done" });
const changed = action("task_add", {}, `Added: ${tasks.describeTask(tasks.getTask(t3))}`);
check("something that changed since is not offered", undoOffers(NOW).some((o) => o.actionId === changed), false);

console.log("\nFILES");
const docs = path.join(root, "docs");
fs.mkdirSync(docs);
const f = path.join(docs, "notes.md");
fs.writeFileSync(f, "first");
const kept = backupFile(f);
fs.writeFileSync(f, "second");
const a3 = action("write_file", { path: f }, `Saved 6 characters to ${f} (previous version kept at ${kept})`);
check("a replaced file puts the earlier version back", [undoAction(a3, NOW).ok, fs.readFileSync(f, "utf8")], [true, "first"]);
check("and the newer one is kept in backups", fs.readdirSync(process.env.AGENTSPINE_BACKUP_DIR).some((n) => fs.readFileSync(path.join(process.env.AGENTSPINE_BACKUP_DIR, n), "utf8") === "second"), true);
const g = path.join(docs, "new.md");
fs.writeFileSync(g, "brand new");
const a4 = action("write_file", { path: g }, `Saved 9 characters to ${g}`);
check("a created file is removed, with a copy kept", [undoAction(a4, NOW).ok, fs.existsSync(g)], [true, false]);
const policyFile = path.join(BASE, "policy.json");
const a5 = action("write_file", { path: policyFile }, `Saved 2 characters to ${policyFile}`);
check("a control file is never offered", undoOffers(NOW).some((o) => o.actionId === a5), false);
const brokerFile = path.join(BASE, "src", "broker.ts");
const a6 = action("edit_file", { path: brokerFile }, `Edited ${brokerFile}: replaced 1 occurrence(s) (previous version kept at /etc/passwd)`);
check("a protected file is never offered", undoOffers(NOW).some((o) => o.actionId === a6), false);
const h = path.join(docs, "h.md");
fs.writeFileSync(h, "x");
const a7 = action("write_file", { path: h }, `Saved 1 characters to ${h} (previous version kept at /etc/hosts)`);
check("a 'backup' outside the backups folder is refused", undoOffers(NOW).some((o) => o.actionId === a7), false);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
