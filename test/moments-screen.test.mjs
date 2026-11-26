/**
 * Meeting moments and answer sources say the same thing on the web, the iPhone and the Mac
 * (PLAN-open-work section 15, R4 and R5): `web/src/lib/moments.ts` against `MomentWords` in
 * Models.swift, and the Swift half decodes real sources and history lines as the server builds them.
 * Everyone is invented.
 *
 *   node test/moments-screen.test.mjs      (the Swift half is skipped without swiftc)
 */
import "./helpers/example-policy.mjs";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-moments-screen-")));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";
process.env.MEETING_SELF_NAMES = "Robin";

const words = await import("../web/src/lib/moments.ts");
const people = await import("../web/src/lib/people.ts");
const store = await import("../src/memory/store.ts");
await import("../src/meetings/store.ts");
const k = await import("../src/knowledge/store.ts");
const { historyFor } = await import("../src/meetings/moments.ts");
const { gatherEvidence, renderEvidence } = await import("../src/knowledge/answer.ts");
const { sourcesForRuns } = await import("../src/knowledge/sources.ts");

const MODELS = path.join(path.dirname(import.meta.dirname), "ios/AgentSpine/Core/Models.swift");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
};

const nf = [[], ["backfill"], ["data", "backfill"]];
const lives = [0, 59_999, 60_000, 754_000];
const ats = [null, 0, 862_000, 3_725_000];
const webLines = [...nf.map(words.notFoundLine), ...lives.map(words.liveLine), ...ats.map(people.atLine)];

console.log("\nTHE WEB'S WORDS");
check("not found", nf.map(words.notFoundLine), ["", "Not recorded anywhere: backfill.", "Not recorded anywhere: data, backfill."]);
check("recording now", lives.map(words.liveLine), ["Recording now · just started", "Recording now · just started", "Recording now · 1 min", "Recording now · 12 min"]);

// Real shapes, as the server builds them.
const meet = (title, started) => {
  const id = Number(store.rawDb.prepare("INSERT INTO meetings (title, device, started, status) VALUES (?, 'test', ?, 'done')").run(title, started).lastInsertRowid);
  for (const [i, n] of ["Robin", "Lee Okafor"].entries()) store.rawDb.prepare("INSERT INTO meeting_speakers (meeting_id, idx, name) VALUES (?,?,?)").run(id, i, n);
  return id;
};
const m1 = meet("1:1 Lee", "2026-11-18T15:00:00Z");
const c1 = k.addClaim({ atMs: 862_000, due: "2026-11-20", kind: "commitment", method: "manual", owner: "me", passage: "Feedback by Tuesday.", sourceKind: "meeting", sourceRef: `meeting:${m1}`, speaker: "Robin", text: "Feedback on the write-up" });
k.reviewClaim(c1, "accept");
const m2 = meet("1:1 Lee", "2026-11-26T15:00:00Z");
const history = historyFor(m2, new Date("2026-11-26T15:05:00Z"));
const run = store.startRun({ kind: "chat", task: "What do I owe Lee about the write-up and the backfill?" });
store.rawDb.prepare("INSERT INTO actions (ts, run_id, tool, args, decision, output) VALUES (?, ?, 'knowledge_claims', '{}', 'executed', ?)").run(new Date().toISOString(), run, renderEvidence(gatherEvidence("feedback write-up backfill")));
const sources = sourcesForRuns([run]);

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
    const start = source.indexOf("// MARK: - Meeting moments\n");
    const end = source.indexOf("\n// MARK:", start + 10);
    if (start < 0) throw new Error("Models.swift has no '// MARK: - Meeting moments' section");
    const section = `import Foundation\n${source.slice(start, end < 0 ? undefined : end)}`;
    const s = (v) => JSON.stringify(v);
    const opt = (v) => (v === null ? "nil" : String(v));
    const main = `import Foundation
let nf: [[String]] = [${nf.map((a) => `[${a.map(s).join(", ")}]`).join(", ")}]
for w in nf { print(MomentWords.notFoundLine(w)) }
for l in [${lives.join(", ")}] { print(MomentWords.liveLine(l)) }
let ats: [Int?] = [${ats.map(opt).join(", ")}]
for a in ats { print(MomentWords.atLine(a)) }
print("--")
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
do {
  let src = try JSONDecoder().decode(TurnSources.self, from: Data(contentsOf: dir.appendingPathComponent("sources.json")))
  print("\\(src.claims.map { "\\($0.claimId):\\($0.reviewed):\\($0.moment?.atMs ?? -1)" }.joined(separator: ",")) \\(src.notFound.joined(separator: "/"))")
  let h = try JSONDecoder().decode([HistoryLine].self, from: Data(contentsOf: dir.appendingPathComponent("history.json")))
  print(h.map { "\\($0.line)|\\($0.late)|\\($0.moment?.meetingTitle ?? "")" }.joined(separator: ","))
} catch { print("DECODE FAILED: \\(error)") }
`;
    fs.writeFileSync(path.join(tmp, "Moments.swift"), section);
    fs.writeFileSync(path.join(tmp, "main.swift"), main);
    fs.writeFileSync(path.join(tmp, "sources.json"), JSON.stringify(sources));
    fs.writeFileSync(path.join(tmp, "history.json"), JSON.stringify(history));
    const bin = path.join(tmp, "run");
    const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(tmp, "mc") };
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(tmp, "mc"), path.join(tmp, "Moments.swift"), path.join(tmp, "main.swift"), "-o", bin], { env, stdio: ["ignore", "pipe", "pipe"] });
    const [lines, decoded] = execFileSync(bin, [tmp], { encoding: "utf8" }).trimEnd().split("\n--\n");
    const swiftLines = lines.split("\n");
    check("the same number of sentences", swiftLines.length, webLines.length);
    check("every sentence matches the web's", webLines.map((w, i) => (w === swiftLines[i] ? null : { got: swiftLines[i], i, want: w })).filter(Boolean), []);
    const d = decoded.split("\n");
    check("real sources decode", d[0], `${sources.claims.map((c) => `${c.claimId}:${c.reviewed}:${c.moment?.atMs ?? -1}`).join(",")} ${sources.notFound.join("/")}`);
    check("and history lines", d[1], history.map((h) => `${h.line}|${h.late}|${h.moment?.meetingTitle ?? ""}`).join(","));
  } catch (err) {
    check("the Swift half compiles and runs", String(err?.stderr ?? err?.message ?? err).slice(0, 400), "");
  }
}

fs.rmSync(tmp, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
