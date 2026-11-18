/**
 * Heads-up, the stateful half: the Google event mapper, and the ledger driven through the
 * planner the way the morning run will. Run with `node test/headsup-ledger.test.mjs`.
 *
 * The scenario tests are the point. A planner that is right on one scan and wrong on the second
 * is the bug this feature will actually have: offering Garrett's birthday every morning, or
 * never again after a snooze.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-headsup-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;

const { mapCalendarEvent } = await import("../src/google/client.ts");
const ledger = await import("../src/headsup/ledger.ts");
const { planOffers } = await import("../src/headsup/plan.ts");
const { scanEvents } = await import("../src/headsup/scan.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const cal = { id: "primary", name: "Me", primary: true };

console.log("\nmapping a Google event\n");
const timed = mapCalendarEvent(
  { attendees: [{}, {}], description: "d", end: { dateTime: "2026-11-20T11:00:00-05:00" }, id: "abc", location: "Gate 4", recurringEventId: "ser", start: { dateTime: "2026-11-20T10:00:00-05:00" }, status: "confirmed", summary: "Flight UA 482" },
  cal,
);
check("a timed event is not all-day", timed.allDay, false);
check("start keeps the offset", timed.start, "2026-11-20T10:00:00-05:00");
check("attendees are counted", timed.attendees, 2);
check("series id carried", timed.recurringEventId, "ser");
const allDay = mapCalendarEvent({ end: { date: "2026-11-21" }, id: "b", start: { date: "2026-11-20" }, summary: "Garrett" , eventType: "birthday" }, cal);
check("a date-only event is all-day", allDay.allDay, true);
check("... and its start stays a bare date", allDay.start, "2026-11-20");
check("event type carried", allDay.eventType, "birthday");
const bare = mapCalendarEvent({ id: "c", start: { date: "2026-11-20" } }, cal);
check("a missing title gets a placeholder", bare.title, "(no title)");
check("missing optional fields are empty strings, not undefined", [bare.description, bare.location, bare.recurringEventId, bare.eventType], ["", "", "", ""]);
check("a missing status means confirmed", bare.status, "confirmed");
check("the calendar is attached", [bare.calendarId, bare.calendarName], ["primary", "Me"]);

console.log("\nthe ledger, run like the morning job\n");
const day = (n, h = 7, m = 30) => new Date(2026, 10, 18 + n, h, m);
const dateStr = (n) => { const d = day(n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const birthday = (id = "g1") => ({ allDay: true, calendarId: "primary", calendarName: "Me", description: "", eventType: "birthday", id, location: "", recurringEventId: "", start: dateStr(10), status: "confirmed", title: "Garrett's Birthday" });
const none = { exclude: [], include: [] };
const deps = { get: ledger.getByKey, muted: ledger.isMuted };

/** One morning: scan, plan, record what was offered. Returns the offers. */
const morning = (n, events) => {
  const now = day(n);
  const plan = planOffers(scanEvents(events, now, none), deps, now);
  for (const o of plan.offers) ledger.markOffered(o.candidate, o.stage, now);
  return plan.offers.map((o) => `${o.candidate.subject}:${o.reason}:${o.stage}`);
};

const events = [birthday()];
check("day 0 (10 days out): first mention", morning(0, events), ["Garrett's Birthday:new:0"]);
check("day 0 run twice: no repeat", morning(0, events), []);
check("day 1: silent", morning(1, events), []);
check("day 7: silent", morning(7, events), []);
check("day 8 (2 days out): the reminder", morning(8, events), ["Garrett's Birthday:reminder:1"]);
check("day 8 again: no repeat", morning(8, events), []);
check("day 9: silent", morning(9, events), []);
check("one row for the whole story", ledger.listByState(["offered"]).length, 1);
check("stage advanced and stayed", ledger.getByKey(`birthday:g1:${dateStr(10)}`).stage, 1);

console.log("\nanswering an offer\n");
const row = ledger.getByKey(`birthday:g1:${dateStr(10)}`);
check("yes accepts", ledger.answer(row.id, "yes", day(8)).state, "accepted");
check("accepted is not offered again", morning(9, events), []);
const rent = { ...birthday("r1"), eventType: "default", start: dateStr(5), title: "Rent $1,800 due" };
check("a bill 5 days out: first mention", morning(0, [rent]), ["Rent $1,800 due:new:0"]);
const rentRow = ledger.getByKey(`bill:r1:${dateStr(5)}`);
const snoozed = ledger.answer(rentRow.id, "later", day(0));
check("later snoozes", snoozed.state, "snoozed");
check("... until a day later", new Date(snoozed.snooze_until).getTime() - day(0).getTime(), 24 * 3_600_000);
check("snoozed: still silent later the same morning", morning(0, [rent]), []);
check("the morning after the snooze it returns", morning(1, [rent]), ["Rent $1,800 due:snoozed:0"]);
check("... and is back to offered", ledger.getByKey(`bill:r1:${dateStr(5)}`).state, "offered");
check("... without a stale snooze time", ledger.getByKey(`bill:r1:${dateStr(5)}`).snooze_until, null);

