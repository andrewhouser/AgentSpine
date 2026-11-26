/**
 * One tick of the scheduler (src/scheduler.ts) against a throwaway database: which due jobs
 * run, which are skipped for being too late, and what is written to the job's row either way
 * (PLAN-open-work section 13 H6). The arithmetic of "too late" has its own suite,
 * test/schedule-catchup.test.mjs; this one is about the wiring around it.
 *
 * The tick is handed its clock, and every slot is a fixed local date.
 *
 * Run with: node test/scheduler-tick.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-tick-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");

const store = await import("../src/memory/store.ts");
const { tickSchedules } = await import("../src/scheduler.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

// The tick logs each skip; keep the suite's own output readable and keep what it said.
const logged = [];
const realLog = console.log;
const quiet = (fn) => {
  console.log = (...a) => logged.push(a.join(" "));
  try {
    return fn();
  } finally {
    console.log = realLog;
  }
};

const at = (h, m = 0, day = 15) => new Date(2026, 6, day, h, m, 0, 0); // July 2026, local
const db = store.rawDb;
/** A job with its spec and due slot set directly, the way a row looks after the server slept. */
const job = (name, spec, slot, extra = {}) => {
  const id = store.createSchedule(name, `do ${name}`, "every 30 minutes");
  db.prepare("UPDATE schedules SET spec = ?, interval_minutes = ?, next_run = ?, enabled = ? WHERE id = ?").run(
    spec,
    extra.interval ?? 0,
    slot ? slot.toISOString() : null,
    extra.enabled ?? 1,
    id,
  );
  return id;
};
const tick = (now) => {
  const started = [];
  const result = quiet(() => tickSchedules((s) => started.push(s.id), now));
  return { ...result, started };
};
const clear = () => db.exec("DELETE FROM schedules");

console.log("\nA SLOT THE SERVER SLEPT THROUGH");
{
  clear();
  const id = job("morning brief", "daily at 7:00am", at(7));
  const r = tick(at(12));
  const s = store.getSchedule(id);
  check("it is skipped, not started", [r.skipped, r.ran, r.started], [[id], [], []]);
  check("the job is armed for tomorrow's slot", s.next_run, at(7, 0, 16).toISOString());
  check("and stays enabled", s.enabled, 1);
  check("nothing ran, so last_run is untouched", s.last_run, null);
  check("the row says which slot was skipped", s.last_skip_slot, at(7).toISOString());
  check("and when", typeof s.last_skip_at === "string" && !Number.isNaN(Date.parse(s.last_skip_at)), true);
  check("and why, in words", /5 hours late/.test(s.last_skip_reason) && /2 hours/.test(s.last_skip_reason), true);
  check("the skip is logged with the job's name and the reason", logged.some((l) => l.includes("[schedule morning brief] skipped") && l.includes("5 hours late")), true);
  check("the next tick does not see it as due", tick(at(12, 1)).skipped.concat(tick(at(12, 1)).ran), []);
}

console.log("\nA SLOT THAT IS ONLY A LITTLE LATE");
{
  clear();
  const id = job("morning brief", "daily at 7:00am", at(7));
  const r = tick(at(7, 30));
  const s = store.getSchedule(id);
  check("it runs", [r.ran, r.started, r.skipped], [[id], [id], []]);
  check("and is re-armed before it starts", typeof s.next_run === "string" && s.next_run > at(7, 30).toISOString(), true);
  check("last_run is set", typeof s.last_run, "string");
  check("no skip is recorded", [s.last_skip_at, s.last_skip_slot, s.last_skip_reason], [null, null, null]);
}

console.log("\nONE TICK, SEVERAL JOBS");
{
  clear();
  const late = job("morning brief", "daily at 7:00am", at(7));
  const fine = job("inbox watcher", "every 30 minutes", at(11, 50));
  const never = job("new job", "every 30 minutes", null);
  const off = job("switched off", "daily at 7:00am", at(7), { enabled: 0 });
  const r = tick(at(12));
  check("the late one is skipped and the others run", [r.skipped, r.ran], [[late], [fine, never]]);
  check("a job that was never armed is due, not late", store.getSchedule(never).last_skip_at, null);
  check("a disabled job is not looked at", [store.getSchedule(off).next_run, store.getSchedule(off).last_skip_at], [at(7).toISOString(), null]);
}

