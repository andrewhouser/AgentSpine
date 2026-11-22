/**
 * Closing out a meeting in one step (docs/PLAN-open-work.md, K5), and the supersession record it depends on.
 *
 * What this holds: a preview changes nothing and matches what saving does; a save lands whole or not at all; only a
 * person's answer moves a claim; one decision can replace two earlier ones and undoing it restores both; filing a
 * meeting moves its claims into the project's brief; and briefs use the S7 status wording.
 *
 * Run with `node test/knowledge-closeout.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-closeout-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";

const { rawDb } = await import("../src/memory/store.ts");
const k = await import("../src/knowledge/store.ts");
const b = await import("../src/knowledge/briefs.ts");
const c = await import("../src/knowledge/closeout.ts");
const meetings = await import("../src/meetings/store.ts");
const projects = await import("../src/projects/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const refuses = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const alpha = projects.createProject("Alpha", "");
const beta = projects.createProject("Beta", "");
const claim = (ref, text, extra = {}) =>
  k.addClaim({ kind: "decision", method: "meeting-extraction", passage: text, projectId: null, saidOn: "2026-11-20", sourceKind: "meeting", sourceRef: ref, text, ...extra });
const reviewedIn = (projectId, text) => {
  const id = claim("meeting:9000", text, { projectId });
  k.reviewClaim(id, "accept");
  return id;
};
const newMeeting = (title = "Budget review") => {
  const id = meetings.startMeeting("mic", null, title);
  meetings.addSegment(id, "final", 0, 0, 4000, "We agreed the launch moves.");
  rawDb.prepare("UPDATE meeting_segments SET speaker = 0 WHERE meeting_id = ?").run(id);
  meetings.setStatus(id, "done");
  return id;
};
const snapshot = () => JSON.stringify([rawDb.prepare("SELECT * FROM kn_claims ORDER BY id").all(), rawDb.prepare("SELECT * FROM kn_links ORDER BY id").all(), rawDb.prepare("SELECT * FROM meetings ORDER BY id").all(), rawDb.prepare("SELECT * FROM meeting_speakers ORDER BY meeting_id, idx").all()]);
const lines = (id, name) => b.projectBrief(id, name).sections.flatMap((s) => s.items.map((i) => i.text));

console.log("\nA PREVIEW CHANGES NOTHING AND TELLS THE TRUTH");
const m1 = newMeeting();
const june = reviewedIn(alpha, "Launch is in June");
const july = reviewedIn(alpha, "Launch is no later than July");
const aug = claim(`meeting:${m1}`, "Launch moves to August");
const noise = claim(`meeting:${m1}`, "Someone mentioned lunch");
const later = claim(`meeting:${m1}`, "Pricing is still open");
const plan1 = c.parsePlan({
  claims: [
    { answer: "accept", id: aug, replaces: [june, july], topic: "launch date" },
    { answer: "reject", id: noise },
    { answer: "skip", id: later },
  ],
  projectId: alpha,
  speakers: [{ index: 0, name: "Priya" }],
});
{
  const state = c.closeoutState(m1, alpha);
  check("the screen offers the project's earlier decisions", state.claims.find((x) => x.id === aug).canReplace.map((o) => o.id).sort(), [june, july].sort());
  check("and none from another project", c.closeoutState(m1, beta).claims.find((x) => x.id === aug).canReplace, []);
  const before = snapshot();
  const p = c.previewCloseout(m1, plan1);
  check("the preview wrote nothing", snapshot() === before, true);
  check("it counts each answer", [p.accepted, p.rejected, p.replaced, p.left], [1, 1, 2, 1]);
  const brief = p.briefs[0];
  check("it names the project", brief.subject, "Alpha");
  check("it shows the new decision", brief.added.some((l) => l.text === "Launch moves to August"), true);
  check("with the shared wording", brief.added.find((l) => l.text === "Launch moves to August").evidence.length > 0, true);
  check("it shows both replaced decisions leaving", ["Launch is in June", "Launch is no later than July"].every((t) => brief.removed.some((l) => l.text === t)), true);
  check("the rejected item is not added", brief.added.some((l) => l.text === "Someone mentioned lunch"), false);
}

console.log("\nA SAVE LANDS WHOLE OR NOT AT ALL");
{
  const before = snapshot();
  const bad = c.parsePlan({ claims: [{ answer: "accept", id: aug, replaces: [june, 999999] }], projectId: alpha, speakers: [{ index: 0, name: "Priya" }] });
  check("a plan with one bad replacement is refused", refuses(() => c.closeMeeting(m1, bad)), true);
  check("and nothing from it was kept", snapshot() === before, true);
  check("a speaker the meeting does not have is refused", refuses(() => c.closeMeeting(m1, c.parsePlan({ claims: [], speakers: [{ index: 7, name: "Nobody" }] }))), true);
  check("a project that does not exist is refused", refuses(() => c.closeMeeting(m1, c.parsePlan({ claims: [], projectId: 999999, speakers: [] }))), true);
  check("a rejected claim cannot replace anything", refuses(() => c.closeMeeting(m1, c.parsePlan({ claims: [{ answer: "reject", id: noise, replaces: [june] }], speakers: [] }))), true);
  check("the same claim cannot be answered twice", refuses(() => c.parsePlan({ claims: [{ answer: "accept", id: aug }, { answer: "reject", id: aug }] })), true);
  const recording = meetings.startMeeting("mic", null, "Live");
  check("a meeting still recording cannot be closed out", refuses(() => c.closeMeeting(recording, c.parsePlan({ claims: [], speakers: [] }))), true);
  meetings.setStatus(recording, "done");

  const saved = c.closeMeeting(m1, plan1);
  check("the save reports what it did", [saved.accepted, saved.rejected, saved.replaced, saved.left, saved.projectChanged, saved.projectId], [1, 1, 2, 1, true, alpha]);
  check("the speaker is named", meetings.speakers(m1)[0].name, "Priya");
  check("the meeting is filed", meetings.getMeeting(m1).project_id, alpha);
  check("its claims moved with it", k.getClaim(later).project_id, alpha);
  check("the accepted claim is reviewed, with its topic", [k.getClaim(aug).review_state, k.getClaim(aug).topic], ["reviewed", "launch date"]);
  check("the rejected claim is rejected", k.getClaim(noise).review_state, "rejected");
  check("a skipped claim still waits", k.getClaim(later).review_state, "proposed");
  check("the brief now holds the new decision", lines(alpha, "Alpha").includes("Launch moves to August"), true);
  check("the same plan cannot be saved twice", refuses(() => c.closeMeeting(m1, plan1)), true);
  check("the audit row holds counts and no content", rawDb.prepare("SELECT detail FROM data_events WHERE kind = 'meeting_closed_out'").get().detail, "1 accepted, 1 rejected, 2 replaced, 1 left for later");
}

console.log("\nONE DECISION CAN REPLACE TWO");
{
  check("both earlier decisions are out of force", [k.getClaim(june).status, k.getClaim(july).status], ["superseded", "superseded"]);
  check("the trail keeps both", k.chain(aug).sort(), [june, july].sort());
  const newer = reviewedIn(alpha, "Launch moves to September");
  k.supersede(aug, newer);
  check("the trail follows through to the oldest", k.chain(newer).sort(), [aug, june, july].sort());
  k.deleteClaimsFromSource("meeting", "meeting:9000");
}

console.log("\nDELETING THE REPLACEMENT BRINGS BOTH BACK");
{
  const m = newMeeting("Undo");
  const one = reviewedIn(beta, "Vendor is Acme");
  const two = reviewedIn(beta, "Budget is ten");
  const replacement = claim(`meeting:${m}`, "Vendor is Globex and budget is twelve");
  c.closeMeeting(m, c.parsePlan({ claims: [{ answer: "accept", id: replacement, replaces: [one, two] }], projectId: beta, speakers: [] }));
  k.deleteClaimsFromSource("meeting", `meeting:${m}`);
  check("both return to force", [k.getClaim(one).status, k.getClaim(two).status], ["active", "active"]);

  const m2 = newMeeting("Two replace one");
  const first = claim(`meeting:${m2}`, "Vendor is Initech");
  c.closeMeeting(m2, c.parsePlan({ claims: [{ answer: "accept", id: first, replaces: [one] }], projectId: beta, speakers: [] }));
  const m3 = newMeeting("Second replacement");
  const second = claim(`meeting:${m3}`, "Vendor is Hooli");
  k.reviewClaim(second, "accept");
  k.setSourceProject("meeting", `meeting:${m3}`, beta);
  k.supersede(one, second);
  k.deleteClaimsFromSource("meeting", `meeting:${m2}`);
  check("a claim another one still replaces stays out of force", k.getClaim(one).status, "superseded");
  k.deleteClaimsFromSource("meeting", `meeting:${m3}`);
  check("and returns when the last replacement goes", k.getClaim(one).status, "active");
}

console.log("\nMOVING A MEETING SHOWS BOTH BRIEFS");
{
  const m = newMeeting("Move");
  meetings.setProject(m, alpha);
  const moved = claim(`meeting:${m}`, "Standup moves to ten", { projectId: alpha });
  k.reviewClaim(moved, "accept");
  const p = c.previewCloseout(m, c.parsePlan({ claims: [], projectId: beta, speakers: [] }));
  check("the preview covers the brief it leaves and the one it joins", p.briefs.map((x) => x.subject), ["Alpha", "Beta"]);
  check("it leaves one", p.briefs[0].removed.some((l) => l.text === "Standup moves to ten"), true);
  check("and joins the other", p.briefs[1].added.some((l) => l.text === "Standup moves to ten"), true);
  check("still nothing moved", k.getClaim(moved).project_id, alpha);
}

console.log("\nBRIEFS USE THE SAME STATUS WORDING (S7)");
{
  const md = b.renderBrief(b.projectBrief(alpha, "Alpha"));
  check("a reviewed line says what supports it", md.includes("[known from reviewed evidence]"), true);
  check("the internal label is gone", md.includes("[reviewed]"), false);
  const empty = projects.createProject("Empty", "");
  check("an empty section says the evidence is insufficient", b.renderBrief(b.projectBrief(empty, "Empty")).includes("Insufficient evidence: nothing reviewed is recorded."), true);
  check("every evidence level has words", ["conflicting", "inferred", "machine-extracted", "retracted", "reviewed", "superseded"].every((e) => k.EVIDENCE_WORDS[e]), true);
}

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
