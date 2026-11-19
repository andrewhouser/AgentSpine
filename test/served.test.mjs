/**
 * What actually answered a run, as opposed to the tier it asked for. Run with
 * `node test/served.test.mjs`. A thread pinned to Cloud that quietly ran local has to be
 * visible, and "did this leave the machine" must not depend on which call came last.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-served-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;

const store = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const served = (id) => {
  const raw = store.getRun(id)?.served;
  return raw ? JSON.parse(raw) : null;
};

console.log("A run that never reached the router");
const quiet = store.startRun({});
check("has no served record", served(quiet), null);

console.log("\nA local run");
const local = store.startRun({});
store.noteServed(local, { model: "qwen-local", tier: "standard", via: "local" });
const rec = served(local);
check("records the model, tier and route", [rec.model, rec.tier, rec.via, rec.cloud], ["qwen-local", "standard", "local", false]);

console.log("\nA run that asked for Cloud and got Local");
const fell = store.startRun({});
store.setRunTier(fell, "deep");
store.noteServed(fell, { model: "qwen-local", tier: "standard", via: "local" });
check("the asked-for tier is still deep", store.getRun(fell).tier, "deep");
check("what served it is standard, and never the cloud", served(fell).cloud, false);

console.log("\nCloud once is cloud for the run");
const mixed = store.startRun({});
store.noteServed(mixed, { model: "gpt-4o", tier: "deep", via: "cloud" });
store.noteServed(mixed, { model: "qwen-local", tier: "standard", via: "local" });
check("the latest call is local", served(mixed).via, "local");
check("but the run still left the machine", served(mixed).cloud, true);

console.log("\nA run that does not exist");
let threw = false;
try {
  store.noteServed(999999, { model: "x", tier: "standard", via: "local" });
} catch {
  threw = true;
}
check("is ignored rather than thrown", threw, false);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
