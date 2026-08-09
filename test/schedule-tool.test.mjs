/**
 * The scheduler tools — the agent's handle on the application it runs inside.
 *
 * Three properties matter here, and none of them is "it can write a row":
 *
 *   1. Absent policy denies. A `policy.json` written before this surface existed must not
 *      silently grant it, same as every other optional section.
 *   2. Every write is irreversible, so it lands in the confirmation queue rather than
 *      executing. A schedule is a prompt the model wrote for an unattended future run; the
 *      queue is what puts that text in front of a human first.
 *   3. A bad spec is rejected BEFORE queueing, with the grammar attached. Caught later, it
 *      would waste the user's approval on a job that then fails.
 *
 * Run with `node test/schedule-tool.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-schedule-${process.pid}.db`);

const store = await import("../src/memory/store.ts");
const { scheduleCreate, scheduleDelete, scheduleList, scheduleUpdate } = await import("../src/tools/schedule.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(56)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const on = { schedules: { enabled: true } };
const off = {};

const noon = { name: "Movie trailers", schedule: "daily at 12:00pm", task: "Search for new movie trailers and notify me." };

console.log("\nscheduler tools\n");

console.log("gate: absent policy section denies, like every other optional surface");
check("list denied", scheduleList.checkPolicy(off, {}).allowed, false);
check("create denied", scheduleCreate.checkPolicy(off, noon).allowed, false);
check("update denied", scheduleUpdate.checkPolicy(off, { id: 1 }).allowed, false);
check("delete denied", scheduleDelete.checkPolicy(off, { id: 1 }).allowed, false);
check("denial names the policy key", /policy\.json/.test(scheduleCreate.checkPolicy(off, noon).reason), true);

console.log("\nreversibility: reads run, writes queue");
check("list reversible", scheduleList.classify({}).reversibility, "reversible");
check("create irreversible", scheduleCreate.classify(noon).reversibility, "irreversible");
check("update irreversible", scheduleUpdate.classify({ id: 1, enabled: false }).reversibility, "irreversible");
check("delete irreversible", scheduleDelete.classify({ id: 1 }).reversibility, "irreversible");

console.log("\nthe approval carries the whole task, not a description of it");
check("summary contains the verbatim task", scheduleCreate.classify(noon).summary.includes(noon.task), true);
check("summary says nothing is scheduled yet", /until you approve/.test(scheduleCreate.classify(noon).summary), true);

console.log("\nvalidation happens in the gate, before anything is queued");
check("cron rejected", scheduleCreate.checkPolicy(on, { ...noon, schedule: "0 12 * * *" }).allowed, false);
check("rejection teaches the grammar", /daily at 12:00pm/.test(scheduleCreate.checkPolicy(on, { ...noon, schedule: "0 12 * * *" }).reason), true);
check("missing task rejected", scheduleCreate.checkPolicy(on, { name: "x", schedule: "every day" }).allowed, false);
check("missing name rejected", scheduleCreate.checkPolicy(on, { schedule: "every day", task: "t" }).allowed, false);
check("valid spec allowed", scheduleCreate.checkPolicy(on, noon).allowed, true);
check("update of a nonexistent job rejected", scheduleUpdate.checkPolicy(on, { enabled: false, id: 999 }).allowed, false);
check("delete of a nonexistent job rejected", scheduleDelete.checkPolicy(on, { id: 999 }).allowed, false);

console.log("\nround trip through the store");
const created = await scheduleCreate.run(noon, { policy: on });
const rows = store.listSchedules();
check("one job exists", rows.length, 1);
check("task stored verbatim", rows[0].task, noon.task);
check("spec stored as written", rows[0].spec, noon.schedule);
check("next run is noon", new Date(rows[0].next_run).getHours(), 12);
check("create reports the id", created.includes(`#${rows[0].id}`), true);

const id = rows[0].id;
check("no-op update rejected", scheduleUpdate.checkPolicy(on, { id }).allowed, false);
await scheduleUpdate.run({ enabled: false, id }, { policy: on });
check("disabled", store.getSchedule(id).enabled, 0);

// A local model that answers "false" as a string must still be able to turn a job off.
await scheduleUpdate.run({ enabled: true, id }, { policy: on });
await scheduleUpdate.run({ enabled: "false", id }, { policy: on });
check("string 'false' disables too", store.getSchedule(id).enabled, 0);

check("list shows the job and its task", (await scheduleList.run({}, { policy: on })).includes(noon.task), true);

await scheduleDelete.run({ id }, { policy: on });
check("deleted", store.listSchedules().length, 0);

/**
 * One-shots. The property under test is that a job asked to run once runs once — which is
 * really a property of what happens AFTER it fires, since the failure mode is silent: a
 * fired one-shot that gets re-armed becomes a reminder that arrives forever, and nothing
 * about it looks wrong until the second one turns up.
 */
