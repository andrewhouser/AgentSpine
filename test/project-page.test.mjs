/**
 * A project (PLAN-open-work section 15, R8): decided items with who said them and who was there
 * (never "agreed", which is not recorded), open questions no decision settled with how many meetings
 * raised them, risks by who named them, and who is waiting on whom. Everyone is invented.
 *
 * Run with `node test/project-page.test.mjs`.
 */
import "./helpers/example-policy.mjs";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spine-project-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.MEETING_SELF_NAMES = "Robin";

const store = await import("../src/memory/store.ts");
await import("../src/meetings/store.ts");
const k = await import("../src/knowledge/store.ts");
const { readProjectPage } = await import("../src/knowledge/project-page.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const P = 7;
const meeting = (title, started, speakers) => {
  const id = Number(store.rawDb.prepare("INSERT INTO meetings (title, device, started, status, project_id) VALUES (?, 'test', ?, 'done', ?)").run(title, started, P).lastInsertRowid);
  speakers.forEach((name, idx) => store.rawDb.prepare("INSERT INTO meeting_speakers (meeting_id, idx, name) VALUES (?,?,?)").run(id, idx, name));
  return id;
};
const claim = (mid, c) => {
  const id = k.addClaim({ method: "meeting-extraction", projectId: P, sourceKind: "meeting", sourceRef: `meeting:${mid}`, ...c });
  k.reviewClaim(id, "accept");
  return id;
};
const everyone = ["Robin", "Sam Whitfield", "Dana Ortiz", "Lee Okafor"];
const s1 = meeting("Billing standup", "2026-11-05T14:00:00Z", everyone);
const s2 = meeting("Billing standup", "2026-11-12T14:00:00Z", everyone);
const s3 = meeting("Billing standup", "2026-11-19T14:00:00Z", everyone);

const cutover = claim(s2, { atMs: 391_000, kind: "decision", passage: "Let's lock the third.", speaker: "Sam Whitfield", text: "Cutover on 3 February", topic: "cutover date" });
claim(s1, { kind: "question", passage: "When do we cut over?", speaker: "Dana Ortiz", text: "When is the cutover?", topic: "cutover date" });
claim(s1, { kind: "question", passage: "Who owns the backfill?", speaker: "Lee Okafor", text: "Who owns the data backfill?", topic: "backfill owner" });
claim(s2, { kind: "question", passage: "Still no backfill owner.", speaker: "Dana Ortiz", text: "Backfill owner still open", topic: "backfill owner" });
const lastAsk = claim(s3, { atMs: 1_325_000, kind: "question", passage: "We need an owner for the backfill.", speaker: "Robin", text: "Backfill needs an owner", topic: "backfill owner" });
claim(s1, { kind: "risk", passage: "That deploy step is flaky.", speaker: "Lee Okafor", text: "Flaky deploy step", topic: "deploy step" });
claim(s2, { kind: "risk", passage: "The deploy step failed again.", speaker: "Lee Okafor", text: "Deploy step failed again", topic: "deploy step" });
claim(s3, { kind: "risk", passage: "Deploy is still flaky.", speaker: "Sam Whitfield", text: "Deploy still flaky", topic: "deploy step" });
claim(s3, { kind: "risk", passage: "Finance has not signed off.", speaker: "Dana Ortiz", text: "No finance sign-off yet" });
claim(s2, { due: "2026-11-28", kind: "commitment", owner: "Sam Whitfield", passage: "I'll send the dry-run report.", speaker: "Sam Whitfield", text: "Dry-run report" });
claim(s3, { due: "2026-11-20", kind: "commitment", owner: "me", passage: "I'll find an owner.", speaker: "Robin", text: "Find a backfill owner" });
k.reviewClaim(claim(s3, { kind: "decision", passage: "secret", speaker: "Sam Whitfield", text: "Hidden decision" }), "accept");
k.setClaimSensitive(k.listClaims({ limit: 500 }).find((c) => c.text === "Hidden decision").id, true);
k.addClaim({ kind: "decision", method: "meeting-extraction", passage: "maybe", projectId: P, sourceKind: "meeting", sourceRef: `meeting:${s3}`, text: "Unreviewed decision" });
k.addClaim({ kind: "decision", method: "manual", passage: "other", projectId: 99, reviewState: "reviewed", sourceKind: "meeting", sourceRef: `meeting:${s3}`, text: "Another project's decision" });

const NOW = new Date("2026-11-26T15:00:00Z");
const page = readProjectPage(P, NOW);

console.log("\nDECIDED");
check("decisions in force, newest first, this project only", page.decided.map((d) => d.text), ["Cutover on 3 February"]);
check("who said it, with the moment", [page.decided[0].saidBy, page.decided[0].moment.atMs, page.decided[0].claimId], ["Sam Whitfield", 391_000, cutover]);
check("who was there, never 'agreed'", page.decided[0].present, ["Dana Ortiz", "Lee Okafor"]);
check("no 'agreedBy' field exists", "agreedBy" in page.decided[0], false);

console.log("\nOPEN");
check("a question a decision settled is not open", page.open.some((o) => o.topic === "cutover date"), false);
check("one row per subject, with the meetings that raised it", page.open.map((o) => [o.topic, o.raisedIn]), [["backfill owner", 3]]);
check("the latest wording and moment", [page.open[0].text, page.open[0].claimId, page.open[0].last.atMs], ["Backfill needs an owner", lastAsk, 1_325_000]);

console.log("\nRISKS");
check("grouped by subject, most raised first", page.risks.map((r) => [r.text, r.times]), [["Deploy still flaky", 3], ["No finance sign-off yet", 1]]);
check("who named it, most often first", page.risks[0].namedBy, ["Lee Okafor", "Sam Whitfield"]);

console.log("\nWAITING");
check("each way, late first", page.waiting.map((w) => [w.text, w.direction, w.who, w.late]), [
  ["Find a backfill owner", "you-owe", null, true],
  ["Dry-run report", "they-owe", "Sam Whitfield", false],
]);
check("meetings counted", page.meetings, 3);
check("a sensitive decision is left out", page.decided.some((d) => d.text === "Hidden decision"), false);
check("an unreviewed one is left out", page.decided.some((d) => d.text === "Unreviewed decision"), false);
check("an empty project is an empty page", readProjectPage(12345, NOW), { decided: [], meetings: 0, open: [], projectId: 12345, risks: [], waiting: [] });

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
