/**
 * The confirmation watchdog — the clock on the approval queue.
 *
 * The queue had no timer on it at all: one push at queue time, a `ts` column nobody read,
 * and a question from a 3am job could wait forever while the only nudge was a console line
 * on the next heartbeat. These assert the three properties that make a sweep running every
 * few minutes, from more than one process, safe to leave unattended:
 *
 *   - it re-pushes once per RUNG, not once per sweep
 *   - a long-cold row climbs straight to escalation rather than firing a late reminder
 *   - a push that failed does not count as delivered
 *
 * And the two that make expiry honest: an expired action never runs — including when
 * approved from the CLI with no sweep in sight — and expiring teaches nothing, because you
 * did not decide against it, you never saw it.
 *
 * Run with `node test/confirm-watchdog.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-watchdog-${process.pid}.db`);
process.env.CONFIRM_REMIND_AFTER_MIN = "60";
process.env.CONFIRM_ESCALATE_AFTER_MIN = "240";
process.env.CONFIRM_EXPIRE_AFTER_MIN = "1440";
// No embeddings endpoint in the test — force the keyword fallback so nothing reaches out.
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const { approveConfirmation, sweepConfirmations } = await import("../src/confirmations.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(56)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

/** A pending draft confirmation, queued `minutes` ago. */
const queueAged = (minutes) => {
  const id = store.queueConfirmation({ args: { body: "hi", kind: "text" }, tool: "draft" }, "DRAFT (text) — a note", null);
  rawDb
    .prepare("UPDATE confirmations SET ts = ? WHERE id = ?")
    .run(new Date(Date.now() - minutes * 60_000).toISOString(), id);
  return id;
};

const stateOf = (id) => rawDb.prepare("SELECT state FROM confirmations WHERE id = ?").get(id).state;
const rungOf = (id) => rawDb.prepare("SELECT rung FROM confirmations WHERE id = ?").get(id).rung;
const resolvedOf = (id) => rawDb.prepare("SELECT resolved FROM confirmations WHERE id = ?").get(id).resolved;

/** A notifier that records instead of pushing. `ok: false` simulates an ntfy outage. */
const recorder = (ok = true) => {
  const sent = [];
  const fn = async (title, body, opts = {}) => {
    sent.push({ body, priority: opts.priority, title });
    return { detail: "test", ok, via: "ntfy" };
  };
  fn.sent = sent;
  return fn;
};

console.log("\nBEFORE THE FIRST RUNG — a fresh question is left alone");
{
  const id = queueAged(5);
  const n = recorder();
  const r = await sweepConfirmations({ notifier: n });
  check("nothing pushed", n.sent.length, 0);
  check("no rung climbed", rungOf(id), null);
  check("still pending", stateOf(id), "pending");
  check("sweep reports nothing", r, { escalated: 0, expired: 0, reminded: 0 });
  store.setConfirmation(id, "done", "");
}

console.log("\nREMIND — one push, and only one however often the sweep runs");
{
  const id = queueAged(90);
  const n = recorder();
  await sweepConfirmations({ notifier: n });
  check("pushed once", n.sent.length, 1);
  check("at priority 4, not 5", n.sent[0].priority, 4);
  check("the body says how long it waited", n.sent[0].body.includes("1h"), true);
  check("rung 1 recorded", rungOf(id), 1);

  await sweepConfirmations({ notifier: n });
  await sweepConfirmations({ notifier: n });
  check("two more sweeps push nothing", n.sent.length, 1);
  check("and it is still a live question", stateOf(id), "pending");
  check("nudging did not resolve it", resolvedOf(id), null);
  store.setConfirmation(id, "done", "");
}

