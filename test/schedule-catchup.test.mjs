/**
 * The catch-up window (src/schedule-catchup.ts, PLAN-open-work section 13 H6): no framework,
 * matching test/schedule-spec.test.mjs.
 *
 * What these guard: a slot the server slept through is skipped only when it is more than half
 * the job's period late, with the grace clamped to 2 minutes .. 2 hours; the boundaries are
 * inclusive on the "still runs" side; a one-shot and a job with no period are never skipped by
 * the default rule; and a skip always says when the job comes back.
 *
 * Every date is fixed and local. Nothing here reads the clock.
 *
 * Run with: node test/schedule-catchup.test.mjs
 */
import { CATCHUP_MAX_MS, CATCHUP_MIN_MS, decideCatchup, defaultGraceMs, periodMs } from "../src/schedule-catchup.ts";

let passed = 0;
let failed = 0;
const check = (label, cond, detail = "") => {
  cond ? passed++ : failed++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (${detail})`}`);
};

const MIN = 60_000;
const HOUR = 60 * MIN;
// Wednesday 2026-07-15, well clear of a DST change.
const at = (h, m = 0, day = 15) => new Date(2026, 6, day, h, m, 0, 0);
const plus = (d, ms) => new Date(d.getTime() + ms);
const decide = (spec, slot, now, extra = {}) => decideCatchup({ intervalMinutes: 0, now, slot, spec, ...extra });

console.log("\nTHE NUMBERS");
check("the floor is 2 minutes", CATCHUP_MIN_MS === 2 * MIN);
check("the ceiling is 2 hours", CATCHUP_MAX_MS === 2 * HOUR);
check("half of 30 minutes is 15", defaultGraceMs(30 * MIN) === 15 * MIN);
check("half of 2 minutes clamps up to 2", defaultGraceMs(2 * MIN) === 2 * MIN);
check("half of 4 minutes is exactly the floor", defaultGraceMs(4 * MIN) === 2 * MIN);
check("half of 4 hours is exactly the ceiling", defaultGraceMs(4 * HOUR) === 2 * HOUR);
check("half of a day clamps down to 2 hours", defaultGraceMs(24 * HOUR) === 2 * HOUR);

console.log("\nTHE PERIOD, MEASURED AT THE MISSED SLOT");
check("an interval is its own period", periodMs("every 30 minutes", 0, at(8)) === 30 * MIN);
check("daily at 8am is 24 hours", periodMs("daily at 8:00am", 0, at(8)) === 24 * HOUR);
check("8am then 2pm is 6 hours after the morning slot", periodMs("daily at 8:00am, 2:00pm", 0, at(8)) === 6 * HOUR);
check("and 18 hours after the afternoon one", periodMs("daily at 8:00am, 2:00pm", 0, at(14)) === 18 * HOUR);
check("weekdays: Friday's slot is 72 hours from Monday's", periodMs("weekdays at 8:00am", 0, at(8, 0, 17)) === 72 * HOUR);
check("a one-shot has none", periodMs("once at 2026-07-15 15:00", 0, at(15)) === null);
check("no spec falls back to the legacy interval", periodMs(null, 45, at(8)) === 45 * MIN);
check("no spec and no interval has none", periodMs(null, 0, at(8)) === null);
check("an unparseable spec with no interval has none", periodMs("whenever", 0, at(8)) === null);

console.log("\nAN INTERVAL JOB");
{
  const slot = at(8);
  const spec = "every 30 minutes";
  check("on time runs", !decide(spec, slot, slot).skip);
  check("one tick late runs", !decide(spec, slot, plus(slot, MIN)).skip);
  check("exactly half the period late still runs", !decide(spec, slot, plus(slot, 15 * MIN)).skip);
  const late = decide(spec, slot, plus(slot, 15 * MIN + 1));
  check("a millisecond past half the period is skipped", late.skip);
  check("its grace is 15 minutes", late.graceMs === 15 * MIN, String(late.graceMs));
  check("the skip keeps the job's own grid", late.next?.getTime() === at(8, 30).getTime(), String(late.next));
  const asleep = decide(spec, slot, plus(slot, 3 * HOUR + 10 * MIN));
  check("three hours asleep: armed for the next grid slot after now", asleep.next?.getTime() === at(11, 30).getTime(), String(asleep.next));
  const onGrid = decide(spec, slot, plus(slot, 3 * HOUR));
  check("waking exactly on a grid slot arms the one after it", onGrid.next?.getTime() === at(11, 30).getTime(), String(onGrid.next));
  check("the reason names how late and the limit", /3\.2 hours late/.test(asleep.reason) && /15 minutes/.test(asleep.reason), asleep.reason);
}