console.log("\nAN INTERVAL JOB KEEPS ITS GRID");
{
  clear();
  const id = job("inbox watcher", "every 8 hours", at(8));
  const r = tick(at(13));
  check("five hours late is past its two-hour limit", r.skipped, [id]);
  check("it comes back where it would have been, not eight hours from now", store.getSchedule(id).next_run, at(16).toISOString());
}
{
  clear();
  const id = job("legacy job", null, at(8), { interval: 60 });
  const r = tick(at(10));
  check("a job with only the legacy interval follows the same rule", [r.skipped, store.getSchedule(id).next_run], [[id], at(11).toISOString()]);
}

console.log("\nA ONE-SHOT");
{
  clear();
  const id = job("reminder", "once at 2026-07-15 15:00", at(15));
  const r = tick(at(23));
  const s = store.getSchedule(id);
  check("it runs however late", [r.ran, r.skipped], [[id], []]);
  check("and retires as a fired one-shot does", [s.enabled, s.next_run], [0, null]);
}
{
  clear();
  const id = job("reminder", "once at 2026-07-15 15:00", at(15));
  store.updateSchedule(id, { catchupMinutes: 60 });
  db.prepare("UPDATE schedules SET next_run = ?, enabled = 1 WHERE id = ?").run(at(15).toISOString(), id);
  const r = tick(at(17));
  const s = store.getSchedule(id);
  check("with its own limit it can be skipped", [r.skipped, r.started], [[id], []]);
  check("and then retires, since it has no other slot", [s.enabled, s.next_run], [0, null]);
  check("with the reason on the row", /one-off/.test(s.last_skip_reason), true);
}

console.log("\nA JOB'S OWN LIMIT");
{
  clear();
  const id = job("morning brief", "daily at 7:00am", at(7));
  check("a new job has none", store.getSchedule(id).catchup_minutes, null);
  store.updateSchedule(id, { catchupMinutes: 0 });
  db.prepare("UPDATE schedules SET next_run = ? WHERE id = ?").run(at(7).toISOString(), id);
  check("0 is stored", store.getSchedule(id).catchup_minutes, 0);
  check("and means it runs however late", tick(at(19)).ran, [id]);

  store.updateSchedule(id, { catchupMinutes: 360 });
  db.prepare("UPDATE schedules SET next_run = ? WHERE id = ?").run(at(7).toISOString(), id);
  check("a wider limit lets a five-hour-late run through", tick(at(12)).ran, [id]);
  db.prepare("UPDATE schedules SET next_run = ? WHERE id = ?").run(at(7).toISOString(), id);
  check("but not a seven-hour-late one", tick(at(14)).skipped, [id]);

  store.updateSchedule(id, { name: "renamed" });
  check("a change to something else leaves the limit alone", store.getSchedule(id).catchup_minutes, 360);
  store.updateSchedule(id, { catchupMinutes: null });
  check("null puts the job back on the default rule", store.getSchedule(id).catchup_minutes, null);

  const refused = (value) => {
    try {
      store.updateSchedule(id, { catchupMinutes: value });
      return false;
    } catch (err) {
      return /catch-up limit/.test(err.message);
    }
  };
  check("a negative limit is refused", refused(-1), true);
  check("a fraction is refused", refused(1.5), true);
  check("not-a-number is refused", refused(Number.NaN), true);
  check("more than a week is refused", refused(7 * 24 * 60 + 1), true);
  check("a refused value changes nothing", store.getSchedule(id).catchup_minutes, null);
  check("changing the limit is not a change of task, so it leaves no version", store.listScheduleVersions(id).length, 0);
}

console.log("\nWHAT THE API RETURNS");
{
  const keys = Object.keys(store.listSchedules()[0]);
  check(
    "every schedule row carries the limit and the last skip",
    ["catchup_minutes", "last_skip_at", "last_skip_slot", "last_skip_reason"].every((k) => keys.includes(k)),
    true,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
