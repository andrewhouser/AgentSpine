/**
 * Memory you can read says the same thing on the web, the iPhone and the Mac (PLAN-open-work section 15,
 * R6): `web/src/lib/memory.ts` against `MemoryWords` in Models.swift. The Swift `Memory` struct's new
 * fields are checked against what `listMemories` really returns, by name.
 *
 *   node test/memory-screen.test.mjs      (the Swift half is skipped without swiftc)
 */
import "./helpers/example-policy.mjs";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-memory-screen-")));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";

const words = await import("../web/src/lib/memory.ts");
const rag = await import("../src/memory/rag.ts");

const MODELS = path.join(path.dirname(import.meta.dirname), "ios/AgentSpine/Core/Models.swift");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
};

const uses = [0, 1, 2, 31, -1];
const webLines = [...uses.map(words.usesLine), words.cloudLine(true), words.cloudLine(false), words.guessLine(true), words.guessLine(false)];

console.log("\nTHE WEB'S WORDS");
check("uses", uses.map(words.usesLine), ["Not used yet", "Used once", "Used 2 times", "Used 31 times", "Not used yet"]);
check("cloud", [words.cloudLine(true), words.cloudLine(false)], ["May reach the cloud", "Local only"]);

await rag.remember("Prefers bullet summaries", "preference", { origin: "profile" });
const row = rag.listMemories(10)[0];
const source = fs.readFileSync(MODELS, "utf8");
const struct = /struct Memory: Codable[\s\S]*?\n}/.exec(source)?.[0] ?? "";
check("the Swift Memory struct names every new field the server sends", ["cloudSafe", "confirmed", "guess", "lastUsed", "uses"].filter((f) => !(f in row) || !new RegExp(`let ${f}:`).test(struct)), []);

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
    const start = source.indexOf("// MARK: - Memory words\n");
    const end = source.indexOf("\n// MARK:", start + 10);
    if (start < 0) throw new Error("Models.swift has no '// MARK: - Memory words' section");
    fs.writeFileSync(path.join(tmp, "Words.swift"), `import Foundation\n${source.slice(start, end < 0 ? undefined : end)}`);
    fs.writeFileSync(
      path.join(tmp, "main.swift"),
      `for u in [${uses.join(", ")}] { print(MemoryWords.usesLine(u)) }
print(MemoryWords.cloudLine(true)); print(MemoryWords.cloudLine(false)); print(MemoryWords.guessLine(true)); print(MemoryWords.guessLine(false))
`,
    );
    const bin = path.join(tmp, "run");
    const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(tmp, "mc") };
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(tmp, "mc"), path.join(tmp, "Words.swift"), path.join(tmp, "main.swift"), "-o", bin], { env, stdio: ["ignore", "pipe", "pipe"] });
    const swiftLines = execFileSync(bin, [], { encoding: "utf8" }).replace(/\n$/, "").split("\n");
    check("the same number of sentences", swiftLines.length, webLines.length);
    check("every sentence matches the web's", webLines.map((w, i) => (w === swiftLines[i] ? null : { got: swiftLines[i], i, want: w })).filter(Boolean), []);
  } catch (err) {
    check("the Swift half compiles and runs", String(err?.stderr ?? err?.message ?? err).slice(0, 400), "");
  }
}

fs.rmSync(tmp, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
