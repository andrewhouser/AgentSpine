/**
 * Evidence level in retrieval (docs/PLAN-open-work.md, K4): a search hit says what its source is backed by, and
 * ranking is untouched.
 *
 * Run with `node test/knowledge-retrieval.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-kn-retrieval-${process.pid}.db`);
process.env.EMBEDDINGS_URL = "";

const meetings = await import("../src/meetings/store.ts");
const session = await import("../src/meetings/session.ts");
const projects = await import("../src/projects/store.ts");
const k = await import("../src/knowledge/store.ts");
const { annotateHits, describeEvidence, evidenceForSource } = await import("../src/knowledge/retrieval.ts");
const { searchKnowledge } = await import("../src/projects/search.ts");
const { knowledgeFor } = await import("../src/projects/recall.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const pid = projects.createProject("Atlas", "");
const meet = async (title, word) => {
  const id = meetings.startMeeting("mic", pid, title);
  meetings.addSegment(id, "final", 0, 0, 3000, `${word} was discussed at length in ${title}`, 0);
  meetings.setStatus(id, "done", "ok");
  await session.indexIntoProject(id, pid, true);
  return id;
};
const claim = (mid, state, text, topic) =>
  k.addClaim({ kind: "decision", method: "meeting-extraction", passage: `${text}`, reviewState: state, sourceKind: "meeting", sourceRef: `meeting:${mid}`, text, topic });

const plain = await meet("plain", "zebrafish");
const reviewedM = await meet("reviewed", "quokka");
const machineM = await meet("machine", "axolotl");
const conflictM = await meet("conflict", "narwhal");
const otherM = await meet("other", "pangolin");
claim(reviewedM, "reviewed", "ship quokka in March", "quokka");
claim(machineM, "proposed", "axolotl is the mascot", "axolotl");
claim(conflictM, "reviewed", "ship narwhal in May", "narwhal");
claim(otherM, "reviewed", "ship narwhal in June", "narwhal");

const search = async (q) => annotateHits(await searchKnowledge(q, { projectId: pid }));
const levelOf = async (q) => (await search(q))[0]?.evidence.level;

console.log("\nA HIT SAYS WHAT ITS SOURCE IS BACKED BY");
check("a source nobody analysed is `none`", await levelOf("zebrafish"), "none");
check("a source with a reviewed claim is `reviewed`", await levelOf("quokka"), "reviewed");
check("a source with only an unreviewed claim is `machine-extracted`", await levelOf("axolotl"), "machine-extracted");
check("a source whose claim disagrees with another source's is `conflicting`", await levelOf("narwhal"), "conflicting");
check("the counts are carried", [(await search("quokka"))[0].evidence.claims, (await search("quokka"))[0].evidence.reviewed], [1, 1]);

console.log("\nANNOTATING DOES NOT CHANGE THE RANKING");
{
  const plainHits = await searchKnowledge("discussed at length", { projectId: pid, k: 5 });
  const annotated = annotateHits(plainHits);
  check("same hits in the same order", annotated.map((h) => h.id), plainHits.map((h) => h.id));
  check("a hit whose source row is gone reads as `none`, not an error", annotateHits([{ sourceId: 99999 }])[0].evidence.level, "none");
}

console.log("\nSUPERSEDED AND RETRACTED CLAIMS DO NOT BACK A PASSAGE");
{
  const id = claim(plain, "reviewed", "zebrafish plan", "zebrafish");
  k.setClaimStatus(id, "retracted");
  check("a retracted claim leaves the source at `none`", evidenceForSource("meeting", `meeting:${plain}`).level, "none");
}

console.log("\nWHAT THE MODEL AND THE SCREEN ARE TOLD");
{
  check("`none` says it is not an established fact", /not an established fact/.test(describeEvidence({ claims: 0, level: "none", reviewed: 0, unreviewed: 0 })), true);
  check("a conflict says to report it", /report the conflict/.test(describeEvidence({ claims: 2, level: "conflicting", reviewed: 2, unreviewed: 0 })), true);
  const block = await knowledgeFor(pid, "quokka", 3);
  check("a project run's excerpt header carries the evidence", /reviewed claim\(s\)/.test(block), true);
  const lead = await knowledgeFor(pid, "axolotl", 3);
  check("an unreviewed source is called a lead", /treat as a lead, not a fact/.test(lead), true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
