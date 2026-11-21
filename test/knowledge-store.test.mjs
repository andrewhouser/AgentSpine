/**
 * The knowledge store (docs/PLAN-open-work.md, K4): cited claims, review, supersession over time, conflicts, and
 * extraction that cannot invent a citation.
 *
 * Run with `node test/knowledge-store.test.mjs`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-kstore-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.INBOX_DIR = path.join(root, "inbox");
process.env.EMBEDDINGS_URL = "";

// A stand-in local model that returns whatever the test queues.
const replies = [];
const requests = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    requests.push(body);
    const content = replies.shift() ?? '{"claims":[]}';
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content, role: "assistant" } }], usage: { total_tokens: 1 } }));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${model.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_RETRIES = "0";

const k = await import("../src/knowledge/store.ts");
const x = await import("../src/knowledge/extract.ts");
const meetings = await import("../src/meetings/store.ts");
const session = await import("../src/meetings/session.ts");
const projects = await import("../src/projects/store.ts");
const { listDataEvents } = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const base = { kind: "decision", method: "manual", sourceKind: "note", sourceRef: "n1" };
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

console.log("\nCITATIONS ARE REQUIRED");
{
  check("a claim with no passage is refused", throws(() => k.addClaim({ ...base, passage: "", text: "We ship in June" })), true);
  check("a claim with no source is refused", throws(() => k.addClaim({ ...base, passage: "we ship in June", sourceKind: "", text: "x" })), true);
  check("an unknown kind is refused", throws(() => k.addClaim({ ...base, kind: "rumour", passage: "p", text: "x" })), true);
  const id = k.addClaim({ ...base, passage: "Priya: we ship in June", saidOn: "2026-03-01", text: "Launch is in June", topic: "launch date" });
  check("a cited claim is stored, unreviewed unless a person entered it", k.getClaim(id).review_state, "proposed");
  check("the same claim from the same source is one claim", k.addClaim({ ...base, passage: "again", saidOn: "2026-03-01", text: "launch is in  JUNE" }), id);
  const byHand = k.addClaim({ ...base, passage: "my note", reviewState: "reviewed", sourceRef: "n2", text: "Budget is fixed" });
  check("a claim a person enters is already reviewed", [k.getClaim(byHand).review_state, k.getClaim(byHand).reviewed !== null], ["reviewed", true]);
}

console.log("\nREVIEW");
{
  const id = k.addClaim({ ...base, owner: "Priya R.", passage: "Priya will send the plan", reviewState: "proposed", sourceRef: "n3", text: "Priya sends the plan", kind: "commitment", due: "2026-04-01" });
  check("an owner becomes a person entity", k.getClaim(id).ownerName, "Priya R.");
  const accepted = k.reviewClaim(id, "accept", { text: "Priya sends the revised plan", owner: "Priya Rao" });
  check("accepting can correct it, and marks it reviewed", [accepted.review_state, accepted.text, accepted.ownerName], ["reviewed", "Priya sends the revised plan", "Priya Rao"]);
  const rej = k.addClaim({ ...base, passage: "maybe", sourceRef: "n4", text: "Something dubious" });
  check("rejecting keeps the row but not the trust", k.reviewClaim(rej, "reject").review_state, "rejected");
  const e = k.upsertEntity("person", "priya rao");
  k.addAlias(e.id, "Priya R.");
  check("an alias merges two spellings into one person", [k.upsertEntity("person", "PRIYA R.").id === e.id, k.listEntities("person").length], [true, 1]);
  check("and the claims of the merged one now belong to the survivor", k.getClaim(id).ownerName, "Priya Rao");
}

console.log("\nSUPERSESSION: ONLY A PERSON MARKS IT, AND TIME IS EXPLICIT");
{
  const june = k.addClaim({ ...base, kind: "status", passage: "launch is June", reviewState: "reviewed", saidOn: "2026-03-01", sourceRef: "s1", text: "Launch is June", topic: "launch" });
  const aug = k.addClaim({ ...base, kind: "status", passage: "launch moved to August", reviewState: "reviewed", saidOn: "2026-06-01", sourceRef: "s2", text: "Launch moved to August", topic: "launch" });
  check("two reviewed claims about one topic are reported as a conflict", k.findConflicts().some((g) => g.topic === "launch" && g.claims.length === 2), true);
  check("each is labelled conflicting", [k.evidenceLevel(k.getClaim(june)), k.evidenceLevel(k.getClaim(aug))], ["conflicting", "conflicting"]);
  k.supersede(june, aug);
  check("the older becomes superseded and the newer records what it replaced", [k.getClaim(june).status, k.getClaim(aug).supersedes_id], ["superseded", june]);
  check("the conflict is resolved by the person's act", k.findConflicts().some((g) => g.topic === "launch"), false);
  check("evidence levels follow", [k.evidenceLevel(k.getClaim(june)), k.evidenceLevel(k.getClaim(aug))], ["superseded", "reviewed"]);
  check("the trail of how it evolved is kept", k.chain(aug), [june]);
  check("as of May, the old claim was still the current one", k.listClaims({ asOf: "2026-05-01", kind: "status" }).map((c) => c.id), [june]);
  check("as of July it is the new one", k.listClaims({ asOf: "2026-07-01", kind: "status", status: "active" }).map((c) => c.id), [aug]);
  check("a claim cannot replace itself", throws(() => k.supersede(aug, aug)), true);
  check("nor make the history circular", throws(() => k.supersede(aug, june)), true);
  check("nor replace a different kind", throws(() => k.supersede(aug, k.addClaim({ ...base, passage: "p", sourceRef: "d1", text: "a decision" }))), true);
  check("a superseded claim cannot simply be retracted", throws(() => k.setClaimStatus(june, "retracted")), true);
  const q = k.addClaim({ ...base, kind: "question", passage: "who owns QA?", sourceRef: "q1", text: "Who owns QA?" });
  check("a question can be resolved", k.setClaimStatus(q, "resolved").status, "resolved");
  check("an unreviewed claim is labelled machine-extracted", k.evidenceLevel(k.getClaim(k.addClaim({ ...base, passage: "p", sourceRef: "m9", text: "unreviewed" }))), "machine-extracted");
  const inferred = k.addClaim({ ...base, method: "inferred", passage: "combining s1 and s2", reviewState: "reviewed", sourceRef: "i1", text: "The plan slipped by two months" });
  check("an inference is labelled as one, never as a reviewed fact", k.evidenceLevel(k.getClaim(inferred)), "inferred");
}

console.log("\nMEETING EXTRACTIONS ARE NORMALIZED, NOT RE-EXTRACTED");
{
  const pid = projects.createProject("Reorg", "");
  const mid = meetings.startMeeting("mic", pid, "Planning");
  meetings.setStatus(mid, "done", "ok");
  meetings.startExtraction(mid, "test");
  meetings.saveExtraction(mid, { decisions: [{ quote: "we will go with option B", start_ms: 61000, text: "Go with option B" }], elapsedMs: 1, summary: "s", topics: [], windows: 1 });
  meetings.addWorkItem(mid, { owner: "Sam", quote: "Sam will draft the memo", startMs: 70000, task: "Draft the memo", verdict: "queued", verdictNote: null });
  meetings.addWorkItem(mid, { owner: null, quote: null, startMs: null, task: "Not a real task", verdict: "not-a-task", verdictNote: null });
  meetings.addWorkItem(mid, { owner: "Priya", quote: "Priya booked the room", startMs: 80000, task: "Book the room", verdict: "filed", verdictNote: null });
  check("decisions and real work items become claims", x.normalizeMeeting(mid), 3);
  const claims = k.listClaims({ sourceKind: "meeting", sourceRef: `meeting:${mid}` });
  check("a false positive is not carried over", claims.some((c) => c.text === "Not a real task"), false);
  const d = claims.find((c) => c.kind === "decision");
  check("a decision keeps its quote, its timestamp, its date and project", [d.passage, d.at_ms, d.said_on, d.project_id], ["we will go with option B", 61000, new Date().toISOString().slice(0, 10), pid]);
  check("a queued work item is proposed, a filed one is reviewed", [claims.find((c) => c.text === "Draft the memo").review_state, claims.find((c) => c.text === "Book the room").review_state], ["proposed", "reviewed"]);
  check("running it again adds nothing", [x.normalizeMeeting(mid), k.listClaims({ sourceKind: "meeting", sourceRef: `meeting:${mid}` }).length], [3, 3]);
  check("deleting the meeting removes the claims cited to it", [session.deleteMeeting(mid).ok, k.listClaims({ sourceRef: `meeting:${mid}` }).length], [true, 0]);
  check("and the audit row says how many", /3 knowledge claim/.test(listDataEvents(5, "meeting_deleted")[0].detail), true);
}

console.log("\nEXTRACTION CANNOT INVENT A CITATION");
{
  const text = "Weekly sync notes.\nSam: we decided to move the launch to August.\nPriya will send the vendor contract by Friday.\nRisk: the vendor may miss the date.";
  replies.push(JSON.stringify({ claims: [
    { kind: "decision", quote: "we decided to move the launch to August", speaker: "Sam", text: "Launch moves to August", topic: "launch date" },
    { kind: "commitment", owner: "Priya", quote: "Priya will send the vendor contract", due: "2026-12-04", text: "Priya sends the vendor contract" },
    { kind: "decision", quote: "we agreed to hire three engineers", text: "Hire three engineers" },
    { kind: "risk", text: "no quote at all" },
    { kind: "nonsense", quote: "Risk: the vendor may miss the date", text: "bad kind" },
  ] }));
  const r = await x.extractClaims({ saidOn: "2026-11-21", sourceKind: "inbox", sourceRef: "inbox:77", text });
  check("quotes that are really in the text are kept", r.kept, 2);
  check("an invented quote, a missing quote and a bad kind are dropped", r.dropped, 3);
  const got = k.listClaims({ sourceRef: "inbox:77" });
  check("kept claims start unreviewed and say a model found them", got.every((c) => c.review_state === "proposed" && c.method === "model"), true);
  check("the invented one never reached the store", got.some((c) => /three engineers/.test(c.text)), false);
  check("owner, due date and speaker came through", [got.find((c) => c.kind === "commitment").ownerName, got.find((c) => c.kind === "commitment").due, got.find((c) => c.kind === "decision").speaker], ["Priya", "2026-12-04", "Sam"]);
  check("the request was marked private and the text marked untrusted", [requests.at(-1).includes("UNTRUSTED") || /untrusted/i.test(requests.at(-1))], [true]);
  replies.push("this is not json");
  check("an unparseable reply is survived", (await x.extractClaims({ sourceKind: "inbox", sourceRef: "inbox:78", text })).kept, 0);
  replies.push(JSON.stringify({ claims: [{ kind: "decision", quote: "WE DECIDED  to move the LAUNCH to august", text: "again" }] }));
  check("a quote matches ignoring case and spacing", (await x.extractClaims({ sourceKind: "inbox", sourceRef: "inbox:79", text })).kept, 1);
}

model.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
