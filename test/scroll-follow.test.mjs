/**
 * When the web chat follows new content, and when it leaves a reader where they are.
 *
 * Run with `node test/scroll-follow.test.mjs`.
 */
import { keepsFollowing } from "../web/src/lib/scroll-follow.ts";

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(60)} ${ok ? "" : JSON.stringify(actual)}`);
};

console.log("Following");
check("scrolling up lets go", keepsFollowing(true, { distanceFromBottom: 500, previousTop: 900, top: 600 }), false);
check("a smooth scroll down keeps following", keepsFollowing(true, { distanceFromBottom: 900, previousTop: 100, top: 300 }), true);
check("a small move near the end keeps following", keepsFollowing(true, { distanceFromBottom: 40, previousTop: 900, top: 880 }), true);

console.log("Let go");
check("reading further up stays let go", keepsFollowing(false, { distanceFromBottom: 700, previousTop: 300, top: 400 }), false);
check("coming back to the end follows again", keepsFollowing(false, { distanceFromBottom: 20, previousTop: 800, top: 1000 }), true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
