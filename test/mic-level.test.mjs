/**
 * The dictation waveform's level rule, on the web and on the phone: `web/src/lib/micLevel.ts`
 * and `MicLevel` in `ios/AgentSpine/Core/TurnHelpers.swift`, run against the same cases so the
 * bars mean the same thing on both. The Swift half compiles the real file, like
 * ios-turn-helpers.test.mjs, and skips with no `swiftc`. Run with `node test/mic-level.test.mjs`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { micLevel, pushLevel, rmsDecibels } from "../web/src/lib/micLevel.ts";

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${detail}`}`);
};
const near = (a, b) => Math.abs(a - b) < 1e-3;

// [label, dB as Swift source, dB as a JS number, expected]
const levels = [
  ["below the floor is silence", "-60", -60, 0],
  ["the floor itself is silence", "-50", -50, 0],
  ["no signal at all is silence", "-Float.infinity", -Infinity, 0],
  ["a broken reading is silence", "Float.nan", NaN, 0],
  ["full scale is a full bar", "0", 0, 1],
  ["clipping is still a full bar", "5", 5, 1],
  ["halfway down is lifted above half", "-25", -25, Math.SQRT1_2],
  ["quiet speech still shows", "-37.5", -37.5, 0.5],
];
const pushes = [
  ["drops the oldest when full", "[0.1, 0.2, 0.3]", [0.1, 0.2, 0.3], "0.2,0.3,0.4"],
  ["grows until full", "[]", [], "0.4"],
];

console.log("\nWEB");
for (const [name, , db, want] of levels) {
  const got = micLevel(db);
  check(name, near(got, want), `want ${want}, got ${got}`);
}
for (const [name, , start, want] of pushes) {
  const got = pushLevel(start, 0.4, 3).join(",");
  check(name, got === want, `want ${want}, got ${got}`);
}
check("silence measures -Infinity dB", rmsDecibels(new Float32Array(128)) === -Infinity);
check("a full-scale square wave measures 0 dB", near(rmsDecibels([1, -1, 1, -1]), 0));
check("half amplitude is about -6 dB", near(rmsDecibels([0.5, -0.5]), -6.0206));

const swiftc = (() => {
  // Through xcrun when it is there: it supplies the SDK, which a bare toolchain swiftc cannot find.
  for (const [cmd, args, run] of [
    ["xcrun", ["--find", "swiftc"], (found) => ({ args: ["swiftc"], cmd: "xcrun", found })],
    ["which", ["swiftc"], (found) => ({ args: [], cmd: found, found })],
  ]) {
    try {
      const found = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (found && fs.existsSync(found)) return run(found);
    } catch {
      /* try the next */
    }
  }
  return null;
})();

if (!swiftc) {
  console.log("\nSKIP  Swift half: no swiftc on this machine");
} else {
  console.log("\nPHONE");
  const source = path.join(path.dirname(import.meta.dirname), "ios/AgentSpine/Core/TurnHelpers.swift");
  const main = `import Foundation
${levels.map(([, db]) => `print(MicLevel.normalized(decibels: ${db}))`).join("\n")}
${pushes.map(([, start]) => `print(MicLevel.push(0.4, onto: ${start} as [Float], count: 3).map { String(format: "%g", $0) }.joined(separator: ","))`).join("\n")}
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mic-level-"));
  try {
    fs.writeFileSync(path.join(dir, "main.swift"), main);
    const bin = path.join(dir, "run");
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(dir, "mc"), source, path.join(dir, "main.swift"), "-o", bin], {
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(dir, "mc") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = execFileSync(bin, { encoding: "utf8" }).split("\n");
    levels.forEach(([name, , , want], i) => check(name, near(Number(lines[i]), want), `want ${want}, got ${lines[i]}`));
    pushes.forEach(([name, , , want], i) => {
      const got = lines[levels.length + i];
      check(name, got === want, `want ${want}, got ${got}`);
    });
  } catch (error) {
    failed++;
    console.log(`  FAIL  could not compile or run TurnHelpers.swift\n${error.stderr?.toString() ?? error}`);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