console.log("\nTHE 2-MINUTE FLOOR");
{
  const slot = at(8);
  const spec = "every 2 minutes"; // half is 1 minute, which one slow tick would exceed
  check("90 seconds late runs", !decide(spec, slot, plus(slot, 90_000)).skip);
  check("exactly 2 minutes late runs", !decide(spec, slot, plus(slot, 2 * MIN)).skip);
  check("just past 2 minutes is skipped", decide(spec, slot, plus(slot, 2 * MIN + 1)).skip);
}

console.log("\nTHE 2-HOUR CEILING");
{
  const slot = at(7);
  const spec = "daily at 7:00am"; // half is 12 hours
  check("exactly 2 hours late runs", !decide(spec, slot, plus(slot, 2 * HOUR)).skip);
  const noon = decide(spec, slot, at(12));
  check("a 7am brief at noon is skipped", noon.skip);
  check("and armed for tomorrow at 7", noon.next?.getTime() === at(7, 0, 16).getTime(), String(noon.next));
  check("the reason reads in hours", /5 hours late/.test(noon.reason) && /2 hours/.test(noon.reason), noon.reason);
}

console.log("\nSEVERAL TIMES A DAY");
{
  const spec = "daily at 8:00am, 11:00am";
  const slot = at(8); // 3 hours to the next slot, so the grace is 90 minutes
  check("90 minutes late runs", !decide(spec, slot, at(9, 30)).skip);
  const skipped = decide(spec, slot, at(9, 31));
  check("91 minutes late is skipped", skipped.skip);
  check("and the 11am slot is next", skipped.next?.getTime() === at(11).getTime(), String(skipped.next));
}

console.log("\nA ONE-SHOT IS NEVER SKIPPED BY THE DEFAULT RULE");
{
  const spec = "once at 2026-07-15 15:00";
  const slot = at(15);
  const d = decide(spec, slot, at(23));
  check("eight hours late still runs", !d.skip);
  check("it has no grace to exceed", d.graceMs === null);
}

console.log("\nNOTHING TO MEASURE AGAINST");
check("no spec and no interval runs however late", !decideCatchup({ intervalMinutes: 0, now: at(20), slot: at(8), spec: null }).skip);
check("an unparseable spec runs however late", !decide("whenever", at(8), at(20)).skip);
check("a job that was never armed runs", !decide("every 30 minutes", null, at(8)).skip);
check("an unreadable slot runs", !decide("every 30 minutes", new Date("nonsense"), at(8)).skip);
check("a slot in the future is not late", decide("every 30 minutes", at(9), at(8)).lateMs === 0);
{
  const legacy = decideCatchup({ intervalMinutes: 60, now: at(10), slot: at(8), spec: null });
  check("the legacy interval is a period like any other", legacy.skip && legacy.next?.getTime() === at(11).getTime(), String(legacy.next));
}

console.log("\nA JOB'S OWN LIMIT");
{
  const spec = "daily at 7:00am";
  const slot = at(7);
  check("0 means always run", !decide(spec, slot, at(19), { overrideMinutes: 0 }).skip);
  check("null follows the default", decide(spec, slot, at(12), { overrideMinutes: null }).skip);
  check("a wider limit lets a late run through", !decide(spec, slot, at(12), { overrideMinutes: 360 }).skip);
  check("exactly at the limit runs", !decide(spec, slot, at(13), { overrideMinutes: 360 }).skip);
  const past = decide(spec, slot, at(13, 1), { overrideMinutes: 360 });
  check("past it is skipped", past.skip);
  check("and the reason says the limit is the job's own", /this job's own limit of 6 hours/.test(past.reason), past.reason);
  check("a narrower limit skips sooner than the default", decide(spec, slot, at(7, 31), { overrideMinutes: 30 }).skip);
  check("a limit under the floor is raised to it", !decide(spec, slot, at(7, 2), { overrideMinutes: 1 }).skip);
  check("a negative limit is ignored", decide(spec, slot, at(12), { overrideMinutes: -5 }).graceMs === 2 * HOUR);
  check("a limit that is not a number is ignored", decide(spec, slot, at(12), { overrideMinutes: Number.NaN }).graceMs === 2 * HOUR);
}
{
  const spec = "once at 2026-07-15 15:00";
  const d = decide(spec, at(15), at(17), { overrideMinutes: 60 });
  check("a one-shot with its own limit can be skipped", d.skip);
  check("with nothing to arm, so it retires", d.next === null);
  check("and says so", /one-off/.test(d.reason), d.reason);
  check("inside its limit it runs", !decide(spec, at(15), at(15, 59), { overrideMinutes: 60 }).skip);
}
{
  // No period and no later slot: a skip could not say when the job comes back, so it runs.
  const d = decideCatchup({ intervalMinutes: 0, now: at(20), overrideMinutes: 30, slot: at(8), spec: null });
  check("an override never ends a recurring job with nowhere to go", !d.skip);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
