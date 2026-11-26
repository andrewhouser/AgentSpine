/**
 * The Files page folders on iPhone and Mac group and search the same way as the web.
 * Run with `node test/ios-file-groups.test.mjs`.
 *
 * `FileGroup` in `ios/AgentSpine/Core/Models.swift` is the Swift twin of
 * `web/src/lib/fileGroups.ts`. The rules are written twice, so this builds one list of files with
 * the real server code (the join in src/deliverables.ts), runs it through both, and compares.
 * The real Swift is compiled, not retyped, as in ios-tab-layout.test.mjs: if the Swift changes,
 * this runs the new code. The Swift half skips when there is no `swiftc`; the web half is
 * test/file-groups.test.mjs and always runs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-ios-filegroups-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");

const REPO = path.dirname(import.meta.dirname);
const MODELS = path.join(REPO, "ios/AgentSpine/Core/Models.swift");

const swiftc = (() => {
  try {
    const found = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: ["swiftc"], cmd: "xcrun" };
  } catch {
    /* fall through */
  }
  return null;
})();

if (!swiftc) {
  console.log("SKIP  no swiftc on this machine");
  fs.rmSync(root, { force: true, recursive: true });
  process.exit(0);
}

const store = await import("../src/memory/store.ts");
const { createProject, deleteProject } = await import("../src/projects/store.ts");
const { listDeliverables, recordDeliverable } = await import("../src/deliverables.ts");
const { filterFiles, groupFiles } = await import("../web/src/lib/fileGroups.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(62)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

// --- one list of files, from the server's own code ---------------------------------------------
const touch = (name) => {
  const f = path.join(root, name);
  fs.writeFileSync(f, name);
  return f;
};
const runIn = (projectId) => store.startRun({ conversationId: store.createConversation("t", projectId) });
const zeta = createProject("Zeta");
const alpha = createProject("alpha");
const gone = createProject("Doomed");
recordDeliverable(touch("z.md"), "create", runIn(zeta));
recordDeliverable(touch("a1.md"), "create", runIn(alpha));
recordDeliverable(touch("a2.md"), "create", runIn(alpha));
recordDeliverable(touch("loose.md"), "create", runIn(null));
recordDeliverable(touch("sched.md"), "create", store.startRun({}));
recordDeliverable(touch("norun.md"), "create", null);
recordDeliverable(touch("orphan.md"), "create", runIn(gone));
deleteProject(gone);
const rows = listDeliverables();

// Lists the server cannot easily produce, built from its rows so every field the app decodes is real.
const twins = [
  { ...rows[0], project_id: 10, project_name: "Same" },
  { ...rows[1], project_id: 2, project_name: "Same" },
];
// A copy saved offline before the server sent a project: both fields are missing, not null.
const old = rows.slice(0, 2).map(({ project_id, project_name, ...rest }) => (void project_id, void project_name, rest));
// A project id with no name (the project was deleted between the two reads) is General, on both.
const nameless = [{ ...rows[0], project_id: 5, project_name: null }];
const lists = { empty: [], nameless, old, rows, twins };
const queries = ["A1", "zeta", "general", "  ", "zzzz", "Z.MD"];

const webGroups = (files) => groupFiles(files).map((g) => `${g.name}=${g.files.map((f) => f.name).join("|")}`);
const web = [
  ...Object.entries(lists).map(([name, files]) => `${name}: ${webGroups(files).join(" ; ")}`),
  ...queries.map((q) => `${JSON.stringify(q)}: ${filterFiles(rows, q).map((f) => f.name).join("|")}`),
];

console.log("\nTHE WEB'S ANSWERS (the reference)");
check("projects A to Z in any case, General last", groupFiles(rows).map((g) => g.name), ["alpha", "Zeta", "General"]);
check("same-named projects are two folders, lower id first", groupFiles(twins).map((g) => g.projectId), [2, 10]);

// --- the same lists through the app's Swift ----------------------------------------------------
console.log("\nTHE APP'S ANSWERS");
const models = fs.readFileSync(MODELS, "utf8");
const from = models.indexOf("/// A file the assistant wrote for you.");
const to = from < 0 ? -1 : models.indexOf("struct FileContent", from);
if (from < 0 || to < 0) throw new Error(`could not find SavedFile and FileGroup in ${MODELS} (markers moved?)`);
const section = models.slice(from, to);
for (const needle of ["struct SavedFile", "struct FileGroup", "static func group", "static func filter"]) {
  if (!section.includes(needle)) throw new Error(`the Files section of Models.swift is missing ${needle}`);
}

const main = `
func read(_ name: String) -> [SavedFile] {
    let url = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent(name + ".json")
    return try! JSONDecoder().decode([SavedFile].self, from: try! Data(contentsOf: url))
}
func show(_ files: [SavedFile]) -> String {
    FileGroup.group(files).map { "\\($0.name)=\\($0.files.map(\\.name).joined(separator: "|"))" }.joined(separator: " ; ")
}
${Object.keys(lists).map((name) => `print("${name}: " + show(read("${name}")))`).join("\n")}
let rows = read("rows")
${queries.map((q) => `print(${JSON.stringify(`${JSON.stringify(q)}: `)} + FileGroup.filter(rows, ${JSON.stringify(q)}).map(\\.name).joined(separator: "|"))`).join("\n")}
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-file-groups-"));
try {
  for (const [name, files] of Object.entries(lists)) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(files));
  fs.writeFileSync(path.join(dir, "Files.swift"), `import Foundation\n\n${section}\n`);
  fs.writeFileSync(path.join(dir, "main.swift"), `import Foundation\n${main}`);
  const bin = path.join(dir, "run");
  execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(dir, "mc"), path.join(dir, "Files.swift"), path.join(dir, "main.swift"), "-o", bin], {
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(dir, "mc") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const app = execFileSync(bin, [dir], { encoding: "utf8" }).trimEnd().split("\n");
  check("the same number of answers were compared", app.length, web.length);
  web.forEach((line, i) => check(`same as the web: ${line.split(":")[0]}`, app[i], line));
} catch (error) {
  failed++;
  console.log(`  FAIL  could not compile or run SavedFile and FileGroup from Models.swift\n${error.stderr?.toString() ?? error}`);
} finally {
  fs.rmSync(dir, { force: true, recursive: true });
  fs.rmSync(root, { force: true, recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
