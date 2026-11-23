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
const { closeMeeting, previewCloseout } = await import("../src/knowledge/closeout.ts");
const { searchKnowledge } = await import("../src/projects/search.ts");

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

console.log("\nMOVING OR UN-FILING LEAVES NO COPY BEHIND");
{
  const other = projects.createProject("Elsewhere");
  const copies = (id) => rawDb.prepare("SELECT project_id AS p, ref FROM project_sources WHERE kind = 'meeting' AND ref IN (?, ?) ORDER BY id").all(`meeting:${id}`, `meeting-summary:${id}`).map((r) => [r.p, r.ref]);
  const chunksIn = (project, id) => rawDb.prepare("SELECT COUNT(*) AS n FROM chunks WHERE project_id = ? AND path IN (?, ?)").get(project, `meeting:${id}`, `meeting-summary:${id}`).n;
  const plan = (projectId) => ({ claims: [], projectId, speakers: [] });
  const move = async (id, to) => {
    const saved = closeMeeting(id, plan(to));
    if (saved.projectChanged && saved.projectId) await session.indexIntoProject(id, saved.projectId);
  };

  const moved = make("move keep");
  await session.indexIntoProject(moved, pid, true);
  await move(moved, other);
  check("a moved transcript is only in the new project", copies(moved), [[other, `meeting:${moved}`]]);
  check("and no chunk stays in the old one", chunksIn(pid, moved), 0);

  // The promise is about search, so ask search and not only the tables.
  const found = async (project, id) => (await searchKnowledge(CANARY, { k: 50, perSource: 50, projectId: project })).some((h) => h.path === `meeting:${id}`);
  check("search no longer finds it in the old project", await found(pid, moved), false);
  check("search finds it in the new one", await found(other, moved), true);

  const previewed = make("preview only");
  await session.indexIntoProject(previewed, pid, true);
  const events = () => rawDb.prepare("SELECT COUNT(*) AS n FROM data_events WHERE kind = 'meeting_copies_refiled'").get().n;
  const eventsBefore = events();
  previewCloseout(previewed, plan(other));
  check("a close-out preview moves nothing", [copies(previewed), store.getMeeting(previewed).project_id, events()], [[[pid, `meeting:${previewed}`]], pid, eventsBefore]);

  const summary = make("move summary");
  await session.indexIntoProject(summary, pid, false);
  await move(summary, other);
  check("a moved summary is only in the new project", copies(summary), [[other, `meeting-summary:${summary}`]]);
  check("and no summary chunk stays in the old one", chunksIn(pid, summary), 0);

  const unfiled = make("unfile");
  await session.indexIntoProject(unfiled, pid, true);
  await move(unfiled, null);
  check("un-filing removes the copy", copies(unfiled), []);
  check("and its chunks", chunksIn(pid, unfiled), 0);

  // After the prune the index holds the only words left of a kept transcript, so a move has to carry them.
  const pruned = make("move after prune");
  await session.indexIntoProject(pruned, pid, true);
  rawDb.prepare("DELETE FROM meeting_segments WHERE meeting_id = ?").run(pruned);
  await move(pruned, other);
  check("a kept transcript past the prune moves with its words", [copies(pruned), chunksIn(other, pruned) > 0], [[[other, `meeting:${pruned}`]], true]);

  const deleted = make("delete after a stale move");
  await session.indexIntoProject(deleted, pid, true);
  store.setProject(deleted, other); // the state an earlier move left behind
  await session.indexIntoProject(deleted, other);
  check("delete clears a copy in a project it no longer belongs to", [session.deleteMeeting(deleted).ok, copies(deleted), chunksIn(pid, deleted)], [true, [], 0]);

  // A folder source whose path merely looks like a meeting ref is not a meeting copy.
  const lookalike = make("lookalike");
  const folder = projects.addSource(other, `meeting:${lookalike}`, "path");
  const sameProject = projects.addSource(pid, `meeting:${lookalike}`, "path");
  await move(lookalike, other);
  check("a move leaves a look-alike path source alone", [projects.getSource(folder)?.project_id, projects.getSource(sameProject)?.project_id], [other, pid]);
  session.deleteMeeting(lookalike);
  check("a path source with a look-alike ref survives delete", [projects.getSource(folder)?.kind, projects.getSource(sameProject)?.kind], ["path", "path"]);

  const same = make("same project");
  await session.indexIntoProject(same, pid, true);
  store.fileMeeting(same, pid);
  check("re-filing under the same project keeps the copy", [copies(same), chunksIn(pid, same) > 0], [[[pid, `meeting:${same}`]], true]);

  const toSummary = make("past prune, ask for transcript");
  await session.indexIntoProject(toSummary, pid, false);
  rawDb.prepare("DELETE FROM meeting_segments WHERE meeting_id = ?").run(toSummary);
  store.fileMeeting(toSummary, other);
  await session.indexIntoProject(toSummary, other, true);
  check("asking for a pruned transcript does not lose the summary", copies(toSummary), [[other, `meeting-summary:${toSummary}`]]);

  const racing = make("moved while embedding");
  store.setProject(racing, other);
  check("a late write to a project the meeting left is dropped", [await session.indexIntoProject(racing, pid, true), chunksIn(pid, racing)], [0, 0]);
  store.setProject(racing, pid);

  console.log("\nCOPIES ALREADY ORPHANED");
  // Clear the board so the counts below are about these cases alone.
  rawDb.prepare("DELETE FROM chunks WHERE source_id IN (SELECT id FROM project_sources WHERE kind = 'meeting')").run();
  rawDb.prepare("DELETE FROM project_sources WHERE kind = 'meeting'").run();
  const orphan = async (title, keep = true) => {
    const id = make(title);
    await session.indexIntoProject(id, pid, keep);
    return id;
  };
  const superseded = await orphan("has a copy in B");
  store.setProject(superseded, other);
  await session.indexIntoProject(superseded, other);
  const sole = await orphan("only copy, past prune");
  rawDb.prepare("DELETE FROM meeting_segments WHERE meeting_id = ?").run(sole);
  store.setProject(sole, other);
  const held = await orphan("un-filed, past prune");
  rawDb.prepare("DELETE FROM meeting_segments WHERE meeting_id = ?").run(held);
  store.setProject(held, null);
  const gone = await orphan("meeting gone");
  rawDb.prepare("DELETE FROM meetings WHERE id = ?").run(gone);

  const dangling = await orphan("filed under a deleted project");
  const doomed = projects.createProject("Deleted later");
  store.setProject(dangling, doomed);
  projects.deleteProject(doomed);

  const before = rawDb.prepare("SELECT COUNT(*) AS n FROM project_sources WHERE kind = 'meeting'").get().n;
  const expected = { lastCopyHeld: [held, dangling], meetingGone: 1, moved: 1, superseded: 1 };
  check("the report counts each kind", store.staleMeetingCopies(), expected);
  check("and changes nothing", rawDb.prepare("SELECT COUNT(*) AS n FROM project_sources WHERE kind = 'meeting'").get().n, before);
  check("applying does what the report said", store.staleMeetingCopies(true), expected);
  check("the superseded copy is gone", copies(superseded), [[other, `meeting:${superseded}`]]);
  check("the only copy moved with its words", [copies(sole), chunksIn(other, sole) > 0], [[[other, `meeting:${sole}`]], true]);
  check("the un-filed last copy is left for a person", copies(held), [[pid, `meeting:${held}`]]);
  check("the deleted meeting's copy is gone", copies(gone), []);
  check("a second pass finds only the held one", store.staleMeetingCopies(), { lastCopyHeld: [held, dangling], meetingGone: 0, moved: 0, superseded: 0 });
  check("a copy is not moved into a deleted project", copies(dangling), [[pid, `meeting:${dangling}`]]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
