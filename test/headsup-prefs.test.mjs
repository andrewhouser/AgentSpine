/**
 * Heads-up preferences: validation, and that they actually change what the morning job and the
 * watch loop do. Run with `node test/headsup-prefs.test.mjs`.
 *
 * A setting that saves but is ignored is worse than no setting, so most of this is "change it, then
 * watch the behaviour change".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-prefs-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.AERODATABOX_RAPIDAPI_KEY = "k";
process.env.POLICY_PATH = path.join(root, "policy.json");
fs.writeFileSync(process.env.POLICY_PATH, JSON.stringify({ autoExecute: { irreversibleAlwaysConfirm: true, reversible: true }, headsup: { flights: true }, version: 1 }));

const prefs = await import("../src/headsup/prefs.ts");
const { prefsForClient } = await import("../src/headsup/prefs-view.ts");
const { inQuietHours, DAILY_CAP } = await import("../src/headsup/rules.ts");
const { runMorningHeadsup } = await import("../src/headsup/morning.ts");
const { planOffers } = await import("../src/headsup/plan.ts");
const ledger = await import("../src/headsup/ledger.ts");
const store = await import("../src/headsup/watch/store.ts");
const { runWatchLoop } = await import("../src/headsup/watch/loop.ts");
const { enableWatch } = await import("../src/headsup/watch/enable.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const at = (day, h, m = 0) => new Date(2026, 10, day, h, m);
const dateStr = (n) => { const d = at(18 + n, 12); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

console.log("\ndefaults\n");
const d = prefs.getPrefs();
check("every kind is on", Object.values(d.kinds).every((v) => v === true) && Object.keys(d.kinds).length === 6, true);
check("the cap and quiet hours are the shipped defaults", [d.dailyCap, d.quietStartHour, d.quietEndHour], [DAILY_CAP, 21, 6]);
check("the client view adds the floor, and says what cannot run", [prefsForClient().floorMinutes, typeof prefsForClient().unavailable.drive], [30, "string"]);
check("flights are not blocked here (key and policy set)", prefsForClient().unavailable.flights, null);
check("drives are (no routing key)", prefsForClient().unavailable.drive, "Drive watching needs TOMTOM_API_KEY in .env.");

console.log("\nchanging them\n");
const ok = (patch) => prefs.updatePrefs(patch);
const err = (patch) => { const r = prefs.updatePrefs(patch); return r.ok ? "ACCEPTED" : r.error; };
check("turn a kind off", [ok({ kinds: { bill: false } }).ok, prefs.getPrefs().kinds.bill, prefs.getPrefs().kinds.birthday], [true, false, true]);
check("a kind can come back on", (ok({ kinds: { bill: true } }), prefs.getPrefs().kinds.bill), true);
check("the cap", (ok({ dailyCap: 5 }), prefs.getPrefs().dailyCap), 5);
check("quiet hours", (ok({ quietEndHour: 8, quietStartHour: 22 }), [prefs.getPrefs().quietStartHour, prefs.getPrefs().quietEndHour]), [22, 8]);
check("a partial change leaves the rest alone", (ok({ dailyCap: 2 }), [prefs.getPrefs().quietStartHour, prefs.getPrefs().dailyCap]), [22, 2]);
check("a change persists across reads", prefs.getPrefs().dailyCap, 2);

console.log("\nrefusing bad input, and changing nothing\n");
const before = JSON.stringify(prefs.getPrefs());
check("a cap of 0", err({ dailyCap: 0 }), "dailyCap must be a whole number from 1 to 10");
check("a cap of 11", err({ dailyCap: 11 }), "dailyCap must be a whole number from 1 to 10");
check("a fractional cap", err({ dailyCap: 2.5 }), "dailyCap must be a whole number from 1 to 10");
check("a text cap", err({ dailyCap: "lots" }), "dailyCap must be a whole number from 1 to 10");
check("hour 24", err({ quietStartHour: 24 }), "quietStartHour must be a whole hour from 0 to 23");
check("hour -1", err({ quietEndHour: -1 }), "quietEndHour must be a whole hour from 0 to 23");
check("an unknown kind", err({ kinds: { lunch: false } }), 'unknown kind "lunch"');
check("a non-boolean kind", err({ kinds: { bill: "no" } }), "kinds.bill must be true or false");
check("kinds that is not an object", err({ kinds: "all" }), "kinds must be an object like { birthday: false }");
check("a non-object patch", [err(null), err("x"), err(5)], ["send an object of settings to change", "send an object of settings to change", "send an object of settings to change"]);
check("a patch with one good and one bad field applies NOTHING", [err({ dailyCap: 7, quietStartHour: 99 }), JSON.stringify(prefs.getPrefs()) === before], ["quietStartHour must be a whole hour from 0 to 23", true]);
check("the floor cannot be set (it is not a setting, and an unknown field is ignored)", (ok({ floorMinutes: 1 }), prefsForClient().floorMinutes), 30);

console.log("\nstorage cannot make it misbehave\n");
const store0 = await import("../src/memory/store.ts");
store0.kvSet("headsup:prefs", "{not json");
check("corrupt storage means the defaults", [prefs.getPrefs().dailyCap, prefs.getPrefs().quietStartHour], [DAILY_CAP, 21]);
store0.kvSet("headsup:prefs", JSON.stringify({ dailyCap: 9999, kinds: { bill: false, lunch: false }, quietStartHour: "x" }));
check("out-of-range values are ignored one by one", [prefs.getPrefs().dailyCap, prefs.getPrefs().quietStartHour, prefs.getPrefs().kinds.bill], [DAILY_CAP, 21, false]);
check("an unknown kind in storage is dropped", "lunch" in prefs.getPrefs().kinds, false);
store0.kvSet("headsup:prefs", "{}");

console.log("\nquiet-hour windows\n");
check("21 to 6 wraps midnight (the default)", [inQuietHours(at(18, 22)), inQuietHours(at(18, 3)), inQuietHours(at(18, 12))], [true, true, false]);
check("1 to 6 sits inside a day", [inQuietHours(at(18, 3), 1, 6), inQuietHours(at(18, 0), 1, 6), inQuietHours(at(18, 6), 1, 6), inQuietHours(at(18, 22), 1, 6)], [true, false, false, false]);
check("start is inclusive and end is exclusive", [inQuietHours(at(18, 21), 21, 7), inQuietHours(at(18, 7), 21, 7), inQuietHours(at(18, 6, 59), 21, 7)], [true, false, true]);
check("equal hours mean no quiet hours at all", [inQuietHours(at(18, 3), 5, 5), inQuietHours(at(18, 12), 0, 0)], [false, false]);

console.log("\nthe morning job obeys them\n");
const ev = (id, title, n, over = {}) => ({ allDay: true, calendarId: "p", calendarName: "Me", description: "", eventType: "default", id, location: "", recurringEventId: "", start: dateStr(n), status: "confirmed", title, ...over });
let events = [];
const sent = [];
const deps = { fetchEvents: async () => ({ errors: [], events }), googleEnabled: () => true, remembered: () => [], send: async (title, body) => { sent.push([title, body]); } };
const run = (when, o) => runMorningHeadsup(when, o, deps);

events = [ev("b", "Garrett's Birthday", 5, { eventType: "birthday" }), ev("r", "Rent due $900", 4)];
prefs.updatePrefs({ kinds: { bill: false } });
const r1 = await run(at(18, 8), { force: true });
check("with bills turned off, only the birthday is offered", [r1.status, r1.offered, sent[0][1]], ["sent", 1, "Garrett's Birthday: in 5 days"]);
check("... and the bill never reached the ledger", ledger.listForClient("all").some((v) => v.kind === "bill"), false);
prefs.updatePrefs({ kinds: { bill: true } });
const r2 = await run(at(18, 8, 5), { force: true });
check("turned back on, it is offered", [r2.status, r2.offered], ["sent", 1]);
check("turning off every kind means nothing to say", (prefs.updatePrefs({ kinds: { anniversary: false, appointment: false, bill: false, birthday: false, flight: false, recurring: false } }), (await run(at(19, 8), { force: true })).status), "nothing");
prefs.updatePrefs({ kinds: { anniversary: true, appointment: true, bill: true, birthday: true, flight: true, recurring: true } });

// Run on the 22nd. dateStr counts from the 18th, so 5 here means one day after the run.
events = [ev("a", "Dentist appointment", 5), ev("b2", "Mia's Birthday", 6, { eventType: "birthday" }), ev("c", "Car rental due $50", 5), ev("d", "Vet appointment", 5)];
prefs.updatePrefs({ dailyCap: 1 });
const r3 = await run(at(22, 8), { force: true });
check("a daily cap of 1 offers one and defers the rest", [r3.offered, r3.deferred], [1, 3]);
prefs.updatePrefs({ dailyCap: 10 });
check("a cap of 10 lets the rest through next day", (await run(at(23, 8), { force: true })).offered >= 3, true);

console.log("\nthe planner takes the cap and quiet hours as arguments\n");
const cand = (i) => ({ daysUntil: 1, dedupeKey: `k${i}`, fingerprint: "", kind: "bill", location: "", sourceId: `k${i}`, startsAt: dateStr(1), subject: `Bill ${i}`, timeSensitive: false });
const dep = { get: () => undefined, muted: () => false };
check("an explicit cap", planOffers([cand(1), cand(2), cand(3)], dep, at(18, 8), 2).offers.length, 2);
check("the default cap is the shipped one", planOffers([1, 2, 3, 4, 5].map(cand), dep, at(18, 8)).offers.length, DAILY_CAP);
check("explicit quiet hours: 8am is quiet if you say 6 to 10", planOffers([cand(1)], dep, at(18, 8), 3, [6, 10]).offers.length, 0);
check("... and 8am is fine under the default", planOffers([cand(1)], dep, at(18, 8), 3).offers.length, 1);
check("explicit equal hours turn quiet hours off", planOffers([cand(1)], dep, at(18, 3), 3, [4, 4]).offers.length, 1);

console.log("\nthe watch loop obeys quiet hours too\n");
const sentW = [];
const wdeps = (flights) => ({ buffer: () => 10, flights: () => flights, home: () => "", limits: () => ({ flightsPerMonth: 400, travelPerDay: 1000 }), send: async (t, b, o) => { sentW.push({ b, o, t }); }, travel: () => null });
const dep0 = at(21, 5);
const fl = ledger.markOffered({ daysUntil: 1, dedupeKey: "fl:p", fingerprint: "", flightNumber: "UA 482", kind: "flight", location: "", sourceId: "fl", startsAt: "2026-11-21T05:00:00", subject: "Flight UA 482", timeSensitive: true }, 0, at(18, 8));
enableWatch(ledger.getById(fl.id), at(18, 8));
const st = (over = {}) => ({ arrivalAirport: "DEN", arrivalGate: "", arrivalTerminal: "", delayMinutes: 0, departureAirport: "AVL", departureGate: "B12", departureTerminal: "A", estimatedArrival: "", estimatedDeparture: dep0.toISOString(), phase: "scheduled", scheduledDeparture: dep0.toISOString(), ...over });
let queue = [st()];
const src = { lookup: async () => queue.length > 1 ? queue.shift() : queue[0] };
await runWatchLoop(at(20, 23, 30), wdeps(src));
queue = [st({ departureGate: "C4" })];
const q1 = (await runWatchLoop(at(21, 3, 0), wdeps(src)))[0].outcome;
check("by default a 3am gate change is held (quiet hours)", q1, "quiet");
// Move quiet hours so that 3am is NOT quiet: the same change now goes out.
prefs.updatePrefs({ quietEndHour: 2, quietStartHour: 1 });
queue = [st({ departureGate: "C4" })];
const q2 = (await runWatchLoop(at(21, 3, 40), wdeps(src)))[0].outcome;
check("with quiet hours moved to 1am-2am, the same 3:40am change is sent", [q2, sentW.at(-1)?.b], ["notified", "Gate changed from B12 to C4."]);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
