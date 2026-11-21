/**
 * Deleting what the user keeps leaves an audit row (docs/PLAN-open-work.md, K0).
 *
 * The rows hold ids, names and counts, never content, because this is the one table that must stay safe
 * to read after the content is gone. Every path that removes a conversation, a memory, a meeting, a
 * kept recording, a project or an indexed source records it, including the automatic retention prune.
 *
 * Run with `node test/data-audit.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-audit-${process.pid}.db`);
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const rag = await import("../src/memory/rag.ts");
const meetings = await import("../src/meetings/store.ts");
const session = await import("../src/meetings/session.ts");
const projects = await import("../src/projects/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const kinds = () => store.listDataEvents(200).map((e) => e.kind);
const SECRET = "SECRET-BUDGET-FIGURE-90210";

console.log("\nA CONVERSATION");
{
  const id = store.createConversation(`Plan ${SECRET}`, null);
  store.deleteConversation(id);
  const e = store.listDataEvents(1, "conversation_deleted")[0];
  check("is recorded with its id", e.target, `conversation #${id}`);
}

console.log("\nA MEMORY");
{
  const id = Number(store.rawDb.prepare("INSERT INTO memories (kind, text, ts) VALUES ('fact', ?, ?)").run(`the figure is ${SECRET}`, new Date().toISOString()).lastInsertRowid);
  check("deleting it reports success", rag.deleteMemory(id), true);
  const e = store.listDataEvents(1, "memory_deleted")[0];
  check("and is recorded by id and kind", [e.target, e.detail], [`memory #${id}`, "kind fact"]);
  check("a delete that removed nothing records nothing", (rag.deleteMemory(id), store.listDataEvents(50, "memory_deleted").length), 1);
}

console.log("\nA MEETING, ITS RECORDING, AND THE RETENTION PRUNE");
{
  const pid = projects.createProject("Reorg", "");
  const mid = meetings.startMeeting("mic", pid, `Board ${SECRET}`);
  meetings.addSegment(mid, "final", 0, 0, 3000, `we said ${SECRET}`, 0);
  meetings.setStatus(mid, "done", "ok");
  store.rawDb.prepare("UPDATE meetings SET started = ? WHERE id = ?").run(new Date(Date.now() - 90 * 86_400_000).toISOString(), mid);
  meetings.pruneTranscripts(30);
  const exp = store.listDataEvents(1, "transcript_expired")[0];
  check("the retention prune records what it removed", /1 segment\(s\)/.test(exp.detail), true);
  check("a prune that removes nothing records nothing", (meetings.pruneTranscripts(30), store.listDataEvents(50, "transcript_expired").length), 1);

  check("deleting the meeting succeeds", session.deleteMeeting(mid).ok, true);
  const e = store.listDataEvents(1, "meeting_deleted")[0];
  check("and is recorded", e.target, `meeting #${mid}`);

  const sid = projects.addSource(pid, "/tmp/some/folder", "path");
  projects.removeSource(sid);
  check("removing an indexed source is recorded", store.listDataEvents(1, "project_source_removed")[0].target, "path source /tmp/some/folder");
  projects.deleteProject(pid);
  check("deleting a project is recorded", store.listDataEvents(1, "project_deleted")[0].target, `project #${pid}`);
}

console.log("\nNO CONTENT IS EVER STORED");
{
  const all = JSON.stringify(store.listDataEvents(200));
  check("the secret never appears in any row, though it was in every title, text and transcript", all.includes(SECRET), false);
  check("the expected kinds are all present", ["conversation_deleted", "memory_deleted", "transcript_expired", "meeting_deleted", "project_source_removed", "project_deleted"].every((k) => kinds().includes(k)), true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
