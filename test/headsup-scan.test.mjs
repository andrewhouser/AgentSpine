/**
 * Heads-up, the pure half: classification, the PAID filter, calendar scope, the scanner and the
 * planner. Run with `node test/headsup-scan.test.mjs`.
 *
 * No database, no network, no model. The cases that matter are the silent ones: a bill that is
 * marked PAID but still nags, a date-only birthday that lands a day early, a weekly event that
 * is offered every week, a daily cap that quietly drops things instead of rolling them forward.
 */
const rules = await import("../src/headsup/rules.ts");
const { isExcludedCalendar } = await import("../src/headsup/calendars.ts");
const { scanEvents, daysBetween, localDate, subjectKey } = await import("../src/headsup/scan.ts");
const { planOffers } = await import("../src/headsup/plan.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

// Wednesday 2026-11-18, 7:30am local (the morning heads-up).
const now = new Date(2026, 10, 18, 7, 30, 0, 0);
const dayOffset = (n) => {
  const d = new Date(2026, 10, 18 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let nextId = 0;
const ev = (over = {}) => ({
  allDay: true,
  calendarId: "primary",
  calendarName: "Me",
  description: "",
  eventType: "default",
  id: `e${++nextId}`,
  location: "",
  recurringEventId: "",
  start: dayOffset(5),
  status: "confirmed",
  title: "Something",
  ...over,
});
const none = { exclude: [], include: [] };

console.log("\nclassifying an event\n");
const cls = (title, over = {}) => rules.classify({ description: "", eventType: "default", recurringEventId: "", title, ...over });
check("birthday by word", cls("Garrett's Birthday"), "birthday");
check("birthday by Google event type", cls("Garrett", { eventType: "birthday" }), "birthday");
check("anniversary", cls("Our anniversary"), "anniversary");
check("flight", cls("Flight to Denver UA 482"), "flight");
check("bill by 'due'", cls("Electric bill due"), "bill");
check("bill by rent", cls("Rent"), "bill");
check("appointment", cls("Dentist 3pm"), "appointment");
check("an ordinary meeting is nothing", cls("Team standup"), null);
check("an ordinary recurring event is a series", cls("Pottery class", { recurringEventId: "abc" }), "recurring");
check("first match wins: birthday dinner is a birthday", cls("Birthday dinner reservation"), "birthday");
check("a word inside a word does not match (rental)", cls("Rental car pickup"), null);

console.log("\nthe PAID filter\n");
check("PAID in the title drops a bill", cls("Electric bill PAID"), null);
check("lowercase paid also drops it", cls("water bill (paid)"), null);
check("PAID in the description drops it", cls("Electric bill", { description: "Paid 11/3 by autopay" }), null);
check("'unpaid' is not PAID", cls("Unpaid invoice"), "bill");
check("'prepaid' is not PAID", cls("Prepaid rent due"), "bill");
check("PAID also drops a non-bill (it is a general ignore)", cls("Birthday PAID dinner"), null);
check("isPaid on a clean title", rules.isPaid({ description: "", title: "Electric bill" }), false);

console.log("\nfinding an amount\n");
check("from the title", rules.findAmount({ description: "", title: "Electric bill $140" }), "$140");
check("with thousands and cents", rules.findAmount({ description: "", title: "Rent $1,250.00 due" }), "$1,250.00");
check("falls back to the description", rules.findAmount({ description: "Total: $62.10", title: "Water" }), "$62.10");
check("none", rules.findAmount({ description: "", title: "Water bill" }), undefined);

console.log("\ncalendar scope\n");
const cal = (id, name) => ({ id, name });
check("primary is read", isExcludedCalendar(cal("me@x.com", "Me"), none), false);
check("US holidays are excluded by id", isExcludedCalendar(cal("en.usa#holiday@group.v.calendar.google.com", "Holidays in United States"), none), true);
check("a holiday calendar by name", isExcludedCalendar(cal("abc123", "Family holidays"), none), true);
check("an NFL calendar is excluded", isExcludedCalendar(cal("x", "Patriots NFL"), none), true);
check("a soccer calendar is excluded", isExcludedCalendar(cal("x", "Kids Soccer"), none), true);
check("'Team standup' is NOT sports", isExcludedCalendar(cal("x", "Team standup"), none), false);
check("'Work schedule' is NOT sports", isExcludedCalendar(cal("x", "Work schedule"), none), false);
check("contact birthdays are always read", isExcludedCalendar(cal("addressbook#contacts@group.v.calendar.google.com", "Birthdays"), none), false);
check("include beats the sports heuristic", isExcludedCalendar(cal("x", "Kids Soccer"), { exclude: [], include: ["kids soccer"] }), false);
check("include beats an explicit exclude", isExcludedCalendar(cal("x", "Kids Soccer"), { exclude: ["kids soccer"], include: ["kids soccer"] }), false);
check("explicit exclude by name, case-insensitive", isExcludedCalendar(cal("x", "Work Shifts"), { exclude: ["work shifts"], include: [] }), true);
check("explicit exclude by id", isExcludedCalendar(cal("abc@group", "Whatever"), { exclude: ["abc@group"], include: [] }), true);

console.log("\ndates\n");
check("a date-only string stays on its own day", localDate("2026-11-20", true), "2026-11-20");
check("today is 0 days away", daysBetween(now, "2026-11-18"), 0);
check("ten days ahead", daysBetween(now, "2026-11-28"), 10);
check("yesterday is -1", daysBetween(now, "2026-11-17"), -1);
check("across a DST change counts dates, not 24h blocks", daysBetween(new Date(2026, 10, 1, 0, 30), "2026-11-02"), 1);
check("across a year boundary", daysBetween(new Date(2026, 11, 30, 12), "2027-01-02"), 3);

console.log("\nscanning\n");
check("a birthday ten days out is a candidate", scanEvents([ev({ start: dayOffset(10), title: "Garrett's Birthday" })], now, none).map((c) => [c.kind, c.daysUntil]), [["birthday", 10]]);
check("past events are dropped", scanEvents([ev({ start: dayOffset(-1), title: "Birthday" })], now, none).length, 0);
check("beyond the look-ahead is dropped", scanEvents([ev({ start: dayOffset(rules.LOOKAHEAD_DAYS + 1), title: "Birthday" })], now, none).length, 0);
check("cancelled events are dropped", scanEvents([ev({ status: "cancelled", title: "Birthday" })], now, none).length, 0);
check("a PAID bill never becomes a candidate", scanEvents([ev({ title: "Electric bill PAID" })], now, none).length, 0);
check("an unpaid bill does", scanEvents([ev({ title: "Electric bill $140" })], now, none).map((c) => c.amount), ["$140"]);
check("events on a holiday calendar are dropped", scanEvents([ev({ calendarId: "en.usa#holiday@group.v.calendar.google.com", calendarName: "Holidays", title: "Anniversary of something" })], now, none).length, 0);
check("a flight is time-sensitive", scanEvents([ev({ title: "Flight to Denver" })], now, none)[0].timeSensitive, true);
check("a birthday is not", scanEvents([ev({ title: "Birthday" })], now, none)[0].timeSensitive, false);

const weekly = [
  ev({ id: "w1", recurringEventId: "series1", start: dayOffset(1), title: "Pottery class" }),
  ev({ id: "w2", recurringEventId: "series1", start: dayOffset(8), title: "Pottery class" }),
  ev({ id: "w3", recurringEventId: "series1", start: dayOffset(15), title: "Pottery class" }),
];
const series = scanEvents(weekly, now, none);
check("a weekly series is ONE candidate", series.length, 1);
check("... the soonest instance", series[0].daysUntil, 1);
check("... keyed by the series, not the instance", series[0].dedupeKey, "recurring:series1");
check("same series on a later scan keeps its key", scanEvents(weekly.slice(1), now, none)[0].dedupeKey, "recurring:series1");
check("a one-off keys by kind, id and date", scanEvents([ev({ id: "abc", start: dayOffset(3), title: "Rent" })], now, none)[0].dedupeKey, `bill:abc:${dayOffset(3)}`);
check("series fingerprint ignores the date", scanEvents(weekly, now, none)[0].fingerprint, scanEvents(weekly.slice(1), now, none)[0].fingerprint);
check("series fingerprint sees a moved time", scanEvents([ev({ allDay: false, recurringEventId: "s", start: "2026-11-19T18:00:00-05:00", title: "Pottery class" })], now, none)[0].fingerprint
  === scanEvents([ev({ allDay: false, recurringEventId: "s", start: "2026-11-26T19:00:00-05:00", title: "Pottery class" })], now, none)[0].fingerprint, false);
check("subject key ignores amounts", subjectKey("Electric $140") === subjectKey("Electric $152.30"), true);

console.log("\nquiet hours\n");
check("8pm is not quiet", rules.inQuietHours(new Date(2026, 10, 18, 20, 59)), false);
check("9pm is quiet", rules.inQuietHours(new Date(2026, 10, 18, 21, 0)), true);
check("3am is quiet", rules.inQuietHours(new Date(2026, 10, 18, 3, 0)), true);
check("5:59am is quiet", rules.inQuietHours(new Date(2026, 10, 18, 5, 59)), true);
check("6am is not", rules.inQuietHours(new Date(2026, 10, 18, 6, 0)), false);
check("a cancelled flight 2h out breaks through", rules.breaksQuietHours({ cancelled: true, hoursUntil: 2 }), true);
check("a 90 min delay 5h out breaks through", rules.breaksQuietHours({ delayMinutes: 90, hoursUntil: 5 }), true);
check("a 30 min delay does not", rules.breaksQuietHours({ delayMinutes: 30, hoursUntil: 2 }), false);
check("a cancellation 12h out does not", rules.breaksQuietHours({ cancelled: true, hoursUntil: 12 }), false);
check("a flight already gone does not", rules.breaksQuietHours({ cancelled: true, hoursUntil: -1 }), false);
check("the fast loop floor is 30 minutes", rules.FAST_LOOP_FLOOR_MINUTES >= 30, true);

console.log("\nplanning against the ledger\n");
const noLedger = { get: () => undefined, muted: () => false };
const cand = (kind, daysUntil, subject = `${kind} thing`, extra = {}) => ({
  daysUntil, dedupeKey: `${kind}:${subject}:${daysUntil}`, fingerprint: "", kind, location: "", sourceId: subject, startsAt: dayOffset(daysUntil), subject, timeSensitive: false, ...extra,
});
const stages = (plan) => plan.offers.map((o) => [o.candidate.kind, o.reason, o.stage]);

check("a birthday 11 days out is too early", stages(planOffers([cand("birthday", 11)], noLedger, now)), []);
check("10 days out: first mention (stage 0)", stages(planOffers([cand("birthday", 10)], noLedger, now)), [["birthday", "new", 0]]);
check("3 days out and never offered: still stage 0", stages(planOffers([cand("birthday", 3)], noLedger, now)), [["birthday", "new", 0]]);
check("1 day out and never offered: jumps to stage 1, no stale first mention", stages(planOffers([cand("birthday", 1)], noLedger, now)), [["birthday", "new", 1]]);
const row = (over) => ({ answer: null, dedupe_key: "k", fingerprint: "", id: 1, kind: "birthday", snooze_until: null, stage: 0, state: "offered", subject: "birthday thing", ...over });
const withRow = (r) => ({ get: () => r, muted: () => false });
check("already offered at stage 0, day 8: silent", stages(planOffers([cand("birthday", 8)], withRow(row()), now)), []);
check("already offered at stage 0, day 2: reminder", stages(planOffers([cand("birthday", 2)], withRow(row()), now)), [["birthday", "reminder", 1]]);
check("already reminded: silent", stages(planOffers([cand("birthday", 1)], withRow(row({ stage: 1 })), now)), []);
check("bill: 5 days first", stages(planOffers([cand("bill", 5)], noLedger, now)), [["bill", "new", 0]]);
check("bill: day before is stage 1", stages(planOffers([cand("bill", 1)], withRow(row({ kind: "bill", stage: 0 })), now)), [["bill", "reminder", 1]]);
check("bill: day of is stage 2", stages(planOffers([cand("bill", 0)], withRow(row({ kind: "bill", stage: 1 })), now)), [["bill", "reminder", 2]]);
check("anniversary: 14 days first", stages(planOffers([cand("anniversary", 14)], noLedger, now)), [["anniversary", "new", 0]]);
check("accepted is left alone", stages(planOffers([cand("birthday", 2)], withRow(row({ state: "accepted" })), now)), []);
check("dismissed is left alone", stages(planOffers([cand("birthday", 2)], withRow(row({ state: "dismissed" })), now)), []);
check("snoozed and still snoozing: silent", stages(planOffers([cand("birthday", 5)], withRow(row({ snooze_until: new Date(now.getTime() + 3600_000).toISOString(), state: "snoozed" })), now)), []);
check("snooze elapsed: comes back", stages(planOffers([cand("birthday", 5)], withRow(row({ snooze_until: new Date(now.getTime() - 3600_000).toISOString(), state: "snoozed" })), now)), [["birthday", "snoozed", 0]]);
check("a muted subject is never offered", stages(planOffers([cand("birthday", 5)], { get: () => undefined, muted: () => true }, now)), []);

const recur = (fp) => cand("recurring", 1, "Pottery class", { fingerprint: fp });
check("new series: offered once", stages(planOffers([recur("18:00|studio")], noLedger, now)), [["recurring", "new", 0]]);
check("same series, same fingerprint: silent", stages(planOffers([recur("18:00|studio")], withRow(row({ fingerprint: "18:00|studio", kind: "recurring" })), now)), []);
check("same series, moved: offered as changed", stages(planOffers([recur("19:00|studio")], withRow(row({ fingerprint: "18:00|studio", kind: "recurring" })), now)), [["recurring", "changed", 0]]);

console.log("\nthe daily cap and ordering\n");
const many = [cand("birthday", 9, "a"), cand("bill", 0, "b"), cand("flight", 3, "c"), cand("anniversary", 14, "d"), cand("appointment", 2, "e")];
const capped = planOffers(many, noLedger, now);
check("capped at three", capped.offers.length, 3);
check("the rest are deferred, not lost", capped.deferred, 2);
check("soonest first, then kind priority", capped.offers.map((o) => o.candidate.subject), ["b", "e", "c"]);
check("a custom cap is honored", planOffers(many, noLedger, now, 5).offers.length, 5);
check("a deferred item is offered tomorrow (nothing was recorded)", planOffers(many.slice(3), noLedger, now).offers.length, 2);
const quiet = planOffers(many, noLedger, new Date(2026, 10, 18, 22, 0));
check("quiet hours: nothing offered", quiet.offers.length, 0);
check("quiet hours: all deferred", quiet.deferred, 5);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
