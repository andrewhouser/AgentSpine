/**
 * The trust dials say the same thing on the web, the iPhone and the Mac (PLAN-open-work section
 * 15, R3). The sentences are pure functions, `web/src/lib/dials.ts` and `DialWords` in
 * `ios/AgentSpine/Core/Models.swift`; this runs one list of cases through both and compares every
 * line. The Swift half also decodes the dials and a would-have row exactly as `src/modes.ts` and
 * `src/modes-watch.ts` build them, so a field renamed on the server fails here.
 *
 *   node test/dials-screen.test.mjs      (the Swift half is skipped without swiftc)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-dials-screen-")));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.MODES_PATH = path.join(tmp, "modes.json");
process.env.EMBEDDINGS_URL = "";
process.env.CHECKIN_MODE = "log";
process.env.INBOX_SORT_MODE = "off";
process.env.HEADSUP_ENABLED = "true";
process.env.OUTBOX_ENFORCE = "true";
process.env.OUTGOING_ENFORCE = "false";

const words = await import("../web/src/lib/dials.ts");
const { listDials } = await import("../src/modes.ts");
const { agreement, wouldHave } = await import("../src/modes-watch.ts");
const store = await import("../src/memory/store.ts");
await import("../src/checkin/store.ts");

const REPO = path.dirname(import.meta.dirname);
const MODELS = path.join(REPO, "ios/AgentSpine/Core/Models.swift");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
};

// --- one list of cases -----------------------------------------------------------------------
const levels = ["off", "watch", "on"];
const agreements = [
  { agreed: 0, days: 7, of: 0 },
  { agreed: 17, days: 7, of: 19 },
  { agreed: 1, days: 1, of: 1 },
  { agreed: 0, days: 1, of: 0 },
];
const envs = [
  { allowed: ["off", "watch"], env: "watch", envName: "CHECKIN_MODE", guard: false },
  { allowed: ["off"], env: "off", envName: "INBOX_SORT_MODE", guard: false },
  { allowed: ["on"], env: "on", envName: "OUTBOX_ENFORCE", guard: true },
  { allowed: ["watch", "on"], env: "watch", envName: "OUTGOING_ENFORCE", guard: true },
];

const webLines = [...levels.map(words.levelLabel), ...agreements.map(words.agreementLine), ...envs.map(words.envLine)];

console.log("\nTHE WEB'S WORDS");
check("the three levels", levels.map(words.levelLabel), ["Off", "Watch", "On"]);
check("nothing to judge", words.agreementLine(agreements[0]), "Nothing to judge from the last 7 days.");
check("an agreement count", words.agreementLine(agreements[1]), "You agreed with 17 of 19, the last 7 days.");
check("one day reads today", words.agreementLine(agreements[2]), "You agreed with 1 of 1, today.");
check("a feature below its ceiling", words.envLine(envs[0]), ".env (CHECKIN_MODE) allows up to Watch.");
check("a feature at off in .env", words.envLine(envs[1]), "Off in .env (INBOX_SORT_MODE). To turn it up, change it there and restart.");
check("a guard on in .env", words.envLine(envs[2]), "On in .env (OUTBOX_ENFORCE). A guard cannot be loosened from here.");
check("a guard that can be tightened", words.envLine(envs[3]), ".env (OUTGOING_ENFORCE) keeps it at least Watch. You can tighten it here.");

// --- the server's real shapes ---------------------------------------------------------------
const now = new Date("2026-11-26T12:00:00Z");
store.rawDb
  .prepare("INSERT INTO checkin_runs (at, mode, status, title, body) VALUES (?, 'log', 'logged', 'Mail from Ada Quill', 'Ada Quill: budget')")
  .run(new Date(now.getTime() - 3_600_000).toISOString());
const dials = listDials().map((d) => (d.feature === "checkin" ? { ...d, agreement: agreement("checkin", 7, now) } : d));
const rows = wouldHave("checkin", 7, now);
check("the server's checkin dial reads as the web says", words.envLine(dials[0]), ".env (CHECKIN_MODE) allows up to Watch.");

// --- the same cases through the Swift ------------------------------------------------------------
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
    const start = source.indexOf("// MARK: - Trust dials\n");
    const end = source.indexOf("\n// MARK:", start + 10);
    if (start < 0) throw new Error("Models.swift has no '// MARK: - Trust dials' section");
    const section = `import Foundation\n${source.slice(start, end < 0 ? undefined : end)}`;
    for (const need of ["struct Dial:", "struct WouldHave:", "enum DialWords"]) if (!section.includes(need)) throw new Error(`the dials section has no ${need}`);
    const s = (v) => JSON.stringify(v);
    const main = `import Foundation
for l in [${levels.map(s).join(", ")}] { print(DialWords.levelLabel(l)) }
let agreements: [(Int, Int, Int)] = [${agreements.map((a) => `(${a.agreed}, ${a.days}, ${a.of})`).join(", ")}]
for a in agreements { print(DialWords.agreementLine(DialAgreement(agreed: a.0, days: a.1, of: a.2))) }
let envs: [([String], String, String, Bool)] = [${envs.map((e) => `([${e.allowed.map(s).join(", ")}], ${s(e.env)}, ${s(e.envName)}, ${e.guard})`).join(", ")}]
for e in envs { print(DialWords.envLine(allowed: e.0, env: e.1, envName: e.2, guard: e.3)) }
print("--")
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
do {
  let dials = try JSONDecoder().decode([Dial].self, from: Data(contentsOf: dir.appendingPathComponent("dials.json")))
  print(dials.map { "\\($0.feature) \\($0.mode) \\($0.guard_) \\($0.allowed.joined(separator: "/")) \\($0.agreement.map(DialWords.agreementLine) ?? "-")" }.joined(separator: ","))
  let rows = try JSONDecoder().decode([WouldHave].self, from: Data(contentsOf: dir.appendingPathComponent("rows.json")))
  print(rows.map { "\\($0.key) \\($0.action): \\($0.subject) \\($0.thumbsDown)" }.joined(separator: ","))
} catch { print("DECODE FAILED: \\(error)") }
`;
    fs.writeFileSync(path.join(tmp, "Dials.swift"), section);
    fs.writeFileSync(path.join(tmp, "main.swift"), main);
    fs.writeFileSync(path.join(tmp, "dials.json"), JSON.stringify(dials));
    fs.writeFileSync(path.join(tmp, "rows.json"), JSON.stringify(rows));
    const bin = path.join(tmp, "run");
    const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(tmp, "mc") };
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(tmp, "mc"), path.join(tmp, "Dials.swift"), path.join(tmp, "main.swift"), "-o", bin], { env, stdio: ["ignore", "pipe", "pipe"] });
    const [lines, decoded] = execFileSync(bin, [tmp], { encoding: "utf8" }).trimEnd().split("\n--\n");
    const swiftLines = lines.split("\n");
    check("the same number of sentences", swiftLines.length, webLines.length);
    const differ = webLines.map((w, i) => (w === swiftLines[i] ? null : { got: swiftLines[i], i, want: w })).filter(Boolean);
    check("every sentence matches the web's", differ, []);
    const d = decoded.split("\n");
    const wantDials = dials.map((x) => `${x.feature} ${x.mode} ${x.guard} ${x.allowed.join("/")} ${x.agreement ? words.agreementLine(x.agreement) : "-"}`).join(",");
    check("the server's dials decode, guard and agreement included", d[0], wantDials);
    check("a would-have row decodes", d[1], rows.map((r) => `${r.key} ${r.action}: ${r.subject} ${r.thumbsDown}`).join(","));
  } catch (err) {
    check("the Swift half compiles and runs", String(err?.stderr ?? err?.message ?? err).slice(0, 400), "");
  }
}

fs.rmSync(tmp, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