console.log("\nESCALATE — priority 5, once the second rung is crossed");
{
  const id = queueAged(90);
  const n = recorder();
  await sweepConfirmations({ notifier: n });
  check("reminder first", n.sent[0].priority, 4);

  // Age it past the escalation threshold and sweep again.
  rawDb
    .prepare("UPDATE confirmations SET ts = ? WHERE id = ?")
    .run(new Date(Date.now() - 300 * 60_000).toISOString(), id);
  const r = await sweepConfirmations({ notifier: n });
  check("pushed again", n.sent.length, 2);
  check("this one breaks through DND", n.sent[1].priority, 5);
  check("counted as an escalation", r.escalated, 1);
  check("rung 2 recorded", rungOf(id), 2);

  await sweepConfirmations({ notifier: n });
  check("and the top rung is also climbed once", n.sent.length, 2);
  store.setConfirmation(id, "done", "");
}

console.log("\nA LONG-COLD ROW — skips the rung it is too late for");
{
  // The server was down for six hours. The reminder window passed unobserved; firing it
  // now and the escalation five minutes later would be two pushes for one question.
  const id = queueAged(400);
  const n = recorder();
  const r = await sweepConfirmations({ notifier: n });
  check("one push, not two", n.sent.length, 1);
  check("straight to escalation", n.sent[0].priority, 5);
  check("no reminder counted", r.reminded, 0);
  check("rung 2 recorded", rungOf(id), 2);
  store.setConfirmation(id, "done", "");
}

console.log("\nA FAILED PUSH — not recorded as delivered, so the next sweep retries");
{
  const id = queueAged(90);
  const down = recorder(false);
  await sweepConfirmations({ notifier: down });
  check("it tried", down.sent.length, 1);
  check("but climbed no rung", rungOf(id), null);

  const up = recorder();
  await sweepConfirmations({ notifier: up });
  check("so the next sweep tries again", up.sent.length, 1);
  check("and this one sticks", rungOf(id), 1);
  store.setConfirmation(id, "done", "");
}

console.log("\nEXPIRY — the question closes and the action never runs");
{
  const id = queueAged(2000);
  const n = recorder();
  const r = await sweepConfirmations({ notifier: n });
  check("state is expired", stateOf(id), "expired");
  check("counted as expired", r.expired, 1);
  check("not counted as a rejection", r.reminded + r.escalated, 0);
  check("you are told it closed", n.sent.length, 1);
  check("quietly — this is not an alarm", n.sent[0].priority, 3);
  check("the reason says nothing ran", store.getConfirmation(id).result.includes("never run"), true);
  check("the approval token is burnt", store.getConfirmation(id).token, null);
}

console.log("\nEXPIRY TEACHES NOTHING — absence is not a decision");
{
  // A rejection with no reason tallies the (tool, target) shape and eventually writes a
  // preference memory. An expiry must do neither: putting words in your mouth from your
  // silence is worse than asking twice.
  const before = store.kvList("reject:shape:").length;
  const id = queueAged(2000);
  await sweepConfirmations({ notifier: recorder() });
  check("state is expired", stateOf(id), "expired");
  check("no silent-rejection tally", store.kvList("reject:shape:").length, before);
  check("no preference written", rawDb.prepare("SELECT COUNT(*) n FROM memories WHERE kind='preference'").get().n, 0);
}

console.log("\nAPPROVING A STALE ROW — refused without waiting for a sweep");
{
  // `npm run confirm approve` runs in a process where no watchdog has ever ticked. The
  // window must be a property of the question, not of whatever happened to be running.
  const id = queueAged(2000);
  const outcome = await approveConfirmation(id);
  check("refused", outcome.ok, false);
  check("and said why", outcome.message.includes("expired"), true);
  check("row closed as expired", stateOf(id), "expired");

  const again = await approveConfirmation(id);
  check("a second attempt is inert", again.ok, false);
  check("and reports the settled state", again.message.includes("already 'expired'"), true);
}

console.log("\nA ROW INSIDE THE WINDOW STILL APPROVES NORMALLY");
{
  const id = queueAged(1000);
  const outcome = await approveConfirmation(id);
  // The draft tool actually writes the file, so this asserts the gate let it through
  // rather than asserting the tool's own behaviour.
  check("not refused as expired", outcome.message.includes("expired"), false);
  check("and left 'pending' behind", stateOf(id) !== "pending", true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
