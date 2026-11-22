/**
 * Topic entities (docs/PLAN-open-work.md, K4): claims resolve to one topic, a person's acceptance is what creates it,
 * and teaching that two names are one subject changes what conflicts, briefs and answers see.
 *
 * Run with `node test/knowledge-topics.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-topics-${process.pid}.db`);
process.env.EMBEDDINGS_URL = "";

const k = await import("../src/knowledge/store.ts");
const b = await import("../src/knowledge/briefs.ts");
const { gatherEvidence } = await import("../src/knowledge/answer.ts");
const { rawDb } = await import("../src/memory/store.ts");
const projects = await import("../src/projects/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const topicNames = () => k.listEntities("topic").map((e) => e.name);
const P = projects.createProject("Platform", "");
const Q = projects.createProject("Mobile", "");
let n = 0;
const add = (o) => k.addClaim({ method: "manual", passage: "the words", projectId: P, reviewState: "reviewed", saidOn: day(1), sourceKind: "meeting", sourceRef: `meeting:${++n}`, ...o });
const propose = (o) => add({ method: "model", reviewState: "proposed", ...o });

console.log("\nWHO CREATES A TOPIC");
{
  const guess = propose({ kind: "risk", text: "A model's guess", topic: "Model invention" });
  check("a proposed claim does not create a topic", topicNames().includes("Model invention"), false);
  check("and is not linked to one", k.getClaim(guess).topic_id, null);
  const twin = propose({ kind: "risk", text: "The same guess again", topic: "model  invention" });
  k.reviewClaim(guess, "accept");
  const made = k.getClaim(guess).topic_id;
  check("accepting it creates the topic", k.getEntity(made).name, "Model invention");
  check("another proposal using those words joins it", k.getClaim(twin).topic_id, made);
  const rejected = propose({ kind: "risk", text: "Junk", topic: "Junk topic" });
  k.reviewClaim(rejected, "reject");
  check("rejecting one creates nothing", topicNames().includes("Junk topic"), false);
  const moved = add({ kind: "status", text: "Moved", topic: "Before" });
  k.reviewClaim(moved, "accept", { topic: "After" });
  check("correcting the topic moves the claim", k.getClaim(moved).topicName, "After");
  check("and removes a topic nothing uses any more", topicNames().includes("Before"), false);
  k.reviewClaim(moved, "accept", { topic: "   " });
  check("clearing the topic clears the link", [k.getClaim(moved).topic, k.getClaim(moved).topic_id], [null, null]);
}

console.log("\nTEACHING THAT TWO NAMES ARE ONE SUBJECT");
{
  const one = add({ kind: "decision", text: "Launch in June", topic: "launch date" });
  const two = add({ kind: "decision", text: "Launch in August", topic: "ship date" });
  const inProject = (name) => k.findConflicts().filter((g) => g.claims.some((c) => c.topicName === name));
  check("different names do not conflict yet", inProject("launch date").length, 0);
  const launch = k.getEntity(k.getClaim(one).topic_id);
  const clash = k.teachAlias(launch.id, "ship date");
  check("a name in use changes nothing until the merge is confirmed", [clash.taught, clash.clash?.name], [false, "ship date"]);
  k.teachAlias(launch.id, "ship date", { merge: true });
  check("the merge moves the other topic's claims", k.getClaim(two).topic_id, launch.id);
  check("the words each source used are kept", k.getClaim(two).topic, "ship date");
  check("the merged topic is gone", topicNames().includes("ship date"), false);
  check("the two claims now conflict under one name", inProject("launch date").map((g) => g.topic), ["launch date"]);
  check("an answer finds it by the taught name", gatherEvidence("what is the ship date").reviewed.some((c) => c.id === one), true);
  const later = propose({ kind: "decision", text: "Launch in May", topic: "SHIP DATE" });
  check("a later proposal under the alias joins the topic", k.getClaim(later).topic_id, launch.id);
  const unlinked = propose({ kind: "status", text: "Go-live is close", topic: "go live" });
  k.teachAlias(launch.id, "go live");
  check("a new alias picks up waiting claims with those words", k.getClaim(unlinked).topic_id, launch.id);
}

console.log("\nACROSS PROJECTS");
{
  add({ kind: "risk", text: "Vendor may slip", topic: "vendor" });
  add({ kind: "risk", text: "Supplier unsigned", projectId: Q, topic: "supplier" });
  const risks = () => b.operation("recurring-risks").sections[0].items.map((i) => i.text).sort();
  check("two names are not yet a recurring risk", risks().includes("Vendor may slip"), false);
  const vendor = k.listEntities("topic").find((e) => e.name === "vendor");
  k.teachAlias(vendor.id, "supplier", { merge: true });
  check("once merged, the risk recurs across projects", risks().filter((t) => /Vendor|Supplier/.test(t)), ["Supplier unsigned", "Vendor may slip"]);
  check("claims can be filtered by topic", k.listClaims({ topicId: vendor.id }).length, 2);
}

console.log("\nA TOPIC BRIEF");
{
  const older = add({ kind: "decision", saidOn: day(30), text: "Use Postgres", topic: "database" });
  const newer = add({ kind: "decision", saidOn: day(2), text: "Use SQLite", topic: "database" });
  k.supersede(older, newer);
  add({ kind: "commitment", due: day(-3), owner: "Sam", projectId: Q, text: "Migrate the data", topic: "database" });
  add({ kind: "question", text: "Who runs backups?", topic: "database" });
  propose({ kind: "risk", text: "Unreviewed worry", topic: "database" });
  const hidden = add({ kind: "status", text: "A sensitive status", topic: "database" });
  k.setClaimSensitive(hidden, true);
  const id = k.listEntities("topic").find((e) => e.name === "database").id;
  const brief = b.topicBrief(id);
  const sec = (t) => brief.sections.find((s) => s.title === t).items.map((i) => i.text);
  check("names the topic", [brief.kind, brief.subject], ["topic", "database"]);
  check("shows only the decision in force", sec("Active decisions"), ["Use SQLite"]);
  check("keeps what it replaced", sec("Resolved or replaced"), ["Use Postgres"]);
  check("spans projects", sec("Commitments, by due date"), ["Migrate the data"]);
  check("leaves unreviewed claims out and counts them", [sec("Risks"), brief.waitingForReview], [[], 1]);
  check("withholds sensitive claims and counts them", [sec("Current status"), brief.withheldSensitive], [[], 1]);
  const then = b.topicBrief(id, { asOf: day(10) });
  const thenSec = (t) => then.sections.find((s) => s.title === t).items.map((i) => i.text);
  check("as of an earlier date, the old decision was in force", thenSec("Active decisions"), ["Use Postgres"]);
  check("and had not been replaced yet", thenSec("Resolved or replaced"), []);
  const person = k.upsertEntity("person", "Dana");
  let refused = false;
  try {
    b.topicBrief(person.id);
  } catch {
    refused = true;
  }
  check("a person's id is not a topic", refused, true);
}

console.log("\nDELETION");
{
  add({ kind: "claim", sourceKind: "meeting", sourceRef: "meeting:private", text: "A private subject", topic: "Confidential reorg" });
  check("the topic exists while a claim uses it", topicNames().includes("Confidential reorg"), true);
  k.deleteClaimsFromSource("meeting", "meeting:private");
  check("deleting the source removes the topic's name too", topicNames().includes("Confidential reorg"), false);
  add({ kind: "claim", sourceKind: "meeting", sourceRef: "meeting:taught", text: "Taught subject", topic: "Kept topic" });
  const kept = k.listEntities("topic").find((e) => e.name === "Kept topic");
  k.teachAlias(kept.id, "Retained name");
  k.deleteClaimsFromSource("meeting", "meeting:taught");
  check("a topic a person taught a name to stays", topicNames().includes("Kept topic"), true);
}

console.log("\nCLAIMS FROM BEFORE TOPICS WERE LINKED");
{
  const old = add({ kind: "status", text: "Reviewed long ago", topic: "Legacy subject" });
  const waiting = propose({ kind: "status", text: "Still waiting", topic: "Legacy subject" });
  const unknown = propose({ kind: "status", text: "Never reviewed", topic: "Unreviewed legacy" });
  rawDb.prepare("UPDATE kn_claims SET topic_id = NULL WHERE id IN (?, ?, ?)").run(old, waiting, unknown);
  rawDb.prepare("DELETE FROM kn_entities WHERE kind = 'topic' AND name = 'Legacy subject'").run();
  await import("../src/knowledge/store.ts?restart=1");
  const id = k.getClaim(old).topic_id;
  check("a start links reviewed claims", k.getEntity(id)?.name, "Legacy subject");
  check("and waiting claims that use the same words", k.getClaim(waiting).topic_id, id);
  check("but never makes a topic from unreviewed words", [k.getClaim(unknown).topic_id, topicNames().includes("Unreviewed legacy")], [null, false]);
  const before = topicNames().length;
  await import("../src/knowledge/store.ts?restart=2");
  check("repeating it changes nothing", topicNames().length, before);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
