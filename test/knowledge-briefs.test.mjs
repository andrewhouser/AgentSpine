/**
 * Briefs and synthesis operations (docs/PLAN-open-work.md, K6): assembled from reviewed claims, every line cited,
 * unreviewed claims kept out and counted, and an honest "nothing recorded" where the store has no answer.
 *
 * Run with `node test/knowledge-briefs.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-briefs-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDINGS_URL = "";

const k = await import("../src/knowledge/store.ts");
const b = await import("../src/knowledge/briefs.ts");
const projects = await import("../src/projects/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const A = projects.createProject("Platform", "");
const B = projects.createProject("Mobile", "");
let n = 0;
const add = (o) => k.addClaim({ method: "manual", reviewState: "reviewed", saidOn: day(1), sourceKind: "meeting", sourceRef: `meeting:${++n}`, passage: `said: ${o.text}`, projectId: A, ...o });

const decision = add({ kind: "decision", text: "Go with option B", topic: "approach", saidOn: day(3) });
const oldDecision = add({ kind: "decision", text: "Go with option A", topic: "approach", saidOn: day(40) });
k.supersede(oldDecision, decision);
const overdue = add({ kind: "commitment", owner: "Priya", text: "Send the vendor contract", due: day(5), saidOn: day(20) });
const later = add({ kind: "commitment", owner: "Sam", text: "Draft the memo", due: day(-10), saidOn: day(2) });
add({ kind: "risk", text: "Vendor may miss the date", topic: "vendor", saidOn: day(35) });
add({ kind: "risk", text: "Vendor contract unsigned", topic: "vendor", projectId: B, saidOn: day(2) });
add({ kind: "question", text: "Who owns QA?", topic: "qa", speaker: "Priya", saidOn: day(60) });
k.addClaim({ kind: "decision", method: "model", passage: "maybe we should hire", sourceKind: "inbox", sourceRef: "inbox:1", text: "Hire three engineers", projectId: A });

console.log("\nA PROJECT BRIEF");
{
  const brief = b.projectBrief(A, "Platform");
  const sec = (t) => brief.sections.find((s) => s.title === t);
  check("active decisions include only the current one", sec("Active decisions").items.map((i) => i.text), ["Go with option B"]);
  check("a superseded decision is not presented as current", brief.sections.flatMap((s) => s.items).some((i) => i.text === "Go with option A" && s.title === "Active decisions"), false);
  check("the unreviewed claim is kept out and counted", [brief.sections.flatMap((s) => s.items).some((i) => /Hire three/.test(i.text)), brief.waitingForReview], [false, 1]);
  const c = sec("Commitments, by due date").items;
  check("commitments run by due date, with the overdue one flagged", [c.map((i) => i.owner), c[0].overdue, c[1].overdue], [["Priya", "Sam"], true, false]);
  check("every item carries its exact cited words and source", sec("Active decisions").items[0].cite, { atMs: null, passage: "said: Go with option B", source: "meeting meeting:1", sourceState: "available" });
  check("a section with nothing says so, rather than inventing", sec("Goals").empty, "Nothing recorded.");
  check("recent changes are the last fortnight's reviewed claims", sec("Recent changes").items.every((i) => i.saidOn >= day(14)), true);
  check("the people involved are the owners of reviewed commitments", sec("People involved").items.map((i) => i.owner).sort(), ["Priya", "Sam"]);
  const past = b.projectBrief(A, "Platform", { asOf: day(30) });
  check("asking as of an earlier date shows what was current then", past.sections.find((s) => s.title === "Active decisions").items.map((i) => i.text), ["Go with option A"]);
}

console.log("\nA PERSON BRIEF");
{
  const priya = k.listEntities("person").find((e) => e.name === "Priya");
  const brief = b.personBrief(priya.id);
  check("their commitments", brief.sections[0].items.map((i) => i.text), ["Send the vendor contract"]);
  check("what they raised, by speaker", brief.sections[1].items.map((i) => i.text), ["Who owns QA?"]);
  check("the gap in the data is stated, not filled", brief.sections.at(-1).empty, "Not recorded: the store does not yet track what others owe them.");
}

console.log("\nOPERATIONS");
{
  const c = b.operation("commitments", { projectId: A });
  check("commitments: overdue first", c.sections[0].items.map((i) => i.text), ["Send the vendor contract", "Draft the memo"]);
  const mine = b.operation("commitments", { ownerId: k.listEntities("person").find((e) => e.name === "Sam").id });
  check("commitments can be limited to one person", mine.sections[0].items.map((i) => i.owner), ["Sam"]);
  const changed = b.operation("what-changed", { days: 7, projectId: A });
  check("what changed lists new claims and what was replaced", [changed.sections[0].items.some((i) => i.text === "Draft the memo"), changed.sections[1].items.map((i) => i.text)], [true, ["Go with option A"]]);
  const next = b.operation("next-meeting", { projectId: A });
  check("next meeting: due commitments, open questions, active risks, recent decisions", next.sections.map((s) => s.title), ["Overdue and due commitments", "Open questions to raise", "Risks still active", "Decided recently"]);
  const rec = b.operation("recurring-risks");
  check("a risk topic stated in two projects is reported as recurring", rec.sections[0].items.map((i) => i.topic), ["vendor", "vendor"]);
  const stale = b.operation("stale-topics", { days: 30, projectId: A });
  check("unresolved topics gone quiet for a month are listed", stale.sections[0].items.map((i) => i.text).sort(), ["Vendor may miss the date", "Who owns QA?"].sort());
  const week = b.operation("weekly-summary", { projectId: A });
  check("the weekly summary has its fixed sections", week.sections.map((s) => s.title), ["Decisions", "New commitments", "Risks raised", "Questions opened", "Commitments overdue"]);
  check("and an empty week says nothing happened", b.operation("weekly-summary", { projectId: B, asOf: day(0) }).sections[0].empty, "Nothing recorded.");
  check("every operation name is handled", b.OPERATIONS.every((name) => b.operation(name, { projectId: A }).sections.length > 0), true);
}

console.log("\nHOW A DECISION EVOLVED");
{
  const t = b.decisionTrace(decision);
  check("newest first, then what it replaced", t.sections[0].items.map((i) => i.text), ["Go with option B", "Go with option A"]);
}

console.log("\nMARKDOWN AND MATERIALIZATION");
{
  const md = b.renderBrief(b.projectBrief(A, "Platform"));
  check("markdown quotes each citation", md.includes('> "said: Go with option B" (meeting meeting:1)'), true);
  check("it flags overdue work and says how many claims are not included", [md.includes("(OVERDUE)"), md.includes("1 unreviewed claim(s) are not included.")], [true, true]);
  let builds = 0;
  const build = () => (builds++, b.projectBrief(A, "Platform"));
  b.materialize({ kind: "project", subject: String(A) }, build);
  b.materialize({ kind: "project", subject: String(A) }, build);
  check("a stored brief is reused until it is refreshed", builds, 1);
  b.materialize({ kind: "project", subject: String(A) }, build, 0);
  check("a zero age rebuilds it", builds, 2);
}

console.log("\nSENSITIVE CLAIMS ARE WITHHELD, NOT DELETED (K6)");
{
  const secret = add({ kind: "commitment", owner: "Dana", text: "Negotiate the severance terms", due: day(-3) });
  const before = b.projectBrief(A, "Platform");
  const lines = (br) => br.sections.flatMap((x) => x.items.map((i) => i.text));
  check("before it is marked, the claim is in the brief", lines(before).includes("Negotiate the severance terms"), true);
  b.materialize({ kind: "project", subject: String(A) }, () => before, 60);
  k.setClaimSensitive(secret, true);
  const after = b.projectBrief(A, "Platform");
  check("marked sensitive, it leaves the brief and the brief says how many it withheld", [lines(after).includes("Negotiate the severance terms"), after.withheldSensitive], [false, 1]);
  check("the Markdown export says so too", /1 claim\(s\) marked sensitive are withheld/.test(b.renderBrief(after)), true);
  check("a stored brief is dropped when a claim is marked, so nothing leaks for the hour", b.materialize({ kind: "project", subject: String(A) }, () => after, 60).withheldSensitive, 1);
  check("the claim is still in the store for the review screens", [k.getClaim(secret).sensitive, k.listClaims({ projectId: A, limit: 500 }).some((c) => c.id === secret)], [1, true]);
  check("operations leave it out as well", lines(b.operation("commitments", { projectId: A })).includes("Negotiate the severance terms"), false);
  check("so does a person's brief", lines(b.personBrief(k.getClaim(secret).owner_id)).includes("Negotiate the severance terms"), false);
  k.setClaimSensitive(secret, false);
  check("clearing the flag brings it back", lines(b.projectBrief(A, "Platform")).includes("Negotiate the severance terms"), true);
}

console.log("\nA ONE-ON-ONE IS RECORDED FACTS ONLY (K6)");
{
  const priya = k.listEntities("person").find((e) => e.name === "Priya");
  const brief = b.oneOnOne(priya.id);
  const sec = (t) => brief.sections.find((x) => x.title.startsWith(t));
  check("it lists what they owe, overdue flagged", sec("Their commitments").items.map((i) => [i.text, i.overdue]), [["Send the vendor contract", true]]);
  check("what they raised that is still open comes from what they said", sec("Open questions").items.map((i) => i.text), ["Who owns QA?"]);
  check("what others owe them is stated as not recorded", sec("Owed to them").empty.startsWith("Not recorded"), true);
  check("every item still carries its citation", brief.sections.every((x) => x.items.every((i) => i.cite.passage || i.kind === "stakeholder")), true);
}

console.log("\nA PLAN AGAINST THE MEETINGS (K6)");
{
  const plan = "# Q4 plan\n- Go with option B for the approach\n- Send the vendor contract to legal\n- Launch the loyalty programme in Q4\n";
  const cmp = b.comparePlan(plan, { projectId: A, projectName: "Platform" });
  const sec = (t) => cmp.sections.find((x) => x.title.startsWith(t));
  check("a plan line with a recorded decision shows the claim and the plan line it matched", sec("Recorded for these").items.some((i) => i.text === "Go with option B" && /plan line: Go with option B/.test(i.topic)), true);
  check("a plan line with nothing recorded is listed as such", sec("Plan lines with nothing").items.map((i) => i.text), ["Launch the loyalty programme in Q4"]);
  check("recorded commitments the plan does not mention are listed, and ones it does mention are not", [sec("Recorded decisions and commitments the plan does not").items.map((i) => i.text).includes("Draft the memo"), sec("Recorded decisions and commitments the plan does not").items.map((i) => i.text).includes("Send the vendor contract")], [true, false]);
  check("it never claims the two agree", /not agreement/.test(sec("Recorded for these").title), true);
  check("an empty plan compares nothing", b.comparePlan("", { projectId: A }).sections[1].items, []);
}

console.log("\nGOALS WITH MEASURES, AND WHO IS ON WHICH TEAM (K4)");
{
  const goal = add({ kind: "goal", text: "Cut onboarding time in half" });
  const measure = add({ kind: "measure", text: "Median onboarding under 5 days" });
  k.link(measure, goal, "measures");
  const sec = (br, t) => br.sections.find((x) => x.title === t);
  const mine = sec(b.projectBrief(A, "Platform"), "Measures").items.find((i) => i.text === "Median onboarding under 5 days");
  check("a measure appears with the goal it measures", mine?.topic, "measures goal: Cut onboarding time in half");
  check("a measure with no goal linked is still listed", (add({ kind: "measure", text: "NPS above 40" }), sec(b.projectBrief(A, "Platform"), "Measures").items.some((i) => i.text === "NPS above 40")), true);

  const priya = k.listEntities("person").find((e) => e.name === "Priya");
  const sam = k.listEntities("person").find((e) => e.name === "Sam");
  const team = k.upsertEntity("team", "Platform team");
  k.relate(priya.id, team.id, "member_of");
  k.relate(priya.id, sam.id, "reports_to");
  k.relate(priya.id, sam.id, "reports_to");
  check("relations are stored once, in either direction", [k.relationsOf(priya.id).length, k.relationsOf(sam.id).length], [2, 1]);
  const lines = sec(b.personBrief(priya.id), "Team and reporting line").items.map((i) => i.text);
  check("a person brief says them in words, from what a person entered", lines, ["Priya member of Platform team", "Priya reports to Sam"]);
  check("a one-on-one carries the same section", sec(b.oneOnOne(priya.id), "Team and reporting line").items.length, 2);
  check("a person cannot be a member of a person, or relate to themselves", [(() => { try { k.relate(priya.id, sam.id, "member_of"); } catch (e) { return String(e.message); } })(), (() => { try { k.relate(priya.id, priya.id, "works_with"); } catch (e) { return String(e.message); } })()], ["member_of relates a person to a team", "an entity cannot relate to itself"]);
  const samAlias = k.upsertEntity("person", "Samuel");
  k.relate(samAlias.id, priya.id, "works_with");
  k.addAlias(sam.id, "Samuel");
  check("merging two spellings of a person carries their relations over", [k.relationsOf(sam.id).map((r) => r.rel).sort(), k.getEntity(samAlias.id)], [["reports_to", "works_with"], undefined]);
  k.unrelate(priya.id, team.id, "member_of");
  check("a relation can be removed", k.relationsOf(priya.id).some((r) => r.rel === "member_of"), false);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
