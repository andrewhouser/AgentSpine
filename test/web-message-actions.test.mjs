/**
 * The two rules behind the web chat's message row and quieter tool calls.
 *
 * `recoveredCalls` decides when a failed tool call stops being an alarm; `relativeTime` is the
 * timestamp under your message. Both are pure and live in web/src/lib, so they can be checked
 * here without a browser.
 *
 * What matters about the recovery rule is what it REFUSES to soften: a denial is never
 * recovered, a failure with nothing after it is never recovered, and a turn that itself failed
 * keeps every error as it was. A rule that quietly greyed out real failures would be worse than
 * the red node it replaced.
 *
 * Run with `node test/web-message-actions.test.mjs`.
 */
import { recoveredCalls } from "../web/src/lib/recovery.ts";
import { relativeTime } from "../web/src/lib/relativeTime.ts";

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const calls = (...statuses) => statuses.map((status) => ({ status }));

console.log("\nRECOVERED — a failure the turn went on to get past");
check("the screenshot's case: error, then two that ran", recoveredCalls(calls("error", "executed", "executed")), [true, false, false]);
check("an error followed by a later call that ran is recovered", recoveredCalls(calls("error", "executed")), [true, false]);
check("the later call need not be the next one", recoveredCalls(calls("error", "denied", "executed")), [true, false, false]);

console.log("\nWHAT IT REFUSES TO SOFTEN");
check("an error with nothing after it is not recovered", recoveredCalls(calls("executed", "error")), [false, false]);
check("a denial is never recovered, even with a success after it", recoveredCalls(calls("denied", "executed")), [false, false]);
check("an error followed only by a denial is not recovered", recoveredCalls(calls("error", "denied")), [false, false]);
check("a queued call is not a recovery", recoveredCalls(calls("error", "queued")), [false, false]);
check("nor is one still running (no status yet)", recoveredCalls(calls("error", null)), [false, false]);
check("a dry run is not a recovery", recoveredCalls(calls("error", "dry-run")), [false, false]);
check("a turn that failed keeps every error", recoveredCalls(calls("error", "executed"), true), [false, false]);

console.log("\nSEVERAL FAILURES — each is judged by what came after it");
check("two errors then a success: both recovered", recoveredCalls(calls("error", "error", "executed")), [true, true, false]);
check("a success between them does not save the later one", recoveredCalls(calls("error", "executed", "error")), [true, false, false]);
check("no calls, no flags", recoveredCalls([]), []);
check("one flag per call, in order", recoveredCalls(calls("executed", "error", "executed")).length, 3);

console.log("\nTHE TIMESTAMP");
const NOW = new Date(2026, 10, 19, 15, 0, 0).getTime(); // 19 Nov 2026, 3pm local
const at = (...parts) => new Date(...parts).toISOString();
check("seconds ago is just now", relativeTime(new Date(NOW - 5_000).toISOString(), NOW), "Just now");
check("a time slightly in the future is just now, not negative", relativeTime(new Date(NOW + 30_000).toISOString(), NOW), "Just now");
check("minutes ago", relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW), "5 min ago");
check("59 minutes is still minutes", relativeTime(new Date(NOW - 59 * 60_000).toISOString(), NOW), "59 min ago");
const earlierToday = relativeTime(at(2026, 10, 19, 10, 0), NOW);
check("earlier today is a clock time, not 'ago'", /ago|Yesterday|Just now/.test(earlierToday), false);
check("yesterday says so", relativeTime(at(2026, 10, 18, 9, 0), NOW).startsWith("Yesterday, "), true);
const older = relativeTime(at(2026, 9, 2, 9, 0), NOW);
check("older this year is a date, with no year", /2026/.test(older) || /ago|Yesterday/.test(older), false);
check("a previous year includes the year", relativeTime(at(2025, 9, 2, 9, 0), NOW).includes("2025"), true);
check("garbage is an empty string, not 'Invalid Date'", relativeTime("not a date", NOW), "");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
