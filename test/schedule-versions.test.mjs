/**
 * Version history and after-checks for scheduled tasks (docs/PLAN-open-work.md, SL8).
 *
 * The claims worth testing are the ones that would hurt if wrong: no route changes a task without a record, the
 * comparison cannot call a job worse because its history was pruned, and going back never happens without an
 * approval, or over text written after that approval was offered.
 *
 * Run with `node test/schedule-versions.test.mjs`.
 */
import "./helpers/example-policy.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-versions-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.AUDIT_RETENTION_DAYS = "90";

const store = await import("../src/memory/store.ts");
const v = await import("../src/learn/versions.ts");
const { approveConfirmation, rejectConfirmation } = await import("../src/confirmations.ts");
const { scheduleUpdate } = await import("../src/tools/schedule.ts");
const { loadPolicy } = await import("../src/config.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const job = (task = "first text", name = "job") => store.createSchedule(name, task, "every day");
const backdate = (versionId, ms) => store.rawDb.prepare("UPDATE schedule_versions SET changed = ? WHERE id = ?").run(iso(ms), versionId);

/** A finished run at a moment, with `calls` audit rows, `errors` of them failed. */
const addRun = (scheduleId, ms, { calls = 3, errors = 0, parent = null, status = "ok" } = {}) => {
  const id = store.startRun({ kind: "schedule", parentRunId: parent, scheduleId, task: "x" });
  store.finishRun(id, status);
  store.rawDb.prepare("UPDATE runs SET started = ?, finished = ? WHERE id = ?").run(iso(ms), iso(ms + 1000), id);
  for (let i = 0; i < calls; i++) {
    store.rawDb
      .prepare("INSERT INTO actions (ts, run_id, tool, args, decision, output) VALUES (?,?,?,?,?,?)")
      .run(iso(ms), id, "fetch", "{}", i < errors ? "error" : "executed", "");
  }
  return id;
};
const runs = (id, fromMs, count, opts) => {
  for (let i = 0; i < count; i++) addRun(id, fromMs + i * DAY, opts);
};
/** A job changed at T0, with runs on both sides. */
const measured = (before, after, count = 10) => {
  const id = job(`old ${Math.random()}`);
  store.updateSchedule(id, { task: `new ${Math.random()}` }, "agent");
  const version = store.listScheduleVersions(id).at(-1);
  backdate(version.id, T0);
  runs(id, T0 - 15 * DAY, count, before);
  runs(id, T0 + DAY, count, after);
  return { id, version: store.getScheduleVersion(version.id) };
};
const verdictOf = ({ id, version }) => v.afterCheck(version, store.listScheduleVersions(id), T0 + 22 * DAY);

console.log("\nEVERY CHANGE TO THE TASK KEEPS THE OLD TEXT");
{
  const id = job("alpha");
  store.updateSchedule(id, { name: "renamed" });
  store.updateSchedule(id, { enabled: false });
  check("a rename or pause is not a version", store.listScheduleVersions(id).length, 0);
  store.updateSchedule(id, { task: "alpha" });
  check("writing the same text is not a version", store.listScheduleVersions(id).length, 0);
  store.updateSchedule(id, { task: "beta" }, "edit");
  const [row] = store.listScheduleVersions(id);
  check("a change records both texts and who", [row.before_task, row.after_task, row.source], ["alpha", "beta", "edit"]);
  await scheduleUpdate.run({ id, task: "gamma" }, { policy: loadPolicy() });
  check("the agent's tool is recorded as such", store.listScheduleVersions(id).at(-1).source, "agent");
  for (let i = 0; i < 30; i++) store.updateSchedule(id, { task: `text ${i}` }, "edit");
  check("history is capped per job", store.listScheduleVersions(id).length, 20);
  check("the newest is what survives", store.listScheduleVersions(id).at(-1).after_task, "text 29");
  store.deleteSchedule(id);
  check("deleting a job deletes its old instructions", store.listScheduleVersions(id).length, 0);
}

console.log("\nA FAILED WRITE LEAVES NEITHER HALF");
{
  const id = job("kept");
  store.rawDb.exec("CREATE TRIGGER block_version BEFORE INSERT ON schedule_versions BEGIN SELECT RAISE(ABORT, 'no'); END");
  let threw = false;
  try {
    store.updateSchedule(id, { task: "lost" }, "edit");
  } catch {
    threw = true;
  }
  store.rawDb.exec("DROP TRIGGER block_version");
  check("the error reaches the caller", threw, true);
  check("the task did not change without a record", store.getSchedule(id).task, "kept");
}

console.log("\nTHE COMPARISON IS ARITHMETIC");
{
  const a = (runsN, medianCalls, failureRate) => ({ failureRate, medianCalls, runs: runsN });
  check("fewer calls is better", v.judge(a(10, 8, 0), a(10, 4, 0)), "better");
  check("more calls is worse", v.judge(a(10, 4, 0), a(10, 8, 0)), "worse");
  check("more failures is worse", v.judge(a(10, 4, 0), a(10, 4, 0.2)), "worse");
  check("exactly the failure threshold counts", v.judge(a(10, 4, 0.05), a(10, 4, 0.2)), "worse");
  check("cheaper but failing more is mixed", v.judge(a(10, 8, 0), a(10, 4, 0.5)), "mixed");
  check("a small wobble is no difference", v.judge(a(10, 8, 0.1), a(10, 9, 0.15)), "same");
  check("a job of one call needs a whole call to move", v.judge(a(10, 1, 0), a(10, 1.5, 0)), "same");

  const worse = measured({ calls: 3 }, { calls: 9 });
  const report = verdictOf(worse);
  check("real runs produce a verdict", [report.status, report.verdict], ["ready", "worse"]);
  check("the detail states the numbers", report.detail.includes("Tool calls per run: 3 to 9"), true);

  const failing = measured({ calls: 3 }, { calls: 3, errors: 1 });
  check("an ok run with an errored call counts as failed", verdictOf(failing).verdict, "worse");

  const stopped = measured({ calls: 3 }, { calls: 9, status: "stopped" });
  check("runs you stopped are left out", verdictOf(stopped).status, "not_enough");

  const child = job("parent job");
  store.updateSchedule(child, { task: "moved into a subagent" }, "agent");
  const row = store.listScheduleVersions(child).at(-1);
  backdate(row.id, T0);
  runs(child, T0 - 15 * DAY, 6, { calls: 4 });
  for (let i = 0; i < 6; i++) {
    const parent = addRun(child, T0 + (i + 1) * DAY, { calls: 1 });
    const sub = store.startRun({ kind: "subagent", parentRunId: parent, task: "x" });
    store.finishRun(sub, "ok");
    for (let c = 0; c < 3; c++) {
      store.rawDb.prepare("INSERT INTO actions (ts, run_id, tool, args, decision, output) VALUES (?,?,?,?,?,?)").run(iso(T0), sub, "fetch", "{}", "executed", "");
    }
  }
  check("work moved into a subagent is not 'cheaper'", verdictOf({ id: child, version: store.getScheduleVersion(row.id) }).verdict, "same");
}

console.log("\nIT DOES NOT CLAIM WHAT IT CANNOT KNOW");
{
  const early = measured({ calls: 3 }, { calls: 9 });
  check("inside the window it is still measuring", v.afterCheck(early.version, store.listScheduleVersions(early.id), T0 + 5 * DAY).status, "waiting");

  const few = measured({ calls: 3 }, { calls: 9 }, 4);
  check("too few runs gives no verdict", [verdictOf(few).status, verdictOf(few).verdict], ["not_enough", null]);

  const again = measured({ calls: 3 }, { calls: 9 });
  store.updateSchedule(again.id, { task: "third" }, "edit");
  const third = store.listScheduleVersions(again.id).at(-1);
  backdate(third.id, T0 + 5 * DAY);
  check("a second change inside the window voids the first", v.afterCheck(again.version, store.listScheduleVersions(again.id), T0 + 40 * DAY).status, "superseded");

  const aged = measured({ calls: 3 }, { calls: 9 });
  const late = v.afterCheck(aged.version, store.listScheduleVersions(aged.id), T0 + 120 * DAY);
  check("pruned audit rows cannot read as a change", [late.status, late.verdict], ["not_enough", null]);
}

console.log("\nGOING BACK ALWAYS ASKS FIRST");
{
  const id = job("original");
  store.updateSchedule(id, { task: "changed" }, "agent");
  const row = store.listScheduleVersions(id)[0];
  const queued = v.queueRestore(id, row.id);
  check("restoring only queues", store.getSchedule(id).task, "changed");
  const pending = store.getConfirmation(queued.confirmationId);
  check("the approval shows the diff", [pending.summary.includes("- changed"), pending.summary.includes("+ original")], [true, true]);
  check("asking twice does not queue twice", v.queueRestore(id, row.id).confirmationId, queued.confirmationId);
  await rejectConfirmation(queued.confirmationId, "no", { resume: false });
  check("a rejected restore changes nothing", store.getSchedule(id).task, "changed");

  const again = v.queueRestore(id, row.id);
  const outcome = await approveConfirmation(again.confirmationId, { resume: false });
  check("approving applies it", [outcome.ok, store.getSchedule(id).task], [true, "original"]);
  const history = v.scheduleHistory(id);
  check("the restore is itself in the history", [history.versions.length, history.versions[0].restored], [2, true]);
  check("restoring what it already says is refused", "error" in v.queueRestore(id, history.versions[1].id), true);
  check("a version of another job is refused", "error" in v.queueRestore(job("other"), row.id), true);
}

console.log("\nAN OLD APPROVAL CANNOT OVERWRITE NEWER TEXT");
{
  const id = job("one");
  store.updateSchedule(id, { task: "two" }, "edit");
  const row = store.listScheduleVersions(id)[0];
  const queued = v.queueRestore(id, row.id);
  store.updateSchedule(id, { task: "three, written after the offer" }, "edit");
  const outcome = await approveConfirmation(queued.confirmationId, { resume: false });
  check("the stale approval is refused", outcome.ok, false);
  check("the newer text stands", store.getSchedule(id).task, "three, written after the offer");
}

console.log("\nA RESTORE PUTS BACK THE EXACT TEXT");
{
  const long = `  ${"word ".repeat(1200)}\n`;
  const id = job(long);
  store.updateSchedule(id, { task: "short" }, "edit");
  const row = store.listScheduleVersions(id)[0];
  const { confirmationId } = v.queueRestore(id, row.id);
  await approveConfirmation(confirmationId, { resume: false });
  check("past the tool's cap and with its spacing", store.getSchedule(id).task === long, true);
  const policy = loadPolicy();
  policy.schedules = { enabled: true };
  const bad = scheduleUpdate.checkPolicy(policy, { id, if_current: store.taskFingerprint(long), restore_version: row.id, task: "smuggled" });
  check("a restore cannot also carry new text", bad.allowed, false);
}

console.log("\nTHE WEEKLY REVIEW ASKS ONCE");
{
  const worse = measured({ calls: 3 }, { calls: 9 });
  const at = T0 + 22 * DAY;
  const card = () => v.openAfterChecks(at).find((c) => c.id === worse.version.id);
  check("a finished check appears", card()?.verdict, "worse");
  check("before the window ends it does not", v.openAfterChecks(T0 + 5 * DAY).some((c) => c.id === worse.version.id), false);
  const answer = v.answerAfterCheck(worse.version.id, "revert", at);
  check("going back queues an approval", typeof answer.queued, "number");
  check("and has not changed the job", store.getSchedule(worse.id).task, worse.version.after_task);
  check("the card is gone", card(), undefined);
  check("a second answer does nothing", v.answerAfterCheck(worse.version.id, "keep", at), null);

  const fine = measured({ calls: 8 }, { calls: 3 });
  check("keeping queues nothing", v.answerAfterCheck(fine.version.id, "keep", at).queued, null);
  check("and closes the card", v.openAfterChecks(at).some((c) => c.id === fine.version.id), false);
}

console.log("\nA LEARNER LEAVES RESTORED TEXT ALONE");
{
  const id = job("watch state_get original");
  store.updateSchedule(id, { task: "watch state_get rewritten" }, "agent");
  check("a plain change is not a restore", store.wasTaskRestored(id, "watch state_get rewritten"), false);
  store.updateSchedule(id, { task: "watch state_get original" }, "edit");
  check("text you went back to is marked", store.wasTaskRestored(id, "watch state_get original"), true);
  store.updateSchedule(id, { task: "watch state_get new idea" }, "edit");
  check("the mark ends when the text moves on", store.wasTaskRestored(id, "watch state_get new idea"), false);
}

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
