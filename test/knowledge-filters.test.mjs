/**
 * K2's filters that need the knowledge store (docs/PLAN-open-work.md section 8): a person or team filter on
 * passages, a filter by what backs a source (reviewed, extracted, none), and the structured path in
 * knowledge_claims, where a person, team or kind decides which claims qualify and the words only narrow them.
 * All names are invented.
 *
 * Run with `node test/knowledge-filters.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-kfilters-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDINGS_URL = "";

const projects = await import("../src/projects/store.ts");
const { searchKnowledge } = await import("../src/projects/search.ts");
const { searchFiltered } = await import("../src/knowledge/retrieval.ts");
const { gatherEvidence, UnknownEntityError } = await import("../src/knowledge/answer.ts");
const k = await import("../src/knowledge/store.ts");
const { registry } = await import("../src/tools/index.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const heads = (hits) => hits.map((h) => h.text.slice(0, 10)).sort();

const P = projects.createProject("Platform", "");
const Q = projects.createProject("Mobile", "");
const doc = projects.addSource(P, "/docs/migration.md", "path");
const meet = projects.addSource(P, "meeting:7", "meeting");
const notes = projects.addSource(P, "/docs/notes.md", "path");
const other = projects.addSource(Q, "/docs/mobile.md", "path");
const put = (pid, sid, p, ord, text) => projects.insertChunk(pid, sid, p, ord, "2026-05-01", text, null);

put(P, doc, "/docs/migration.md", 0, "Priya Rao owns the migration cutover and the rollback plan.");
put(P, doc, "/docs/migration.md", 1, "The migration needs a freeze window in June.");
put(P, meet, "meeting:7", 0, "Sam asked whether the migration can slip to August.");
put(P, notes, "/docs/notes.md", 0, "Samsung devices fail the migration smoke test.");
put(P, notes, "/docs/notes.md", 1, "PR said the migration dashboard is ready.");
put(Q, other, "/docs/mobile.md", 0, "Priya Rao reviewed the mobile migration too.");
put(Q, other, "/docs/mobile.md", 1, "Priya from finance asked about the migration budget.");

const priya = k.upsertEntity("person", "Priya Rao");
k.addAlias(priya.id, "PR");
const sam = k.upsertEntity("person", "Sam");
const team = k.upsertEntity("team", "Platform team");
k.relate(priya.id, team.id, "member_of");
k.relate(sam.id, team.id, "member_of");
const lonely = k.upsertEntity("team", "Data team");

// What backs each source: the migration doc has a reviewed claim, the meeting only an extracted one.
const claim = (over) => k.addClaim({ kind: "decision", method: "meeting-extraction", passage: over.text, projectId: P, ...over });
claim({ owner: "Priya Rao", reviewState: "reviewed", sourceKind: "path", sourceRef: "/docs/migration.md", text: "Cutover is owned by Priya", topic: "cutover" });
claim({ kind: "risk", reviewState: "proposed", sourceKind: "meeting", sourceRef: "meeting:7", speaker: "Sam", text: "The migration may slip to August", topic: "migration date" });
claim({ kind: "risk", reviewState: "reviewed", sourceKind: "meeting", sourceRef: "meeting:8", speaker: "Sam", text: "Vendor contract ends in July", topic: "vendor" });
claim({ kind: "question", reviewState: "reviewed", sourceKind: "meeting", sourceRef: "meeting:8", speaker: "PR", text: "Who signs off the freeze window", topic: "freeze" });
claim({ kind: "commitment", owner: "Sam", reviewState: "reviewed", sourceKind: "meeting", sourceRef: "meeting:8", text: "Sam sends the runbook Friday", topic: "runbook" });
claim({ kind: "decision", reviewState: "reviewed", sourceKind: "meeting", sourceRef: "meeting:9", speaker: "Alex", text: "Mobile ships the migration last", topic: "order" });

console.log("\nSEARCH: A PERSON");
{
  const r = await searchFiltered("migration", { person: "Priya Rao", projectId: P });
  check("passages that name her, by name or alias", heads(r.hits), ["PR said th", "Priya Rao "]);
  check("the names searched are reported", r.who.names, ["Priya Rao", "PR"]);
  const sams = await searchFiltered("migration", { person: "sam", projectId: P });
  check("a whole word only: Sam is not in Samsung, and case does not matter", heads(sams.hits), ["Sam asked "]);
  const nobody = await searchFiltered("migration", { person: "Jordan" });
  check("an unknown person finds nothing and says why", [nobody.hits.length, /no person called "Jordan"/.test(nobody.note)], [0, true]);
  check("a team name is not taken as a person", (await searchFiltered("migration", { person: "Platform team" })).hits.length, 0);
  const everywhere = await searchFiltered("migration", { person: "Priya Rao" });
  check("with no project, it reaches every project she is named in", heads(everywhere.hits), ["PR said th", "Priya Rao ", "Priya Rao "]);
  check("a bare first name is not hers until it is taught as an alias", everywhere.hits.some((h) => h.text.startsWith("Priya from")), false);
}

console.log("\nSEARCH: A TEAM");
{
  const r = await searchFiltered("migration", { projectId: P, team: "Platform team" });
  check("passages that name any recorded member", heads(r.hits), ["PR said th", "Priya Rao ", "Sam asked "]);
  const empty = await searchFiltered("migration", { team: "Data team" });
  check("a team with no members says so", [empty.hits.length, /no members are recorded/.test(empty.note ?? "")], [0, true]);
  check("an id works as well as a name", heads((await searchFiltered("migration", { projectId: P, team: String(team.id) })).hits).length, 3);
  void lonely;
}

console.log("\nSEARCH: WHAT BACKS THE SOURCE");
{
  const reviewed = await searchFiltered("migration", { evidence: ["reviewed"], projectId: P });
  check("reviewed: only the doc with a reviewed claim", [...new Set(reviewed.hits.map((h) => h.path))], ["/docs/migration.md"]);
  const extracted = await searchFiltered("migration", { evidence: ["extracted"], projectId: P });
  check("extracted: only the meeting nobody has reviewed", [...new Set(extracted.hits.map((h) => h.path))], ["meeting:7"]);
  const none = await searchFiltered("migration", { evidence: ["none"], projectId: P });
  check("none: only the notes nothing was drawn from", [...new Set(none.hits.map((h) => h.path))], ["/docs/notes.md"]);
  const two = await searchFiltered("migration", { evidence: ["reviewed", "none"], projectId: P });
  check("two groups together", [...new Set(two.hits.map((h) => h.path))].sort(), ["/docs/migration.md", "/docs/notes.md"]);
  const both = await searchFiltered("migration", { evidence: ["reviewed"], person: "PR", projectId: P });
  check("filters combine", heads(both.hits), ["Priya Rao "]);
  check("every hit still says what backs it", reviewed.hits.every((h) => h.evidence.level === "reviewed"), true);
}

console.log("\nSEARCH WITHOUT FILTERS IS UNCHANGED");
{
  check("plain search still finds all five project passages", (await searchKnowledge("migration", { k: 10, perSource: 5, projectId: P })).length, 5);
  check("an empty name list matches nothing rather than everything", (await searchKnowledge("migration", { mentions: [], projectId: P })).length, 0);
  check("a name with LIKE wildcards in it is taken literally", (await searchKnowledge("migration", { mentions: ["%"], projectId: P })).length, 0);
}

console.log("\nCLAIMS: THE STRUCTURED PATH");
{
  const raised = gatherEvidence("what has Sam raised", { person: "Sam" });
  check("'what has Sam raised' answers from Sam's claims, not the word 'raised'", raised.reviewed.map((c) => c.text).sort(), ["Sam sends the runbook Friday", "Vendor contract ends in July"]);
  check("his unreviewed claim is a lead, not the answer", raised.leads.map((c) => c.text), ["The migration may slip to August"]);
  check("and the answer is supported", raised.status, "supported");
  const risks = gatherEvidence("", { kind: "risk", person: "Sam" });
  check("person and kind together", risks.reviewed.map((c) => c.text), ["Vendor contract ends in July"]);
  const owed = gatherEvidence("runbook", { kind: "commitment", team: "Platform team" });
  check("a team: what its members owe, narrowed by the subject", owed.reviewed.map((c) => c.text), ["Sam sends the runbook Friday"]);
  const alias = gatherEvidence("", { person: "PR" });
  check("an alias finds the person, owner or speaker", alias.reviewed.map((c) => c.text).sort(), ["Cutover is owned by Priya", "Who signs off the freeze window"]);
  const subject = gatherEvidence("vendor", { person: "Priya Rao" });
  check("words still narrow: Priya said nothing about the vendor", subject.status, "insufficient");
  let threw = "";
  try {
    gatherEvidence("x", { person: "Jordan" });
  } catch (e) {
    threw = e instanceof UnknownEntityError ? "unknown" : String(e);
  }
  check("an unknown person is an error, never an answer for everyone", threw, "unknown");
  check("without a filter, matching is as before", gatherEvidence("vendor contract").reviewed.map((c) => c.text), ["Vendor contract ends in July"]);
}

console.log("\nTHE TOOLS");
{
  const claims = registry.knowledge_claims;
  const out = await claims.run({ kind: "risk", person: "Sam" }, {});
  check("knowledge_claims with only a person and kind", /SUPPORTED/.test(out) && /Vendor contract/.test(out), true);
  check("an unknown person says nothing was answered", /Nothing was answered for anyone else/.test(await claims.run({ person: "Jordan" }, {})), true);
  check("a bad kind is refused", /kind must be one of/.test(await claims.run({ kind: "rumour", person: "Sam" }, {})), true);
  check("nothing to ask is refused", /needs a "question"/.test(await claims.run({}, {})), true);
  const pinned = await claims.run({ projectId: Q, question: "migration" }, { run: { projectId: P } });
  check("a project run cannot read another project's claims", /can only read that project/.test(pinned), true);
  const inProject = await claims.run({ question: "mobile migration last" }, { run: { projectId: Q } });
  check("and leaving the project out does not widen it", /INSUFFICIENT/.test(inProject), true);

  const search = registry.knowledge_search;
  const s = await search.run({ person: "Priya Rao", projectId: P, query: "migration" }, {});
  check("knowledge_search with a person says who it searched for", /Passages naming Priya Rao \(searched: Priya Rao, PR\)/.test(s), true);
  check("a bad evidence value is refused", /evidence must be any of/.test(await search.run({ evidence: ["rumour"], query: "migration" }, {})), true);
  check("an unknown team says so", /no team called "Ops"/.test(await search.run({ query: "migration", team: "Ops" }, {})), true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
