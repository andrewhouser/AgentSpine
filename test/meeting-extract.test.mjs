/**
 * Meeting extraction: the parts that decide things without asking a model.
 *
 * The LLM calls are not tested here and should not be — they need a server, they are not
 * deterministic, and their quality is a measurement rather than an assertion (SPEC §15 holds
 * the numbers). What IS tested is everything the model's output has to survive, because that
 * is the machinery standing between a confident wrong answer and your long-term memory:
 *
 * **Anchoring must reject a quote the transcript does not contain.** This is the free gate,
 * and it runs first precisely so a fabricated quote costs no inference. It has to be loose
 * enough that a model retyping a line from memory still matches — punctuation, case, a
 * dropped filler — and tight enough that eight consecutive words of invention do not.
 *
 * **An unreadable verdict must mean rejection.** `parseVerdict` defaults to `neither`, never
 * `commitment`. A garbled reply from the strict pass is not permission to put something in
 * front of a human as if it had passed.
 *
 * **Windowing must not lose the end of a transcript.** A long meeting that overruns the
 * context window loses its tail — which is where the decisions are.
 *
 * **Retention must take the quotes and leave the summary.** A summary describes a meeting; a
 * quote is a copy of it, and the 30-day window exists to remove copies.
 *
 * Run with `node test/meeting-extract.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-extract-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;

const store = await import("../src/meetings/store.ts");
const { anchor, normalize, parseProposal, parseVerdict, passageAround, render, windowSegments } = await import(
  "../src/meetings/extract.ts"
);

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(56)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

/** A transcript with the shape the Phase 0 measurement ran into: achievements, then one task. */
const seg = (ord, startMs, endMs, text) => ({ end_ms: endMs, id: ord + 1, ord, start_ms: startMs, text });
const TRANSCRIPT = [
  seg(0, 0, 5000, "So we came up with a set of guidelines for the team"),
  seg(1, 5000, 10000, "and then we went git native in the second quarter"),
  seg(2, 10000, 15000, "Priya will draft the migration plan before Friday"),
];

console.log("\nNORMALIZE — words only, because whisper's punctuation is a guess");
check("case and punctuation fall away", normalize("Git-native, in Q2!"), "git native in q2");
check("runs of whitespace collapse", normalize("  two   words  "), "two words");
check("an empty quote normalizes to empty", normalize("...!"), "");

console.log("\nANCHOR — the free gate: is this quote actually in the transcript?");
check("an exact quote anchors to its segment", anchor("Priya will draft the migration plan before Friday", TRANSCRIPT), 10000);
check("punctuation and case do not matter", anchor("priya WILL draft the migration plan, before friday!", TRANSCRIPT), 10000);
check("a short quote still anchors if it is exact", anchor("went git native", TRANSCRIPT), 5000);
check("a quote spanning two segments anchors to the first", anchor("guidelines for the team and then we went git native", TRANSCRIPT), 0);
check("an invented quote is refused", anchor("Jamie will rewrite the onboarding docs next week", TRANSCRIPT), null);
check("an empty quote is refused", anchor("   ", TRANSCRIPT), null);

console.log("\nANCHOR — the relaxation, which has to cut both ways");
check(
  "eight real words carry an invented tail",
  anchor("we came up with a set of guidelines that everyone signed off on", TRANSCRIPT),
  0,
);
check(
  "seven real words and a wrong one do not",
  anchor("we came up with a set of rules for the team", TRANSCRIPT),
  null,
);
check(
  "a short quote gets no relaxation — it matches half a transcript",
  anchor("we should do that", TRANSCRIPT),
  null,
);

console.log("\nWINDOWS — a transcript that overruns the context loses its END, where the decisions are");
check("a short transcript is one window", windowSegments(TRANSCRIPT, 1000).length, 1);
check("a long one splits on segment boundaries", windowSegments(TRANSCRIPT, 15).length, 3);
check("and keeps every segment", windowSegments(TRANSCRIPT, 15).flatMap((w) => w.segments).length, 3);
check("the last window carries the last segment", windowSegments(TRANSCRIPT, 15).at(-1).segments[0].ord, 2);
check("a segment longer than the budget still gets a window", windowSegments(TRANSCRIPT, 2).length, 3);
check("an empty transcript is no windows at all", windowSegments([], 100).length, 0);
check("windows carry their span", windowSegments(TRANSCRIPT, 15)[0].endMs, 5000);

console.log("\nPASSAGE — what the strict pass reads before it rules");
check("padding pulls in the neighbours", passageAround(TRANSCRIPT, 10_000, 1).split("\n").length, 2);
check("a wide pad takes the whole transcript", passageAround(TRANSCRIPT, 10_000, 600).split("\n").length, 3);
check("timestamps are on every line", render(TRANSCRIPT).startsWith("[0:00] So we came up"), true);

console.log("\nPROPOSALS — a local model's JSON is a best effort, not a contract");
const proposal = parseProposal(`Here you go:
{ "summary": "A team retro.",
  "topics": ["guidelines", "git"],
  "decisions": [{ "text": "Go git native", "quote": "we went git native" }],
  "workItems": [{ "task": "Draft the migration plan", "owner": "Priya", "quote": "Priya will draft", "confidence": "high" }] }`);
check("prose around the object is ignored", proposal.summary, "A team retro.");
check("topics come through", proposal.topics, ["guidelines", "git"]);
check("so do decisions", proposal.decisions.length, 1);
check("and work items", proposal.workItems[0].task, "Draft the migration plan");
check("an owner is kept", proposal.workItems[0].owner, "Priya");
check(
  "a volunteered confidence is dropped, not stored",
  Object.hasOwn(proposal.workItems[0], "confidence"),
  false,
);