console.log("\none-shot jobs");

const stamp = (d) =>
  `once at ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

check("a past time is refused", scheduleCreate.checkPolicy(on, { name: "n", schedule: "2020-01-01 at 09:00", task: "t" }).allowed, false);
check("  and says so, rather than blaming the syntax", /already in the past/.test(scheduleCreate.checkPolicy(on, { name: "n", schedule: "2020-01-01 at 09:00", task: "t" }).reason), true);

await scheduleCreate.run({ name: "Remind me", schedule: "in 2 hours", task: "Tell the user the thing." }, { policy: on });
const shot = store.listSchedules()[0];
// Stored absolute, not as the sentence that was typed: "in 2 hours" re-read tomorrow would
// be a different time, and would never arrive.
check("relative spec stored as an instant", /^once at \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(shot.spec), true);
check("armed", shot.next_run != null, true);
check("the proposal says it runs once", scheduleCreate.classify({ name: "n", schedule: "in 2 hours", task: "t" }).summary.includes("ONE-OFF"), true);

// Wind the clock forward the only way a test honestly can: rewrite the stored instant to
// one that has passed. Both columns move together, because for a one-shot they are two
// views of the same moment — `dueSchedules` reads next_run, `markScheduleRan` re-reads the
// spec, and in production the scheduler only fires once the instant they agree on arrives.
const past = new Date(Date.now() - 60_000);
store.rawDb.prepare("UPDATE schedules SET spec = ?, next_run = ? WHERE id = ?").run(stamp(past), past.toISOString(), shot.id);
check("it is now due", store.dueSchedules().some((s) => s.id === shot.id), true);

store.markScheduleRan(shot.id);
const fired = store.getSchedule(shot.id);
check("after firing: nothing left to run at", fired.next_run, null);
check("after firing: disabled", fired.enabled, 0);
check("after firing: not due again", store.dueSchedules().some((s) => s.id === shot.id), false);
check("after firing: the row survives for the record", store.getSchedule(shot.id) != null, true);
check("list says it ran rather than 'disabled'", (await scheduleList.run({}, { policy: on })).includes("already ran"), true);

check("re-enabling a spent one-shot is refused", scheduleUpdate.checkPolicy(on, { enabled: true, id: shot.id }).allowed, false);
check("  and points at the fix", /new time|new job/.test(scheduleUpdate.checkPolicy(on, { enabled: true, id: shot.id }).reason), true);
// The store must make it unrepresentable even if a caller ignores the tool's refusal.
store.updateSchedule(shot.id, { enabled: true });
check("the store refuses to arm it anyway", store.getSchedule(shot.id).enabled, 0);
check("  and leaves it with no next run", store.getSchedule(shot.id).next_run, null);

// Giving it a fresh time is the supported way back.
await scheduleUpdate.run({ enabled: true, id: shot.id, schedule: "in 3 hours" }, { policy: on });
check("a new time revives it", store.getSchedule(shot.id).enabled, 1);
check("  and re-arms it", store.getSchedule(shot.id).next_run != null, true);

// The contrast that matters: a recurring job in the same position re-arms, as it always did.
await scheduleCreate.run({ name: "Hourly", schedule: "every 1 hours", task: "t" }, { policy: on });
const rec = store.listSchedules().find((s) => s.name === "Hourly");
store.markScheduleRan(rec.id);
check("a recurring job still re-arms", store.getSchedule(rec.id).next_run != null, true);
check("  and stays enabled", store.getSchedule(rec.id).enabled, 1);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
