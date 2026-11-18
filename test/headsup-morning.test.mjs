/**
 * The morning heads-up end to end, with Google and push replaced by seams.
 * Run with `node test/headsup-morning.test.mjs`.
 *
 * What goes wrong here is timing and repetition, not logic: sending twice in one day after a
 * restart, hammering a dead calendar API every ten minutes, losing an offer because the push
 * failed, or waking someone at 3am. Each is a case below.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-headsup-morning-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;

const { runMorningHeadsup, composeNotification, describeOffer, whenText } = await import("../src/headsup/morning.ts");
const ledger = await import("../src/headsup/ledger.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const at = (n, h = 8, m = 0) => new Date(2026, 10, 18 + n, h, m);
const dateStr = (n) => { const d = at(n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const ev = (id, title, daysAhead, over = {}) => ({
  allDay: true, calendarId: "primary", calendarName: "Me", description: "", eventType: "default", id,
  location: "", recurringEventId: "", start: dateStr(daysAhead), status: "confirmed", title, ...over,
});

let events = [ev("b1", "Garrett's Birthday", 10), ev("r1", "Rent $1,800 due", 5)];
let fetchError = null;
let fetchCalls = 0;
let sent = [];
let sendFails = false;
let enabled = true;
const deps = {
  fetchEvents: async () => { fetchCalls++; if (fetchError) throw new Error(fetchError); return { errors: [], events }; },
  googleEnabled: () => enabled,
  send: async (title, body, opts) => { if (sendFails) throw new Error("push down"); sent.push({ body, opts, title }); },
};
const run = (when, opts) => runMorningHeadsup(when, opts, deps);

console.log("\nwording\n");
check("today", whenText(0), "today");
check("tomorrow", whenText(1), "tomorrow");
check("in N days", whenText(10), "in 10 days");
const offer = (kind, subject, daysUntil, extra = {}, reason = "new") => ({ candidate: { amount: undefined, daysUntil, kind, subject, ...extra }, reason, stage: 0 });
check("a birthday line", describeOffer(offer("birthday", "Garrett's Birthday", 10)), "Garrett's Birthday: in 10 days");
check("an amount is added when the title lacks it", describeOffer(offer("bill", "Electric bill", 3, { amount: "$140" })), "Electric bill ($140): in 3 days");
check("... and not repeated when the title has it", describeOffer(offer("bill", "Electric bill $140", 3, { amount: "$140" })), "Electric bill $140: in 3 days");
check("a changed series", describeOffer(offer("recurring", "Pottery class", 1, {}, "changed")), "Pottery class: time or place changed");
check("a new series", describeOffer(offer("recurring", "Pottery class", 2)), "Pottery class: new on your calendar, in 2 days");
const two = composeNotification([offer("birthday", "A", 1), offer("bill", "B", 0)], 0);
check("title counts the items", two.title, "Heads-up: 2 things coming up");
check("one item reads singular", composeNotification([offer("bill", "B", 0)], 0).title, "Heads-up: 1 thing coming up");
check("one line per item", two.body, "A: tomorrow\nB: today");
check("overflow is mentioned, not dropped silently", composeNotification([offer("bill", "B", 0)], 4).body, "B: today\n+4 more tomorrow");

console.log("\ngates\n");
check("google disabled in policy: does nothing, reads nothing", (enabled = false, (await run(at(0))).status), "disabled");
check("... and never touched the calendar", fetchCalls, 0);
enabled = true;
check("before 7:15: early", (await run(at(0, 7, 14))).status, "early");
check("at 7:15 it may run", (await run(at(0, 7, 15), { force: false })).status, "sent");
check("3am: quiet", (await run(at(1, 3, 0))).status, "quiet");
check("9pm: quiet", (await run(at(1, 21, 0))).status, "quiet");
check("force does NOT override quiet hours", (await run(at(1, 3, 0), { force: true })).status, "quiet");

console.log("\nthe first morning\n");
check("one notification went out", sent.length, 1);
check("... titled for two items", sent[0].title, "Heads-up: 2 things coming up");
check("... soonest first", sent[0].body, "Rent $1,800 due: in 5 days\nGarrett's Birthday: in 10 days");
check("... collapses with itself on the phone", sent[0].opts.push.collapseId, "headsup-morning");
check("... opens the heads-up screen on tap", sent[0].opts.push.screen, "headsup");
check("both are on the list", ledger.listForClient("open").map((v) => v.subject).sort(), ["Garrett's Birthday", "Rent $1,800 due"]);
check("a restart the same day does not repeat it", (await run(at(0, 9, 0))).status, "already");
check("... and sent nothing more", sent.length, 1);

console.log("\nthe days after\n");
check("tomorrow: nothing new, nothing sent", (await run(at(1))).status, "nothing");
check("... no notification", sent.length, 1);
check("force runs again the same day", (await run(at(1), { force: true })).status, "nothing");
const t = (n) => run(at(n));
for (let d = 2; d <= 7; d++) await t(d);
// Rent is 5 days out on day 0, so it earns a reminder the day before and another the day of.
check("a week on: two reminders for the rent, nothing else", sent.length, 3);
check("... the day before", sent[1].body, "Rent $1,800 due: tomorrow");
check("... the day of", sent[2].body, "Rent $1,800 due: today");

console.log("\nfailures\n");
fetchError = "Google API HTTP 401";
const err = await run(at(20));
check("a calendar failure is reported, not thrown", [err.status, err.errors[0]], ["error", "Google API HTTP 401"]);
const calls = fetchCalls;
check("it backs off for an hour", (await run(at(20, 8, 30))).status, "backoff");
check("... without calling Google", fetchCalls, calls);
fetchError = null;
check("an hour later it tries again", (await run(at(20, 9, 1))).status === "backoff", false);

sent = [];
events = [ev("z1", "Zoe's Birthday", 28)]; // 3 days after the run day below (at(25))
sendFails = true;
const lost = await run(at(25));
check("a failed push still reports sent", lost.status, "sent");
check("... and the offer is still recorded", ledger.getByKey(`birthday:z1:${dateStr(28)}`)?.state, "offered");
sendFails = false;
check("... so running again does not offer it as new", (await run(at(25, 9, 0), { force: true })).status, "nothing");
check("... it comes back as the reminder two days out, not a repeat", (await run(at(26))).status, "sent");

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