const sparse = parseProposal(`{ "summary": "Nothing much.", "workItems": [{ "task": "", "quote": "x" }, { "task": "Real one", "owner": "", "quote": "y" }] }`);
check("missing keys read as empty, not as a crash", sparse.topics, []);
check("an item with no task is dropped", sparse.workItems.length, 1);
check("an empty owner becomes null", sparse.workItems[0].owner, null);
check("empty arrays are a normal answer", parseProposal(`{ "summary": "s", "topics": [], "workItems": [] }`).workItems, []);

console.log("\nVERDICTS — an unreadable ruling must mean rejection, never approval");
check("a commitment passes", parseVerdict(`{"verdict":"commitment","why":"will draft"}`).verdict, "commitment");
check("a past achievement is rejected", parseVerdict(`{"verdict":"done","why":"came up with"}`).verdict, "done");
check("so is a non-task", parseVerdict(`{"verdict":"neither"}`).verdict, "neither");
check("an unrecognised verdict is NOT a commitment", parseVerdict(`{"verdict":"probably yes"}`).verdict, "neither");
check("neither is unparseable output", parseVerdict("the model wandered off"), { verdict: "neither", why: "the verifier's reply could not be read" });
check("the reason survives", parseVerdict(`{"verdict":"done","why":"past tense"}`).why, "past tense");

console.log("\nSTORE — re-running supersedes, it does not accumulate");
const meetingId = store.startMeeting("Test Mic", null, "Retro");
store.replacePass(meetingId, "final", TRANSCRIPT.map((s) => ({ end_ms: s.end_ms, start_ms: s.start_ms, text: s.text })));
check("a final pass is distinguishable from a fallback", store.hasPass(meetingId, "final"), true);
check("and a live one that never ran is too", store.hasPass(meetingId, "live"), false);

store.startExtraction(meetingId, "test-model");
check("an extraction starts as running", store.getExtraction(meetingId).status, "running");
const kept = store.addWorkItem(meetingId, { owner: "Priya", quote: "Priya will draft", startMs: 10_000, task: "Draft the plan", verdict: "queued", verdictNote: "future" });
store.addWorkItem(meetingId, { owner: null, quote: "we went git native", startMs: 5000, task: "Go git native", verdict: "already-done", verdictNote: "past tense" });
store.addWorkItem(meetingId, { owner: null, quote: "invented", startMs: null, task: "Something else", verdict: "unanchored", verdictNote: "not in the transcript" });
store.setWorkItemConfirmation(kept, 77);

check("every candidate is kept, refusals included", store.workItems(meetingId).length, 3);
check("survivors sort first", store.workItems(meetingId)[0].verdict, "queued");
check("a queued item remembers its confirmation", store.workItems(meetingId)[0].confirmation_id, 77);
check("the refusals keep their reasons", store.workItems(meetingId)[1].verdict_note, "past tense");
check("an unanchored item has no place in the transcript, so it sorts last", store.workItems(meetingId)[2].verdict, "unanchored");

store.saveExtraction(meetingId, {
  decisions: [{ quote: "we went git native", start_ms: 5000, text: "Go git native" }],
  elapsedMs: 4200,
  note: "1 candidate queued",
  summary: "A team retro about tooling.",
  topics: ["guidelines", "git"],
  windows: 1,
});
const saved = store.getExtraction(meetingId);
check("saving finishes it", saved.status, "done");
check("topics round-trip through JSON", saved.topics, ["guidelines", "git"]);
check("so do decisions", saved.decisions[0].text, "Go git native");
check("timing is recorded", saved.elapsed_ms, 4200);

store.startExtraction(meetingId, "test-model");
check("re-running clears the previous candidates", store.workItems(meetingId).length, 0);
check("and the previous summary", store.getExtraction(meetingId).summary, null);
check("leaving exactly one extraction row", store.getExtraction(meetingId).status, "running");

console.log("\nRETENTION — a summary describes the meeting; a quote is a copy of it");
store.saveExtraction(meetingId, {
  decisions: [{ quote: "we went git native", start_ms: 5000, text: "Go git native" }],
  elapsedMs: 100,
  summary: "A team retro about tooling.",
  topics: ["git"],
  windows: 1,
});
store.addWorkItem(meetingId, { owner: null, quote: "Priya will draft", startMs: 10_000, task: "Draft the plan", verdict: "queued", verdictNote: null });

const { rawDb } = await import("../src/memory/store.ts");
rawDb.prepare("UPDATE meetings SET started = ? WHERE id = ?").run(new Date(Date.now() - 90 * 86_400_000).toISOString(), meetingId);
check("a dry run changes nothing", store.pruneTranscripts(30, true) > 0 && store.workItems(meetingId)[0].quote, "Priya will draft");
store.pruneTranscripts(30);
check("the transcript is gone", store.segments(meetingId, "final").length, 0);
check("the work item's quote goes with it", store.workItems(meetingId)[0].quote, null);
check("the work item itself stays", store.workItems(meetingId)[0].task, "Draft the plan");
check("a decision's quote goes too", store.getExtraction(meetingId).decisions[0].quote, null);
check("but the decision stays", store.getExtraction(meetingId).decisions[0].text, "Go git native");
check("and so does the summary", store.getExtraction(meetingId).summary, "A team retro about tooling.");

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
