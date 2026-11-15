/**
 * Approvals that live in the conversation, and schedules that need none.
 *
 *   - A scheduled run's irreversible call executes: creating the schedule was the approval.
 *     The allowlist still applies to it.
 *   - A chat run's irreversible call queues in that run's conversation (a subagent's in its
 *     caller's), and the conversation list counts it — the blue dot.
 *   - A question no conversation raised goes to the inbox thread.
 *   - Deleting a conversation withdraws its open questions.
 *   - The resumed turn waits for every open question, ignores a bare "no", never fires in
 *     the inbox, and hears about each decision once.
 *
 * Run with `node test/conversation-approvals.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-conv-approvals-${process.pid}.db`);
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";

const store = await import("../src/memory/store.ts");
const { registry } = await import("../src/tools/index.ts");
const { executeCall } = await import("../src/broker.ts");
const { decisionMessage, resumeConversation } = await import("../src/confirmations.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(60)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// An irreversible tool that does nothing, allowlisted for target "ok" only.
let ran = 0;
registry.__fake_send = {
  argsSchema: "{}",
  checkPolicy: (_p, args) => (args.to === "ok" ? { allowed: true } : { allowed: false, reason: "not allowlisted" }),
  classify: (args) => ({ reversibility: "irreversible", summary: `send to ${args.to}`, target: args.to }),
  description: "test",
  name: "__fake_send",
  run: async () => {
    ran++;
    return "sent";
  },
};
const policy = { autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true } };
const call = (to = "ok") => ({ args: { to }, tool: "__fake_send" });

console.log("\nSCHEDULED — pre-approved, still allowlisted");
{
  const runId = store.startRun({ kind: "schedule", task: "nightly" });
  const r = await executeCall(call(), policy, runId, runId, { conversational: false, goal: "nightly", preApproved: true });
  check("a scheduled irreversible call executes", r.status, "executed");
  check("the tool actually ran", ran, 1);
  check("the audit row says why it skipped the queue", r.output.includes("pre-approved"), true);
  const denied = await executeCall(call("evil"), policy, runId, runId, { conversational: false, goal: "x", preApproved: true });
  check("off-allowlist is still denied", denied.status, "denied");
  const unscheduled = await executeCall(call(), policy, null, null, { conversational: false, goal: "x" });
  check("without preApproved it still queues", unscheduled.status, "queued");
}

console.log("\nCHAT — asked in the conversation, counted for the dot");
const conv = store.createConversation("Email Jeff", null);
let chatCid;
{
  const runId = store.startRun({ conversationId: conv, kind: "chat", task: "email jeff" });
  const r = await executeCall(call(), policy, runId, runId, { conversational: true, goal: "email jeff" });
  check("a chat irreversible call queues", r.status, "queued");
  check("the model is told the buttons are in the thread", r.output.includes("buttons"), true);
  chatCid = Number(/#(\d+)/.exec(r.output)[1]);
  check("the question belongs to that conversation", store.getConfirmation(chatCid).conversation_id, conv);
  const listed = store.listConversations().find((c) => c.id === conv);
  check("the conversation list counts it", listed.attention, 1);

  const child = store.startRun({ conversationId: null, kind: "subagent", parentRunId: runId, task: "helper" });
  const cr = await executeCall(call(), policy, child, runId, { conversational: false, goal: "helper" });
  const childCid = Number(/#(\d+)/.exec(cr.output)[1]);
  check("a subagent's question goes to its caller's thread", store.getConfirmation(childCid).conversation_id, conv);
  check("now two waiting", store.listConversations().find((c) => c.id === conv).attention, 2);
  store.setConfirmation(childCid, "rejected", "rejected by user");
}

console.log("\nINBOX — a question nobody's conversation raised");
{
  const id = store.queueConfirmation({ args: { kind: "task", text: "x" }, tool: "memory_save" }, "Work item", null);
  const inbox = store.getConfirmation(id).conversation_id;
  check("it has a thread", typeof inbox, "number");
  check("that thread is the inbox", store.isInbox(inbox), true);
  check("the inbox is named", store.getConversation(inbox).title, store.INBOX_TITLE);
  store.deleteConversation(inbox);
  check("deleting a thread withdraws its question", store.getConfirmation(id).state, "expired");
  const again = store.queueConfirmation({ args: {}, tool: "memory_save" }, "Another", null);
  check("the inbox comes back when needed", store.isInbox(store.getConfirmation(again).conversation_id), true);
  check("…as a new thread", store.getConfirmation(again).conversation_id !== inbox, true);
  store.setConfirmation(again, "done", "saved");
  check("an inbox decision never resumes a turn", await resumeConversation(store.getConfirmation(again).conversation_id), null);
}

console.log("\nPRUNE — a thread still asking is not an empty thread");
{
  const id = store.queueConfirmation({ args: {}, tool: "memory_save" }, "Kept through a prune", null);
  const inbox = store.getConfirmation(id).conversation_id;
  store.pruneLedger({ auditDays: 90, runDays: 90, traceDays: 90 });
  check("the inbox survives with a question open", !!store.getConversation(inbox), true);
  store.setConfirmation(id, "done", "saved");
}

console.log("\nRESUME — gating, and each decision told once");
{
  // One question is still open (chatCid), so nothing resumes yet.
  check("waits while a question is still open", await resumeConversation(conv), null);
  const unreported = () =>
    store.rawDb.prepare("SELECT COUNT(*) AS n FROM confirmations WHERE conversation_id = ? AND reported IS NULL AND state != 'pending'").get(conv).n;
  check("…and has not consumed the decision made so far", unreported(), 1);
  // A bare no, with nothing else to report, ends the matter.
  store.setConfirmation(chatCid, "rejected", "rejected by user");
  check("a bare rejection does not resume", await resumeConversation(conv), null);
  check("…and both decisions were marked told", unreported(), 0);
}

console.log("\nTHE MESSAGE the resumed turn is given");
{
  const msg = decisionMessage([
    { result: "sent", state: "done", summary: "send to ok" },
    { result: "rejected by user: not today", state: "rejected", summary: "DRAFT (email)\nDear Jeff…" },
    { result: "boom", state: "error", summary: "post it" },
  ]);
  check("approved, with the result", msg.includes("✓ Approved: send to ok\n  Result: sent"), true);
  check("rejected, with the reason, headline only", msg.includes("✗ Rejected: DRAFT (email) — not today"), true);
  check("a failure says so", msg.includes("It failed: boom"), true);
  check("ends by handing back", msg.trim().endsWith("Carry on from here."), true);
}

console.log("\nUNREAD — a finished reply the user has not looked at");
{
  const t = store.createConversation("Unread check", null);
  const unread = () => store.listConversations().find((c) => c.id === t).unread;
  check("a new thread is not unread", unread(), 0);
  const r1 = store.startRun({ conversationId: t, kind: "chat", task: "hi" });
  check("a running turn is not unread yet", unread(), 0);
  store.finishRun(r1, "ok", "hello");
  check("a finished reply is unread", unread(), 1);
  store.markConversationRead(t);
  check("looking at the thread reads it", unread(), 0);
  const r2 = store.startRun({ conversationId: t, kind: "chat", task: "again" });
  store.markConversationRead(t);
  store.finishRun(r2, "ok", "hello again");
  check("a reply that finished after the look is unread", unread(), 1);
}

delete registry.__fake_send;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
