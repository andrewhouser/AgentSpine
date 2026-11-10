/**
 * Sentence splitting and speaker assignment — the rules that turn Whisper tokens plus
 * diarization turns into a readable transcript. No audio or models involved.
 * Run with `node test/meeting-speakers.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-speakers-${process.pid}.db`);
const { endsSentence, isHallucination, planClips, splitSentences, utterancesFromText } = await import("../src/meetings/utterances.ts");
const store = await import("../src/meetings/store.ts");
const { anchor, render, stripLabel } = await import("../src/meetings/extract.ts");

let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n    got      ${JSON.stringify(actual)}\n    expected ${JSON.stringify(expected)}`}`);
};

console.log("\nSENTENCE ENDS");
check("period ends", endsSentence("done."), true);
check("question mark ends", endsSentence("really?"), true);
check("quoted end", endsSentence('it."'), true);
check("abbreviation does not", endsSentence("Dr."), false);
check("initial does not", endsSentence("J."), false);
check("initialism does not", endsSentence("U.S."), false);
check("no punctuation does not", endsSentence("and"), false);

console.log("\nSPLITTING");
check("a window of several sentences splits", splitSentences("Hi all. Thanks for that. Any questions?"), ["Hi all.", "Thanks for that.", "Any questions?"]);
check("abbreviations stay inside a sentence", splitSentences("Ask Dr. Patel about it. Then go."), ["Ask Dr. Patel about it.", "Then go."]);
check("trailing words without a stop still land", splitSentences("One. and then"), ["One.", "and then"]);
const timed = utterancesFromText("Aaaa. Bbbbbbbb.", 1000, 3000, 1);
check("sentences share the span by length", timed.map((x) => [x.start_ms, x.end_ms, x.speaker]), [[1000, 1714, 1], [1714, 3000, 1]]);

console.log("\nCLIPS");
const turns = [
  { end: 3, speaker: 0, start: 0 },
  { end: 6, speaker: 0, start: 3.5 },
  { end: 9, speaker: 1, start: 6.2 },
  { end: 9.2, speaker: 0, start: 9.0 },
  { end: 15, speaker: 0, start: 12.5 },
];
check(
  "a speaker's near turns merge, tiny ones drop",
  planClips(turns, { mergeGapS: 1.5, minS: 0.4 }),
  [{ endMs: 6000, speaker: 0, startMs: 0 }, { endMs: 9000, speaker: 1, startMs: 6200 }, { endMs: 15000, speaker: 0, startMs: 12500 }],
);
check("a lone filler on a short clip is dropped", isHallucination("Thank you.", 600), true);
check("the same words on a long clip are kept", isHallucination("Thank you.", 5000), false);
check("real words on a short clip are kept", isHallucination("Ship it Friday.", 900), false);

console.log("\nSTORE, NAMES, RENDER");
const id = store.startMeeting("mic", null, "t");
store.replacePass(id, "final", [
  { end_ms: 3000, speaker: 0, start_ms: 0, text: "I will draft the plan." },
  { end_ms: 6000, speaker: 1, start_ms: 4000, text: "Sounds good to me." },
]);
check("default names", store.segments(id).map((s) => s.speaker_name), ["Speaker 1", "Speaker 2"]);
store.setSpeakerName(id, 0, "Priya");
check("renaming shows through", store.segments(id).map((s) => s.speaker_name), ["Priya", "Speaker 2"]);
check("speakers list", store.speakers(id), [{ index: 0, name: "Priya" }, { index: 1, name: "Speaker 2" }]);
check("render carries the label", render(store.segments(id)).split("\n")[0], "[0:00] Priya: I will draft the plan.");
store.setSpeakerName(id, 0, "  ");
check("an empty name clears it", store.segments(id)[0].speaker_name, "Speaker 1");
store.setSpeakerName(id, 0, "Priya");
check("a copied label is stripped from a quote", stripLabel("[0:00] Priya: I will draft the plan.", store.segments(id)), "I will draft the plan.");
check("a label-prefixed quote still anchors", anchor("Priya: I will draft the plan.", store.segments(id)), 0);

const live = store.startMeeting("mic", null, "live");
store.addSegment(live, "live", 0, 0, 1000, "no speaker here");
check("live pass has no speaker", store.segments(live, "live")[0].speaker_name, null);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
