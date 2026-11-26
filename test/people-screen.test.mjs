/**
 * The person page says the same thing on the web, the iPhone and the Mac (PLAN-open-work section 15,
 * R7). The sentences are `web/src/lib/people.ts` and `PeopleWords` in ios/AgentSpine/Core/Models.swift;
 * this runs one list of cases through both, and the Swift half decodes a real person and list as
 * src/knowledge/people.ts builds them, so a renamed field fails here. Everyone is invented.
 *
 *   node test/people-screen.test.mjs      (the Swift half is skipped without swiftc)
 */
import "./helpers/example-policy.mjs";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-people-screen-")));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";
process.env.MEETING_SELF_NAMES = "Robin";

const words = await import("../web/src/lib/people.ts");
const store = await import("../src/memory/store.ts");
await import("../src/meetings/store.ts");
const k = await import("../src/knowledge/store.ts");
const { listPeople, readPerson } = await import("../src/knowledge/people.ts");

const MODELS = path.join(path.dirname(import.meta.dirname), "ios/AgentSpine/Core/Models.swift");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
};

const dirs = [["you-owe", "Lee Okafor"], ["they-owe", "Lee Okafor"], ["they-owe", "Sam"]];
const days = [null, 0, 1, 8];
const counts = [[0, 0], [2, 1]];
const ats = [null, 0, 862_000, 3_725_000, -5];
const webLines = [
  ...dirs.map(([d, n]) => words.directionLabel(d, n)),
  ...days.map(words.oneToOneLine),
  ...counts.map(([a, b]) => words.openCountLine(a, b)),
  ...ats.map(words.atLine),
];

console.log("\nTHE WEB'S WORDS");
check("which way", dirs.map(([d, n]) => words.directionLabel(d, n)), ["You owe", "Lee owes", "Sam owes"]);
check("the last 1:1", days.map(words.oneToOneLine), ["No 1:1 recorded", "Last 1:1 today", "Last 1:1 yesterday", "Last 1:1 8 days ago"]);
check("the counts", counts.map(([a, b]) => words.openCountLine(a, b)), ["Nothing open", "You owe 2 · they owe 1"]);
check("a time in the meeting", ats.map(words.atLine), ["", "0:00 into the meeting", "14:22 into the meeting", "1:02:05 into the meeting", ""]);

// A real page and list, as the server builds them.
const mid = Number(store.rawDb.prepare("INSERT INTO meetings (title, device, started, status) VALUES ('1:1 Lee', 'test', '2026-11-18T15:00:00Z', 'done')").run().lastInsertRowid);
for (const [i, n] of ["Robin", "Lee Okafor"].entries()) store.rawDb.prepare("INSERT INTO meeting_speakers (meeting_id, idx, name) VALUES (?,?,?)").run(mid, i, n);
const lee = k.upsertEntity("person", "Lee Okafor");
const cid = k.addClaim({ atMs: 862_000, due: "2026-11-20", kind: "commitment", method: "manual", owner: "me", passage: "Feedback by Tuesday.", sourceKind: "meeting", sourceRef: `meeting:${mid}`, speaker: "Robin", text: "Feedback on the write-up" });
k.reviewClaim(cid, "accept");
k.setMyTeam(lee.id, true);
const NOW = new Date("2026-11-26T15:00:00Z");
const person = readPerson(lee.id, NOW);
const list = listPeople(NOW);

const swiftc = (() => {
  try {
    const found = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: ["swiftc"], cmd: "xcrun" };
  } catch {
    /* fall through */
  }
  try {
    const found = execFileSync("which", ["swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: [], cmd: found };
  } catch {
    /* none */
  }
  return null;
})();

console.log("\nTHE APP'S WORDS, AND WHAT IT CAN DECODE");
if (!swiftc) {
  console.log("  SKIP  no swiftc on this machine");
} else {
  try {
    const source = fs.readFileSync(MODELS, "utf8");
    const start = source.indexOf("// MARK: - People\n");
    const end = source.indexOf("\n// MARK:", start + 10);
    if (start < 0) throw new Error("Models.swift has no '// MARK: - People' section");
    const section = `import Foundation\n${source.slice(start, end < 0 ? undefined : end)}`;
    const s = (v) => JSON.stringify(v);
    const opt = (v) => (v === null ? "nil" : String(v));
    const main = `import Foundation
let dirs: [(String, String)] = [${dirs.map(([d, n]) => `(${s(d)}, ${s(n)})`).join(", ")}]
for d in dirs { print(PeopleWords.directionLabel(d.0, name: d.1)) }
let days: [Int?] = [${days.map(opt).join(", ")}]
for d in days { print(PeopleWords.oneToOneLine(d)) }
let counts: [(Int, Int)] = [${counts.map(([a, b]) => `(${a}, ${b})`).join(", ")}]
for c in counts { print(PeopleWords.openCountLine(youOwe: c.0, theyOwe: c.1)) }
let ats: [Int?] = [${ats.map(opt).join(", ")}]
for a in ats { print(PeopleWords.atLine(a)) }
print("--")
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
do {
  let p = try JSONDecoder().decode(Person.self, from: Data(contentsOf: dir.appendingPathComponent("person.json")))
  print("\\(p.name) \\(p.onTeam) \\(p.open.count) \\(p.open.first?.direction ?? "") \\(p.open.first?.late ?? false) \\(p.open.first?.moment?.atMs ?? -1) \\(PeopleWords.oneToOneLine(p.daysSince))")
  let rows = try JSONDecoder().decode([PersonRow].self, from: Data(contentsOf: dir.appendingPathComponent("list.json")))
  print(rows.map { "\\($0.name):\\($0.youOwe)/\\($0.theyOwe)" }.joined(separator: ","))
} catch { print("DECODE FAILED: \\(error)") }
`;
    fs.writeFileSync(path.join(tmp, "People.swift"), section);
    fs.writeFileSync(path.join(tmp, "main.swift"), main);
    fs.writeFileSync(path.join(tmp, "person.json"), JSON.stringify(person));
    fs.writeFileSync(path.join(tmp, "list.json"), JSON.stringify(list));
    const bin = path.join(tmp, "run");
    const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(tmp, "mc") };
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(tmp, "mc"), path.join(tmp, "People.swift"), path.join(tmp, "main.swift"), "-o", bin], { env, stdio: ["ignore", "pipe", "pipe"] });
    const [lines, decoded] = execFileSync(bin, [tmp], { encoding: "utf8" }).trimEnd().split("\n--\n");
    const swiftLines = lines.split("\n");
    check("the same number of sentences", swiftLines.length, webLines.length);
    check("every sentence matches the web's", webLines.map((w, i) => (w === swiftLines[i] ? null : { got: swiftLines[i], i, want: w })).filter(Boolean), []);
    const d = decoded.split("\n");
    check("a real person decodes", d[0], `Lee Okafor true 1 you-owe true 862000 ${words.oneToOneLine(person.daysSince)}`);
    check("and the list", d[1], list.map((r) => `${r.name}:${r.youOwe}/${r.theyOwe}`).join(","));
  } catch (err) {
    check("the Swift half compiles and runs", String(err?.stderr ?? err?.message ?? err).slice(0, 400), "");
  }
}

fs.rmSync(tmp, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
