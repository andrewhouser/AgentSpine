/**
 * The knowledge evaluation harness (docs/PLAN-open-work.md, K1) measures retrieval honestly.
 *
 * A fixture base is built in which two kinds of question exist: one whose answer shares MEANING with its
 * question but no words (only the vector path can find it) and one whose answer shares an exact identifier
 * (only full-text can). The harness must show baseline cosine failing the second, each path winning its own
 * kind, and the fused mode winning both, and it must never put question text or passages in its output.
 *
 * Run with `node test/knowledge-eval.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-keval-${process.pid}.db`);
process.env.EMBEDDINGS_URL = "";

// A stand-in embedder: unit vectors chosen per topic word, so "meaning" is controlled by the test.
const rag = await import("../src/memory/rag.ts");
const projects = await import("../src/projects/store.ts");
const { evaluate, renderReports, MODES } = await import("../src/eval/knowledge.ts");

const topic = { budget: [1, 0, 0], hiring: [0, 1, 0], launch: [0, 0, 1] };
rag.__setEmbedderForTests(async (text) => {
  const t = text.toLowerCase();
  const hit = Object.keys(topic).find((k) => t.includes(k) || (k === "budget" && /spend|money|cost/.test(t)) || (k === "hiring" && /recruit|candidate/.test(t)));
  return new Float32Array(hit ? topic[hit] : [0.1, 0.1, 0.1]);
});

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const pid = projects.createProject("Platform", "");
const src = projects.addSource(pid, "/docs", "path");
const put = async (p, ord, text) => projects.insertChunk(pid, src, p, ord, "2026-01-01", text, rag.toBlob(await rag.getEmbedder().then((e) => e(text))));
await put("budget.md", 0, "The cost envelope for next year is capped by finance.");
await put("hiring.md", 0, "We will recruit two candidates before the summer.");
await put("tickets.md", 0, "Escalation OPS-9931 is blocked on the vendor, filler about launch.");
await put("noise.md", 0, "Notes on the offsite agenda and catering.");

const questions = [
  { expectSources: ["budget.md"], id: "meaning", project: "Platform", question: "how much money can we spend" },
  { expectSources: ["tickets.md"], id: "exact", project: "Platform", question: "what is happening with OPS-9931" },
  { expectNone: true, id: "nothing", project: "Platform", question: "who won the regatta" },
  { forbidSources: ["noise.md"], id: "forbid", project: "Platform", question: "how much money can we spend" },
];

console.log("\nTHE EMBEDDER STAND-IN IS WIRED (otherwise the rest proves nothing)");
const haveEmbedder = typeof rag.__setEmbedderForTests === "function";
check("the test hook exists", haveEmbedder, true);

if (haveEmbedder) {
  const reports = Object.fromEntries(await Promise.all(MODES.map(async (m) => [m, await evaluate(questions, m, 1)])));
  const of = (mode, id) => reports[mode].results.find((r) => r.id === id);

  console.log("\nEACH PATH WINS ITS OWN KIND OF QUESTION");
  check("a question that shares only meaning: vector and baseline find it", [of("vector", "meaning").hit, of("baseline", "meaning").hit], [true, true]);
  check("and full-text alone does not", of("fts", "meaning").hit, false);
  check("a question that shares only an identifier: full-text finds it", of("fts", "exact").hit, true);
  check("and the old cosine baseline misses it", of("baseline", "exact").hit, false);
  check("the fused mode finds both", [of("hybrid", "meaning").hit, of("hybrid", "exact").hit], [true, true]);

  console.log("\nTHE NUMBERS");
  check("hybrid recall beats baseline recall", reports.hybrid.recallAtK > reports.baseline.recallAtK, true);
  check("hybrid is perfect on the two scored questions", reports.hybrid.recallAtK, 1);
  check("the rank of a found source is reported", of("hybrid", "exact").rank >= 1, true);
  check("a question with no expected source is not scored", reports.hybrid.scored, 2);
  check("a forbidden source that did not appear is not a leak", of("hybrid", "forbid").leaked, false);

  console.log("\nNO-EVIDENCE QUESTIONS REPORT A SCORE, NOT A VERDICT");
  check("it records the best score so a threshold can be chosen", of("hybrid", "nothing").hit, null);

  console.log("\nTHE OUTPUT IS SAFE TO PRINT");
  const text = renderReports(Object.values(reports));
  check("it has a row per mode", MODES.every((m) => text.includes(m)), true);
  check("no question text or passage appears in it", /regatta|money|OPS-9931|vendor|catering|finance/.test(text), false);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
