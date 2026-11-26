/**
 * The weekly review as five cards (PLAN-open-work section 15, R10): the web's words and the Swift
 * `ReviewWords` agree, and the review opens on the first card with something waiting.
 *
 *   node test/review-cards.test.mjs      (the Swift half is skipped without swiftc)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-review-cards-")));
const words = await import("../web/src/lib/review-cards.ts");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
};

const cases = [
  { changes: 0, learned: 0, quiet: 0, unrated: 0 },
  { changes: 1, learned: 1, quiet: 1, unrated: 1 },
  { changes: 3, learned: 2, quiet: 4, unrated: 0 },
  { changes: 2, learned: 0, quiet: 0, unrated: 0 },
];
const keys = words.REVIEW_CARDS.map((c) => c.key);
const webLines = [...cases.flatMap((c) => keys.map((k) => words.reviewCardLine(k, c))), ...cases.map(words.firstOpenCard), ...words.REVIEW_CARDS.map((c) => c.title)];

console.log("\nTHE WEB'S WORDS");
check("five cards, in order", keys, ["sent", "quiet", "learned", "changes", "missed"]);
check("lines with nothing waiting", keys.map((k) => words.reviewCardLine(k, cases[0])), ["All rated", "Nothing to quiet", "Nothing waiting", "No changes proposed", "Anything you wish you had been told?"]);
check("plurals", keys.map((k) => words.reviewCardLine(k, cases[2])), ["All rated", "4 kinds you mostly skip", "2 lessons to keep or drop", "3 changes proposed", "Anything you wish you had been told?"]);
check("opens on the first card with something waiting", cases.map(words.firstOpenCard), ["sent", "sent", "quiet", "changes"]);

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

console.log("\nTHE APP'S WORDS");
if (!swiftc) {
  console.log("  SKIP  no swiftc on this machine");
} else {
  try {
    const source = fs.readFileSync(path.join(path.dirname(import.meta.dirname), "ios/AgentSpine/Core/Models.swift"), "utf8");
    const start = source.indexOf("// MARK: - Review cards\n");
    const end = source.indexOf("\n// MARK:", start + 10);
    if (start < 0) throw new Error("Models.swift has no '// MARK: - Review cards' section");
    fs.writeFileSync(path.join(tmp, "Words.swift"), `import Foundation\n${source.slice(start, end < 0 ? undefined : end)}`);
    const args = (c) => `unrated: ${c.unrated}, quiet: ${c.quiet}, learned: ${c.learned}, changes: ${c.changes}`;
    fs.writeFileSync(
      path.join(tmp, "main.swift"),
      [
        ...cases.flatMap((c) => keys.map((k) => `print(ReviewWords.line(${JSON.stringify(k)}, ${args(c)}))`)),
        ...cases.map((c) => `print(ReviewWords.firstOpen(${args(c)}))`),
        "for c in ReviewWords.cards { print(c.title) }",
      ].join("\n") + "\n",
    );
    const bin = path.join(tmp, "run");
    const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(tmp, "mc") };
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(tmp, "mc"), path.join(tmp, "Words.swift"), path.join(tmp, "main.swift"), "-o", bin], { env, stdio: ["ignore", "pipe", "pipe"] });
    const swiftLines = execFileSync(bin, [], { encoding: "utf8" }).replace(/\n$/, "").split("\n");
    check("every line matches the web's", webLines.map((w, i) => (w === swiftLines[i] ? null : { got: swiftLines[i], i, want: w })).filter(Boolean), []);
  } catch (err) {
    check("the Swift half compiles and runs", String(err?.stderr ?? err?.message ?? err).slice(0, 400), "");
  }
}

fs.rmSync(tmp, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
