/**
 * A person (PLAN-open-work section 15, R7): which way a commitment runs, worked out at review and
 * correctable; what is open between you in both directions; what you have heard; 1:1s from meetings
 * and the stored calendar; your team first in the list. Everyone here is invented.
 *
 * Run with `node test/people.test.mjs`.
 */
import "./helpers/example-policy.mjs";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spine-people-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.MEETING_SELF_NAMES = "Robin Vale,Robin";

const store = await import("../src/memory/store.ts");
await import("../src/meetings/store.ts");
const k = await import("../src/knowledge/store.ts");
const cache = await import("../src/calendar-cache.ts");
const { dueGroups, listDue, listPeople, openBetween, readPerson } = await import("../src/knowledge/people.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const NOW = new Date("2026-11-26T15:00:00Z");
const meeting = (title, started, speakers) => {
  const id = Number(store.rawDb.prepare("INSERT INTO meetings (title, device, started, status) VALUES (?, 'test', ?, 'done')").run(title, started).lastInsertRowid);
  speakers.forEach((name, idx) => store.rawDb.prepare("INSERT INTO meeting_speakers (meeting_id, idx, name) VALUES (?,?,?)").run(id, idx, name));
  return id;
};
const lee = k.upsertEntity("person", "Lee Okafor");
const sam = k.upsertEntity("person", "Sam Whitfield");
const oneOnOne = meeting("1:1 Lee", "2026-11-18T15:00:00Z", ["Robin", "Lee Okafor"]);
const standup = meeting("Billing standup", "2026-11-19T14:00:00Z", ["Robin", "Lee Okafor", "Sam Whitfield"]);
const claim = (c) => {
  const id = k.addClaim({ method: "meeting-extraction", sourceKind: "meeting", ...c });
  k.reviewClaim(id, "accept");
  return k.getClaim(id);
};

console.log("\nWHICH WAY A COMMITMENT RUNS");
const mine1on1 = claim({ atMs: 862_000, due: "2026-11-24", kind: "commitment", owner: "me", passage: "I'll have feedback on the write-up by Tuesday.", sourceRef: `meeting:${oneOnOne}`, speaker: "Robin", text: "Feedback on the on-call write-up" });
check("yours, in a 1:1: owed to the other person", [mine1on1.owed_to_id, mine1on1.owed_to_me], [lee.id, 0]);
const theirs = claim({ kind: "commitment", owner: "Lee Okafor", passage: "I'll shorten the handoff doc.", sourceRef: `meeting:${oneOnOne}`, speaker: "Lee Okafor", text: "Shorter handoff doc" });
check("theirs: owed to you", [theirs.owed_to_id, theirs.owed_to_me], [null, 1]);
const mineRoom = claim({ kind: "commitment", owner: "me", passage: "I'll find an owner for the backfill.", sourceRef: `meeting:${standup}`, speaker: "Robin", text: "Find a backfill owner" });
check("yours, in a room of people: nobody in particular", [mineRoom.owed_to_id, mineRoom.owed_to_me], [null, 0]);
const askedBySam = claim({ kind: "commitment", owner: "me", passage: "Robin, can you send me the dry-run numbers?", sourceRef: `meeting:${standup}`, speaker: "Sam Whitfield", text: "Send Sam the dry-run numbers" });
check("yours, asked for by a named speaker: owed to them", askedBySam.owed_to_id, sam.id);
k.reviewClaim(mineRoom.id, "accept", { owedTo: "Lee Okafor" });
check("a person can correct it", k.getClaim(mineRoom.id).owed_to_id, lee.id);
k.reviewClaim(mineRoom.id, "accept", {});
check("and a later review without a direction keeps the correction", k.getClaim(mineRoom.id).owed_to_id, lee.id);
const decision = claim({ kind: "decision", owner: "Sam Whitfield", passage: "Let's lock the third.", sourceRef: `meeting:${standup}`, speaker: "Sam Whitfield", text: "Cutover on 3 February" });
check("only commitments get a direction", [decision.owed_to_id ?? null, decision.owed_to_me ?? null], [null, null]);
const newOne = meeting("1:1 Kai", "2026-11-20T15:00:00Z", ["Robin", "Kai Mendes"]);
const toKai = claim({ kind: "commitment", owner: "me", passage: "I'll send the offer letter.", sourceRef: `meeting:${newOne}`, speaker: "Robin", text: "Send Kai the offer letter" });
check("a speaker not yet in the store becomes a person at review", k.findEntity("Kai Mendes", ["person"])?.id === toKai.owed_to_id, true);
const before = k.listEntities("person").length;
readPerson(lee.id, NOW);
check("reading a page never adds anyone", k.listEntities("person").length, before);

console.log("\nOPEN BETWEEN YOU");
const person = readPerson(lee.id, NOW);
check("you owe Lee two things, Lee owes you one", person.open.map((o) => [o.direction, o.text]), [
  ["you-owe", "Feedback on the on-call write-up"],
  ["you-owe", "Find a backfill owner"],
  ["they-owe", "Shorter handoff doc"],
]);
check("a promise past its due date is late", person.open[0].late, true);
check("it carries the moment it was said", [person.open[0].moment.meetingTitle, person.open[0].moment.atMs, person.open[0].moment.quote], ["1:1 Lee", 862_000, "I'll have feedback on the write-up by Tuesday."]);
check("no audio kept, so no playback offered", person.open[0].moment.audio, false);
check("set by a person is not marked inferred", person.open[1].inferred, false);
const legacy = k.addClaim({ kind: "commitment", method: "manual", owner: "Lee Okafor", passage: "old", reviewState: "reviewed", sourceKind: "meeting", sourceRef: `meeting:${oneOnOne}`, text: "An old promise" });
check("an old row with no direction is inferred on read", openBetween(lee.id, k.reviewedActiveClaims(), NOW).find((o) => o.claimId === legacy)?.inferred, true);
k.setClaimSensitive(theirs.id, true);
check("a sensitive claim is left out", readPerson(lee.id, NOW).open.some((o) => o.claimId === theirs.id), false);
k.setClaimSensitive(theirs.id, false);
const proposed = k.addClaim({ kind: "commitment", method: "meeting-extraction", owner: "Lee Okafor", passage: "maybe", sourceKind: "meeting", sourceRef: `meeting:${oneOnOne}`, text: "Unreviewed" });
check("an unreviewed claim is left out", readPerson(lee.id, NOW).open.some((o) => o.claimId === proposed), false);

console.log("\nHEARD LATELY, AND 1:1s");
check("what Lee said or owns, newest first", readPerson(lee.id, NOW).heard.map((h) => h.text).includes("Shorter handoff doc"), true);
check("Sam's decision is not Lee's", readPerson(lee.id, NOW).heard.some((h) => h.text === "Cutover on 3 February"), false);
check("the last 1:1 is the meeting with only Lee", [person.lastOneToOne.meetingId, person.daysSince], [oneOnOne, 8]);
check("Sam has had no 1:1", readPerson(sam.id, NOW).lastOneToOne, null);
cache.storeCalendar("headsup", [{ allDay: false, calendar: "Work", key: "x", start: "2026-11-27T15:00:00Z", title: "Lee / Robin 1:1" }, { allDay: false, calendar: "Work", key: "y", start: "2026-11-27T16:00:00Z", title: "Lee lunch" }], new Date("2026-11-26T00:00:00Z"), new Date("2026-12-10T00:00:00Z"), NOW);
check("the next 1:1 comes from the stored calendar", readPerson(lee.id, NOW).nextOneToOne, { at: "2026-11-27T15:00:00Z", title: "Lee / Robin 1:1" });

console.log("\nTHE LIST");
check("you are not on it", listPeople(NOW).some((p) => p.name === "me" || p.name === "Robin"), false);
check("alphabetical with no team", listPeople(NOW).map((p) => p.name), ["Kai Mendes", "Lee Okafor", "Sam Whitfield"]);
k.setMyTeam(sam.id, true);
const list = listPeople(NOW);
check("your team first", list.map((p) => [p.name, p.onTeam]), [["Sam Whitfield", true], ["Kai Mendes", false], ["Lee Okafor", false]]);
check("with what is open each way", [list[2].youOwe, list[2].theyOwe], [2, 2]);
check("you owe Sam the dry-run numbers", [list[0].youOwe, list[0].theyOwe], [1, 0]);
check("a team flag on a non-person is refused", k.setMyTeam(k.upsertEntity("team", "Platform").id, true), false);
check("an unknown id has no page", readPerson(99999, NOW), null);

console.log("\nDUE (R12): what is owed, and whose");
const due = listDue(NOW);
const all = [...due.late, ...due.soon, ...due.later, ...due.undated];
check("every open item appears once, across everyone", all.length, list.reduce((n, p) => n + p.youOwe + p.theyOwe, 0));
check("the late one is first, with whose it is", due.late.map((d) => [d.text, d.personName, d.direction]), [["Feedback on the on-call write-up", "Lee Okafor", "you-owe"]]);
check("you are never the person on a row", all.some((d) => d.personName === "Robin"), false);
const item = (due, extra = {}) => ({ claimId: 1, direction: "you-owe", due, inferred: false, late: false, moment: null, personId: 1, personName: "Ada", text: "x", ...extra });
const g = dueGroups([item("2026-12-30", { claimId: 4 }), item(null, { claimId: 3 }), item("2026-11-28", { claimId: 2 }), item("2026-11-20", { claimId: 1, late: true })], NOW);
check("grouped late, this week, later, undated", [g.late, g.soon, g.later, g.undated].map((x) => x.map((d) => d.claimId)), [[1], [2], [4], [3]]);
check("a date it cannot read is undated, not lost", dueGroups([item("next sprint")], NOW).undated.length, 1);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
