/**
 * Filing a meeting under a project asks what to keep (docs/PLAN-open-work.md F6).
 *
 * The 30-day prune removes a meeting's transcript, but filing used to copy the whole transcript
 * into the project's searchable index, where the prune never reached. Filing now carries a
 * choice: keep the full transcript searchable (an explicit retention opt-in), or index only the
 * summary, topics and decisions, so the words never enter the project at all.
 *
 * Run with `node test/meeting-filing.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-filing-${process.pid}.db`);
process.env.EMBEDDINGS_URL = "";
process.env.MEETING_EXTRACT_ENABLED = "false";

const store = await import("../src/meetings/store.ts");
const session = await import("../src/meetings/session.ts");
const projects = await import("../src/projects/store.ts");
const { rawDb } = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const CANARY = "OKAPI-HEADCOUNT-REORG-2210";
const pid = projects.createProject("Reorg");
const make = (title) => {
  const id = store.startMeeting("mic", pid, title);
  store.addSegment(id, "final", 0, 0, 4000, `We will do the ${CANARY} next quarter.`, 0);
  store.setStatus(id, "done", "ok");
  store.startExtraction(id, "test");
  store.saveExtraction(id, { decisions: [{ quote: null, text: "Reorg moves to Q3" }], elapsedMs: 1, summary: "Reorg timing discussed.", topics: ["reorg"], windows: 1 });
  return id;
};
const sources = (id) => projects.listSources(pid).filter((s) => s.ref === `meeting:${id}` || s.ref === `meeting-summary:${id}`).map((s) => s.ref);
const chunkText = () => rawDb.prepare("SELECT text FROM chunks WHERE project_id = ?").all(pid).map((r) => r.text).join("\n");
const keepOf = (id) => store.getMeeting(id).keep_transcript;

console.log("\nKEEP THE FULL TRANSCRIPT");
{
  const id = make("keep");
  await session.indexIntoProject(id, pid, true);
  check("the transcript source exists", sources(id), [`meeting:${id}`]);
  check("its words are searchable in the project", chunkText().includes(CANARY), true);
  check("the choice is recorded", keepOf(id), 1);
}

console.log("\nSUMMARY ONLY");
{
  const id = make("summary only");
  await session.indexIntoProject(id, pid, false);
  check("only the summary source exists", sources(id), [`meeting-summary:${id}`]);
  const text = rawDb.prepare("SELECT c.text FROM chunks c JOIN project_sources s ON s.id = c.source_id WHERE s.ref = ?").all(`meeting-summary:${id}`).map((r) => r.text).join("\n");
  check("it holds the summary and the decision", text.includes("Reorg timing discussed.") && text.includes("Reorg moves to Q3"), true);
  check("and not the transcript's words", text.includes(CANARY), false);
  check("the choice is recorded", keepOf(id), 0);
}

console.log("\nCHANGING THE CHOICE REPLACES WHAT THE PROJECT HOLDS");
{
  const id = make("switch");
  await session.indexIntoProject(id, pid, true);
  await session.indexIntoProject(id, pid, false);
  check("keep then summary only: the transcript source is gone", sources(id), [`meeting-summary:${id}`]);
  await session.indexIntoProject(id, pid, true);
  check("and back: the summary source is gone", sources(id), [`meeting:${id}`]);
}

console.log("\nNEVER ASKED BEHAVES AS IT DID BEFORE");
{
  const id = make("legacy");
  check("starts unchosen", keepOf(id), null);
  await session.indexIntoProject(id, pid);
  check("filing without a choice keeps the transcript", sources(id), [`meeting:${id}`]);
  check("and does not invent a choice", keepOf(id), null);
}

console.log("\nTHE PRUNE");
{
  const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const mk = async (title, keep) => {
    const id = make(title);
    rawDb.prepare("UPDATE meetings SET started = ? WHERE id = ?").run(old, id);
    if (keep === undefined) await session.indexIntoProject(id, pid);
    else await session.indexIntoProject(id, pid, keep);
    return id;
  };
  const kept = await mk("old keep", true);
  const never = await mk("old never asked");
  const summaryOnly = await mk("old summary only", false);
  // The backstop case: a summary-only meeting that somehow holds a transcript copy.
  const odd = await mk("old odd", true);
  store.setKeepTranscript(odd, false);

  store.pruneTranscripts(30);
  check("the segments are pruned for all of them", rawDb.prepare("SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting_id IN (?,?,?,?)").get(kept, never, summaryOnly, odd).n, 0);
  check("a kept transcript stays searchable on purpose", sources(kept), [`meeting:${kept}`]);
  check("a never-asked one is left as it was", sources(never), [`meeting:${never}`]);
  check("a summary-only one keeps its summary", sources(summaryOnly), [`meeting-summary:${summaryOnly}`]);
  check("a stray transcript copy of a summary-only meeting is removed", sources(odd), []);
}

console.log("\nDELETING A MEETING REMOVES EITHER FORM");
{
  const a = make("delete keep");
  const b = make("delete summary");
  await session.indexIntoProject(a, pid, true);
  await session.indexIntoProject(b, pid, false);
  check("both delete cleanly", [session.deleteMeeting(a).ok, session.deleteMeeting(b).ok], [true, true]);
  check("nothing of either is left in the project", [sources(a), sources(b)], [[], []]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
