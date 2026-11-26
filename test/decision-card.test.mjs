/**
 * The decision card (PLAN-open-work section 15, R2): the four facts come from code, "read outside
 * content" is recorded on the run, the tree and the thread, and "Always allow" is offered only for
 * a shape the promoter already proposes, never for a pinned call or one made after outside content.
 * Names and addresses are invented.
 *
 * Run with `node test/decision-card.test.mjs`.
 */
import "./helpers/example-policy.mjs";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spine-card-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.PROMOTE_MIN_APPROVALS = "2";
process.env.PROMOTE_MIN_DAYS = "0";
process.env.CONFIRM_EXPIRE_AFTER_MIN = "60";

const store = await import("../src/memory/store.ts");
const { decisionCard, factsFor, originOf } = await import("../src/decision-card.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nWHO STARTED IT");
const r = (kind, extra = {}) => ({ kind, parent_run_id: null, task_by_code: null, ...extra });
check("no run is a button", originOf(null, null), "button");
check("a chat turn is you", originOf(r("chat"), r("chat")), "you-typed");
check("a chat turn whose task code wrote is a button", originOf(r("chat", { task_by_code: 1 }), r("chat", { task_by_code: 1 })), "button");
check("a schedule is a schedule", originOf(r("schedule"), r("schedule")), "schedule");
check("the heartbeat is a schedule", originOf(r("heartbeat"), r("heartbeat")), "schedule");
check("a helper inside your chat is still you", originOf(r("subagent", { parent_run_id: 1 }), r("chat")), "you-typed");
check("a helper inside a job is that job", originOf(r("subagent", { parent_run_id: 1 }), r("schedule")), "schedule");
check("a resumed approval is you", originOf(r("approval"), r("approval")), "you-typed");

console.log("\nTHE FOUR FACTS");
const conv = store.createConversation("Card test");
const chatRun = store.startRun({ conversationId: conv, kind: "chat", task: "draft a note to Ada" });
const draftArgs = { body: "Numbers attached.", subject: "Q1 headcount", to: "ada@example.com" };
const c1 = store.queueConfirmation({ args: draftArgs, tool: "draft" }, "Draft an email to ada@example.com", chatRun);
let f = factsFor(store.getConfirmation(c1)).facts;
check("what leaves is the tool's own declaration", f.leaves, ["Q1 headcount", "Numbers attached."]);
check("said in a sentence", f.leavesLine, "2 pieces of text leave this machine.");
check("a queued call cannot be undone", f.undo, "irreversible");
check("a run the cloud never served is local", f.where, "local");
store.noteServed(chatRun, { model: "cloud-x", tier: "deep", via: "cloud" });
check("a run the cloud served says so", factsFor(store.getConfirmation(c1)).facts.where, "cloud");
store.markRunPrivate(chatRun);
check("a pinned run is local whatever served it", factsFor(store.getConfirmation(c1)).facts.where, "local");
check("why: you asked", f.whyLine, "You asked for this in a conversation.");
check("nothing outside was read yet", f.readOutside, false);

const noteArgs = { body: "hi", title: "Ping" };
const c0 = store.queueConfirmation({ args: { path: "/tmp/x.txt", content: "x" }, tool: "write_file" }, "Write a file", null);
const f0 = factsFor(store.getConfirmation(c0)).facts;
check("a tool that declares nothing sends nothing", f0.leavesLine, "Nothing leaves this machine.");
check("no run: a screen asked", [f0.where, f0.origin], ["none", "button"]);
void noteArgs;

console.log("\nOUTSIDE CONTENT IS RECORDED ON THE RUN, THE TREE AND THE THREAD");
const helper = store.startRun({ conversationId: conv, kind: "subagent", parentRunId: chatRun, task: "read the mail" });
store.markReadOutside(helper);
check("the helper is marked", store.readOutsideFor(helper), true);
check("so is the run that started it", store.readOutsideFor(chatRun), true);
const laterTurn = store.startRun({ conversationId: conv, kind: "chat", task: "now draft it" });
check("and a later turn in the same thread", store.readOutsideFor(laterTurn), true);
const otherConv = store.createConversation("Elsewhere");
const clean = store.startRun({ conversationId: otherConv, kind: "chat", task: "x" });
check("another thread is not", store.readOutsideFor(clean), false);
f = factsFor(store.getConfirmation(c1)).facts;
check("the card says why it matters", [f.readOutside, /read outside content/.test(f.whyLine)], [true, true]);

console.log("\nALWAYS ALLOW");
// Two earlier approvals of the same shape, so the promoter proposes it (thresholds lowered above).
const shapeRun = store.startRun({ conversationId: otherConv, kind: "chat", task: "y" });
for (let i = 0; i < 2; i++) {
  const id = store.queueConfirmation({ args: { body: "b", subject: "s", to: "sam@example.com" }, tool: "draft" }, "Draft to Sam", shapeRun);
  store.rawDb.prepare("UPDATE confirmations SET state = 'done' WHERE id = ?").run(id);
}
const cClean = store.queueConfirmation({ args: { body: "b2", subject: "s2", to: "sam@example.com" }, tool: "draft" }, "Draft to Sam again", clean);
const cleanCard = decisionCard(cClean);
check("a proposed shape from a clean run is offered", cleanCard.alwaysAllow && [cleanCard.alwaysAllow.tool, cleanCard.alwaysAllow.approvals], ["draft", 2]);
const cDirty = store.queueConfirmation({ args: { body: "b3", subject: "s3", to: "sam@example.com" }, tool: "draft" }, "Draft to Sam, after mail", laterTurn);
check("never after outside content", decisionCard(cDirty).alwaysAllow, null);
// The draft tool's shape is "drafts" whatever the recipient, so a different tool is the unproposed case.
const cOther = store.queueConfirmation({ args: { content: "x", path: "/tmp/notes/a.txt" }, tool: "write_file" }, "Write a note", clean);
check("never for a shape the promoter has not proposed", decisionCard(cOther).alwaysAllow, null);

console.log("\nONE AT A TIME, OLDEST FIRST");
const pending = store.listConfirmations("pending").map((c) => c.id).sort((a, b) => a - b);
const first = decisionCard(pending[0]);
check("the first card is 1 of all pending", first.position, { index: 1, of: pending.length });
check("and points at the next", first.nextId, pending[1]);
const last = decisionCard(pending.at(-1));
check("the last points back to the oldest still waiting", last.nextId, pending[0]);
check("an expiry from the configured window", Date.parse(first.expiresAt) - Date.parse(first.ts), 60 * 60_000);
check("an unknown id has no card", decisionCard(99999), null);
check("the card never carries the approval token", JSON.stringify(first).includes("token"), false);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
