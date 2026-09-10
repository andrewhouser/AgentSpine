/**
 * The denial learner (LEARNING Phase 1.1).
 *
 * All SQL, no inference, so the assertions are exact: a (tool, target) shape denied N times
 * shows up in standing context with its count and cleaned reason, and only crosses into the
 * digest's "worth deciding" proposals once it has been denied often enough to be a pattern
 * rather than a one-off.
 *
 * Run with `node test/learn-denials.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-denials-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
// Pin the thresholds the assertions below assume, so a change to the defaults can't
// silently invalidate the test.
process.env.DENIAL_PROMPT_MAX = "5";
process.env.DENIAL_PROPOSE_MIN = "3";

const store = await import("../src/memory/store.ts");
const { deniedContext, deniedProposals } = await import("../src/learn/denials.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(52)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const deny = (tool, target, reason, n = 1) => {
  const ins = rawDb.prepare(
    "INSERT INTO actions (ts, run_id, tool, args, target, reversibility, decision, output) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < n; i++) ins.run(new Date().toISOString(), null, tool, "{}", target, "reversible", "denied", `DENIED: ${reason}`);
};

console.log("\nEMPTY — a clean ledger injects nothing");
check("no denials, no context", deniedContext(), "");
check("no denials, no proposals", deniedProposals(), []);

console.log("\nGROUPING — shapes counted, ordered by attempts");
deny("mac_control", "com.apple.Notes", "com.apple.Notes not in apps allowlist", 4);
deny("web_read", "example.com", "example.com not in web allowlist", 2);
{
  const shapes = store.deniedShapes(1, 10);
  check("two shapes", shapes.length, 2);
  check("most-attempted first", [shapes[0].tool, shapes[0].n], ["mac_control", 4]);
}

console.log("\nCONTEXT — trusted block, count and cleaned reason");
{
  const ctx = deniedContext();
  check("names the tool+target", ctx.includes("mac_control on com.apple.Notes"), true);
  check("shows the count", ctx.includes("(4×)"), true);
  check("strips the DENIED: prefix", ctx.includes("com.apple.Notes not in apps allowlist"), true);
  check("does not leak the raw prefix", ctx.includes("DENIED:"), false);
}

console.log("\nPROPOSALS — only shapes past the threshold (3)");
{
  const props = deniedProposals();
  check("one shape qualifies (4 ≥ 3)", props.length, 1);
  check("it is the notes shape", props[0].shape, "mac_control on com.apple.Notes");
  check("the 2× shape is not proposed", props.some((p) => p.shape.includes("example.com")), false);
}

console.log("\nCAP — context is bounded by DENIAL_PROMPT_MAX");
{
  for (let i = 0; i < 8; i++) deny(`tool_${i}`, `t_${i}`, "nope", 1);
  const lines = deniedContext().split("\n").filter((l) => l.startsWith("- "));
  check("at most DENIAL_PROMPT_MAX lines", lines.length <= 5, true);
}

console.log("\nNULL TARGET — a call with no target still groups");
{
  deny("notify", null, "some reason", 3);
  const props = deniedProposals();
  check("bare-tool shape appears", props.some((p) => p.shape === "notify"), true);
}

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
