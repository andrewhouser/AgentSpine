/**
 * A project's page says the same thing on the web, the iPhone and the Mac (PLAN-open-work section 15,
 * R8): `web/src/lib/project-page.ts` against `ProjectWords` in Models.swift, and the Swift half decodes a
 * real page as src/knowledge/project-page.ts builds it. Everyone is invented.
 *
 *   node test/project-screen.test.mjs      (the Swift half is skipped without swiftc)
 */
import "./helpers/example-policy.mjs";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-project-screen-")));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";
process.env.MEETING_SELF_NAMES = "Robin";

const words = await import("../web/src/lib/project-page.ts");
const store = await import("../src/memory/store.ts");
await import("../src/meetings/store.ts");
const k = await import("../src/knowledge/store.ts");
const { readProjectPage } = await import("../src/knowledge/project-page.ts");

const MODELS = path.join(path.dirname(import.meta.dirname), "ios/AgentSpine/Core/Models.swift");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
};

const said = [[null, []], ["Sam Whitfield", []], ["Sam Whitfield", ["Dana Ortiz"]], ["Sam Whitfield", ["Dana Ortiz", "Lee Okafor", "Kai Mendes"]]];
const raised = [1, 2, 5];
const risk = [[1, ["Dana Ortiz"]], [2, []], [3, ["Lee Okafor", "Sam Whitfield"]]];
const waiting = [["you-owe", "Lee Okafor"], ["you-owe", null], ["they-owe", "Sam Whitfield"], ["they-owe", null], ["unknown", "Sam Whitfield"]];
const webLines = [
  ...said.map(([a, b]) => words.saidLine(a, b)),
  ...raised.map(words.raisedLine),
  ...risk.map(([n, by]) => words.riskLine(n, by)),
  ...waiting.map(([d, w]) => words.waitingLine(d, w)),
];

console.log("\nTHE WEB'S WORDS");
check("who said it, and who was there", said.map(([a, b]) => words.saidLine(a, b)), [
  "Speaker not recorded.",
  "Said by Sam Whitfield.",
  "Said by Sam Whitfield, with Dana Ortiz there.",
  "Said by Sam Whitfield, with Dana Ortiz, Lee Okafor and Kai Mendes there.",
]);
check("never 'agreed'", webLines.some((l) => /agree/i.test(l)), false);
check("raised", raised.map(words.raisedLine), ["Raised once, not settled.", "Raised in 2 meetings, not settled.", "Raised in 5 meetings, not settled."]);
check("risks", risk.map(([n, by]) => words.riskLine(n, by)), ["Named once, by Dana Ortiz.", "Named twice.", "Named 3 times, by Lee Okafor and Sam Whitfield."]);
check("waiting", waiting.map(([d, w]) => words.waitingLine(d, w)), ["You owe Lee Okafor", "You owe", "Sam Whitfield owes you", "Someone owes you", "Sam Whitfield owes someone"]);

const mid = Number(store.rawDb.prepare("INSERT INTO meetings (title, device, started, status, project_id) VALUES ('Standup', 'test', '2026-11-12T14:00:00Z', 'done', 3)").run().lastInsertRowid);
for (const [i, n] of ["Robin", "Sam Whitfield", "Dana Ortiz"].entries()) store.rawDb.prepare("INSERT INTO meeting_speakers (meeting_id, idx, name) VALUES (?,?,?)").run(mid, i, n);
for (const c of [
  { atMs: 391_000, kind: "decision", passage: "Lock the third.", speaker: "Sam Whitfield", text: "Cutover on 3 February" },
  { kind: "question", passage: "Who owns it?", speaker: "Dana Ortiz", text: "Backfill owner?", topic: "backfill" },
  { kind: "risk", passage: "Flaky.", speaker: "Sam Whitfield", text: "Flaky deploy" },
  { due: "2026-11-20", kind: "commitment", owner: "Sam Whitfield", passage: "I'll send it.", speaker: "Sam Whitfield", text: "Dry-run report" },
]) k.reviewClaim(k.addClaim({ method: "manual", projectId: 3, sourceKind: "meeting", sourceRef: `meeting:${mid}`, ...c }), "accept");
const page = readProjectPage(3, new Date("2026-11-26T15:00:00Z"));

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
    const start = source.indexOf("// MARK: - Project page\n");
    const end = source.indexOf("\n// MARK:", start + 10);
    if (start < 0) throw new Error("Models.swift has no '// MARK: - Project page' section");
    const section = `import Foundation\n${source.slice(start, end < 0 ? undefined : end)}`;
    const s = (v) => JSON.stringify(v);
    const opt = (v) => (v === null ? "nil" : s(v));
    const arr = (a) => `[${a.map(s).join(", ")}]`;
    const main = `import Foundation
let said: [(String?, [String])] = [${said.map(([a, b]) => `(${opt(a)}, ${arr(b)})`).join(", ")}]
for x in said { print(ProjectWords.saidLine(x.0, present: x.1)) }
for n in [${raised.join(", ")}] { print(ProjectWords.raisedLine(n)) }
let risk: [(Int, [String])] = [${risk.map(([n, by]) => `(${n}, ${arr(by)})`).join(", ")}]
for r in risk { print(ProjectWords.riskLine(r.0, namedBy: r.1)) }
let waiting: [(String, String?)] = [${waiting.map(([d, w]) => `(${s(d)}, ${opt(w)})`).join(", ")}]
for w in waiting { print(ProjectWords.waitingLine(w.0, who: w.1)) }
print("--")
do {
  let p = try JSONDecoder().decode(ProjectPage.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
  print("\\(p.decided.count) \\(p.open.count) \\(p.risks.count) \\(p.waiting.count) \\(p.meetings) \\(p.decided.first?.moment?.atMs ?? -1) \\(ProjectWords.saidLine(p.decided.first?.saidBy, present: p.decided.first?.present ?? []))")
} catch { print("DECODE FAILED: \\(error)") }
`;
    fs.writeFileSync(path.join(tmp, "Project.swift"), section);
    fs.writeFileSync(path.join(tmp, "main.swift"), main);
    fs.writeFileSync(path.join(tmp, "page.json"), JSON.stringify(page));
    const bin = path.join(tmp, "run");
    const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(tmp, "mc") };
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(tmp, "mc"), path.join(tmp, "Project.swift"), path.join(tmp, "main.swift"), "-o", bin], { env, stdio: ["ignore", "pipe", "pipe"] });
    const [lines, decoded] = execFileSync(bin, [path.join(tmp, "page.json")], { encoding: "utf8" }).trimEnd().split("\n--\n");
    const swiftLines = lines.split("\n");
    check("the same number of sentences", swiftLines.length, webLines.length);
    check("every sentence matches the web's", webLines.map((w, i) => (w === swiftLines[i] ? null : { got: swiftLines[i], i, want: w })).filter(Boolean), []);
    check("a real page decodes", decoded, `1 1 1 1 1 391000 ${words.saidLine(page.decided[0].saidBy, page.decided[0].present)}`);
  } catch (err) {
    check("the Swift half compiles and runs", String(err?.stderr ?? err?.message ?? err).slice(0, 400), "");
  }
}

fs.rmSync(tmp, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
