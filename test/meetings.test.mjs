/**
 * Meeting capture: the policy gate, the transcript store, and name corrections.
 *
 * The counts are the easy half. The assertions that matter are the refusals and the
 * fallbacks:
 *
 * **The policy gate must deny four different ways.** An empty `devices` list means NO
 * microphone, inverting the convention `browser.navigateAllowlist` uses — an empty allowlist
 * that means "everything" is fine for reading public web pages and is not fine for a
 * microphone, where the cost of being wrong lands on people who never agreed to be recorded.
 *
 * **A meeting whose final pass failed must keep its rough transcript.** Both passes are
 * stored, and `segments()` falls back to the live one, because a rough transcript is worth
 * far more than a clean error.
 *
 * **An orphaned recording must be reapable.** A `recording` row that outlived its process
 * would otherwise claim the microphone forever and block every future capture.
 *
 * Run with `node test/meetings.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-meetings-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
process.env.MEETING_CORRECTIONS = "PLOD=Claude,Vardant=Guardant,chat GPT=ChatGPT";

const store = await import("../src/meetings/store.ts");
const { checkAudioPolicy } = await import("../src/senses/listen.ts");
const { applyCorrections } = await import("../src/meetings/session.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(54)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const DEVICE = "MacBook Pro Microphone";

console.log("\nPOLICY GATE — deny by default, four ways");
check("absent section is denied", checkAudioPolicy({}, DEVICE).allowed, false);
check("enabled:false is denied", checkAudioPolicy({ audio: { devices: [DEVICE], enabled: false } }, DEVICE).allowed, false);
check(
  "empty devices means NO device, not any",
  checkAudioPolicy({ audio: { devices: [], enabled: true } }, DEVICE).allowed,
  false,
);
check(
  "a device off the list is denied",
  checkAudioPolicy({ audio: { devices: ["Other Mic"], enabled: true } }, DEVICE).allowed,
  false,
);
check(
  "the allowlisted device is allowed",
  checkAudioPolicy({ audio: { devices: [DEVICE], enabled: true } }, DEVICE).allowed,
  true,
);

console.log("\nCORRECTIONS — substitution, because a glossary prompt does not fix a misheard name");
check("a misheard product name is replaced", applyCorrections("we transitioned to PLOD in October"), "we transitioned to Claude in October");
check("case-insensitively", applyCorrections("we moved to Plod"), "we moved to Claude");
check("a multi-word term is replaced", applyCorrections("we had chat GPT and Codex"), "we had ChatGPT and Codex");
check("word boundaries are respected", applyCorrections("PLODDING along"), "PLODDING along");
check("untouched text passes through", applyCorrections("nothing to fix here"), "nothing to fix here");

console.log("\nSTORE — one microphone, one active session");
const first = store.startMeeting(DEVICE, null, "Standup");
check("a started meeting is the active one", store.activeMeeting()?.id, first);
check("it starts in recording", store.getMeeting(first).status, "recording");
check("with no project", store.getMeeting(first).project_id, null);

store.addSegment(first, "live", 0, 0, 5000, "rough words from the live pass");
check("live segments land", store.segments(first, "live").length, 1);

console.log("\nFALLBACK — a failed final pass must not lose the rough transcript");
check("asking for final falls back to live", store.transcriptText(first, "final"), "rough words from the live pass");

store.replacePass(first, "final", [
  { end_ms: 4000, start_ms: 0, text: "accurate words from the final pass" },
  { end_ms: 8000, start_ms: 4000, text: "and a second segment" },
]);
check("the final pass replaces nothing but itself", store.segments(first, "live").length, 1);
check("and is what final now returns", store.transcriptText(first, "final"), "accurate words from the final pass and a second segment");
check("word count is recorded", store.getMeeting(first).word_count, 10);

console.log("\nREPLACE — a second final pass supersedes the first rather than appending");
store.replacePass(first, "final", [{ end_ms: 2000, start_ms: 0, text: "redone" }]);
check("only the new segments remain", store.segments(first, "final").length, 1);
check("and the count follows", store.getMeeting(first).word_count, 1);

console.log("\nASSIGN AFTER — a meeting is filed once you know what it was about");
store.setProject(first, 42);
check("the project sticks", store.getMeeting(first).project_id, 42);
check("and it lists under that project", store.listMeetings(10, 42).length, 1);
check("but not under another", store.listMeetings(10, 7).length, 0);

console.log("\nORPHANS — a recording that outlived its process must not hold the microphone");
const second = store.startMeeting(DEVICE, null);
check("two rows claim to be recording", store.listMeetings(10).filter((m) => m.status === "recording").length, 2);
check("reaping reports both", store.reapOrphans(), 2);
check("nothing is active afterwards", store.activeMeeting(), undefined);
check("and they are marked abandoned", store.getMeeting(second).status, "abandoned");
check("with an end time filled in", typeof store.getMeeting(second).ended, "string");

console.log("\nRETENTION — transcripts go, the meetings they belonged to stay");
const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
const { rawDb } = await import("../src/memory/store.ts");
rawDb.prepare("UPDATE meetings SET started = ? WHERE id = ?").run(cutoff, first);
check("a dry run reports without deleting", store.pruneTranscripts(30, true) > 0, true);
check("segments are still there", store.segments(first, "final").length, 1);
const removed = store.pruneTranscripts(30);
check("the real run removes them", removed > 0, true);
check("the transcript is gone", store.segments(first, "final").length, 0);
check("the meeting row survives", store.getMeeting(first).id, first);
check("0 days keeps forever", store.pruneTranscripts(0), 0);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
