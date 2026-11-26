/**
 * Deleting a meeting: every dependent row goes, pending approvals are rejected, the project's
 * indexed copy is removed, and a meeting still being recorded is refused.
 * Run with `node test/meeting-delete.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-mdelete-${process.pid}-${Date.now()}.db`);
const store = await import("../src/meetings/store.ts");
const session = await import("../src/meetings/session.ts");
const memory = await import("../src/memory/store.ts");
const projects = await import("../src/projects/store.ts");

let failed = 0;
const check = (label, ok) => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};
const count = (table, id) => memory.rawDb.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE meeting_id = ?`).get(id).n;

const project = projects.createProject("Acme");
const id = store.startMeeting("mic", project, "Test meeting");
store.addSegment(id, "final", 0, 0, 1000, "hello there", 0);
store.setSpeakerName(id, 0, "Priya");
store.setTags(id, ["test"]);
store.addChat(id, "user", "what happened?");
const w = store.addWorkItem(id, { owner: null, quote: "q", startMs: 0, task: "Do a thing", verdict: "queued", verdictNote: null });
const c = memory.queueConfirmation({ args: { kind: "task", text: "x" }, tool: "memory_save" }, "Work item");
store.setWorkItemConfirmation(w, c);
const sourceId = projects.addSource(project, `meeting:${id}`, "meeting");
projects.insertChunk(project, sourceId, `meeting:${id}`, 0, "stamp", "hello there", null);
const other = store.startMeeting("mic", null, "Keep me");
store.addSegment(other, "final", 0, 0, 1000, "unrelated", 0);

store.setStatus(id, "recording");
const busy = session.deleteMeeting(id);
check("refused while recording", busy.ok === false && /still/.test(busy.reason));
check("meeting survives a refusal", store.getMeeting(id) != null);

store.setStatus(id, "done");
const r = session.deleteMeeting(id);
check("delete succeeds", r.ok === true && r.rejectedItems === 1);
check("meeting row gone", store.getMeeting(id) === undefined);
for (const t of ["meeting_segments", "meeting_speakers", "meeting_tags", "meeting_chat", "meeting_work_items"])
  check(`${t} empty`, count(t, id) === 0);
check("pending approval rejected", memory.getConfirmation(c).state === "rejected");
check("project index copy removed", projects.listSources(project).length === 0 && projects.countChunks(project) === 0);
check("other meeting untouched", store.getMeeting(other) != null && store.segments(other).length === 1);
check("second delete is 'no such meeting'", session.deleteMeeting(id).ok === false);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
