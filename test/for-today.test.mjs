/**
 * "For today" (PLAN-open-work section 15, R9), the code version with no model: what you owe first,
 * oldest first, then what they are waiting to hear (their questions nothing settled), then what they owe
 * you; and a 1:1 on the spine's line links to that person with the counts. Everyone is invented.
 *
 * Run with `node test/for-today.test.mjs`.
 */
import "./helpers/example-policy.mjs";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spine-fortoday-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.MEETING_SELF_NAMES = "Robin";

const store = await import("../src/memory/store.ts");
await import("../src/meetings/store.ts");
const k = await import("../src/knowledge/store.ts");
const cache = await import("../src/calendar-cache.ts");
const { personForEvent, readPerson, FOR_TODAY_MAX } = await import("../src/knowledge/people.ts");
const { readSpine } = await import("../src/day-line.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const meeting = (title, started, speakers) => {
  const id = Number(store.rawDb.prepare("INSERT INTO meetings (title, device, started, status) VALUES (?, 'test', ?, 'done')").run(title, started).lastInsertRowid);
  speakers.forEach((name, idx) => store.rawDb.prepare("INSERT INTO meeting_speakers (meeting_id, idx, name) VALUES (?,?,?)").run(id, idx, name));
  return id;
};
const claim = (mid, c) => {
  const id = k.addClaim({ method: "meeting-extraction", sourceKind: "meeting", sourceRef: `meeting:${mid}`, ...c });
  k.reviewClaim(id, "accept");
  return id;
};
const m1 = meeting("1:1 Lee", "2026-11-11T15:00:00Z", ["Robin", "Lee Okafor"]);
const m2 = meeting("1:1 Lee", "2026-11-18T15:00:00Z", ["Robin", "Lee Okafor"]);
const lee = k.upsertEntity("person", "Lee Okafor");
k.upsertEntity("person", "Lee Park");
k.upsertEntity("person", "Sam Whitfield");

claim(m2, { due: "2026-11-30", kind: "commitment", owner: "me", passage: "I'll send the intro.", speaker: "Robin", text: "Intro to the SRE lead" });
claim(m1, { due: "2026-11-15", kind: "commitment", owner: "me", passage: "Feedback by Friday.", speaker: "Robin", text: "Feedback on the write-up" });
claim(m1, { kind: "commitment", owner: "Lee Okafor", passage: "I'll shorten it.", speaker: "Lee Okafor", text: "Shorter handoff doc" });
claim(m1, { kind: "question", passage: "Can I lead the January review?", speaker: "Lee Okafor", text: "Can Lee lead the January incident review?", topic: "incident review lead" });
claim(m2, { kind: "question", passage: "What about the staff track?", speaker: "Lee Okafor", text: "What is the staff engineer track?", topic: "staff track" });
claim(m2, { kind: "decision", passage: "Yes, lead it.", speaker: "Robin", text: "Lee leads the January review", topic: "incident review lead" });

const NOW = new Date("2026-11-26T15:00:00Z");
const p = readPerson(lee.id, NOW);

console.log("\nFOR TODAY, IN CODE");
check("you owe first, oldest first, then waiting to hear, then they owe", p.forToday.map((f) => [f.kind, f.text]), [
  ["you-owe", "Feedback on the write-up"],
  ["you-owe", "Intro to the SRE lead"],
  ["waiting", "What is the staff engineer track?"],
  ["they-owe", "Shorter handoff doc"],
]);
check("a question a decision answered is not waiting", p.forToday.some((f) => f.text.startsWith("Can Lee lead")), false);
check("late is the server's", p.forToday[0].late, true);
check("each with its moment", p.forToday.every((f) => f.moment?.meetingId != null), true);
check("never more than a half hour's worth", FOR_TODAY_MAX, 8);

console.log("\nA 1:1 ON THE CALENDAR");
check("a 1:1 naming one known person", personForEvent("Lee Okafor / Robin 1:1"), lee.id);
check("a 1:1 by a full name only", personForEvent("1-on-1 with Sam Whitfield"), k.findEntity("Sam Whitfield").id);
check("a first name two people share is not guessed", personForEvent("Lee 1:1"), null);
check("a meeting that is not a 1:1 is not matched", personForEvent("Lee Okafor lunch"), null);
check("a name inside another word does not count", personForEvent("Fleet 1:1"), null);
cache.storeCalendar("headsup", [{ allDay: false, calendar: "Work", key: "a", start: "2026-11-26T20:00:00Z", title: "Lee Okafor 1:1" }, { allDay: false, calendar: "Work", key: "b", start: "2026-11-26T21:00:00Z", title: "Design review" }], new Date("2026-11-26T00:00:00Z"), new Date("2026-11-28T00:00:00Z"), NOW);
const ahead = readSpine(NOW).ahead.filter((a) => a.kind === "event");
check("the spine's 1:1 row links to the person, with the counts", ahead.map((a) => [a.title, a.personId ?? null, a.prep ?? null]), [
  ["Lee Okafor 1:1", lee.id, { theyOwe: 1, youOwe: 2 }],
  ["Design review", null, null],
]);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
