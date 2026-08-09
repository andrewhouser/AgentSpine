/**
 * The schedule grammar, with one-shots added.
 *
 * Three things are being defended here, and only the first is about parsing:
 *
 *   1. Every recurring spec that worked before still means exactly what it meant. The
 *      one-shot forms are all explicitly marked (`in`, `once`, `today`, `tomorrow`, `next`,
 *      or a date) so that "tue at 9am" cannot drift from "every Tuesday" to "this Tuesday".
 *      A grammar where those two are spelled alike turns "remind me Tuesday" into a coin
 *      flip between one reminder and a permanent one.
 *
 *   2. A relative one-shot is resolved ONCE, at creation. "in 30 minutes" is a sentence
 *      about the moment it was said; stored verbatim it would re-read as a different time on
 *      every glance and never actually arrive.
 *
 *   3. A one-shot whose moment has passed has NO next run. `nextRun` returning null is what
 *      the store keys on to retire the job rather than re-arm it, so this is the assertion
 *      standing between "remind me once at 3pm" and an hourly reminder forever.
 *
 * Everything resolves against an injected `from`, so the suite doesn't depend on what day
 * it is run. Run with `node test/schedule-spec.test.mjs`.
 */
const { canonicalSpec, isOneShot, nextRun, parseSpec } = await import("../src/schedule-spec.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(50)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

// Saturday 8 August 2026, 14:30 local.
const from = new Date(2026, 7, 8, 14, 30, 0, 0);
const fires = (spec) => {
  const d = nextRun(spec, from);
  return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : null;
};

console.log("\nschedule grammar\n");

console.log("REGRESSION — every recurring form still parses to what it always did");
check("interval", parseSpec("every 30 minutes", from).kind, "interval");
check("interval hours", parseSpec("every 2 hours", from).minutes, 120);
check("every day", parseSpec("every day", from).minutes, 1440);
check("weekdays at a time", parseSpec("weekdays at 8:00am", from).kind, "at");
check("bare 'at 9am' is still daily", parseSpec("at 9am", from).kind, "at");
check("'tue at 9am' is still EVERY tuesday", parseSpec("tue at 9am", from).kind, "at");
check("  and fires on the next tuesday", fires("tue at 9am"), "2026-08-11 09:00");
check("day lists", parseSpec("mon,wed,fri at 6pm", from).kind, "at");
check("day ranges + multiple times", parseSpec("tue-thu at 17:00, 21:00", from).kind, "at");
check("weekends", parseSpec("weekends at 10am", from).kind, "at");
check("garbage is still garbage", parseSpec("0 12 * * *", from), null);
check("no recurring form is mistaken for a one-shot", ["every day", "weekdays at 8:00am", "at 9am", "tue at 9am", "mon,wed,fri at 6pm"].some((s) => isOneShot(s, from)), false);

console.log("\nONE-SHOTS — relative to Sat 8 Aug 2026, 14:30");
check("in 30 minutes", fires("in 30 minutes"), "2026-08-08 15:00");
check("in 2 hours", fires("in 2 hours"), "2026-08-08 16:30");
check("in 3 days", fires("in 3 days"), "2026-08-11 14:30");
check("in 1 week", fires("in 1 week"), "2026-08-15 14:30");
check("today at 5pm", fires("today at 5pm"), "2026-08-08 17:00");
check("tomorrow at 9am", fires("tomorrow at 9am"), "2026-08-09 09:00");
check("tomorrow 09:15", fires("tomorrow 09:15"), "2026-08-09 09:15");
check("next tuesday at 9am", fires("next tuesday at 9am"), "2026-08-11 09:00");
check("'next saturday' skips today", fires("next saturday at 10am"), "2026-08-15 10:00");
check("iso date", fires("2026-08-15 at 14:00"), "2026-08-15 14:00");
check("iso date with 'on'", fires("on 2026-12-25 at 07:30"), "2026-12-25 07:30");
check("month name", fires("aug 15 at 9am"), "2026-08-15 09:00");
check("month name, long + ordinal", fires("on August 15th at 9am"), "2026-08-15 09:00");
check("a month already gone rolls to next year", fires("jan 3 at 9am"), "2027-01-03 09:00");
check("once at <time> is today", fires("once at 6pm"), "2026-08-08 18:00");
check("all of the above are one-shots", ["in 30 minutes", "tomorrow at 9am", "next tuesday at 9am", "2026-08-15 at 14:00", "aug 15 at 9am", "once at 6pm"].every((s) => isOneShot(s, from)), true);

console.log("\nA PAST ONE-SHOT HAS NO NEXT RUN — what stops it re-arming forever");
check("earlier today", fires("today at 9am"), null);
check("a date gone by", fires("2020-01-01 at 09:00"), null);
check("but it is still recognisably a one-shot", isOneShot("today at 9am", from), true);
check("while a recurring spec always has a next", fires("every 30 minutes") !== null, true);

console.log("\nCANONICAL FORM — a one-shot is resolved once, at creation");
check("relative becomes absolute", canonicalSpec("in 30 minutes", from), "once at 2026-08-08 15:00");
check("tomorrow becomes absolute", canonicalSpec("tomorrow at 9am", from), "once at 2026-08-09 09:00");
check("next tuesday becomes absolute", canonicalSpec("next tuesday at 9am", from), "once at 2026-08-11 09:00");
check("recurring specs are left alone", canonicalSpec("weekdays at 8:00am", from), "weekdays at 8:00am");
check("unparseable canonicalises to null", canonicalSpec("0 12 * * *", from), null);

// The round trip is the property that matters: the stored text is re-parsed by the
// scheduler on every tick, so a canonical form that didn't parse back to itself would move
// the job every time anyone looked at it.
const canon = canonicalSpec("in 30 minutes", from);
check("canonical form parses back to itself", canonicalSpec(canon, from), canon);
check("  and to the same instant, read much later", fires(canon), "2026-08-08 15:00");
check("  read from a LATER 'now', it has passed", nextRun(canon, new Date(2026, 7, 8, 16, 0)), null);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
