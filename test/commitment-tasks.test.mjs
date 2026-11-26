/**
 * Client calls feed Tasks (docs/PLAN-open-work.md, section 14 U6).
 *
 * A meeting's commitments stopped in the knowledge store. Now an accepted commitment can be ticked "Add as a
 * task" in the close-out. What this holds: nothing becomes a task without that tick; the task is part of the
 * close-out's preview and of its all-or-nothing save; it carries the commitment's words, day, project and the
 * client that project belongs to; someone else's promise becomes a waiting-on task naming them; one claim makes
 * one task; deleting the meeting leaves the task and drops the link, and says so; and a client's page lists
 * the reviewed commitments in its project with the task made from each.
 *
 * Run with `node test/commitment-tasks.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-commitment-tasks-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.MEETING_SELF_NAMES = "Alex";

const { rawDb } = await import("../src/memory/store.ts");
const k = await import("../src/knowledge/store.ts");
const c = await import("../src/knowledge/closeout.ts");
const meetings = await import("../src/meetings/store.ts");
const projects = await import("../src/projects/store.ts");
const tasks = await import("../src/tasks/store.ts");
const clients = await import("../src/clients/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const refuses = (fn) => {
  try {
    fn();
    return false;
  } catch (err) {
    return err.message;
  }
};

const project = projects.createProject("Ridgeline onboarding", "");
const client = clients.upsertClient("Ridgeline Cabinets", { projectId: project });
const other = projects.createProject("Unrelated", "");

const newMeeting = (title, projectId = project) => {
  const id = meetings.startMeeting("mic", projectId, title);
  meetings.addSegment(id, "final", 0, 0, 4000, "Sam will send the export by Friday and Alex will draft the map.");
  meetings.setStatus(id, "done");
  return id;
};
const commitment = (meetingId, text, extra = {}) =>
  k.addClaim({ kind: "commitment", method: "meeting-extraction", passage: text, projectId: project, saidOn: "2026-11-20", sourceKind: "meeting", sourceRef: `meeting:${meetingId}`, text, ...extra });
const allTasks = () => rawDb.prepare("SELECT * FROM tasks ORDER BY id").all();
const snapshot = () => JSON.stringify([rawDb.prepare("SELECT * FROM kn_claims ORDER BY id").all(), allTasks()]);

console.log("\nTHE DUE DAY AND WHO OWNS IT");
{
  const due = c.taskDue("2026-12-04");
  const d = new Date(due);
  check("a bare day becomes nine in the morning, local, on that day", [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()], [2026, 12, 4, 9, 0]);
  check("a full time is kept", c.taskDue("2026-12-04T15:30:00.000Z"), "2026-12-04T15:30:00.000Z");
  check("no day means no due time", [c.taskDue(null), c.taskDue("")], [null, null]);
  check("words that are not a date give none, not a wrong one", c.taskDue("next sprint"), null);
  check("nobody named is you", c.isSelf(null), true);
  check('"me" is you', c.isSelf("Me"), true);
  check("a name in MEETING_SELF_NAMES is you, whatever its case", c.isSelf("alex"), true);
  check("anyone else is not", c.isSelf("Sam Rivera"), false);
}

console.log("\nNOTHING BECOMES A TASK WITHOUT THE TICK");
const m1 = newMeeting("Kickoff with Ridgeline");
const mine = commitment(m1, "Draft the systems map", { due: "2026-12-04", owner: "Alex" });
const theirs = commitment(m1, "Send the order export", { due: "2026-12-01", owner: "Sam Rivera" });
const decision = k.addClaim({ kind: "decision", method: "meeting-extraction", passage: "We keep the spreadsheet.", projectId: project, saidOn: "2026-11-20", sourceKind: "meeting", sourceRef: `meeting:${m1}`, text: "Keep the spreadsheet" });
{
  const state = c.closeoutState(m1);
  const byId = Object.fromEntries(state.claims.map((x) => [x.id, x]));
  check("a commitment can become a task", byId[mine].canTask, true);
  check("a decision cannot", byId[decision].canTask, false);
  check("the screen is told the commitment's day", byId[theirs].due, "2026-12-01");
}

console.log("\nTHE PREVIEW SHOWS THE TASK AND WRITES NOTHING");
const plan = c.parsePlan({
  claims: [
    { answer: "accept", id: mine, task: true },
    { answer: "accept", id: theirs, task: true },
    { answer: "accept", id: decision },
  ],
  speakers: [],
});
{
  const before = snapshot();
  const preview = c.previewCloseout(m1, plan);
  check("the preview lists both tasks", preview.tasks.map((t) => [t.title, t.kind, t.waitingOn, t.clientName]), [
    ["Draft the systems map", "task", null, "Ridgeline Cabinets"],
    ["Send the order export", "followup", "Sam Rivera", "Ridgeline Cabinets"],
  ]);
  check("and nothing was written", snapshot() === before, true);
  check("no task exists yet", allTasks().length, 0);
}

console.log("\nA PLAN THAT CANNOT BE HONOURED IS REFUSED WHOLE");
{
  const before = snapshot();
  check("a rejected commitment cannot become a task", !!refuses(() => c.closeMeeting(m1, c.parsePlan({ claims: [{ answer: "reject", id: mine, task: true }], speakers: [] }))), true);
  check("a decision cannot become a task", /not a commitment/.test(refuses(() => c.closeMeeting(m1, c.parsePlan({ claims: [{ answer: "accept", id: decision, task: true }], speakers: [] }))) || ""), true);
  check("a task after a bad claim leaves nothing behind", !!refuses(() => c.closeMeeting(m1, c.parsePlan({ claims: [{ answer: "accept", id: mine, task: true }, { answer: "accept", id: 999999 }], speakers: [] }))), true);
  check("none of the three wrote anything", snapshot() === before, true);
  check("a tick that is not exactly true is no tick", c.parsePlan({ claims: [{ answer: "accept", id: mine, task: "yes" }], speakers: [] }).claims[0].task, undefined);
}

console.log("\nSAVING MAKES THE TASKS");
{
  const saved = c.closeMeeting(m1, plan);
  check("both tasks are reported", saved.tasks.length, 2);
  const [a, b] = allTasks();
  check("mine is a task in the project, for the client", [a.title, a.kind, a.waiting_on, a.project_id, a.client_id, a.claim_id, a.status], ["Draft the systems map", "task", null, project, client.id, mine, "open"]);
  check("its due time is the commitment's day", a.due, c.taskDue("2026-12-04"));
  check("its notes say where it came from, without the passage", a.notes, `From a commitment in the meeting "Kickoff with Ridgeline" on 2026-11-20 (claim #${mine}).`);
  check("theirs is a waiting-on task naming them", [b.kind, b.waiting_on, b.claim_id], ["followup", "Sam Rivera", theirs]);
  check("the decision made no task", allTasks().length, 2);
  const audit = rawDb.prepare("SELECT detail FROM data_events WHERE kind = 'meeting_closed_out' ORDER BY id DESC LIMIT 1").get();
  check("the audit row counts them", /2 made into tasks$/.test(audit.detail), true);
}

console.log("\nAN ACCEPTED COMMITMENT WITH NO TICK STAYS A COMMITMENT");
const m2 = newMeeting("Follow-up call");
const plain = commitment(m2, "Check the invoice export format", { owner: "Alex" });
const corrected = commitment(m2, "Send the thing", { owner: "Sam Rivera" });
{
  c.closeMeeting(m2, c.parsePlan({ claims: [{ answer: "accept", id: plain }, { answer: "accept", id: corrected, owner: "Alex", task: true, text: "Send the cabinet price list" }], speakers: [] }));
  check("no task for the one that was not ticked", tasks.taskForClaim(plain), undefined);
  const t = tasks.taskForClaim(corrected);
  check("the task takes the corrected words and owner", [t.title, t.kind, t.waiting_on], ["Send the cabinet price list", "task", null]);
  check("no day on the commitment, none on the task", t.due, null);
}

console.log("\nONE CLAIM, ONE TASK");
{
  check("a second task for the same claim is refused", /already has a task/.test(refuses(() => tasks.addTaskForClaim(mine, { title: "again" })) || ""), true);
  check("from the client's page too", /already has a task/.test(refuses(() => c.taskForReviewedCommitment(mine)) || ""), true);
  check("and it left no half-made row", allTasks().length, 3);
  const later = c.taskForReviewedCommitment(plain);
  check("a commitment accepted earlier can still be made into one", [later.title, later.kind, later.clientName], ["Check the invoice export format", "task", "Ridgeline Cabinets"]);
  check("an unreviewed commitment cannot", /has not been accepted/.test(refuses(() => c.taskForReviewedCommitment(commitment(m2, "Unreviewed promise"))) || ""), true);
  check("nor one that does not exist", refuses(() => c.taskForReviewedCommitment(424242)), "no such claim");
}

console.log("\nA CLIENT'S COMMITMENTS");
{
  const offProject = commitment(m2, "Something for another project", { projectId: other });
  k.reviewClaim(offProject, "accept");
  const hidden = commitment(m2, "A sensitive promise");
  k.reviewClaim(hidden, "accept");
  k.setClaimSensitive(hidden, true);
  const out = c.clientCommitments(client.id, "2026-12-02");
  check("the client and its project", out.client, { id: client.id, name: "Ridgeline Cabinets", projectId: project });
  check("overdue first, then by day, then undated", out.commitments.map((x) => [x.text, x.overdue]), [
    ["Send the order export", true],
    ["Draft the systems map", false],
    ["Check the invoice export format", false],
    ["Send the cabinet price list", false],
  ]);
  check("each carries the task made from it", out.commitments.map((x) => x.task?.title ?? null), ["Send the order export", "Draft the systems map", "Check the invoice export format", "Send the cabinet price list"]);
  check("another project's commitment is not listed", out.commitments.some((x) => x.claimId === offProject), false);
  check("a sensitive one is not listed", out.commitments.some((x) => x.claimId === hidden), false);
  check("unreviewed ones are counted, not listed", out.waitingForReview, 1);
  check("a client with no project has none", c.clientCommitments(clients.upsertClient("No Project Co", {}).id, "2026-12-02").commitments, []);
  check("no such client", c.clientCommitments(98765), undefined);
}

console.log("\nDELETING THE MEETING LEAVES THE TASK AND DROPS THE LINK");
{
  const before = tasks.taskForClaim(mine);
  k.deleteClaimsFromSource("meeting", `meeting:${m1}`);
  meetings.deleteMeeting(m1);
  const listed = tasks.listTasks({ status: "all" });
  const after = listed.find((t) => t.id === before.id);
  check("the task is still there, still open", [after?.title, after?.status], ["Draft the systems map", "open"]);
  check("it no longer points at a claim", after?.claim_id, null);
  check("and its notes say the commitment is gone", after?.notes.endsWith(tasks.CLAIM_GONE_NOTE), true);
  check("a task from the other meeting keeps its link", tasks.taskForClaim(corrected)?.claim_id, corrected);
  check("running it again changes nothing", tasks.dropDeadClaimLinks(), 0);
  check("the client's page no longer lists that commitment", c.clientCommitments(client.id, "2026-12-02").commitments.some((x) => x.claimId === mine), false);
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
