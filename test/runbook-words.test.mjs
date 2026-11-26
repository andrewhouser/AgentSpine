/**
 * The sentence shown after a runbook is written says the same thing on the web, the iPhone and the Mac
 * (docs/PLAN-open-work.md, section 14 U5).
 *
 * `runbookSavedLine` in web/src/lib/runbook.ts and `RunbookWords.savedLine` in ios/AgentSpine/Core/Models.swift
 * are the same rule written twice, so one set of server replies goes through both and the lines are compared.
 * The real Swift is compiled, not retyped, as in ios-file-groups.test.mjs, and it decodes the same JSON the
 * server sends. The Swift half skips when there is no `swiftc`; the web half always runs.
 *
 *   node test/runbook-words.test.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.dirname(import.meta.dirname);
const { runbookSavedLine } = await import("../web/src/lib/runbook.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(60)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const cases = [
  ["several steps, none dropped", { dropped: 0, path: "/srv/docs/runbook-month-end-close-meeting-4.md", steps: 3, title: "Month-end close", truncated: false }],
  ["one step", { dropped: 0, path: "/srv/docs/runbook-a-meeting-5.md", steps: 1, title: "A", truncated: false }],
  ["one dropped", { dropped: 1, path: "/srv/docs/runbook-a-meeting-5.md", steps: 4, title: "A", truncated: false }],
  ["several dropped", { dropped: 3, path: "/srv/docs/runbook-a-meeting-5.md", steps: 4, title: "A", truncated: false }],
  ["a recording longer than what was read", { dropped: 2, path: "/srv/docs/runbook-a-meeting-5.md", steps: 9, title: "A", truncated: true }],
  ["a bare file name", { dropped: 0, path: "runbook.md", steps: 2, title: "A", truncated: false }],
];

console.log("\nTHE WEB SENTENCE");
check(cases[0][0], runbookSavedLine(cases[0][1]), "Draft saved to Files as runbook-month-end-close-meeting-4.md: 3 steps, each quoting the recording. Check it before relying on it.");
check(cases[1][0], runbookSavedLine(cases[1][1]), "Draft saved to Files as runbook-a-meeting-5.md: 1 step, each quoting the recording. Check it before relying on it.");
check(cases[2][0], /1 proposed step was left out because the quote was not in the transcript\./.test(runbookSavedLine(cases[2][1])), true);
check(cases[3][0], /3 proposed steps were left out/.test(runbookSavedLine(cases[3][1])), true);
check(cases[4][0], /the steps stop before its end\. Check it before relying on it\.$/.test(runbookSavedLine(cases[4][1])), true);
check("it never repeats the folder", runbookSavedLine(cases[0][1]).includes("/srv/"), false);

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
  console.log("\nSKIP  the Swift half: no swiftc on this machine");
} else {
  console.log("\nTHE SWIFT SENTENCE IS THE SAME");
  const models = fs.readFileSync(path.join(REPO, "ios/AgentSpine/Core/Models.swift"), "utf8");
  const from = models.indexOf("struct RunbookSaved: Codable");
  const words = models.indexOf("enum RunbookWords {");
  const to = models.indexOf("\n}\n", words) + 3;
  if (from < 0 || words < 0 || to < 3) {
    check("RunbookSaved and RunbookWords are in Models.swift", false, true);
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-runbook-words-"));
    fs.writeFileSync(path.join(dir, "cases.json"), JSON.stringify(cases.map(([, reply]) => reply)));
    fs.writeFileSync(path.join(dir, "Runbook.swift"), `import Foundation\n\n${models.slice(from, to)}\n`);
    fs.writeFileSync(
      path.join(dir, "main.swift"),
      [
        "import Foundation",
        "let data = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))",
        "let replies = try! JSONDecoder().decode([RunbookSaved].self, from: data)",
        "for r in replies { print(RunbookWords.savedLine(r)) }",
      ].join("\n"),
    );
    const bin = path.join(dir, "words");
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(dir, "mc"), path.join(dir, "Runbook.swift"), path.join(dir, "main.swift"), "-o", bin], { stdio: ["ignore", "pipe", "pipe"] });
    const lines = execFileSync(bin, [path.join(dir, "cases.json")], { encoding: "utf8" }).trimEnd().split("\n");
    cases.forEach(([label, reply], i) => check(label, lines[i], runbookSavedLine(reply)));
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
