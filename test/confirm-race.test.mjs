/**
 * Two answers to one question must not both act.
 *
 * `approveOnly` used to read the row, check `pending`, await the tool, and only then write
 * `done`. Two callers (a lock-screen button and the dashboard, say, or a double tap) could
 * both pass the check before either wrote, and an irreversible action ran twice. The fix
 * claims the row with a conditional UPDATE before anything runs, so exactly one caller wins.
 *
 * These use a counting stand-in for an irreversible tool and assert what it did, not what
 * the return values say, because the return value is exactly what the bug got wrong.
 *
 * Run with `node test/confirm-race.test.mjs`.
 */
import "./helpers/example-policy.mjs";
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-confirm-race-${process.pid}-${Date.now()}.db`);
process.env.CONFIRM_EXPIRE_AFTER_MIN = "1440";
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const { approveConfirmation, rejectConfirmation, sweepConfirmations } = await import("../src/confirmations.ts");
const { registry } = await import("../src/tools/index.ts");
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

// A stand-in for an irreversible tool. It yields before returning so a second caller has
// every chance to slip past a check-then-act gap.
let runs = 0;
let fail = false;
registry.race_probe = {
  argsSchema: "{}",
  checkPolicy: () => ({ allowed: true }),
  classify: () => ({ reversibility: "irreversible", target: "probe" }),
  description: "test only",
  name: "race_probe",
  run: async () => {
    runs++;
    await new Promise((r) => setTimeout(r, 25));
    if (fail) throw new Error("probe failed");
    return "probe ran";
  },
};

const queue = () => store.queueConfirmation({ args: {}, tool: "race_probe" }, "PROBE", null);
const stateOf = (id) => rawDb.prepare("SELECT state FROM confirmations WHERE id = ?").get(id).state;
const noResume = { resume: false };

console.log("\nAPPROVE AGAINST APPROVE — the action runs once");
{
  runs = 0;
  const id = queue();
  const [a, b] = await Promise.all([approveConfirmation(id, noResume), approveConfirmation(id, noResume)]);
  check("the tool ran exactly once", runs, 1);
  check("exactly one caller got ok", [a.ok, b.ok].filter(Boolean).length, 1);
  check("the loser was told it is already taken", [a, b].some((o) => /already/.test(o.message)), true);
  check("the row ends done", stateOf(id), "done");
}

console.log("\nFIVE AT ONCE — still once");
{
  runs = 0;
  const id = queue();
  const all = await Promise.all(Array.from({ length: 5 }, () => approveConfirmation(id, noResume)));
  check("the tool ran exactly once", runs, 1);
  check("one winner", all.filter((o) => o.ok).length, 1);
}

console.log("\nAPPROVE AGAINST REJECT — approval first, the rejection is refused");
{
  runs = 0;
  const id = queue();
  const [a, r] = await Promise.all([approveConfirmation(id, noResume), rejectConfirmation(id, "", noResume)]);
  check("the tool ran exactly once", runs, 1);
  check("approval won", a.ok, true);
  check("rejection refused", r.ok, false);
  check("the row is done, not rejected", stateOf(id), "done");
}

console.log("\nREJECT AGAINST APPROVE — rejection first, nothing runs");
{
  runs = 0;
  const id = queue();
  const [r, a] = await Promise.all([rejectConfirmation(id, "", noResume), approveConfirmation(id, noResume)]);
  check("the tool never ran", runs, 0);
  check("rejection won", r.ok, true);
  check("approval refused", a.ok, false);
  check("the row is rejected", stateOf(id), "rejected");
}

console.log("\nREJECT AGAINST REJECT — one rejection, one tally");
{
  const id = queue();
  const both = await Promise.all([rejectConfirmation(id, "", noResume), rejectConfirmation(id, "", noResume)]);
  check("exactly one ok", both.filter((o) => o.ok).length, 1);
  check("the row is rejected", stateOf(id), "rejected");
}

console.log("\nA FAILING TOOL — the row ends 'error' and is not retried by a second approval");
{
  runs = 0;
  fail = true;
  const id = queue();
  const [a, b] = await Promise.all([approveConfirmation(id, noResume), approveConfirmation(id, noResume)]);
  fail = false;
  check("ran once", runs, 1);
  check("neither reports success", [a.ok, b.ok], [false, false]);
  check("the row ends error", stateOf(id), "error");
  const again = await approveConfirmation(id, noResume);
  check("a later approval does not re-run it", runs, 1);
  check("and says it is already 'error'", /already 'error'/.test(again.message), true);
}

console.log("\nEXECUTING IS LIVE — the sweep neither expires it nor lets a second caller in");
{
  runs = 0;
  const id = queue();
  rawDb.prepare("UPDATE confirmations SET ts = ? WHERE id = ?").run(new Date(Date.now() - 3000 * 60_000).toISOString(), id);
  // Claim it by hand, as a first approver mid-run would.
  check("the claim succeeds once", store.claimConfirmation(id), true);
  check("and only once", store.claimConfirmation(id), false);
  check("the row is executing", stateOf(id), "executing");
  await sweepConfirmations({ notifier: async () => ({ detail: "test", ok: true, via: "apns" }) });
  check("an old executing row is not expired by the sweep", stateOf(id), "executing");
  check("an executing row is not offered as pending", store.listConfirmations("pending").some((c) => c.id === id), false);
  const late = await approveConfirmation(id, noResume);
  check("approving it again does not run the tool", runs, 0);
  check("and says it is already 'executing'", /already 'executing'/.test(late.message), true);
  check("the claim burned the token", store.getApprovalToken(id), null);
  store.setConfirmation(id, "done", "");
}

console.log("\nCRASH RECOVERY — an executing row left by a dead process ends 'error' and never re-runs");
{
  runs = 0;
  const id = queue();
  store.claimConfirmation(id);
  const live = queue(); // still pending; recovery must leave it alone
  const n = store.recoverInterruptedConfirmations();
  check("one row recovered", n, 1);
  check("the stuck row is error", stateOf(id), "error");
  check("its result says it was not re-run", /not re-run/.test(store.getConfirmation(id).result), true);
  check("a pending row is untouched", stateOf(live), "pending");
  const again = await approveConfirmation(id, noResume);
  check("approval after recovery does not run it", runs, 0);
  check("and is refused", again.ok, false);
  check("recovery is idempotent", store.recoverInterruptedConfirmations(), 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