console.log("\n'never' mutes the subject, not just this one\n");
const anniv = { ...birthday("a1"), eventType: "default", start: dateStr(10), title: "Our anniversary" };
check("first mention", morning(0, [anniv]), ["Our anniversary:new:0"]);
const aRow = ledger.getByKey(`anniversary:a1:${dateStr(10)}`);
check("never dismisses", ledger.answer(aRow.id, "never", day(0)).state, "dismissed");
check("the subject is muted", ledger.isMuted("anniversary", "Our anniversary"), true);
check("not offered again", morning(8, [anniv]), []);
const nextYear = { ...anniv, id: "a2" };
check("... nor next year's event with a new id", morning(8, [nextYear]), []);
check("muting one kind does not mute another", ledger.isMuted("birthday", "Our anniversary"), false);
const rentMute = { ...rent, id: "r9", title: "Water bill $40" };
morning(0, [rentMute]);
ledger.answer(ledger.getByKey(`bill:r9:${dateStr(5)}`).id, "never", day(0));
check("amounts do not defeat a mute", ledger.isMuted("bill", "Water bill $52.10"), true);
check("answering a headsup that does not exist", ledger.answer(99999, "yes", day(0)), undefined);

console.log("\nrecurring series, over time\n");
const series = (id, time, date) => ({ ...birthday(id), allDay: false, eventType: "default", location: "Studio", recurringEventId: "pot", start: `${date}T${time}:00-05:00`, title: "Pottery class" });
check("new series: one mention", morning(0, [series("p1", "18:00", dateStr(1)), series("p2", "18:00", dateStr(8))]), ["Pottery class:new:0"]);
check("next week, same time: silent", morning(7, [series("p2", "18:00", dateStr(8))]), []);
check("moved to a different time: mentioned as changed", morning(7, [series("p2", "19:30", dateStr(8))]), ["Pottery class:changed:0"]);
check("... once", morning(7, [series("p2", "19:30", dateStr(8))]), []);

console.log("\nexpiring\n");
check("offered rows in the past are expired, accepted ones are done", (() => {
  const n = ledger.expirePast(day(30));
  return n > 0;
})(), true);
check("nothing is left open", ledger.listByState(["offered", "snoozed", "accepted"]).length, 0);
check("accepted became done", ledger.getByKey(`birthday:g1:${dateStr(10)}`).state, "done");
const today = { ...birthday("t1"), start: dateStr(0), title: "Rent today" , eventType: "default" };
morning(0, [{ ...today }]);
ledger.expirePast(day(0, 15, 0));
check("an all-day event is still open at 3pm that day", ledger.getByKey(`bill:t1:${dateStr(0)}`)?.state, "offered");
ledger.expirePast(day(1, 0, 5));
check("... and expired just after midnight", ledger.getByKey(`bill:t1:${dateStr(0)}`)?.state, "expired");

console.log("\nwhat a client sees\n");
const bill = { ...birthday("v1"), eventType: "default", location: "Online", start: dateStr(4), title: "Gas bill $62.10" };
morning(0, [bill]);
const view = ledger.listForClient("open").find((v) => v.subject === "Gas bill $62.10");
check("kind and subject", [view.kind, view.subject], ["bill", "Gas bill $62.10"]);
check("the amount and place are lifted out of the payload", [view.amount, view.location], ["$62.10", "Online"]);
check("internal stage and dedupe key are not exposed", Object.keys(view).some((k) => /stage|dedupe|fingerprint|payload/i.test(k)), false);
check("open lists only offered and snoozed", ledger.listForClient("open").every((v) => ["offered", "snoozed"].includes(v.state)), true);
check("all includes finished ones too", ledger.listForClient("all").length > ledger.listForClient("open").length, true);
check("a row with a corrupt payload still renders", ledger.toView({ ...ledger.getByKey(`bill:v1:${dateStr(4)}`), payload_json: "{nope" }).amount, null);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
