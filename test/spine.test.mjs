/**
 * The spine (PLAN-open-work section 15, R1): Ahead's rules, the calendar copy the readers keep,
 * and the route's shape, which is Today plus Ahead. Names and events are invented.
 *
 * Run with `node test/spine.test.mjs`.
 */
import "./helpers/example-policy.mjs";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spine-line-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const cache = await import("../src/calendar-cache.ts");
const { assembleAhead, readSpine, SPINE_AHEAD_MAX } = await import("../src/day-line.ts");
const { readToday } = await import("../src/today.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// Local times, so midnight is this machine's midnight, as it is for the server.
const NOW = new Date(2026, 10, 26, 9, 30);
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 10, 26 + dayOffset, h, m).toISOString();
const sched = (id, next, extra = {}) => ({ enabled: 1, id, name: `Job ${id}`, next_run: next, spec: "weekdays at 8am", task: "t", ...extra });

console.log("\nAHEAD'S RULES");
const ahead = assembleAhead(
  {
    events: [
      { allDay: false, calendar: "Work", start: at(8), title: "Already started" },
      { allDay: false, calendar: "Work", start: at(10), title: "1:1 with Lee Okafor" },
      { allDay: true, calendar: "Family", start: "2026-11-26", title: "Ada's birthday" },
      { allDay: false, calendar: "", start: at(15), title: "Staff   meeting\n  (weekly)" },
    ],
    schedules: [
      sched(1, at(13)),
      sched(2, at(7)),
      sched(3, at(8, 0, 1)),
      sched(4, at(17, 30), { enabled: 0 }),
      sched(5, null),
      sched(6, at(11, 30), { name: "", task: "Summarise the inbox" }),
    ],
  },
  NOW,
);
check("all-day first, then by time", ahead.map((a) => a.title), ["Ada's birthday", "1:1 with Lee Okafor", "Summarise the inbox", "Job 1", "Staff meeting (weekly)"]);
check("a schedule past, tomorrow, disabled or unset is left out", ahead.filter((a) => a.kind === "schedule").map((a) => a.scheduleId), [6, 1]);
check("an event that already started is left out", ahead.some((a) => a.title === "Already started"), false);
check("event titles are marked untrusted, schedule names are not", ahead.map((a) => a.untrusted), [true, true, false, false, true]);
check("a schedule row carries its spec and its id", [ahead[3].detail, ahead[3].scheduleId], ["weekdays at 8am", 1]);
const many = assembleAhead({ events: Array.from({ length: 50 }, (_, i) => ({ allDay: false, calendar: "", start: at(10, i), title: `E${i}` })), schedules: [] }, NOW);
check("cut at the most rows", many.length, SPINE_AHEAD_MAX);

console.log("\nTHE CALENDAR COPY");
const from = new Date(2026, 10, 26);
const to = new Date(2026, 10, 28);
const ev = (key, start, title, allDay = false) => ({ allDay, calendar: "Work", key, start, title });
cache.storeCalendar("headsup", [ev("a", at(10), "1:1 with Lee Okafor"), ev("b", at(14), "Design review"), ev("c", "2026-11-26", "Ada's birthday", true)], from, to, NOW);
check("today's events, all-day first", cache.eventsOnDay(NOW).map((e) => e.title), ["Ada's birthday", "1:1 with Lee Okafor", "Design review"]);
cache.storeCalendar("headsup", [ev("a", at(10), "1:1 with Lee Okafor")], from, to, NOW);
check("a re-read drops what was cancelled or moved", cache.eventsOnDay(NOW).map((e) => e.title), ["1:1 with Lee Okafor"]);
cache.storeCalendar("checkin", [ev(`${at(10)}|1:1 with Lee Okafor`, at(10), "1:1 with Lee Okafor"), ev("x", at(16), "Late add")], NOW, new Date(NOW.getTime() + 8 * 3_600_000), NOW);
check("both readers' copies merge, the same event once", cache.eventsOnDay(NOW).map((e) => e.title), ["1:1 with Lee Okafor", "Late add"]);
cache.storeCalendar("checkin", [], NOW, new Date(NOW.getTime() + 8 * 3_600_000), NOW);
check("one reader never erases the other's rows", cache.eventsOnDay(NOW).map((e) => e.title), ["1:1 with Lee Okafor"]);
cache.storeCalendar("headsup", [ev("t", at(9, 0, 1), "Tomorrow's thing")], from, to, NOW);
check("tomorrow's events are not today's", cache.eventsOnDay(NOW).map((e) => e.title), []);
cache.storeCalendar("headsup", [ev("long", at(11), "x".repeat(500))], from, to, NOW);
check("a title is kept to 200 characters", cache.eventsOnDay(NOW)[0].title.length, 200);
check("when it was last stored", cache.calendarAsOf(), NOW.toISOString());
let threw = false;
const oldPrepare = store.rawDb.prepare.bind(store.rawDb);
store.rawDb.prepare = () => {
  throw new Error("disk full");
};
try {
  cache.keepCalendar("headsup", [], from, to, NOW);
} catch {
  threw = true;
}
store.rawDb.prepare = oldPrepare;
check("a failed write never fails the reader that called it", threw, false);

console.log("\nTHE ROUTE'S SHAPE");
cache.storeCalendar("headsup", [ev("a", at(23, 50), "Late call")], from, to, NOW);
const spine = readSpine(new Date(2026, 10, 26, 23, 0));
const today = readToday(new Date(2026, 10, 26, 23, 0));
check("it is Today, field for field, plus Ahead", Object.keys(spine).sort(), [...Object.keys(today), "ahead", "calendarAsOf"].sort());
check("the count is Today's count", spine.count, today.count);
check("Ahead reads the stored copy", spine.ahead.map((a) => a.title), ["Late call"]);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
