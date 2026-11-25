/**
 * The Files page folders: which project a file came from (server) and how the clients group
 * and search it (web/src/lib/fileGroups.ts). Run with `node test/file-groups.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-filegroups-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");

const store = await import("../src/memory/store.ts");
const { createProject, deleteProject } = await import("../src/projects/store.ts");
const { listDeliverables, recordDeliverable } = await import("../src/deliverables.ts");
const { filterFiles, groupFiles } = await import("../web/src/lib/fileGroups.ts");

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const touch = (name) => {
  const f = path.join(root, name);
  fs.writeFileSync(f, name);
  return f;
};
const runIn = (projectId) => store.startRun({ conversationId: store.createConversation("t", projectId) });

console.log("\nthe server names the project a file came from\n");
const zeta = createProject("Zeta");
const alpha = createProject("alpha");
const gone = createProject("Doomed");
recordDeliverable(touch("z.md"), "create", runIn(zeta));
recordDeliverable(touch("a1.md"), "create", runIn(alpha));
recordDeliverable(touch("a2.md"), "create", runIn(alpha));
recordDeliverable(touch("loose.md"), "create", runIn(null)); // a chat outside any project
recordDeliverable(touch("sched.md"), "create", store.startRun({})); // a run with no conversation
recordDeliverable(touch("norun.md"), "create", null);
recordDeliverable(touch("orphan.md"), "create", runIn(gone));
deleteProject(gone);

const rows = listDeliverables();
const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
check("a project's file carries its project", [byName["z.md"].project_id, byName["z.md"].project_name], [zeta, "Zeta"]);
check("a chat outside a project has none", byName["loose.md"].project_id, null);
check("a run with no conversation has none", byName["sched.md"].project_name, null);
check("a file with no run has none", byName["norun.md"].project_name, null);
check("a deleted project's file falls to General", byName["orphan.md"].project_name, null);

console.log("\nthe clients group them\n");
const groups = groupFiles(rows);
check("projects A to Z (any case), General last", groups.map((g) => g.name), ["alpha", "Zeta", "General"]);
check("two files in alpha, newest first", groups[0].files.map((f) => f.name), ["a2.md", "a1.md"]);
check("General holds the four with no project", groups[2].files.length, 4);
const twins = groupFiles([
  { ...rows[0], project_id: 1, project_name: "Same" },
  { ...rows[1], project_id: 2, project_name: "Same" },
]);
check("same-named projects stay separate folders", twins.length, 2);
check("no files, no folders", groupFiles([]), []);

console.log("\nsearch\n");
check("by file name", filterFiles(rows, "A1").map((f) => f.name), ["a1.md"]);
check("by project name", filterFiles(rows, "zeta").map((f) => f.name), ["z.md"]);
check("by the word General", filterFiles(rows, "general").length, 4);
check("blank keeps everything", filterFiles(rows, "  ").length, rows.length);
check("no match, nothing", filterFiles(rows, "zzzz"), []);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
