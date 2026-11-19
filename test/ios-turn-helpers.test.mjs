/**
 * The Swift twins of the web chat's two rules: which failed tool calls the turn got past, and
 * the timestamp under your message. Run with `node test/ios-turn-helpers.test.mjs`.
 *
 * `Core/TurnHelpers.swift` is Foundation-only on purpose, so the real file is compiled here with
 * a tiny main that prints what it returns. Nothing is retyped: if the Swift changes, this runs
 * the new code. The cases mirror `test/web-message-actions.test.mjs`, because the rule has to
 * mean the same thing on the dashboard, the Mac and the phone. Skips (exit 0) with no `swiftc`,
 * like ios-tab-layout.test.mjs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOURCE = path.join(path.dirname(import.meta.dirname), "ios/AgentSpine/Core/TurnHelpers.swift");

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

if (!swiftc) {
  console.log("SKIP  no swiftc on this machine");
  process.exit(0);
}

const s = (v) => (v === null ? "nil" : JSON.stringify(v));
const recovery = [
  { name: "an error, then two that ran: the first is recovered", statuses: ["error", "executed", "executed"], expect: "1,0,0" },
  { name: "the later call need not be the next one", statuses: ["error", "denied", "executed"], expect: "1,0,0" },
  { name: "an error with nothing after it is not recovered", statuses: ["executed", "error"], expect: "0,0" },
  { name: "a denial is never recovered", statuses: ["denied", "executed"], expect: "0,0" },
  { name: "a queued call is not a recovery", statuses: ["error", "queued"], expect: "0,0" },
  { name: "nor is one still running", statuses: ["error", null], expect: "0,0" },
  { name: "a dry run is not a recovery", statuses: ["error", "dry-run"], expect: "0,0" },
  { name: "two errors then a success: both recovered", statuses: ["error", "error", "executed"], expect: "1,1,0" },
  { name: "a success between does not save a later error", statuses: ["error", "executed", "error"], expect: "1,0,0" },
  { name: "a turn that failed keeps every error", statuses: ["error", "executed"], failed: true, expect: "0,0" },
  { name: "no calls, no flags", statuses: [], expect: "" },
];

const swift = `import Foundation
func show(_ v: [Bool]) { print(v.map { $0 ? "1" : "0" }.joined(separator: ",")) }
${recovery
  .map((c) => `show(RecoveredCalls.flags([${c.statuses.map(s).join(", ")}] as [String?], turnFailed: ${c.failed ? "true" : "false"}))`)
  .join("\n")}

let cal = Calendar.current
func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int) -> Date { cal.date(from: DateComponents(year: y, month: m, day: d, hour: h))! }
let now = at(2026, 11, 19, 15)
print(MessageTime.label(from: now.addingTimeInterval(-5), now: now))
print(MessageTime.label(from: now.addingTimeInterval(30), now: now))
print(MessageTime.label(from: now.addingTimeInterval(-5 * 60), now: now))
print(MessageTime.label(from: now.addingTimeInterval(-59 * 60), now: now))
print(MessageTime.label(from: at(2026, 11, 19, 10), now: now))
print(MessageTime.label(from: at(2026, 11, 18, 9), now: now))
print(MessageTime.label(from: at(2026, 9, 2, 9), now: now))
print(MessageTime.label(from: at(2025, 9, 2, 9), now: now))
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-helpers-"));
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${detail}`}`);
};

try {
  fs.writeFileSync(path.join(dir, "main.swift"), swift);
  const bin = path.join(dir, "run");
  const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(dir, "mc") };
  execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(dir, "mc"), SOURCE, path.join(dir, "main.swift"), "-o", bin], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = execFileSync(bin, { encoding: "utf8" }).split("\n");

  console.log("\nRECOVERED CALLS");
  recovery.forEach((c, i) => check(c.name, lines[i] === c.expect, `want "${c.expect}", got "${lines[i]}"`));

  console.log("\nMESSAGE TIME");
  const t = lines.slice(recovery.length);
  check("seconds ago is just now", t[0] === "Just now", t[0]);
  check("a time slightly in the future is just now", t[1] === "Just now", t[1]);
  check("minutes ago", t[2] === "5 min ago", t[2]);
  check("59 minutes is still minutes", t[3] === "59 min ago", t[3]);
  check("earlier today is a clock time", !/ago|Yesterday|Just now/.test(t[4]) && t[4] !== "", t[4]);
  check("yesterday says so", t[5].startsWith("Yesterday, "), t[5]);
  check("older this year is a date with no year", !/2026|ago|Yesterday/.test(t[6]) && t[6] !== "", t[6]);
  check("a previous year includes the year", t[7].includes("2025"), t[7]);
} catch (error) {
  failed++;
  console.log(`  FAIL  could not compile or run TurnHelpers.swift\n${error.stderr?.toString() ?? error}`);
} finally {
  fs.rmSync(dir, { force: true, recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
