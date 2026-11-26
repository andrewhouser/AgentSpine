/**
 * Meetings on the line and answers that point at the moment (PLAN-open-work section 15, R4 and R5):
 * marks store a time and nothing else, the transcript around a moment, the line from your own history
 * (code only), the "not found" words, and a turn's sources read from what the knowledge tool printed.
 * Everyone here is invented.
 *
 * Run with `node test/meeting-moments.test.mjs`.
 */
import "./helpers/example-policy.mjs";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spine-moments-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.MEETING_SELF_NAMES = "Robin";

const store = await import("../src/memory/store.ts");
const meetings = await import("../src/meetings/store.ts");
const k = await import("../src/knowledge/store.ts");
const moments = await import("../src/meetings/moments.ts");
const { gatherEvidence, renderEvidence, notFoundWords, words } = await import("../src/knowledge/answer.ts");
const { citedIds, notFoundOf, sourcesForRuns } = await import("../src/knowledge/sources.ts");

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
const claim = (c) => {
  const id = k.addClaim({ method: "meeting-extraction", sourceKind: "meeting", ...c });
  k.reviewClaim(id, "accept");
  return id;
};

console.log("\nMARKS");
const m1 = meeting("1:1 Lee", "2026-11-18T15:00:00Z", ["Robin", "Lee Okafor"]);
const mark = moments.addMark(m1, 838_000, new Date("2026-11-18T15:14:00Z"));
check("a mark is a time and nothing else", Object.keys(mark).sort(), ["atMs", "created", "id"]);
check("listed by time", moments.listMarks(m1).map((x) => x.atMs), [838_000]);
check("a time that is not one is refused", [moments.addMark(m1, "soon"), moments.addMark(m1, -5), moments.addMark(m1, 90_000_000)], [null, null, null]);
check("a meeting that does not exist is refused", moments.addMark(99999, 1000), null);
check("a mark can be removed", [moments.deleteMark(m1, mark.id), moments.listMarks(m1).length], [true, 0]);
moments.addMark(m1, 5000);
meetings.deleteMeeting(m1);
check("marks go with their meeting", store.rawDb.prepare("SELECT COUNT(*) AS n FROM meeting_marks WHERE meeting_id = ?").get(m1).n, 0);

console.log("\nTHE TRANSCRIPT AROUND A MOMENT");
const m2 = meeting("1:1 Lee", "2026-11-18T15:00:00Z", ["Robin", "Lee Okafor"]);
const seg = (ord, start, end, text, speaker) =>
  store.rawDb.prepare("INSERT INTO meeting_segments (meeting_id, pass, ord, start_ms, end_ms, text, speaker) VALUES (?, 'final', ?, ?, ?, ?, ?)").run(m2, ord, start, end, text, speaker);
seg(0, 0, 5_000, "Morning.", 0);
seg(1, 800_000, 830_000, "The handoff doc is still three pages.", 1);
seg(2, 830_000, 870_000, "I'll have feedback on the write-up by Tuesday.", 0);
seg(3, 900_000, 920_000, "Thanks.", 1);
seg(4, 1_000_000, 1_010_000, "Next topic.", 1);
const near = moments.around(m2, 862_000);
check("a minute either side", near.map((l) => l.text), ["The handoff doc is still three pages.", "I'll have feedback on the write-up by Tuesday.", "Thanks."]);
check("the line the moment falls in is marked", near.map((l) => l.here), [false, true, false]);
check("with the names you gave the speakers", near.map((l) => l.speaker), ["Lee Okafor", "Robin", "Lee Okafor"]);

console.log("\nFROM YOUR HISTORY (code, not the coach)");
const owed = claim({ atMs: 862_000, due: "2026-11-24", kind: "commitment", owner: "me", passage: "I'll have feedback on the write-up by Tuesday.", sourceRef: `meeting:${m2}`, speaker: "Robin", text: "Feedback on the on-call write-up" });
const today = meeting("1:1 Lee", "2026-11-26T15:00:00Z", ["Robin", "Lee Okafor"]);
const lines = moments.historyFor(today, new Date("2026-11-26T15:05:00Z"));
check("what you still owe someone in the room", lines.map((l) => l.line), ["You told Lee Okafor you would: Feedback on the on-call write-up"]);
check("late, with the moment it was promised", [lines[0].late, lines[0].moment.atMs, lines[0].claimId], [true, 862_000, owed]);
check("a promise made in this meeting is not history", moments.historyFor(m2, new Date("2026-11-26T15:05:00Z")).length, 0);
const alone = meeting("Focus time", "2026-11-26T16:00:00Z", ["Robin"]);
check("no one named in the room: nothing is said", moments.historyFor(alone), []);
k.setClaimStatus(owed, "resolved");
check("a kept promise is not raised", moments.historyFor(today, new Date("2026-11-26T15:05:00Z")).length, 0);
k.setClaimStatus(owed, "active");

console.log("\nNOT FOUND, IN CODE");
const decided = claim({ kind: "decision", owner: "Sam Whitfield", passage: "Let's lock the third for the invoice cutover.", sourceRef: `meeting:${m2}`, speaker: "Sam Whitfield", text: "Invoice cutover on 3 February", topic: "invoice cutover" });
const ev = gatherEvidence("When is the invoice cutover, and who owns the data backfill?");
check("the claim that answers part of it is found", ev.reviewed.map((c) => c.id), [decided]);
check("the part nothing covers is named (\"owns\" restates a filter)", ev.notFound, ["data", "backfill"]);
check("and it is said to the model as not recorded", /NOT FOUND in the store: nothing recorded mentions .*backfill/.test(renderEvidence(ev)), true);
check("asking words are never a missing part", notFoundWords(words("should we decide about the backfill"), []), ["backfill"]);
check("an insufficient answer has no not-found line of its own", gatherEvidence("parking garage rates").notFound, []);

console.log("\nA TURN'S SOURCES");
const out = renderEvidence(ev);
check("the ids the tool printed", citedIds(out), [decided]);
check("the not-found words it printed", notFoundOf(out).includes("backfill"), true);
const conv = store.createConversation("Ask");
const run = store.startRun({ conversationId: conv, kind: "chat", task: "When is the cutover?" });
store.rawDb.prepare("INSERT INTO actions (ts, run_id, tool, args, decision, output) VALUES (?, ?, 'knowledge_claims', '{}', 'executed', ?)").run(new Date().toISOString(), run, out);
const src = sourcesForRuns([run]);
check("each source with its meeting moment", src.claims.map((c) => [c.claimId, c.reviewed, c.moment?.meetingId]), [[decided, true, m2]]);
check("and what was not found", src.notFound.includes("backfill"), true);
k.setClaimSensitive(decided, true);
check("a claim since marked sensitive is not shown", sourcesForRuns([run]).claims.length, 0);
const plain = store.startRun({ conversationId: conv, kind: "chat", task: "hi" });
check("a turn that asked the store nothing has no sources", sourcesForRuns([plain]), null);
check("ids come only from the tool's lines, never from prose", citedIds("The model said #99 was decided.\n- #12 decision: x"), [12]);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
