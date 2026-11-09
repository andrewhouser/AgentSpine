/**
 * The vision tier has no substitute — in `resolveTier`, and now also in the router's
 * fallback. Run with `node test/router-vision.test.mjs`.
 *
 * No server is started here. Both endpoints point at a closed port, which is a connect
 * failure rather than a bind — so unlike test/router-retry.test.mjs this runs anywhere,
 * including in a sandbox that refuses to let a process listen.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-rv-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
// Port 9 is the discard port and nothing listens on it, so every attempt fails to connect.
process.env.LOCAL_LLM_URL = "http://127.0.0.1:9/v1";
process.env.VISION_LLM_URL = "http://127.0.0.1:9/v2";
process.env.OPENAI_API_KEY = "";
// One attempt per tier: this file is about which tiers are TRIED, not about backoff.
process.env.LLM_RETRIES = "0";

const { fallbacksFor, route } = await import("../src/router.ts");
const { resolveTier } = await import("../src/tiers.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(60)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nthe fallback rule\n");
check("vision has no substitute", fallbacksFor("vision", "normal"), []);
check("not even for a private request", fallbacksFor("vision", "private"), []);
check("standard still falls back to deep", fallbacksFor("standard", "normal"), ["standard", "deep"]);
check("a private request never reaches deep", fallbacksFor("standard", "private"), ["standard"]);
check("fast falls back the same way", fallbacksFor("fast", "normal"), ["standard", "deep"]);
check("deep falls back to local", fallbacksFor("deep", "normal"), ["standard", "deep"]);

console.log("\nresolveTier already refused to resolve AWAY from vision — unchanged\n");
check("vision stays vision", resolveTier("vision", "normal").tier, "vision");
check("even when marked private", resolveTier("vision", "private").tier, "vision");
check("private still pins deep to local", resolveTier("deep", "private").tier, "standard");

console.log("\nand the router now behaves that way end to end\n");

// Every warning the router emits, so the assertion is about what it TRIED, not only about
// what it returned. Before this fix the log read "falling back to standard" and the image
// was posted to a server that cannot read one.
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));

let visionErr;
try {
  await route([{ content: "describe this", role: "user" }], { sensitivity: "private", tier: "vision" });
} catch (err) {
  visionErr = err;
}

let standardErr;
try {
  await route([{ content: "hello", role: "user" }], { tier: "standard" });
} catch (err) {
  standardErr = err;
}
console.warn = realWarn;

check("the vision call failed", !!visionErr, true);
check("it never fell back to standard", warnings.some((w) => /vision failed.*falling back/.test(w)), false);
check("the error says no other tier can read an image", /no other tier can read an image/.test(visionErr?.message ?? ""), true);
check("and it names the vision tier", /vision:/.test(visionErr?.message ?? ""), true);
// The old message claimed every tier had been tried, which was never true for vision.
check('it no longer claims "every model tier failed"', /every model tier failed/.test(visionErr?.message ?? ""), false);

// The wording for every other tier is deliberately untouched: test/router-retry.test.mjs
// asserts that exact phrase, and this is the check that keeps the two files honest.
check("a standard-tier failure still says every model tier failed", /every model tier failed/.test(standardErr?.message ?? ""), true);

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
