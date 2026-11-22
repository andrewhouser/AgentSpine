/**
 * SL3 (signals of a bad answer, counted by code) and SL4 (proposals that learn from their outcomes).
 * Run with `node test/learn-signals.test.mjs`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-signals-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.REWRITE_ENABLED = "true";
process.env.LLM_RETRIES = "0";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "";

// A stand-in model, so "a held rewrite never reaches the model" is measured rather than assumed.
let modelCalls = 0;
const modelServer = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    modelCalls += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: `{"task":"Use state_get, then report change ${modelCalls}."}`, role: "assistant" } }],
        usage: { completion_tokens: 10, prompt_tokens: 10, total_tokens: 20 },
      }),
    );
  });
});
await new Promise((r) => modelServer.listen(0, "127.0.0.1", r));
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${modelServer.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";

const store = await import("../src/memory/store.ts");
const { rawDb } = store;
const { rejectConfirmation } = await import("../src/confirmations.ts");
const { badAnswerSignals, isSameAsk, SIGNAL_LIMITS } = await import("../src/learn/signals.ts");
const { adoptPastJobProposals, kindRecord, PROPOSAL_QUIET, proposalGate, recordProposal } = await import("../src/learn/outcomes.ts");
const { queueIntentProposal, queueStandingIntent, taskKey } = await import("../src/learn/propose.ts");
const { proposeRewrite } = await import("../src/learn/rewrite.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const T0 = Date.parse("2026-11-20T15:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const since = new Date(T0 - 3_600_000);
const conversation = (n) => {
  rawDb.prepare("INSERT INTO conversations (id, title, created, updated) VALUES (?,?,?,?)").run(n, `t${n}`, iso(T0), iso(T0));
  return n;
};
let nextRun = 1000;
const run = (conv, task, startMs, { kind = "chat", parent = null, status = "ok", tookMs = 20_000 } = {}) => {
  const id = nextRun++;
  rawDb
    .prepare("INSERT INTO runs (id, started, finished, status, kind, task, conversation_id, parent_run_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, iso(startMs), iso(startMs + tookMs), status, kind, task, conv, parent);
  return id;
};

console.log("\nSAME ASK");
check("a light rephrase is the same ask", isSameAsk("summarize the budget meeting notes", "please summarize budget meeting notes"), true);
check("a different request is not", isSameAsk("summarize the budget meeting notes", "book a table for dinner friday"), false);
check("short replies never match", isSameAsk("continue", "continue"), false);
check("filler alone never matches", isSameAsk("what is this?", "what is this?"), false);

console.log("\nSL3: STOPS AND RE-ASKS");
const c1 = conversation(1);
const c2 = conversation(2);
const stopped = run(c1, "draft the quarterly vendor report", T0, { status: "stopped" });
const askedOver = run(c1, "summarize the budget meeting notes", T0 + 60_000);
const again = run(c1, "please summarize budget meeting notes", T0 + 60_000 + 20_000 + 30_000);
run(c1, "summarize the budget meeting notes", T0 + 60_000 + 20_000 + 30_000 + 20_000 + SIGNAL_LIMITS.reAskWindowMs + 1000);
run(c2, "please summarize budget meeting notes", T0 + 60_000 + 20_000 + 40_000);
run(c1, "check on the deploy status now", T0 + 900_000, { kind: "scheduled", status: "stopped" });
const child = run(c1, "summarize the budget meeting notes", T0 + 950_000, { parent: stopped });
const signals = badAnswerSignals(since, { drafts: { dir: path.join(root, "drafts") } });
check("a stopped chat run is counted, a stopped schedule is not", signals.stops, [stopped]);
check("an immediate re-ask points at the answer it replaced", signals.reAsks, [{ followedBy: again, runId: askedOver }]);
check("a subagent's task is never a re-ask", signals.reAsks.some((r) => r.followedBy === child), false);
check("distinct runs lists each run once", signals.runs, [stopped, askedOver]);
check("the report carries no task text", JSON.stringify(signals).includes("budget"), false);
check("a window after them finds nothing", badAnswerSignals(new Date(T0 + 86_400_000), { drafts: { dir: root } }).stops, []);

console.log("\nSL3: EDITED DRAFTS");
const drafts = path.join(root, "drafts");
fs.mkdirSync(drafts);
const stampOf = (ms) => new Date(ms).toISOString().replace(/[:.]/g, "-").slice(0, 19);
const saveDraft = (runId, name, mtimeMs, dir = drafts) => {
  const file = path.join(dir, `${stampOf(T0)}-email-${name}.md`);
  fs.writeFileSync(file, "body");
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  rawDb
    .prepare("INSERT INTO actions (ts, run_id, tool, args, decision, output) VALUES (?,?,'draft','{}','executed',?)")
    .run(iso(T0), runId, `Draft saved to ${file}. Nothing was sent — open it, and send it yourself if you want it.`);
  return file;
};
const editedRun = run(c2, "write the client a short note", T0 + 1_000_000);
const untouchedRun = run(c2, "write the landlord a short note", T0 + 1_100_000);
const deletedRun = run(c2, "write the plumber a short note", T0 + 1_200_000);
const outsideRun = run(c2, "write the school a short note", T0 + 1_300_000);
saveDraft(editedRun, "edited", T0 + 600_000);
saveDraft(untouchedRun, "untouched", T0 + 1000);
fs.rmSync(saveDraft(deletedRun, "deleted", T0 + 600_000));
const elsewhere = path.join(root, "elsewhere");
fs.mkdirSync(elsewhere);
saveDraft(outsideRun, "outside", T0 + 600_000, elsewhere);
const withDrafts = badAnswerSignals(since, { drafts: { dir: drafts } });
check("only the draft changed after writing counts", withDrafts.editedDrafts, [editedRun]);
const before = rawDb.prepare("SELECT COUNT(*) AS n FROM memories").get().n;
badAnswerSignals(since, { drafts: { dir: drafts } });
check("counting writes no memory", rawDb.prepare("SELECT COUNT(*) AS n FROM memories").get().n, before);

console.log("\nSL4: OUTCOMES");
const job = (task) => ({ count: 3, key: taskKey(task), sample: task });
const first = queueIntentProposal(job("Check the Acme invoice status"));
check("a new proposal is queued and logged", rawDb.prepare("SELECT kind, outcome FROM proposal_log WHERE confirmation_id = ?").get(first), { kind: "schedule", outcome: null });
const logRow = JSON.stringify(rawDb.prepare("SELECT * FROM proposal_log WHERE confirmation_id = ?").get(first));
check("the log holds a hash, not the words", logRow.toLowerCase().includes("acme"), false);
await rejectConfirmation(first, "not useful");
check("your no is recorded as rejected", rawDb.prepare("SELECT outcome FROM proposal_log WHERE confirmation_id = ?").get(first).outcome, "rejected");
check("a rejected proposal is not made again", queueIntentProposal(job("check the ACME invoice status!")), null);
check("nor as a standing intent", queueStandingIntent("Check the Acme invoice status"), null);
check("it shows up as a bad-answer signal", badAnswerSignals(new Date(Date.now() - 60_000), { drafts: { dir: drafts } }).rejectedProposals, [{ confirmationId: first, kind: "schedule" }]);

const refused = queueIntentProposal(job("Check the policy refused thing"));
store.closePendingConfirmation(refused, "rejected", "policy now denies it: nope");
check("a policy refusal is not your no", rawDb.prepare("SELECT outcome FROM proposal_log WHERE confirmation_id = ?").get(refused).outcome, "refused");
check("so it may be proposed again", typeof queueIntentProposal(job("Check the policy refused thing")), "number");

const expired = queueIntentProposal(job("Check the expired thing"));
store.closePendingConfirmation(expired, "expired", "too old");
check("an expiry is not your no", rawDb.prepare("SELECT outcome FROM proposal_log WHERE confirmation_id = ?").get(expired).outcome, "expired");
check("so it may be proposed again too", typeof queueIntentProposal(job("Check the expired thing")), "number");

const accepted = queueIntentProposal(job("Check the accepted thing"));
store.claimConfirmation(accepted);
store.setConfirmation(accepted, "error", "the tool failed");
check("approved counts as accepted even if the tool then failed", rawDb.prepare("SELECT outcome FROM proposal_log WHERE confirmation_id = ?").get(accepted).outcome, "accepted");

console.log("\nSL4: REWRITES");
const watcher = store.createSchedule("watch", "Use state_get and report anything new.", "every day at 9:00am", false);
const proposed = await proposeRewrite(watcher);
check("a rewrite is proposed and logged", rawDb.prepare("SELECT kind FROM proposal_log WHERE confirmation_id = ?").get(proposed?.confirmationId)?.kind, "rewrite");
await rejectConfirmation(proposed.confirmationId, "");
const callsBefore = modelCalls;
check("a rejected rewrite is not proposed again", await proposeRewrite(watcher), null);
check("and the model was not asked", modelCalls, callsBefore);
rawDb.prepare("UPDATE schedules SET task = ? WHERE id = ?").run("Use state_get and report only price changes.", watcher);
check("once the task itself changes it may be", typeof (await proposeRewrite(watcher))?.confirmationId, "number");

console.log("\nSL4: A KIND YOU MOSTLY REJECT");
const NOW = new Date("2026-11-22T12:00:00.000Z");
const seed = (id, kind, outcome, daysAgo) => {
  const at = iso(NOW.getTime() - daysAgo * 86_400_000);
  rawDb.prepare("INSERT INTO proposal_log (confirmation_id, kind, key_hash, made, outcome, decided) VALUES (?,?,?,?,?,?)").run(id, kind, `seed-${id}`, at, outcome, at);
};
rawDb.exec("DELETE FROM proposal_log WHERE kind = 'rewrite'");
for (let i = 0; i < PROPOSAL_QUIET.minDecided - 1; i++) seed(90_000 + i, "rewrite", "rejected", 40);
check("too few answers do not quieten a kind", proposalGate("rewrite", "new-a", NOW).allowed, true);
seed(90_100, "rewrite", "rejected", 10);
check("mostly rejected and recent: held", proposalGate("rewrite", "new-a", NOW).allowed, false);
check("the record says why", kindRecord("rewrite", NOW), { accepted: 0, decided: 5, rejected: 5, rejectRate: 1 });
check("after the gap one may go", proposalGate("rewrite", "new-a", new Date(NOW.getTime() + 21 * 86_400_000)).allowed, true);
seed(90_200, "rewrite", "accepted", 5);
seed(90_201, "rewrite", "accepted", 4);
check("accepting some lets the kind back up", proposalGate("rewrite", "new-a", NOW).allowed, true);
check("other kinds are not affected", proposalGate("standing", "new-b", NOW).allowed, true);
rawDb.exec("DELETE FROM proposal_log WHERE kind = 'rewrite'");
for (let i = 0; i < PROPOSAL_QUIET.minDecided; i++) seed(91_000 + i, "rewrite", "rejected", PROPOSAL_QUIET.windowDays + 5);
check("old answers age out of the window", proposalGate("rewrite", "new-a", NOW).allowed, true);
recordProposal("rewrite", "held-shape", 92_000, NOW);
rawDb.prepare("UPDATE proposal_log SET outcome = 'rejected', decided = ? WHERE confirmation_id = 92000").run(iso(NOW.getTime()));
check("a specific no outlasts the window", proposalGate("rewrite", "held-shape", new Date(NOW.getTime() + 400 * 86_400_000)).allowed, false);

console.log("\nSL4: A NO GIVEN BEFORE THE LOG EXISTED");
const old = store.queueConfirmation({ args: { task: "Check the older job" }, tool: "schedule_create" }, "PROPOSED JOB from a request you have made 3 times.", null);
store.closePendingConfirmation(old, "rejected", "rejected by user");
const otherTool = store.queueConfirmation({ args: { task: "Unrelated job" }, tool: "schedule_create" }, "Create a schedule", null);
check("past job proposals are adopted once", [adoptPastJobProposals((t) => `task:${taskKey(t)}`), adoptPastJobProposals((t) => `task:${taskKey(t)}`)], [1, 0]);
check("an ordinary schedule request is not", rawDb.prepare("SELECT COUNT(*) AS n FROM proposal_log WHERE confirmation_id = ?").get(otherTool).n, 0);
check("the earlier no is honored", queueIntentProposal(job("Check the older job")), null);

modelServer.close();
fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
