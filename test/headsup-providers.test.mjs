/**
 * Flight and routing providers: parsing, fingerprints, call budgets, and the two properties that
 * matter most for code that holds API keys: the key never leaks into an error, and a feed that
 * wobbles does not cry wolf. Run with `node test/headsup-providers.test.mjs`.
 *
 * The provider JSON here is written from each provider's published schema. It has NOT been checked
 * against a live key. The parsers are tolerant for that reason, and these tests pin the tolerance:
 * every field optional, an unknown status is "unknown", an empty answer is null.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-prov-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");

const f = await import("../src/headsup/watch/flight.ts");
const t = await import("../src/headsup/watch/travel.ts");
const b = await import("../src/headsup/watch/budget.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nfinding a flight number\n");
const num = (s) => f.parseFlightNumber(s)?.display ?? null;
check("with a space", num("Flight to Denver UA 482"), "UA 482");
check("without one", num("UA482 AVL to DEN"), "UA 482");
check("a letter-digit airline code (B6, 3K)", [num("Flight B6 1234"), num("Flight 3K 502")], ["B6 1234", "3K 502"]);
check("the code a provider wants has no space", f.parseFlightNumber("DL 1090").code, "DL1090");
check("a time is not a flight: 'AM 30'", num("Flight at 10 AM 30 people"), null);
check("a timezone is not a flight: 'ET 2026'", num("Flight lands ET 2026"), null);
check("two digits alone are not an airline", num("Flight 20 25"), null);
check("lowercase is not an airline code", num("flight to denver ua 482"), null);
check("the first real one wins", num("Flight AA 100 (codeshare DL 5500)"), "AA 100");
check("a bad candidate does not stop the search", num("Flight PM 99 then UA 482"), "UA 482");
check("a trailing letter on the number is tolerated", num("Flight UA 482A"), "UA 482");
check("nothing", num("Dentist 3pm"), null);
check("empty and junk", [num(""), f.parseFlightNumber(undefined)], [null, null]);

console.log("\nparsing AeroDataBox\n");
const adb = (over = {}, dep = {}, arr = {}) => ({
  airline: { name: "United" },
  arrival: { airport: { iata: "DEN" }, gate: "41", scheduledTime: { utc: "2026-11-20 19:10Z" }, terminal: "", ...arr },
  departure: { airport: { iata: "AVL" }, gate: "B12", scheduledTime: { local: "2026-11-20 10:00-05:00", utc: "2026-11-20 15:00Z" }, terminal: "A", ...dep },
  number: "UA 482",
  status: "Expected",
  ...over,
});
const ok = f.parseAeroDataBox([adb()], "2026-11-20");
check("an on-time flight", [ok.phase, ok.delayMinutes, ok.departureGate, ok.departureTerminal, ok.departureAirport, ok.arrivalAirport], ["scheduled", 0, "B12", "A", "AVL", "DEN"]);
check("times become ISO", [ok.scheduledDeparture, ok.estimatedDeparture], ["2026-11-20T15:00:00.000Z", "2026-11-20T15:00:00.000Z"]);
const late = f.parseAeroDataBox([adb({ status: "Delayed" }, { revisedTime: { utc: "2026-11-20 15:45Z" } })], "2026-11-20");
check("a revised time gives the delay in minutes", [late.delayMinutes, late.estimatedDeparture], [45, "2026-11-20T15:45:00.000Z"]);
check("a predicted time counts when there is no revised one", f.parseAeroDataBox([adb({}, { predictedTime: { utc: "2026-11-20 15:20Z" } })], "2026-11-20").delayMinutes, 20);
check("departing EARLY is not a negative delay", f.parseAeroDataBox([adb({}, { revisedTime: { utc: "2026-11-20 14:50Z" } })], "2026-11-20").delayMinutes, 0);
check("the arrival estimate", f.parseAeroDataBox([adb({}, {}, { revisedTime: { utc: "2026-11-20 19:50Z" } })], "2026-11-20").estimatedArrival, "2026-11-20T19:50:00.000Z");
const status = (s) => f.parseAeroDataBox([adb({ status: s })], "2026-11-20").phase;
check("statuses: Canceled", status("Canceled"), "cancelled");
check("... CanceledUncertain", status("CanceledUncertain"), "cancelled");
check("... Diverted", status("Diverted"), "diverted");
check("... Arrived", status("Arrived"), "landed");
check("... EnRoute and Departed", [status("EnRoute"), status("Departed")], ["airborne", "airborne"]);
check("... Boarding, CheckIn, GateClosed, Expected", [status("Boarding"), status("CheckIn"), status("GateClosed"), status("Expected")], ["scheduled", "scheduled", "scheduled", "scheduled"]);
check("... an unheard-of status is unknown, not an error", status("Teleported"), "unknown");
const two = f.parseAeroDataBox([adb({}, { scheduledTime: { local: "2026-11-19 10:00-05:00", utc: "2026-11-19 15:00Z" }, gate: "X1" }), adb()], "2026-11-20");
check("with two flights it picks the one departing that day", two.departureGate, "B12");
check("a single object is accepted as well as an array", f.parseAeroDataBox(adb(), "2026-11-20")?.departureAirport, "AVL");
check("an empty array is null", f.parseAeroDataBox([], "2026-11-20"), null);
check("null and junk are null", [f.parseAeroDataBox(null, "x"), f.parseAeroDataBox("nope", "x"), f.parseAeroDataBox(7, "x")], [null, null, null]);
const bare = f.parseAeroDataBox([{}], "2026-11-20");
check("a record with nothing in it does not throw", [bare.phase, bare.departureGate, bare.delayMinutes], ["unknown", "", 0]);

console.log("\nfingerprints and what to say\n");
const S = (over = {}) => ({ ...ok, ...over });
check("12 and 17 minutes late are the same fingerprint", f.flightFingerprint(S({ delayMinutes: 12 })), f.flightFingerprint(S({ delayMinutes: 17 })));
check("... 7 minutes and 8 round apart (8 -> 15)", f.flightFingerprint(S({ delayMinutes: 7 })) === f.flightFingerprint(S({ delayMinutes: 8 })), false);
check("0 and 5 minutes late are both on time", f.flightFingerprint(S({ delayMinutes: 0 })), f.flightFingerprint(S({ delayMinutes: 5 })));
check("a gate change changes it", f.flightFingerprint(S()) === f.flightFingerprint(S({ departureGate: "C4" })), false);
check("a terminal change changes it", f.flightFingerprint(S()) === f.flightFingerprint(S({ departureTerminal: "B" })), false);
check("a status change changes it", f.flightFingerprint(S()) === f.flightFingerprint(S({ phase: "cancelled" })), false);
check("the ARRIVAL gate does not (it is not what you are watching for)", f.flightFingerprint(S()), f.flightFingerprint(S({ arrivalGate: "99" })));
check("bucketMinutes rounds to the nearest step", [f.bucketMinutes(12, 15), f.bucketMinutes(22, 15), f.bucketMinutes(23, 15), f.bucketMinutes(-5, 15)], [15, 15, 30, 0]);
const say = (prev, cur) => f.describeFlightChange(prev, cur);
check("cancelled", say(ok, S({ phase: "cancelled" })), ["Cancelled."]);
check("diverted", say(ok, S({ phase: "diverted" })), ["Diverted."]);
check("landed, with a gate", say(ok, S({ arrivalGate: "41", phase: "landed" })), ["Landed, gate 41."]);
check("a delay says how late and when", say(ok, S({ delayMinutes: 45, estimatedDeparture: "2026-11-20T15:45:00.000Z" }))[0].startsWith("45 min late. Now departing about"), true);
check("a long delay reads in hours", say(ok, S({ delayMinutes: 90 }))[0].startsWith("1 h 30 min late"), true);
check("back on time", say(S({ delayMinutes: 45 }), S({ delayMinutes: 0 })), ["Back on time."]);
check("a gate change names both gates", say(ok, S({ departureGate: "C4" })), ["Gate changed from B12 to C4."]);
check("a first gate is just stated", say({ ...ok, departureGate: "" }, S()), ["Gate B12."]);
check("a terminal change", say(ok, S({ departureTerminal: "B" })), ["Terminal changed from A to B."]);
check("departed", say(ok, S({ phase: "airborne" })), ["Departed."]);
check("nothing changed says nothing", say(ok, S()), []);
check("a wobble inside a bucket says nothing", say(S({ delayMinutes: 12 }), S({ delayMinutes: 17 })), []);

console.log("\nthe flight client, with fetch stubbed\n");
const realFetch = globalThis.fetch;
const KEY = "sk_live_SECRET_KEY_123";
let lastReq = null;
const stub = (status, body, throws) => { globalThis.fetch = async (url, init) => { lastReq = { init, url: String(url) }; if (throws) throw new Error(`connect ECONNREFUSED ${url}`); return { json: async () => body, ok: status >= 200 && status < 300, status }; }; };
const adbSrc = f.aeroDataBox(KEY);
const FL = { code: "UA482", display: "UA 482" };
stub(200, [adb()]);
check("a good answer is parsed", (await adbSrc.lookup(FL, "2026-11-20")).departureGate, "B12");
check("the key travels in a header", lastReq.init.headers["X-RapidAPI-Key"], KEY);
check("... and never in the URL", lastReq.url.includes(KEY), false);
check("the URL names the flight and date", lastReq.url.includes("/flights/number/UA482/2026-11-20"), true);
stub(204, null); check("204 is 'nothing yet', not an error", await adbSrc.lookup(FL, "2026-11-20"), null);
stub(404, null); check("404 is the same", await adbSrc.lookup(FL, "2026-11-20"), null);
const err = async (fn) => { try { await fn(); return "no error"; } catch (e) { return e.message; } };
stub(401, null); const m401 = await err(() => adbSrc.lookup(FL, "2026-11-20"));
check("a rejected key says so", m401, "the flight provider rejected the key");
check("... without the key", m401.includes(KEY), false);
stub(429, null); check("a quota error says so", await err(() => adbSrc.lookup(FL, "2026-11-20")), "the flight provider says the quota is used up");
stub(500, null); check("a server error names the status", await err(() => adbSrc.lookup(FL, "2026-11-20")), "the flight provider answered HTTP 500");
stub(200, null, true); const mnet = await err(() => adbSrc.lookup(FL, "2026-11-20"));
check("a network failure does not leak the key via the URL", mnet.includes(KEY), false);

console.log("\nparsing TomTom\n");
check("a geocode", t.parseGeocode({ results: [{ position: { lat: 35.6, lon: -82.55 } }] }), { lat: 35.6, lon: -82.55 });
check("no results", t.parseGeocode({ results: [] }), null);
check("garbage coordinates are refused", [t.parseGeocode({ results: [{ position: { lat: 999, lon: 0 } }] }), t.parseGeocode({ results: [{ position: { lat: "x", lon: 1 } }] })], [null, null]);
check("junk", [t.parseGeocode(null), t.parseGeocode("x")], [null, null]);
check("a route in minutes, with and without traffic", t.parseRoute({ routes: [{ summary: { noTrafficTravelTimeInSeconds: 1500, travelTimeInSeconds: 2280 } }] }), { minutes: 38, typicalMinutes: 25 });
check("no typical time falls back to the live one", t.parseRoute({ routes: [{ summary: { travelTimeInSeconds: 600 } }] }), { minutes: 10, typicalMinutes: 10 });
check("no route", [t.parseRoute({ routes: [] }), t.parseRoute({}), t.parseRoute({ routes: [{ summary: { travelTimeInSeconds: 0 } }] })], [null, null, null]);

console.log("\nthe TomTom client, with fetch stubbed\n");
const tt = t.tomTom(KEY);
stub(200, { results: [{ position: { lat: 1, lon: 2 } }] });
check("geocode works", await tt.geocode("12 Main St"), { lat: 1, lon: 2 });
check("the address is encoded", lastReq.url.includes("12%20Main%20St"), true);
stub(200, { routes: [{ summary: { noTrafficTravelTimeInSeconds: 600, travelTimeInSeconds: 900 } }] });
check("a route works", await tt.route({ lat: 1, lon: 2 }, { lat: 3, lon: 4 }), { minutes: 15, typicalMinutes: 10 });
check("traffic is asked for", lastReq.url.includes("traffic=true"), true);
check("the coordinates are in the path", lastReq.url.includes("/calculateRoute/1,2:3,4/json"), true);
stub(401, null); const t401 = await err(() => tt.route({ lat: 1, lon: 2 }, { lat: 3, lon: 4 }));
check("a rejected key says so, without the key", [t401, t401.includes(KEY)], ["the routing provider rejected the key", false]);
stub(200, null, true); const tnet = await err(() => tt.geocode("x"));
check("a network failure carries no URL and so no key", [tnet, tnet.includes(KEY)], ["the routing provider could not be reached", false]);
stub(200, { routes: [] }); check("no route is an error", await err(() => tt.route({ lat: 1, lon: 2 }, { lat: 3, lon: 4 })), "the routing provider found no route");
globalThis.fetch = realFetch;

console.log("\ndrive estimates, caching and spending\n");
const calls = { geocode: 0, route: 0 };
const fake = { geocode: async (a) => { calls.geocode++; return a.includes("nowhere") ? null : { lat: a.length, lon: 1 }; }, route: async () => { calls.route++; return { minutes: 38, typicalMinutes: 25 }; } };
const cache = new Map();
let spent = 0;
const io = { cacheGet: (k) => cache.get(k), cacheSet: (k, v) => cache.set(k, v), spend: (n) => { spent += n; } };
const e1 = await t.estimateDrive(fake, "1 Home Rd", "2 Dentist Ave", io);
check("a first estimate geocodes both ends and routes", [e1, calls.geocode, calls.route, spent], [{ minutes: 38, typicalMinutes: 25 }, 2, 1, 3]);
await t.estimateDrive(fake, "1 Home Rd", "2 Dentist Ave", io);
check("the second needs only the route (addresses are cached)", [calls.geocode, calls.route, spent], [2, 2, 4]);
check("the cache is not case or spacing sensitive", (await t.estimateDrive(fake, "  1  HOME rd ", "2 dentist AVE", io)) !== null && calls.geocode === 2, true);
check("an unfindable address gives null, and caches nothing for it", [await t.estimateDrive(fake, "1 Home Rd", "nowhere", io), cache.has("headsup:geocode:nowhere")], [null, false]);
const poisoned = new Map([["headsup:geocode:x", "{not json"]]);
check("a corrupt cache entry is just a miss", (await t.locate(fake, "x", { cacheGet: (k) => poisoned.get(k), cacheSet: () => {}, spend: () => {} }))?.lon, 1);
check("drive fingerprint: 38 and 41 minutes are both 'about 40'", [t.driveFingerprint(38), t.driveFingerprint(41)], ["m40", "m40"]);
check("... 44 and 46 are not", t.driveFingerprint(44) === t.driveFingerprint(46), false);
const start = Date.UTC(2026, 10, 20, 20, 0);
check("leave-by is start minus drive minus buffer", t.leaveByMs(start, 38, 10), start - 48 * 60_000);

console.log("\ncall budgets\n");
const d0 = new Date(2026, 10, 18, 9, 0);
check("periods", [b.monthKey(d0), b.dayKey(d0)], ["2026-11", "2026-11-18"]);
check("nothing used to start", b.used("flight", "2026-11"), 0);
check("room under the limit", b.hasRoom("flight", "2026-11", 3), true);
b.spend("flight", "2026-11"); b.spend("flight", "2026-11"); b.spend("flight", "2026-11");
check("spending is counted", b.used("flight", "2026-11"), 3);
check("at the limit there is no room", b.hasRoom("flight", "2026-11", 3), false);
check("a bigger limit makes room", b.hasRoom("flight", "2026-11", 4), true);
check("a limit of 0 means none allowed", b.hasRoom("flight", "2026-12", 0), false);
check("a new period starts at zero", b.hasRoom("flight", "2026-12", 3), true);
check("budgets are per name", b.used("travel", "2026-11"), 0);
check("the notice is given once", [b.noticeGiven("flight", "2026-11"), (b.markNoticeGiven("flight", "2026-11"), b.noticeGiven("flight", "2026-11"))], [false, true]);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
