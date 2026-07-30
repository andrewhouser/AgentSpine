/**
 * Live context cards: the parts that decide without embedding anything.
 *
 * The retrieval quality is a measurement, not an assertion — SPEC §15 carries the numbers,
 * including the noise floor that set the threshold. What is asserted here is the machinery
 * that decides *whether a card is shown at all*, because those are the choices that make the
 * panel worth glancing at:
 *
 * **A card with nothing strong in it must render as nothing.** A cosine sweep always returns
 * something; the top three chunks of an unrelated corpus are still its top three. Padding a
 * card to k teaches you to stop reading it.
 *
 * **Two filters, because one does not do the job.** The absolute floor rejects an unrelated
 * corpus. It cannot reject a same-domain also-ran — measured, a passage about screenshots
 * scored 0.618 against a question about traceability purely for being in the same talk, while
 * the right passage scored 0.708. The relative gap is what separates those.
 *
 * **The window is the recent past, not the whole meeting.** Cards answer "what is being said
 * now"; querying with everything would drag them toward whatever dominated the first ten
 * minutes and get less responsive as the meeting ran on.
 *
 * Run with `node test/meeting-context.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-context-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
// Pinned rather than inherited: these assertions are about the *shape* of the filtering, and
// a .env that tuned the threshold should not turn the suite red.
process.env.MEETING_CARDS_MIN_SCORE = "0.58";
process.env.MEETING_CARDS_RELATIVE = "0.9";

const store = await import("../src/meetings/store.ts");
const { cardsFor, keepStrong, rollingWindow } = await import("../src/meetings/context.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const card = (score, text = "x") => ({ score, source: "s", text });

console.log("\nTHE FLOOR — an unrelated corpus must produce an empty card, not its best three");
check("everything below the floor is dropped", keepStrong([card(0.45), card(0.41), card(0.37)]).length, 0);
check("a hit on the floor is kept", keepStrong([card(0.58)]).length, 1);
check("generic chatter at 0.55 does not clear it", keepStrong([card(0.55)]).length, 0);
check("an empty ranking stays empty", keepStrong([]).length, 0);

console.log("\nTHE GAP — the floor cannot separate same-domain also-rans, so a fraction of the best does");
check(
  "the measured case: 0.708 kept, 0.618 and 0.611 dropped",
  keepStrong([card(0.708), card(0.618), card(0.611)]).map((c) => c.score),
  [0.708],
);
check(
  "a genuine cluster survives together",
  keepStrong([card(0.744), card(0.703)]).map((c) => c.score),
  [0.744, 0.703],
);
check("a lone strong hit is not dropped for being alone", keepStrong([card(0.9)]).length, 1);
check(
  "the gap is relative, so a high best raises the bar",
  keepStrong([card(0.95), card(0.8)]).map((c) => c.score),
  [0.95],
);

console.log("\nNaN — the keyword fallback cannot rank, so its hits are not passed off as matches");
check("a NaN score is dropped, not treated as strong", keepStrong([card(NaN)]).length, 0);
check("and does not drag a real hit down with it", keepStrong([card(0.7), card(NaN)]).map((c) => c.score), [0.7]);

console.log("\nWINDOW — the recent past, on segment boundaries");
const meetingId = store.startMeeting("Test Mic", null, "Long one");
// 10 segments, 8 seconds each: the meeting runs 0-80s.
for (let i = 0; i < 10; i++) store.addSegment(meetingId, "live", i, i * 8000, (i + 1) * 8000, `line ${i}`);

check("a wide window takes everything", rollingWindow(meetingId, 600).split(" ").length, 20);
check("a 30s window takes the tail", rollingWindow(meetingId, 30), "line 6 line 7 line 8 line 9");
check("it ends at the last thing said", rollingWindow(meetingId, 10).endsWith("line 9"), true);
check("a meeting with no words has no window", rollingWindow(store.startMeeting("Test Mic", null), 60), "");

console.log("\nTHE EARLY GUARD — a handful of filler words retrieves noise against any corpus");
const fresh = store.startMeeting("Test Mic", null, "Just started");
store.addSegment(fresh, "live", 0, 0, 3000, "Okay so um");
const early = await cardsFor(fresh);
check("under eight words returns nothing", [early.meetings.length, early.documents.length, early.memories.length], [0, 0, 0]);
check("and does not even record a query", early.query, "");

// Eight words is the gate, and this must not reach an embedder — no project, no memories in
// this scratch database, so retrieval has nothing to do and cannot make a network call.
const enough = store.startMeeting("Test Mic", null, "Real speech");
store.addSegment(enough, "live", 0, 0, 5000, "How do we link a requirement to its tests");
const ready = await cardsFor(enough);
check("eight words or more does retrieve", ready.query.length > 0, true);
check("a meeting with no project has no project-scoped cards", [ready.meetings.length, ready.documents.length], [0, 0]);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
