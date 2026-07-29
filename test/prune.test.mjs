/**
 * Ledger retention.
 *
 * The counts are the easy half. The assertions that matter are the two refusals: a run
 * holding a **pending confirmation** must survive, because deleting it orphans a question
 * still waiting on you — the approval would point at a run that no longer exists and the
 * phone button would answer into a hole. And an **unfinished** run must survive whatever
 * its timestamp says, because a row stuck open is a bug to look at, not garbage to collect.
 *
 * Run with `node test/prune.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-prune-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;

const store = await import("../src/memory/store.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(54)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

/** A finished run, aged by hand, with a trace and an audit row. */
const makeRun = (ageDays, { conversationId = null, status = "ok" } = {}) => {
  const id = store.startRun({ conversationId, kind: "chat", task: "t" });
  store.saveTrace(id, [
    { content: "system", role: "system" },
    { content: "hello", role: "user" },
    { content: "hi", role: "assistant" },
  ]);
  store.logAction(id, { args: {}, tool: "weather" }, null, "executed", "out");
  rawDb
    .prepare("UPDATE runs SET status = ?, started = ?, finished = ? WHERE id = ?")
    .run(status, daysAgo(ageDays), status === "ok" ? daysAgo(ageDays) : null, id);
  rawDb.prepare("UPDATE actions SET ts = ? WHERE run_id = ?").run(daysAgo(ageDays), id);
  return id;
};

const counts = () => ({
  actions: rawDb.prepare("SELECT COUNT(*) n FROM actions").get().n,
  conversations: rawDb.prepare("SELECT COUNT(*) n FROM conversations").get().n,
  messages: rawDb.prepare("SELECT COUNT(*) n FROM messages").get().n,
  runs: rawDb.prepare("SELECT COUNT(*) n FROM runs").get().n,
});

const NINETY = { auditDays: 90, runDays: 90, traceDays: 90 };

console.log("\nWINDOW — old goes, recent stays");
const oldRun = makeRun(120);
const newRun = makeRun(5);
check("two runs to start", counts().runs, 2);
{
  const dry = store.pruneLedger({ ...NINETY, dryRun: true });
  check("dry run reports the old one", [dry.runs, dry.messages, dry.actions], [1, 2, 1]);
  check("dry run deletes nothing", counts().runs, 2);
}
{
  store.pruneLedger(NINETY);
  const c = counts();
  check("the old run is gone", c.runs, 1);
  check("its trace went with it", c.messages, 2);
  check("its audit row went with it", c.actions, 1);
  check("the recent run survives", !!store.getRun(newRun), true);
  check("the old one does not", !!store.getRun(oldRun), false);
}

console.log("\nREFUSALS — what retention must not touch");
{
  const pending = makeRun(200);
  store.queueConfirmation({ args: {}, tool: "draft" }, "please approve", pending);
  const r = store.pruneLedger(NINETY);
  check("a run holding a pending approval is kept", !!store.getRun(pending), true);
  check("and is reported as withheld", r.withheld >= 1, true);

  // Once the question is answered, it is ordinary history again.
  const cid = rawDb.prepare("SELECT id FROM confirmations WHERE run_id = ?").get(pending).id;
  store.setConfirmation(cid, "done", "ok");
  store.pruneLedger(NINETY);
  check("once resolved it prunes normally", !!store.getRun(pending), false);
}
{
  const stuck = makeRun(300, { status: "running" });
  store.pruneLedger(NINETY);
  check("an unfinished run is kept whatever its age", !!store.getRun(stuck), true);
  rawDb.prepare("UPDATE runs SET status='ok', finished=? WHERE id=?").run(daysAgo(300), stuck);
  store.pruneLedger(NINETY);
  check("and prunes once it has finished", !!store.getRun(stuck), false);
}

console.log("\nCONVERSATIONS — no empty threads left behind");
{
  const kept = store.createConversation("recent thread");
  const emptied = store.createConversation("old thread");
  makeRun(5, { conversationId: kept });
  makeRun(200, { conversationId: emptied });
  const r = store.pruneLedger(NINETY);
  check("the emptied thread is removed", !!store.getConversation(emptied), false);
  check("the active thread survives", !!store.getConversation(kept), true);
  check("and it is reported", r.conversations, 1);
}

console.log("\nDISABLED — 0 means keep forever");
{
  makeRun(500);
  const before = counts();
  const r = store.pruneLedger({ auditDays: 0, runDays: 0, traceDays: 0 });
  check("nothing is removed", [r.runs, r.messages, r.actions], [0, 0, 0]);
  check("counts are unchanged", counts(), before);
}

console.log("\nINDEPENDENT WINDOWS — traces can go while runs stay");
{
  const r = store.pruneLedger({ auditDays: 0, runDays: 0, traceDays: 90 });
  check("traces pruned", r.messages > 0, true);
  check("runs untouched", r.runs, 0);
  check("run rows still present", counts().runs > 0, true);
}

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
