/**
 * Run notes (LP3, LP5): what happened to a run along the way that is not a tool call, kept with the run and said in
 * words on the web. The words, the store, and that pruning takes them with the run.
 *
 * Run with `node test/run-notes.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-run-notes-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const { describeRunNote } = await import("../web/src/lib/runNotes.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nIN WORDS");
check("paused", describeRunNote({ detail: { waitedMs: 42_400 }, kind: "paused_for_person" }), "Paused 42 seconds so your chat could go first, then carried on.");
check("paused a long time", describeRunNote({ detail: { waitedMs: 185_000 }, kind: "paused_for_person" }), "Paused 3 minutes so your chat could go first, then carried on.");
check("paused under a second still says one", describeRunNote({ detail: { waitedMs: 200 }, kind: "paused_for_person" }), "Paused 1 second so your chat could go first, then carried on.");
check(
  "compacted",
  describeRunNote({ detail: { after: 17_900, before: 31_200, stubs: 3 }, kind: "compacted" }),
  "Set aside 3 earlier results to make room (about 31,000 to 18,000 tokens). They can still be read back.",
);
check("one result, small numbers", describeRunNote({ detail: { after: 600, before: 900, stubs: 1 }, kind: "compacted" }).startsWith("Set aside 1 earlier result to make room (about 900 to 600 tokens)"), true);
check("stopped on tokens", describeRunNote({ detail: { reason: "tokens", tokens: 221_400 }, kind: "budget" }), "Stopped at its token budget, about 221,000 tokens, and answered with what it had.");
check("stopped on time", describeRunNote({ detail: { elapsedMs: 720_000, reason: "time" }, kind: "budget" }), "Stopped at its time budget, after 12 minutes, and answered with what it had.");
check("stopped at the step limit", describeRunNote({ detail: { reason: "steps", steps: 10 }, kind: "budget" }), "Stopped at its step limit of 10, and answered with what it had.");
check("a kind this build does not know is left out", describeRunNote({ detail: {}, kind: "something_new" }), null);

console.log("\nKEPT WITH THE RUN");
{
  const runId = store.startRun({ kind: "schedule", task: "nightly" });
  store.addRunNote(runId, "paused_for_person", { waitedMs: 4000 });
  store.addRunNote(runId, "compacted", { after: 10, before: 20, stubs: 1 });
  const notes = store.runNotes(runId);
  check("in the order they happened, with their detail", notes.map((n) => [n.kind, n.detail]), [["paused_for_person", { waitedMs: 4000 }], ["compacted", { after: 10, before: 20, stubs: 1 }]]);
  check("a run with none has none", store.runNotes(store.startRun({ kind: "chat", task: "x" })), []);
  check("no run id is ignored, not thrown", (store.addRunNote(null, "budget", {}), true), true);
  store.finishRun(runId, "ok", "done");
  store.rawDb.prepare("UPDATE runs SET finished = '2000-01-01T00:00:00.000Z', started = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(runId);
  store.pruneLedger({ auditDays: 0, runDays: 1, traceDays: 0 });
  const left = store.rawDb.prepare("SELECT COUNT(*) AS n FROM run_notes WHERE run_id = ?").get(runId).n;
  const runLeft = store.rawDb.prepare("SELECT COUNT(*) AS n FROM runs WHERE id = ?").get(runId).n;
  check("pruning a run takes its notes with it", [runLeft, left], [0, 0]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
