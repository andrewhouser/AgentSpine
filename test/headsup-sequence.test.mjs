/**
 * A booking's reminder sequence (src/headsup/sequence.ts, PLAN-open-work section 14, U9).
 * Run with `node test/headsup-sequence.test.mjs`.
 *
 * A calendar event that reads as a booking is offered "set up reminders". A yes gives you
 * three reminders (two days before, that morning, an hour before) and one draft file of
 * messages for the other person, which is never sent. What goes wrong with a thing like this
 * is noise and lateness, so those are the cases: what counts as a booking and what does not,
 * each lead time at its boundary, a yes that comes late, quiet hours and the daily limit
 * holding a reminder until it is useless, a booking that moves, and saying yes twice.
 *
 * Every instant is passed in and built in local time, so the suite reads the same at any
 * hour and in any time zone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-sequence-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.POLICY_PATH = path.join(root, "policy.json");
fs.writeFileSync(process.env.POLICY_PATH, JSON.stringify({ autoExecute: { irreversibleAlwaysConfirm: true, reversible: true }, version: 1 }));

const ledger = await import("../src/headsup/ledger.ts");
const reminders = await import("../src/headsup/reminders-store.ts");
const seq = await import("../src/headsup/sequence.ts");
const rules = await import("../src/headsup/rules.ts");
const { scanEvents } = await import("../src/headsup/scan.ts");
const { yesAction, yesLabel } = await import("../src/headsup/actions.ts");
const { planOffers } = await import("../src/headsup/plan.ts");
const { answerButtons } = await import("../src/headsup/morning.ts");
const { PROACTIVE_DAILY_CAP } = await import("../src/outbox-rules.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

// December 2026, local time. The booking in most cases is Thursday the 10th at 3pm.
const at = (day, h = 0, m = 0) => new Date(2026, 11, day, h, m);
const iso = (day, h, m = 0) => `2026-12-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
const minutes = (n) => n * 60_000;
const stepsOf = (dueAt, now) => Object.fromEntries(seq.planSteps(dueAt, now).map((s) => [s.id, s.skip ? "skip" : s.dueAt ? s.dueAt.getTime() : null]));

// --- what is a booking --------------------------------------------------------------------
console.log("\nWHAT READS AS A BOOKING");
const cls = (title, extra = {}) => rules.classify({ description: "", eventType: "", recurringEventId: "", title, ...extra });
for (const [title, want] of [
  ["Discovery call with Acme", "booking"],
  ["Intro call: Sam Rivera", "booking"],
  ["Consultation, Harbor Room", "booking"],
  ["Consult with Jordan", "booking"],
  ["Client meeting", "booking"],
  ["Client call", "booking"],
  ["Project kickoff", "booking"],
  ["Kick-off with the team at Acme", "booking"],
  ["Gig at Harbor Room", "booking"],
  ["DJ set, Northside", "booking"],
  ["Booking: wedding reception", "booking"],
  ["Booked: studio B", "booking"],
  // What it must not catch.
  ["Call Mom", null],
  ["Team meeting", null],
  ["Lunch with Sam", null],
  ["Read the gigabit router manual", null],
  // First match wins, and these are something else first.
  ["Gig payment due", "bill"],
  ["Dentist consultation", "appointment"],
  ["Birthday gig for Mia", "birthday"],
  ["Flight to the gig", "flight"],
  ["Gig deposit PAID", null],
]) {
  check(title, cls(title), want);
}
check("a repeating client call is a routine, not a booking", cls("Client call", { recurringEventId: "series-1" }), "recurring");
check("Yes on a booking sets up reminders", [yesAction({ kind: "booking", timed: true, travelReady: true, location: "12 Harbor St" }), yesLabel("booking", "remind")], ["remind", "Yes, set up reminders"]);
check("a booking is first mentioned before its two-days reminder is due", rules.LEAD_DAYS.booking[0] > 2, true);

// --- the scan and the offer ---------------------------------------------------------------
console.log("\nTHE SCAN — a booking is keyed by its start time");
const ev = (id, title, start, extra = {}) => ({
  allDay: !start.includes("T"),
  calendarId: "primary",
  calendarName: "Personal",
  description: "",
  eventType: "",
  id,
  location: "",
  recurringEventId: "",
  start,
  status: "confirmed",
  title,
  ...extra,
});
{
  const [c] = scanEvents([ev("e1", "Discovery call with Acme", iso(10, 15), { location: "12 Harbor St" })], at(6, 8));
  check("kind, days and key", [c.kind, c.daysUntil, c.dedupeKey], ["booking", 4, "booking:e1:2026-12-10T1500"]);
  const [moved] = scanEvents([ev("e1", "Discovery call with Acme", iso(10, 16))], at(6, 8));
  check("the same event an hour later is a different key", moved.dedupeKey, "booking:e1:2026-12-10T1600");
  const [day] = scanEvents([ev("e2", "Gig at Harbor Room", "2026-12-12")], at(6, 8));
  check("an all-day booking is keyed by its date", day.dedupeKey, "booking:e2:2026-12-12");

  const lead = (k) => rules.LEAD_DAYS[k];
  const none = { get: () => undefined, lead, muted: () => false };
  const offered = (daysUntil) => planOffers([{ ...c, daysUntil }], none, at(6, 8)).offers.length;
  check(`offered at ${rules.LEAD_DAYS.booking[0]} days out, not at ${rules.LEAD_DAYS.booking[0] + 1}`, [offered(rules.LEAD_DAYS.booking[0] + 1), offered(rules.LEAD_DAYS.booking[0])], [0, 1]);
  check("a booking made the day before is still offered", offered(1), 1);
}

// --- the arithmetic -----------------------------------------------------------------------
console.log("\nTHE THREE TIMES — counted back from the start");
{
  const start = at(10, 15);
  const plan = stepsOf(iso(10, 15), at(6, 8));
  check("two days before is 48 hours before", plan["two-days"], start.getTime() - minutes(2880));
  check("that morning is 7:30 on the day", plan.morning, at(10, 7, 30).getTime());
  check("an hour before is 60 minutes before", plan.hour, start.getTime() - minutes(60));
  check("labels", seq.planSteps(iso(10, 15), at(6, 8)).map((s) => s.label), ["Two days before", "That morning", "An hour before"]);

  // The morning one is dropped when the hour-before one lands close to it.
  const gap = rules.BOOKING_MORNING_MIN_GAP_MINUTES;
  const startAt = (m) => new Date(at(10, 7, 30).getTime() + minutes(m));
  const localIso = (d) => iso(d.getDate(), d.getHours(), d.getMinutes());
  check(`a booking exactly ${gap} minutes after 7:30 keeps its morning reminder`, stepsOf(localIso(startAt(gap)), at(6, 8)).morning === "skip", false);
  check("one minute sooner drops it", stepsOf(localIso(startAt(gap - 1)), at(6, 8)).morning, "skip");
  check("a 6am booking has no morning reminder either", stepsOf(iso(10, 6), at(6, 8)).morning, "skip");
}

console.log("\nAN ALL-DAY BOOKING — a day, not an hour");
{
  const plan = stepsOf("2026-12-12", at(6, 8));
  check("two days before is 9am two days before", plan["two-days"], at(10, 9).getTime());
  check("that morning is 7:30 on the day", plan.morning, at(12, 7, 30).getTime());
  check("there is no hour before", plan.hour, null);
}

console.log("\nA LATE YES — what has passed is skipped, not sent late");
{
  const twoDays = at(8, 15);
  check("a minute before the two-days mark: all three", stepsOf(iso(10, 15), new Date(twoDays.getTime() - minutes(1)))["two-days"], twoDays.getTime());
  check("exactly at the two-days mark: it is skipped", stepsOf(iso(10, 15), twoDays)["two-days"], "skip");
  const dayBefore = stepsOf(iso(10, 15), at(9, 12));
  check("the day before: two-days skipped, the other two kept", [dayBefore["two-days"], dayBefore.morning === "skip", dayBefore.hour === "skip"], ["skip", false, false]);
  const thatMorning = stepsOf(iso(10, 15), at(10, 9));
  check("at 9am on the day: only the hour-before is left", [thatMorning["two-days"], thatMorning.morning, thatMorning.hour === "skip"], ["skip", "skip", false]);
  const tooLate = stepsOf(iso(10, 15), at(10, 14, 30));
  check("half an hour before it starts: nothing is left", Object.values(tooLate), ["skip", "skip", "skip"]);
}

// --- through the ledger -------------------------------------------------------------------
const sent = [];
let quiet = false;
let sentToday = 0;
const drafts = path.join(root, "drafts");
const deps = {
  draftsDir: () => drafts,
  quiet: () => quiet,
  send: async (title, body, opts) => void sent.push({ body, opts, title }),
  sentToday: () => sentToday,
};
const cand = (key, startsAt, extra = {}) => ({ daysUntil: 4, dedupeKey: key, fingerprint: "", kind: "booking", location: "12 Harbor St", sourceId: key.split(":")[1], startsAt, subject: "Discovery call with Acme", timeSensitive: false, ...extra });
const offer = (c, now = at(6, 8)) => ledger.markOffered(c, 0, now);
const yes = (row, now) => {
  ledger.answer(row.id, "yes", now);
  return seq.startSequence(ledger.getById(row.id), now, deps);
};
const states = (id) => Object.fromEntries(reminders.remindersFor(id).map((r) => [r.step, r.state]));

console.log("\nSAYING YES — reminders for you, a draft for them");
{
  const row = offer(cand("booking:e1:2026-12-10T1500", iso(10, 15)));
  check("the card offers reminders", [ledger.toView(row).yesAction, ledger.toView(row).yesLabel], ["remind", "Yes, set up reminders"]);
  check("its lock-screen category is the reminders one", answerButtons([row]).category, "HEADSUP_REMIND");
  const r = yes(row, at(6, 9));
  check("three reminders are waiting", [r.pending, r.skipped, states(row.id)], [3, 0, { "two-days": "pending", morning: "pending", hour: "pending" }]);
  const file = path.join(drafts, `booking-${row.id}-discovery-call-with-acme.md`);
  check("one draft file, named by the heads-up", [r.draft, fs.existsSync(file)], [file, true]);
  const text = fs.readFileSync(file, "utf8");
  check("it opens by saying nothing was sent", text.startsWith("DRAFT (text) — nothing is sent to anyone"), true);
  check("it holds the confirmation and the three messages", ["Confirmation, to send now", "Two days before", "That morning", "An hour before"].map((h) => text.includes(`## ${h}`)), [true, true, true, true]);
  check("with the day, the time and the place from the calendar", [text.includes("Thursday, December 10"), text.includes("3:00 PM"), text.includes("12 Harbor St")], [true, true, true]);
  const view = ledger.toView(ledger.getById(row.id));
  check("the card shows the three steps, soonest first", view.reminders.map((m) => [m.label, m.state]), [["Two days before", "pending"], ["That morning", "pending"], ["An hour before", "pending"]]);
  check("and says what happened", /3 reminders set\. Messages for the other person are drafted in booking-/.test(view.researchNote), true);
  check("it stays on the open list while a reminder is to come", ledger.listForClient("open").some((v) => v.id === row.id), true);

  console.log("\nTHE SWEEP — each reminder at its moment, once");
  check("nothing is due the day it was set up", [(await seq.runSequences(at(6, 12), deps)).sent, sent.length], [0, 0]);
  check("a minute before the two-days mark: still nothing", (await seq.runSequences(at(8, 14, 59), deps)).sent, 0);
  const first = await seq.runSequences(at(8, 15, 5), deps);
  check("just after it: one goes out", [first.sent, sent.length, states(row.id)["two-days"]], [1, 1, "sent"]);
  check("worded by code, naming the draft section", [sent[0].title, sent[0].body.includes("Thursday, December 10 at 3:00 PM, 12 Harbor St"), sent[0].body.includes('under "Two days before" in booking-')], ["In 2 days: Discovery call with Acme", true, true]);
  check("it opens the Heads-up screen and is one stack per booking", [sent[0].opts.push.screen, sent[0].opts.push.collapseId, sent[0].opts.kind], ["headsup", `headsup-booking-${row.id}`, "booking"]);
  check("the next sweep does not send it again", [(await seq.runSequences(at(8, 15, 15), deps)).sent, sent.length], [0, 1]);
  await seq.runSequences(at(10, 7, 35), deps);
  await seq.runSequences(at(10, 14, 5), deps);
  check("then the morning and the hour before", sent.map((s) => s.title), ["In 2 days: Discovery call with Acme", "Today: Discovery call with Acme", "In an hour: Discovery call with Acme"]);
  check("all three are sent, none twice", states(row.id), { "two-days": "sent", morning: "sent", hour: "sent" });

  console.log("\nYES AGAIN — starts over without sending anything twice");
  const again = seq.startSequence(ledger.getById(row.id), at(10, 14, 10), deps);
  check("what went out stays sent", [again.pending, states(row.id)], [0, { "two-days": "sent", morning: "sent", hour: "sent" }]);
  check("and there is still one draft file", fs.readdirSync(drafts).length, 1);
}

console.log("\nA LATE YES THROUGH THE LEDGER");
{
  sent.length = 0;
  const row = offer(cand("booking:e3:2026-12-10T1500", iso(10, 15), { subject: "Gig at Harbor Room" }), at(9, 8));
  const r = yes(row, at(9, 12));
  check("two set, one skipped with its reason", [r.pending, r.skipped, states(row.id)], [2, 1, { "two-days": "skipped", morning: "pending", hour: "pending" }]);
  check("the reason is in words", reminders.remindersFor(row.id).find((m) => m.step === "two-days").reason, "its time had already passed when you said yes");
  check("a skipped step is never sent later", [(await seq.runSequences(at(9, 13), deps)).sent, sent.length], [0, 0]);

  const close = offer(cand("booking:e4:2026-12-10T1500", iso(10, 15), { subject: "Client call" }), at(10, 8));
  const none = yes(close, at(10, 14, 30));
  check("too close for any reminder: says so, and still drafts", [none.pending, /too close for reminders/.test(none.note), !!none.draft], [0, true, true]);
}

console.log("\nHELD — quiet hours and the daily limit");
{
  sent.length = 0;
  // A booking at 6:30am: its hour-before reminder falls at 5:30, inside quiet hours.
  const early = offer(cand("booking:e5:2026-12-15T0630", iso(15, 6, 30), { subject: "Consultation" }), at(11, 8));
  yes(early, at(11, 9));
  quiet = true;
  const held = await seq.runSequences(at(15, 5, 35), deps);
  check("held in quiet hours, not sent", [held.held, held.sent, states(early.id).hour], [1, 0, "pending"]);
  quiet = false;
  const late = rules.BOOKING_REMINDERS.find((s) => s.id === "hour").lateMinutes;
  const after = await seq.runSequences(new Date(at(15, 5, 30).getTime() + minutes(late + 1)), deps);
  const hour = reminders.remindersFor(early.id).find((m) => m.step === "hour");
  check(`past its ${late}-minute limit it is skipped, and says what held it`, [after.skipped, after.sent, hour.state, hour.reason], [1, 0, "skipped", "quiet hours held it until it was too late to be useful"]);

  // The two-days step has half a day of slack, so quiet hours only delay it.
  const evening = offer(cand("booking:e6:2026-12-17T2300", iso(17, 23), { subject: "DJ set, Northside" }), at(12, 8));
  yes(evening, at(12, 9));
  quiet = true;
  check("a two-days reminder due at 11pm waits", (await seq.runSequences(at(15, 23, 5), deps)).held, 1);
  quiet = false;
  const morning = await seq.runSequences(at(16, 6, 5), deps);
  check("and goes out when quiet hours end", [morning.sent, states(evening.id)["two-days"]], [1, "sent"]);

  // The daily limit, at its boundary.
  const capped = offer(cand("booking:e7:2026-12-20T1500", iso(20, 15), { subject: "Project kickoff" }), at(16, 8));
  yes(capped, at(16, 9));
  sentToday = PROACTIVE_DAILY_CAP;
  const atCap = await seq.runSequences(at(18, 15, 5), deps);
  check(`with ${PROACTIVE_DAILY_CAP} already sent today it is held`, [atCap.held, atCap.sent, reminders.remindersFor(capped.id)[0].reason], [1, 0, `the daily limit of ${PROACTIVE_DAILY_CAP} messages`]);
  sentToday = PROACTIVE_DAILY_CAP - 1;
  check("with one fewer it goes", (await seq.runSequences(at(18, 15, 15), deps)).sent, 1);
  sentToday = 0;

  // A server that was off across the moment.
  const off = offer(cand("booking:e8:2026-12-22T1500", iso(22, 15), { subject: "Intro call: Sam Rivera" }), at(18, 8));
  yes(off, at(18, 9));
  const twoDaysLate = rules.BOOKING_REMINDERS.find((s) => s.id === "two-days").lateMinutes;
  check("exactly at its late limit a reminder is still sent", (await seq.runSequences(new Date(at(20, 15).getTime() + minutes(twoDaysLate)), deps)).sent, 1);
  const missed = await seq.runSequences(at(22, 15, 40), deps);
  const reasons = reminders.remindersFor(off.id).filter((m) => m.state === "skipped").map((m) => m.reason);
  check("the ones it slept through are skipped, with why", [missed.skipped, missed.sent, [...new Set(reasons)]], [2, 0, ["the server was not running at its time"]]);
}

console.log("\nA MOVED OR CANCELLED BOOKING — what has not fired is withdrawn");
{
  sent.length = 0;
  const key = "booking:e9:2026-12-28T1500";
  const row = offer(cand(key, iso(28, 15), { subject: "Discovery call with Northside" }), at(23, 8));
  yes(row, at(23, 9));
  await seq.runSequences(at(26, 15, 5), deps);
  check("one has gone out", states(row.id), { "two-days": "sent", morning: "pending", hour: "pending" });

  check("still on the calendar at the same time: nothing changes", [seq.reconcileSequences([cand(key, iso(28, 15))], at(27, 7, 15)), states(row.id).hour], [0, "pending"]);
  // Moved to 4pm: the scan now produces a different key for it.
  const movedKey = "booking:e9:2026-12-28T1600";
  const n = seq.reconcileSequences([cand(movedKey, iso(28, 16))], at(27, 7, 16));
  check("moved by an hour: the two unsent reminders are withdrawn", [n, states(row.id)], [2, { "two-days": "sent", morning: "withdrawn", hour: "withdrawn" }]);
  check("with the reason", reminders.remindersFor(row.id).find((m) => m.step === "hour").reason, "the booking moved or was cancelled");
  check("the card says so", /remaining reminders were withdrawn/.test(ledger.toView(ledger.getById(row.id)).researchNote), true);
  check("nothing more is sent for the old time", [(await seq.runSequences(at(28, 14, 5), deps)).sent, sent.length], [0, 1]);
  const lead = (k) => rules.LEAD_DAYS[k];
  const plan = planOffers([cand(movedKey, iso(28, 16), { daysUntil: 1 })], { get: ledger.getByKey, lead, muted: ledger.isMuted }, at(27, 7, 16));
  check("the new time is a fresh offer", plan.offers.map((o) => o.reason), ["new"]);

  const gone = offer(cand("booking:e10:2026-12-30T1500", iso(30, 15), { subject: "Gig at Harbor Room" }), at(25, 8));
  yes(gone, at(25, 9));
  check("cancelled, so absent from the scan: all three withdrawn", [seq.reconcileSequences([], at(26, 7, 15)), states(gone.id)], [3, { "two-days": "withdrawn", morning: "withdrawn", hour: "withdrawn" }]);

  // A heads-up taken back whole (its source edited or forgotten) leaves no orphan rows behind.
  const taken = offer(cand("booking:e11:2026-12-31T1500", iso(31, 15), { subject: "Client meeting" }), at(26, 8));
  yes(taken, at(26, 9));
  ledger.withdrawOpenForSource("e11");
  await seq.runSequences(at(26, 10), deps);
  check("a withdrawn heads-up takes its reminders with it", reminders.remindersFor(taken.id), []);
}

console.log("\nDRAFTS OFF — reminders still, and it says why there is no draft");
{
  const row = offer(cand("booking:e12:2027-01-05T1500", "2027-01-05T15:00:00", { subject: "Consult with Jordan" }), at(31, 8));
  ledger.answer(row.id, "yes", at(31, 9));
  const r = seq.startSequence(ledger.getById(row.id), at(31, 9), { ...deps, draftsDir: () => null });
  check("three reminders, no draft, and the note explains", [r.pending, r.draft, /Drafts are switched off in policy\.json/.test(r.note)], [3, null, true]);
  check("the real policy check denies by default", seq.realSequenceDeps.draftsDir(), null);
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
