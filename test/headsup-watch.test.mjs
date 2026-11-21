/**
 * The time-sensitive loop, end to end, with a fake clock and fake providers.
 * Run with `node test/headsup-watch.test.mjs`.
 *
 * What goes wrong with a loop like this is cost and noise, not logic: polling a flight next week,
 * polling every minute, burning a free tier, waking someone at 3am for a gate change, notifying
 * twice for a feed that wobbles, or going silent forever after one bad response. Each is a case.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-watch-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
// Keys present, so "configured" depends only on policy.json, which this test rewrites.
process.env.AERODATABOX_RAPIDAPI_KEY = "test-flight-key";
process.env.TOMTOM_API_KEY = "test-tomtom-key";
process.env.HEADSUP_HOME = "1 Home Rd, Asheville, NC";
process.env.POLICY_PATH = path.join(root, "policy.json");
const writePolicy = (headsup) => fs.writeFileSync(process.env.POLICY_PATH, JSON.stringify({ autoExecute: { irreversibleAlwaysConfirm: true, reversible: true }, ...(headsup ? { headsup } : {}), version: 1 }));
writePolicy({ flights: true, travel: true });

const ledger = await import("../src/headsup/ledger.ts");
const store = await import("../src/headsup/watch/store.ts");
const { runWatchLoop, windowOf, blockedReason } = await import("../src/headsup/watch/loop.ts");
const { enableWatch, flightSpecFor, driveSpecFor } = await import("../src/headsup/watch/enable.ts");
const { yesAction, yesLabel } = await import("../src/headsup/actions.ts");
const { scanEvents } = await import("../src/headsup/scan.ts");
const budget = await import("../src/headsup/watch/budget.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

// Local-time helpers: quiet hours are judged on local hours, so every instant here is local.
const at = (day, h, m = 0) => new Date(2026, 10, day, h, m);
const iso = (day, h, m = 0) => `2026-11-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
const cand = (kind, subject, key, extra = {}) => ({ daysUntil: 2, dedupeKey: key, fingerprint: "", kind, location: "", sourceId: key, startsAt: "2026-11-20", subject, timeSensitive: false, ...extra });
const offer = (c) => ledger.markOffered(c, 0, at(18, 8));

// --- fakes ---
const sent = [];
let flightQueue = [];
let flightCalls = 0;
let driveCalls = { geocode: 0, route: 0 };
let driveTimes = [{ minutes: 38, typicalMinutes: 25 }];
let flightsOn = true;
let travelOn = true;
let home = "1 Home Rd";
let limits = { flightsPerMonth: 400, travelPerDay: 1000 };
// A status whose times agree with the scenario's departure, so "leaving within six hours" is judged on real numbers.
let departHour = 14;
const status = (over = {}) => {
  const base = at(20, departHour);
  const delay = over.delayMinutes ?? 0;
  return { arrivalAirport: "DEN", arrivalGate: "", arrivalTerminal: "", delayMinutes: 0, departureAirport: "AVL", departureGate: "B12", departureTerminal: "A", estimatedArrival: "", estimatedDeparture: new Date(base.getTime() + delay * 60_000).toISOString(), phase: "scheduled", scheduledDeparture: base.toISOString(), ...over };
};
const deps = () => ({
  buffer: () => 10,
  flights: () => (flightsOn ? { lookup: async () => { flightCalls++; const next = flightQueue.length > 1 ? flightQueue.shift() : flightQueue[0]; if (next instanceof Error) throw next; return next; } } : null),
  home: () => home,
  limits: () => limits,
  send: async (title, body, opts) => { sent.push({ body, opts, title }); },
  travel: () => (travelOn ? { geocode: async (a) => { driveCalls.geocode++; return { lat: a.length, lon: 1 }; }, route: async () => { driveCalls.route++; const next = driveTimes.length > 1 ? driveTimes.shift() : driveTimes[0]; if (next instanceof Error) throw next; return next; } } : null),
});
const run = async (when) => (await runWatchLoop(when, deps())).map((r) => r.outcome);
const reset = () => { sent.length = 0; flightCalls = 0; driveCalls = { geocode: 0, route: 0 }; };

// A flight departing Nov 20 at 14:00 local. The window is 08:00 to 02:00 the next day.
const mkFlight = (key, hour = 14, over = {}) => {
  departHour = hour;
  const row = offer(cand("flight", `Flight to Denver UA 482`, key, { flightNumber: "UA 482", startsAt: iso(20, hour), ...over }));
  return { ...row, ...(enableWatch(ledger.getById(row.id), at(18, 8)), {}) };
};

console.log("\nwhat Yes does\n");
const facts = (over = {}) => ({ flightNumber: undefined, kind: "bill", location: undefined, timed: false, travelReady: false, ...over });
check("a birthday researches", yesAction(facts({ kind: "birthday" })), "research");
check("an anniversary researches", yesAction(facts({ kind: "anniversary" })), "research");
check("a flight with a number is watched", yesAction(facts({ flightNumber: "UA 482", kind: "flight" })), "watch");
check("a flight with no number found is just acknowledged", yesAction(facts({ kind: "flight" })), "ack");
check("an appointment with a place, a time and a routing key is watched", yesAction(facts({ kind: "appointment", location: "Dentist", timed: true, travelReady: true })), "watch");
check("... but not without a routing key", yesAction(facts({ kind: "appointment", location: "Dentist", timed: true })), "ack");
check("... nor without a place", yesAction(facts({ kind: "appointment", timed: true, travelReady: true })), "ack");
check("... nor an all-day appointment", yesAction(facts({ kind: "appointment", location: "Dentist", travelReady: true })), "ack");
check("a bill is acknowledged", yesAction(facts()), "ack");
check("labels say what happens", [yesLabel("birthday", "research"), yesLabel("anniversary", "research"), yesLabel("flight", "watch"), yesLabel("appointment", "watch"), yesLabel("bill", "ack")], ["Yes, find gift ideas", "Yes, find restaurants", "Yes, track this flight", "Yes, watch traffic", "Got it"]);

console.log("\nfinding the flight in the calendar\n");
const evt = (over) => ({ allDay: false, calendarId: "p", calendarName: "Me", description: "", eventType: "default", id: "f1", location: "", recurringEventId: "", start: iso(20, 14), status: "confirmed", title: "Flight to Denver", ...over });
const sc = scanEvents([evt({ description: "Confirmation ABC. UA 482 AVL to DEN" })], at(18, 8), { exclude: [], include: [] });
check("the number is found in the description", [sc[0].kind, sc[0].flightNumber, sc[0].timeSensitive], ["flight", "UA 482", true]);
check("or in the title", scanEvents([evt({ title: "Flight UA 482 to Denver" })], at(18, 8), { exclude: [], include: [] })[0].flightNumber, "UA 482");
check("no number is fine: it is just not watchable", scanEvents([evt()], at(18, 8), { exclude: [], include: [] })[0].flightNumber, undefined);
check("a non-flight never gets one", scanEvents([evt({ description: "UA 482", title: "Dentist" })], at(18, 8), { exclude: [], include: [] })[0].flightNumber, undefined);

console.log("\nstarting a watch\n");
const f1 = mkFlight("flight:1");
const wf = store.getWatch(f1.id);
check("saying Yes created a flight watch", [wf.kind, wf.active], ["flight", 1]);
const fs1 = flightSpecFor(ledger.getById(f1.id));
check("with the flight, the local date and the departure", [fs1.flight.code, fs1.date, fs1.allDay], ["UA482", "2026-11-20", false]);
check("configured: the note says it is tracking", wf.note, "Tracking UA 482. You'll hear about delays, gate changes and cancellations.");
check("nothing is blocked", [blockedReason("flight"), blockedReason("drive")], [null, null]);
writePolicy(undefined);
check("without the policy switch, flights are blocked, in words", blockedReason("flight"), 'Flight tracking is off. Set "headsup": { "flights": true } in policy.json.');
check("... and so are drives", blockedReason("drive"), 'Drive watching is off. Set "headsup": { "travel": true } in policy.json.');
const blockedRow = offer(cand("flight", "Flight UA 99", "flight:blocked", { flightNumber: "UA 99", startsAt: iso(21, 9) }));
const be = enableWatch(ledger.getById(blockedRow.id), at(18, 8));
check("a watch is still created, with a note saying what is missing", [be.created, store.getWatch(blockedRow.id).active, be.note.includes("policy.json") && be.note.includes("starts once")], [true, 1, true]);
writePolicy({ flights: true, travel: true });
check("a flight with no number has nothing to watch", enableWatch(ledger.getById(offer(cand("flight", "Flight somewhere", "flight:nonum", { startsAt: iso(22, 9) })).id)).created, false);
check("a bill has nothing to watch", enableWatch(ledger.getById(offer(cand("bill", "Rent", "bill:w")).id)).created, false);
const again = store.getWatch(f1.id);
store.updateWatch(again.id, { state: { seeded: true, fp: "x" }, last_polled: at(18, 9).toISOString() });
enableWatch(ledger.getById(f1.id), at(18, 10));
check("saying Yes again restarts it cleanly", [store.parseState(store.getWatch(f1.id)), store.getWatch(f1.id).last_polled], [{}, null]);

console.log("\nthe window: nothing is polled outside it\n");
const [w0, w1] = windowOf(store.getWatch(f1.id));
check("it opens six hours before departure", w0, at(20, 8).getTime());
check("and closes twelve hours after", w1, at(21, 2).getTime());
reset();
check("a week before: nothing", await run(at(13, 12)), ["before", "before"].slice(0, store.activeWatches().length).map(() => "before"));
check("... and no call was made", flightCalls, 0);
check("... and nothing was spent", budget.used("flight", "2026-11"), 0);
check("seven hours before: still nothing", (await run(at(20, 7, 0)))[0], "before");
check("no calls yet", flightCalls, 0);

console.log("\ninside the window\n");
// Park the other flights so this section watches exactly one.
for (const w of store.activeWatches()) if (w.headsup_id !== f1.id) store.endWatch(w.id, "parked");
flightQueue = [status()];
check("the first look records quietly", await run(at(20, 8, 0)), ["seeded"]);
check("... one call, one unit spent, no notification", [flightCalls, budget.used("flight", "2026-11"), sent.length], [1, 1, 0]);
check("... the note is plain words", store.getWatch(f1.id).note, "On time. Gate B12. Terminal A.");
check("ten minutes later: the floor holds", await run(at(20, 8, 10)), ["throttled"]);
check("... and again at 29 minutes", await run(at(20, 8, 29)), ["throttled"]);
check("no extra calls", flightCalls, 1);
check("at thirty minutes it polls", await run(at(20, 8, 30)), ["unchanged"]);
check("unchanged is silent", sent.length, 0);

console.log("\nspeaking only on a difference\n");
flightQueue = [status({ delayMinutes: 47 })];
check("a 47 minute delay notifies", await run(at(20, 9, 0)), ["notified"]);
check("... title names the flight and where", sent.at(-1).title, "Flight UA 482 to DEN");
check("... body says how late", sent.at(-1).body.startsWith("45 min late. Now departing about"), true);
check("... it collapses with itself on the phone", sent.at(-1).opts.push.collapseId, `headsup-watch-${f1.id}`);
check("... and opens the heads-up screen", sent.at(-1).opts.push.screen, "headsup");
check("... under an hour is ordinary priority", sent.at(-1).opts.priority, 3);
flightQueue = [status({ delayMinutes: 52 })];
check("the feed wobbling to 52 minutes (same bucket) is silent", await run(at(20, 9, 30)), ["unchanged"]);
check("... and the traveller is still last told '45'", store.parseState(store.getWatch(f1.id)).last.delayMinutes, 47);
const n1 = sent.length;
flightQueue = [status({ delayMinutes: 52, departureGate: "C4" })];
check("a gate change notifies", await run(at(20, 10, 0)), ["notified"]);
check("... naming both gates", sent.at(-1).body, "Gate changed from B12 to C4.");
flightQueue = [status({ delayMinutes: 95, departureGate: "C4" })];
await run(at(20, 10, 30));
check("a delay past an hour is time-sensitive priority", sent.at(-1).opts.priority, 4);
check("each update was its own notification", sent.length, n1 + 2);

console.log("\nthe end of a flight\n");
flightQueue = [status({ departureGate: "C4", phase: "cancelled" })];
check("a cancellation notifies", await run(at(20, 11, 0)), ["notified"]);
check("... plainly", sent.at(-1).body, "Cancelled.");
check("... and ends the watch", store.getWatch(f1.id).active, 0);
const calls0 = flightCalls;
check("an ended watch is never polled again", [(await run(at(20, 12, 0))).length, flightCalls], [0, calls0]);

console.log("\nthe first look, with bad news\n");
const f2 = mkFlight("flight:2");
for (const w of store.activeWatches()) if (w.headsup_id !== f2.id) store.endWatch(w.id, "parked");
flightQueue = [status({ phase: "cancelled" })];
reset();
check("already cancelled when you start tracking: say so at once", await run(at(20, 12, 0)), ["notified"]);
const f3 = mkFlight("flight:3");
for (const w of store.activeWatches()) if (w.headsup_id !== f3.id) store.endWatch(w.id, "parked");
flightQueue = [status({ delayMinutes: 75 })];
reset();
check("already 75 minutes late: say so at once", await run(at(20, 12, 0)), ["notified"]);
const f4 = mkFlight("flight:4");
for (const w of store.activeWatches()) if (w.headsup_id !== f4.id) store.endWatch(w.id, "parked");
flightQueue = [status({ delayMinutes: 20 })];
reset();
check("20 minutes late on a first look: record it, stay quiet", await run(at(20, 12, 0)), ["seeded"]);
check("... nothing sent", sent.length, 0);
flightQueue = [status({ delayMinutes: 20 })];
check("and a later landing ends it with a notice", (flightQueue = [status({ arrivalGate: "41", phase: "landed" })], await run(at(20, 12, 30))), ["notified"]);
check("... 'Landed, gate 41.'", sent.at(-1).body, "Landed, gate 41.");
check("... and the watch is over", store.getWatch(f4.id).active, 0);

console.log("\nquiet hours (9 pm to 6 am)\n");
const q = mkFlight("flight:q", 5);
for (const w of store.activeWatches()) if (w.headsup_id !== q.id) store.endWatch(w.id, "parked");
// Departs Nov 20 05:00. Window opens Nov 19 23:00.
flightQueue = [status()];
check("a quiet first look at 11:30pm", await run(at(19, 23, 30)), ["seeded"]);
reset();
flightQueue = [status({ departureGate: "C4" })];
check("a gate change at 3am is held back", await run(at(20, 3, 0)), ["quiet"]);
check("... nothing sent", sent.length, 0);
check("... and NOT recorded as told", store.parseState(store.getWatch(q.id)).last.departureGate, "B12");
check("... the note says why", store.getWatch(q.id).note.includes("held until quiet hours end"), true);
flightQueue = [status({ delayMinutes: 45, departureGate: "C4" })];
check("a 45 minute delay at 3:30am is still held", await run(at(20, 3, 30)), ["quiet"]);
flightQueue = [status({ delayMinutes: 90, departureGate: "C4" })];
check("a 90 minute delay within six hours breaks through", await run(at(20, 4, 0)), ["notified"]);
check("... at time-sensitive priority", sent.at(-1).opts.priority, 4);
const q2 = mkFlight("flight:q2", 9);
for (const w of store.activeWatches()) if (w.headsup_id !== q2.id) store.endWatch(w.id, "parked");
flightQueue = [status()];
await run(at(20, 3, 0));
reset();
flightQueue = [status({ phase: "cancelled" })];
check("a cancellation at 3:30am breaks through", await run(at(20, 3, 30)), ["notified"]);
const q3 = mkFlight("flight:q3", 9);
for (const w of store.activeWatches()) if (w.headsup_id !== q3.id) store.endWatch(w.id, "parked");
flightQueue = [status()];
await run(at(20, 3, 0));
reset();
flightQueue = [status({ departureGate: "C4" })];
await run(at(20, 5, 30));
check("a held change is delivered once quiet hours end", await run(at(20, 6, 5)), ["notified"]);
check("... and says the same thing", sent.at(-1).body, "Gate changed from B12 to C4.");

console.log("\nbudgets\n");
const bd = mkFlight("flight:b", 14);
for (const w of store.activeWatches()) if (w.headsup_id !== bd.id) store.endWatch(w.id, "parked");
limits = { flightsPerMonth: budget.used("flight", "2026-11") + 2, travelPerDay: 1000 };
reset();
flightQueue = [status()];
await run(at(20, 8, 0)); await run(at(20, 8, 30));
check("two calls fit in what is left", flightCalls, 2);
check("the third does not run", await run(at(20, 9, 0)), ["budget"]);
check("... no call made", flightCalls, 2);
check("... and ONE notice that tracking paused", [sent.length, sent.at(-1).title], [1, "Flight tracking paused"]);
await run(at(20, 9, 30));
check("a fourth attempt says nothing more", sent.length, 1);
check("the watch note says why", store.getWatch(bd.id).note, "Paused: this month's flight lookup budget is used up.");
limits = { flightsPerMonth: 400, travelPerDay: 1000 };
check("with budget again it resumes", await run(at(20, 10, 0)), ["unchanged"]);

console.log("\nfailures do not hammer a provider, or silence a watch\n");
const er = mkFlight("flight:e", 14);
for (const w of store.activeWatches()) if (w.headsup_id !== er.id) store.endWatch(w.id, "parked");
reset();
flightQueue = [new Error("the flight provider says the quota is used up")];
check("a provider error is reported, not thrown", await run(at(20, 8, 0)), ["error"]);
check("... in the note, in words", store.getWatch(er.id).note, "Could not check: the flight provider says the quota is used up.");
check("... and the floor still holds (no hammering a failing provider)", await run(at(20, 8, 10)), ["throttled"]);
flightQueue = [status()];
check("the next poll after the floor recovers", await run(at(20, 8, 30)), ["seeded"]);
flightQueue = [null];
check("a provider that does not know the flight yet is 'unknown'", await run(at(20, 9, 0)), ["unknown"]);
check("... with a note", store.getWatch(er.id).note, "The provider does not know this flight yet.");
flightsOn = false;
check("an unconfigured provider is reported, and nothing is called", await run(at(20, 9, 30)), ["unconfigured"]);
check("... the note says how to fix it", store.getWatch(er.id).note.includes("Tracking starts once it is"), true);
flightsOn = true;
check("past the window the watch just ends", await run(at(21, 3, 0)), ["ended"]);
check("... marked finished", [store.getWatch(er.id).active, store.getWatch(er.id).note], [0, "Finished."]);

console.log("\nall-day flights\n");
const ad = offer(cand("flight", "Flight UA 482", "flight:allday", { flightNumber: "UA 482", startsAt: "2026-11-25" }));
enableWatch(ledger.getById(ad.id), at(18, 8));
for (const w of store.activeWatches()) if (w.headsup_id !== ad.id) store.endWatch(w.id, "parked");
const adw = store.getWatch(ad.id);
check("an all-day flight is flagged", JSON.parse(adw.spec).allDay, true);
check("its window is the whole day, through the next morning", windowOf(adw), [at(25, 0).getTime(), at(25, 0).getTime() + 30 * 3_600_000]);
flightQueue = [status()];
check("the day before: nothing", await run(at(24, 23, 0)), ["before"]);
check("the day itself: polled", await run(at(25, 9, 0)), ["seeded"]);

console.log("\ndrives\n");
const apt = offer(cand("appointment", "Dentist", "apt:1", { location: "12 Dentist Ave", startsAt: iso(22, 15) }));
const ae = enableWatch(ledger.getById(apt.id), at(18, 8));
check("a located appointment gets a drive watch", [ae.created, ae.kind, ae.note.startsWith("Watching traffic")], [true, "drive", true]);
const ds = driveSpecFor(ledger.getById(apt.id));
check("with its destination and start", [ds.destination, ds.title], ["12 Dentist Ave", "Dentist"]);
check("an appointment with no place has nothing to watch", driveSpecFor(ledger.getById(offer(cand("appointment", "Checkup", "apt:2", { startsAt: iso(22, 16) })).id)), null);
check("an all-day appointment has nothing to time a drive to", driveSpecFor(ledger.getById(offer(cand("appointment", "Checkup", "apt:3", { location: "x", startsAt: "2026-11-22" })).id)), null);
for (const w of store.activeWatches()) if (w.headsup_id !== apt.id) store.endWatch(w.id, "parked");
check("its window is the three hours before it starts", windowOf(store.getWatch(apt.id)), [at(22, 12).getTime(), at(22, 15).getTime()]);
reset();
driveTimes = [{ minutes: 38, typicalMinutes: 25 }];
check("before the window: nothing", await run(at(22, 11, 0)), ["before"]);
check("... no calls", [driveCalls.geocode, driveCalls.route], [0, 0]);
check("12:00, three hours out, nowhere near time to leave: record only", await run(at(22, 12, 0)), ["seeded"]);
check("... both ends geocoded and one route", [driveCalls.geocode, driveCalls.route, budget.used("travel", "2026-11-22")], [2, 1, 3]);
check("... nothing sent yet", sent.length, 0);
check("30 minutes later, addresses are cached", [await run(at(22, 12, 30)), driveCalls.geocode, budget.used("travel", "2026-11-22")], [["seeded"], 2, 4]);
// leave-by = 15:00 - 38 - 10 = 14:12. The first notice comes an hour before: 13:12.
check("at 13:00 it is still more than an hour before leaving", await run(at(22, 13, 0)), ["seeded"]);
check("at 13:15, within the hour, the first notice", await run(at(22, 13, 30)), ["notified"]);
check("... 'Leave by 2:12 PM'", sent.at(-1).title.startsWith("Leave by 2:12"), true);
check("... with the drive, and what it usually is", sent.at(-1).body, "38 min with traffic (usually 25) to Dentist.");
driveTimes = [{ minutes: 41, typicalMinutes: 25 }];
check("38 -> 41 minutes (same bucket) is silent", await run(at(22, 14, 0)), ["unchanged"]);
driveTimes = [{ minutes: 55, typicalMinutes: 25 }];
check("38 -> 55 minutes notifies", await run(at(22, 14, 30)), ["notified"]);
check("... against what you were TOLD (38), not the silent 41 in between", sent.at(-1).body, "Now 55 min (was 38). Dentist.");
check("... with the new leave-by", sent.at(-1).title.startsWith("Traffic changed: leave by 1:55"), true);
check("... and because it is already past time to go, it is urgent", sent.at(-1).opts.priority, 4);
check("the floor still holds for a drive", await run(at(22, 14, 59)), ["throttled"]);
check("after the event starts it ends", await run(at(22, 15, 5)), ["ended"]);

console.log("\na drive that changes BEFORE it is time to go, then runs late\n");
const apt5 = offer(cand("appointment", "Recital", "apt:r", { location: "7 Hall Rd", startsAt: iso(26, 16) }));
enableWatch(ledger.getById(apt5.id), at(18, 8));
for (const w of store.activeWatches()) if (w.headsup_id !== apt5.id) store.endWatch(w.id, "parked");
reset();
// leave-by starts at 16:00 - 30 - 10 = 15:20, so the first notice is due from 14:20.
driveTimes = [{ minutes: 30, typicalMinutes: 30 }, { minutes: 30, typicalMinutes: 30 }, { minutes: 30, typicalMinutes: 30 }, { minutes: 30, typicalMinutes: 30 }, { minutes: 45, typicalMinutes: 30 }];
check("13:00 (window opens): record", await run(at(26, 13, 0)), ["seeded"]);
check("13:30: record", await run(at(26, 13, 30)), ["seeded"]);
check("14:00: still more than an hour before leaving", await run(at(26, 14, 0)), ["seeded"]);
check("14:30: inside the hour, so the first notice", await run(at(26, 14, 30)), ["notified"]);
check("... 'Leave by 3:20 PM', ordinary priority", [sent.at(-1).title, sent.at(-1).opts.priority], ["Leave by 3:20 PM", 3]);
check("15:00: traffic worsens to 45 minutes before it is time to go", await run(at(26, 15, 0)), ["notified"]);
check("... 'Traffic changed', not urgent yet", [sent.at(-1).title, sent.at(-1).opts.priority], ["Traffic changed: leave by 3:05 PM", 3]);
check("15:30: same 45 minutes, and the moment to leave has passed", await run(at(26, 15, 30)), ["notified"]);
check("... 'Time to leave', urgent", [sent.at(-1).title, sent.at(-1).opts.priority], ["Time to leave", 4]);
check("15:50: throttled, so it does not say it twice", await run(at(26, 15, 50)), ["throttled"]);
check("... and the watch remembers it has said so (late: true)", store.parseState(store.getWatch(apt5.id)).late, true);
check("after the event: ended", await run(at(26, 16, 5)), ["ended"]);

console.log("\ndrive failure modes\n");
const apt2 = offer(cand("appointment", "Vet", "apt:v", { location: "9 Vet Ln", startsAt: iso(23, 15) }));
enableWatch(ledger.getById(apt2.id), at(18, 8));
for (const w of store.activeWatches()) if (w.headsup_id !== apt2.id) store.endWatch(w.id, "parked");
reset();
driveTimes = [new Error("the routing provider rejected the key")];
check("a routing error is reported in words", await run(at(23, 12, 0)), ["error"]);
check("... without hammering", await run(at(23, 12, 5)), ["throttled"]);
driveTimes = [{ minutes: 20, typicalMinutes: 20 }];
travelOn = false;
const routeBefore = driveCalls.route;
check("unconfigured: reported, no call", [await run(at(23, 12, 40)), driveCalls.route - routeBefore], [["unconfigured"], 0]);
travelOn = true; home = "";
check("no home address: reported", await run(at(23, 12, 40)), ["unconfigured"]);
home = "1 Home Rd";
limits = { flightsPerMonth: 400, travelPerDay: budget.used("travel", "2026-11-23") };
check("an exhausted daily budget pauses it", await run(at(23, 13, 10)), ["budget"]);
check("... with one notice", sent.filter((s) => s.title === "Drive watching paused").length, 1);
limits = { flightsPerMonth: 400, travelPerDay: 1000 };
const apt3 = offer(cand("appointment", "Gym", "apt:g", { location: "unfindable place", startsAt: iso(23, 17) }));
enableWatch(ledger.getById(apt3.id), at(18, 8));
for (const w of store.activeWatches()) if (w.headsup_id !== apt3.id) store.endWatch(w.id, "parked");
const geocodeNull = { ...deps(), travel: () => ({ geocode: async () => null, route: async () => ({ minutes: 1, typicalMinutes: 1 }) }) };
check("an address it cannot find is 'unknown'", (await runWatchLoop(at(23, 14, 30), geocodeNull))[0].outcome, "unknown");
check("... with a note", store.getWatch(apt3.id).note, "Could not find one of the addresses.");

console.log("\nquiet hours hold drive notices (a drive is never an emergency)\n");
const apt4 = offer(cand("appointment", "Early", "apt:early", { location: "5 Early St", startsAt: iso(24, 6, 30) }));
enableWatch(ledger.getById(apt4.id), at(18, 8));
for (const w of store.activeWatches()) if (w.headsup_id !== apt4.id) store.endWatch(w.id, "parked");
reset();
driveTimes = [{ minutes: 20, typicalMinutes: 20 }];
check("at 5:30am, within the hour of leaving, it is held", await run(at(24, 5, 30)), ["quiet"]);
check("... nothing sent", sent.length, 0);
check("at 6:05 it says it", await run(at(24, 6, 5)), ["notified"]);

console.log("\nwatched items stay on the list\n");
ledger.answer(f1.id, "yes", at(18, 8));
check("the flight is now accepted", ledger.getById(f1.id).state, "accepted");
check("... and stays on the open list, so its live status is visible", ledger.listForClient("open").some((v) => v.id === f1.id), true);
const plainBill = offer(cand("bill", "Plain bill", "bill:plain"));
ledger.answer(plainBill.id, "yes", at(18, 8));
check("a plain acknowledged bill leaves it", ledger.listForClient("open").some((v) => v.id === plainBill.id), false);

console.log("\nwhat a client sees\n");
const view = ledger.toView(ledger.getById(f1.id));
check("the view carries what Yes does", [view.yesAction, view.yesLabel], ["watch", "Yes, track this flight"]);
check("... and the watch", [view.watch.kind, view.watch.active], ["flight", false]);
check("... which has a note and a last-polled time", [typeof view.watch.note, typeof view.watch.lastPolled], ["string", "string"]);
const aptView = ledger.toView(ledger.getById(apt.id));
check("an appointment with a place offers to watch traffic (a routing key and home are set)", [aptView.yesAction, aptView.yesLabel], ["watch", "Yes, watch traffic"]);
check("a bill offers nothing special", ledger.toView(ledger.getById(offer(cand("bill", "Rent", "bill:v")).id)).yesLabel, "Got it");
check("an item with no watch has none", ledger.toView(ledger.getById(offer(cand("birthday", "Mia", "b:v")).id)).watch, null);
check("no token or internal spec leaks into the view", /answer_token|"spec"|headsupToken/.test(JSON.stringify(view)), false);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
