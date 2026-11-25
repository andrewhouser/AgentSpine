/**
 * K1's answer metrics (src/eval/answers.ts): citation correctness, stale answers, status accuracy, and the extraction
 * acceptance rate, against a small invented knowledge store. No model, no network.
 *
 * Run with `node test/knowledge-eval-answers.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-eval-answers-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDINGS_URL = "";

const k = await import("../src/knowledge/store.ts");
const projects = await import("../src/projects/store.ts");
const { evaluateAnswers, extractionAcceptance, renderAnswers } = await import("../src/eval/answers.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const pid = projects.createProject("Billing migration", "");
const claim = (over) => k.addClaim({ kind: "decision", method: "manual", passage: over.text, projectId: pid, reviewState: "reviewed", sourceKind: "meeting", sourceRef: "meeting:1", ...over });
// The launch moved: the older reviewed decision is superseded by the newer one.
const old = claim({ saidOn: "2026-06-01", text: "The launch is in June", topic: "launch date" });
const next = claim({ saidOn: "2026-09-01", sourceRef: "meeting:2", text: "The launch is in August", topic: "launch date" });
k.supersede(old, next);
claim({ saidOn: "2026-09-02", sourceRef: "meeting:3", text: "Cutover moves to March after the freeze", topic: "cutover" });
// Extraction: three proposed by a meeting, one accepted and one rejected; one by the model, accepted.
const ex = (text, method = "meeting-extraction") => k.addClaim({ kind: "risk", method, passage: text, projectId: pid, sourceKind: "meeting", sourceRef: "meeting:4", text });
k.reviewClaim(ex("The vendor may slip"), "accept");
k.reviewClaim(ex("Someone said lunch was late"), "reject");
ex("Still waiting for a look");
k.reviewClaim(ex("Budget is tight this quarter", "model"), "accept");

console.log("\nANSWERS");
const questions = [
  { expectClaims: ["cutover moves to March"], expectStatus: "supported", id: "decide", project: "Billing migration", question: "Is the cutover in March?" },
  { expectClaims: ["launch is in August"], id: "changed", project: "Billing migration", question: "When is the launch?", staleClaims: ["launch is in June"] },
  { asOf: "2026-07-01", id: "asof", project: "Billing migration", question: "When is the launch?", staleClaims: ["launch is in August"] },
  { expectStatus: "insufficient", id: "none", project: "Billing migration", question: "What was the outcome of the security audit?" },
  { expectSources: ["meeting:1"], id: "retrieval-only", question: "anything" },
];
const r = evaluateAnswers(questions);
const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
check("a question with no answer fields is not scored here", r.results.map((x) => x.id), ["decide", "changed", "asof", "none"]);
check("the decision is cited, and the status is right", [by.decide.citationHit, by.decide.statusRight, by.decide.status], [true, true, "supported"]);
check("the launch: the new date is cited", by.changed.citationHit, true);
check("and the superseded one is not cited as current", by.changed.stale, false);
check("as of July, August had not been said yet, so it is not cited", by.asof.stale, false);
check("a question nothing answers is insufficient, as expected", [by.none.status, by.none.statusRight], ["insufficient", true]);
check("precision: what was cited for the launch was what was expected", by.changed.citationPrecision, 1);
check("the totals", [r.citationRecall, r.staleRate, r.statusAccuracy], [1, 0, 1]);

console.log("\nA STALE ANSWER IS CAUGHT");
{
  // Undo the supersession by hand, as a bad store would have it, and the old date is cited as current again.
  // (The answer module matches on two shared words, so the questions above are worded the way it reads them.)
  const { rawDb } = await import("../src/memory/store.ts");
  rawDb.prepare("UPDATE kn_claims SET status = 'active', status_changed = NULL WHERE id = ?").run(old);
  const bad = evaluateAnswers([{ id: "changed", project: "Billing migration", question: "When is the launch?", staleClaims: ["launch is in June"] }]);
  check("citing a superseded claim as current counts as stale", [bad.results[0].stale, bad.staleRate], [true, 1]);
  rawDb.prepare("UPDATE kn_claims SET status = 'superseded' WHERE id = ?").run(old);
}

console.log("\nEXTRACTION ACCEPTANCE");
{
  const a = extractionAcceptance();
  check("manual claims are left out; decided ones counted", [a.accepted, a.rejected, a.waiting], [2, 1, 1]);
  check("the rate is accepted over decided", a.rate, 2 / 3);
  check("and per way of finding them", a.byMethod.map((m) => [m.method, m.accepted, m.rejected, m.waiting]), [["meeting-extraction", 1, 1, 1], ["model", 1, 0, 0]]);
}

console.log("\nTHE REPORT CARRIES IDS AND NUMBERS ONLY");
{
  const text = renderAnswers(r, extractionAcceptance());
  check("no question text in it", ["cutover", "launch", "audit"].some((w) => text.toLowerCase().includes(w)), false);
  check("it states the numbers", /citation recall 100%/.test(text) && /extraction acceptance:  67% of 3 decided \(1 waiting\)/.test(text), true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
