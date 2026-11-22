/**
 * Epistemic awareness (docs/PLAN-open-work.md, S7): a scripted conflict is reported as a conflict, an unsupported
 * question says there is insufficient evidence, an unreviewed claim is only ever a lead, and every reviewed claim
 * carries its source passage and timestamp.
 *
 * Run with `node test/knowledge-answer.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-kn-answer-${process.pid}.db`);
process.env.EMBEDDINGS_URL = "";

const k = await import("../src/knowledge/store.ts");
const { gatherEvidence, renderEvidence } = await import("../src/knowledge/answer.ts");
const { registry } = await import("../src/tools/index.ts");
const h = await import("../src/harness.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const add = (over) =>
  k.addClaim({ kind: "decision", method: "meeting-extraction", reviewState: "reviewed", sourceKind: "meeting", ...over });

const launch = add({ atMs: 125_000, passage: "we will launch the Atlas pricing page in March", saidOn: "2026-10-01", sourceRef: "meeting:1", text: "Launch the Atlas pricing page in March", topic: "atlas launch" });
const unrel = add({ passage: "maybe Orion gets a new logo", reviewState: "proposed", sourceRef: "meeting:2", text: "Orion gets a new logo", topic: "orion logo" });
const a = add({ passage: "the Borealis budget is ten thousand", saidOn: "2026-10-02", sourceRef: "meeting:3", text: "Borealis budget is ten thousand", topic: "borealis budget" });
const b = add({ passage: "the Borealis budget is fifteen thousand", saidOn: "2026-10-09", sourceRef: "meeting:4", text: "Borealis budget is fifteen thousand", topic: "borealis budget" });

console.log("\nA SUPPORTED ANSWER CARRIES ITS CITATION");
{
  const e = gatherEvidence("When do we launch the Atlas pricing page?");
  const text = renderEvidence(e);
  check("status is supported", e.status, "supported");
  check("the claim is stated with its id and level", /#\d+ decision: Launch the Atlas pricing page in March \(reviewed/.test(text), true);
  check("it links the source", text.includes("source meeting meeting:1"), true);
  check("it gives the timestamp in the recording", text.includes("@ 2:05"), true);
  check("it quotes the exact words", text.includes('"we will launch the Atlas pricing page in March"'), true);
}

console.log("\nA CONFLICT IS REPORTED AS A CONFLICT");
{
  const e = gatherEvidence("What is the Borealis budget?");
  const text = renderEvidence(e);
  check("status is conflicting", e.status, "conflicting");
  check("both claims are in the conflict", e.conflicts[0].claims.map((c) => c.id).sort(), [a, b].sort());
  check("it says to report both sides and not choose", /CONFLICT on "borealis budget".*do not choose one/.test(text), true);
  check("both figures and both sources appear", ["ten thousand", "fifteen thousand", "meeting:3", "meeting:4"].every((s) => text.includes(s)), true);
}

console.log("\nAN UNSUPPORTED QUESTION SAYS SO");
{
  const e = gatherEvidence("What is the Zephyr headcount plan?");
  check("status is insufficient", e.status, "insufficient");
  check("it says INSUFFICIENT EVIDENCE and not to fill the gap", /INSUFFICIENT EVIDENCE.*do not fill the gap/.test(renderEvidence(e)), true);
  check("a question with no usable words is insufficient, not an error", gatherEvidence("what is the?").status, "insufficient");
  check("an unreviewed claim alone does not make it supported", gatherEvidence("Does Orion get a new logo?").status, "insufficient");
  const lead = renderEvidence(gatherEvidence("Does Orion get a new logo?"));
  check("it shows the unreviewed claim as a lead, never as the answer", [/Unreviewed leads \(NOT facts/.test(lead), /Reviewed claims/.test(lead)], [true, false]);
}

console.log("\nREVIEW STATE, STATUS AND DATE DECIDE WHAT COUNTS");
{
  k.setClaimStatus(launch, "retracted");
  check("a retracted claim no longer answers", gatherEvidence("When do we launch the Atlas pricing page?").status, "insufficient");
  k.setClaimStatus(launch, "active");
  check("asOf before it was said finds nothing", gatherEvidence("When do we launch the Atlas pricing page?", { asOf: "2026-09-01" }).status, "insufficient");
  check("asOf after it was said finds it", gatherEvidence("When do we launch the Atlas pricing page?", { asOf: "2026-11-01" }).status, "supported");
  check("reviewing the lead turns it into the answer", (k.reviewClaim(unrel, "accept"), gatherEvidence("Does Orion get a new logo?").status), "supported");
}

console.log("\nSENSITIVE CLAIMS DO NOT ANSWER (K6)");
{
  const s = add({ passage: "the Cassiopeia severance package is two months", saidOn: "2026-10-03", sourceRef: "meeting:9", text: "Cassiopeia severance package is two months", topic: "cassiopeia severance" });
  check("before it is marked, it answers", gatherEvidence("What is the Cassiopeia severance package?").status, "supported");
  k.setClaimSensitive(s, true);
  const e = gatherEvidence("What is the Cassiopeia severance package?");
  check("marked sensitive, it is insufficient, not leaked", [e.status, renderEvidence(e).includes("two months")], ["insufficient", false]);
}

console.log("\nTHE TOOL AND THE CONTRACT");
{
  const t = registry.knowledge_claims;
  check("it is a read-only, local tool that declares private output", [Boolean(t), t.privateOutput, t.classify({}).reversibility, h.READ_ONLY_TOOLS.has("knowledge_claims")], [true, true, "reversible", true]);
  check("it renders the same text", (await t.run({ question: "What is the Borealis budget?" })).startsWith('Knowledge store, for "What is the Borealis budget?": CONFLICTING'), true);
  check("a bad date is refused plainly", (await t.run({ asOf: "last week", question: "x y z" })).startsWith("ERROR"), true);
  check("no question is refused", (await t.run({})).startsWith("ERROR"), true);
  const withTool = h.harnessContract(["knowledge_claims"], true);
  check("the contract tells the model how an answer may use it", [/A CONFLICT is reported as a conflict/.test(withTool), /INSUFFICIENT EVIDENCE is said plainly/.test(withTool)], [true, true]);
  check("without the tool the contract makes no such claim", /knowledge_claims/.test(h.harnessContract(["state_get"], true)), false);
  check("the capability summary lists it only when visible", [h.summarizeCapabilities(["knowledge_claims"], {}, { cloudPrivateBlocked: false }).can.some((l) => /reviewed claims/.test(l)), h.summarizeCapabilities([], {}, { cloudPrivateBlocked: false }).can.some((l) => /reviewed claims/.test(l))], [true, false]);
  check("claims are not touched by asking", k.getClaim(a).review_state, "reviewed");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
