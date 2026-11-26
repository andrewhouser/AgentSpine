/**
 * The heads-up line in the morning brief: the count tool, and upgrading an already-seeded brief.
 * Run with `node test/headsup-brief.test.mjs`.
 *
 * The upgrade is the risky part. The brief is a schedule row in YOUR database, and you may have
 * reworded it. Overwriting that to deliver a feature would be a small betrayal, so the rule is: only
 * a brief that still says exactly the old shipped default is touched, and everything else is left alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-brief-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";

const { describeWaiting, whenWords, headsupStatus } = await import("../src/tools/headsup.ts");
const { BRIEF_NAME, BRIEF_SPEC, BRIEF_TASK, BRIEF_TASK_V1, ensureMorningBrief, upgradeMorningBrief } = await import("../src/briefing.ts");
const store = await import("../src/memory/store.ts");
const ledger = await import("../src/headsup/ledger.ts");
const dates = await import("../src/headsup/dates.ts");
const { registry } = await import("../src/tools/index.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const now = new Date(2026, 10, 18, 7, 30);
const day = (n) => { const d = new Date(2026, 10, 18 + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

console.log("\nwording the count\n");
check("today, tomorrow, in N days", [whenWords(day(0), now), whenWords(day(1), now), whenWords(day(10), now)], ["today", "tomorrow", "in 10 days"]);
check("a past date reads as today, never negative", whenWords(day(-3), now), "today");
check("a timed due date uses its day", whenWords(`${day(2)}T09:00:00-05:00`, now), "in 2 days");
check("none waiting", describeWaiting([], 0, now), "No heads-ups are waiting.");
check("one, named", describeWaiting([{ dueAt: day(10), subject: "Garrett's Birthday" }], 0, now), "1 heads-up is waiting for an answer. Nearest: Garrett's Birthday (in 10 days).");
check("several, soonest first, and capped at three with the rest counted", describeWaiting([
  { dueAt: day(9), subject: "D" }, { dueAt: day(1), subject: "A" }, { dueAt: day(5), subject: "C" }, { dueAt: day(2), subject: "B" }, { dueAt: day(8), subject: "E" },
], 0, now), "5 heads-ups are waiting for an answer. Nearest: A (tomorrow); B (in 2 days); C (in 5 days); and 2 more.");
check("a date noticed in chat counts, and is described", describeWaiting([], 1, now), "1 heads-up is waiting for an answer. 1 date it noticed in chat needs confirming.");
check("both together", describeWaiting([{ dueAt: day(3), subject: "Rent" }], 2, now), "3 heads-ups are waiting for an answer. Nearest: Rent (in 3 days). 2 dates it noticed in chat need confirming.");

console.log("\nthe tool, against the database\n");
check("it is registered, so a brief run can call it", registry.headsup_status === headsupStatus, true);
check("it is read-only and always allowed", [headsupStatus.classify({}).reversibility, headsupStatus.checkPolicy({}).allowed], ["reversible", true]);
check("nothing waiting", await headsupStatus.run({}), "No heads-ups are waiting.");
const cand = (kind, subject, key, d) => ({ daysUntil: 3, dedupeKey: key, fingerprint: "", kind, location: "", sourceId: key, startsAt: d, subject, timeSensitive: false });
const offered = ledger.markOffered(cand("birthday", "Garrett's Birthday", "b1", day(10)), 0, now);
const snoozed = ledger.markOffered(cand("bill", "Water", "w1", day(4)), 0, now);
ledger.answer(snoozed.id, "later", now);
const accepted = ledger.markOffered(cand("bill", "Rent", "r1", day(2)), 0, now);
ledger.answer(accepted.id, "yes", now);
const out = await headsupStatus.run({});
check("an offered one is waiting", out.includes("Garrett's Birthday"), true);
check("a snoozed one is not (it is waiting on the clock)", out.includes("Water"), false);
check("an accepted one is not (it is answered)", out.includes("Rent"), false);
check("so exactly one is counted", out.includes("\n1 heads-up is waiting"), true);
// The 2026-11-25 trace: these are calendar titles, written by whoever sent the invite.
check("the titles come back marked untrusted", out.startsWith("[UNTRUSTED CONTENT from calendar event titles]"), true);
check("and the tool keeps the run local, like calendar_upcoming", headsupStatus.privateOutput, true);
dates.proposeDatesFromChat("Mia's birthday is June 9");
check("a pending date proposal counts too", (await headsupStatus.run({})).includes("\n2 heads-ups are waiting") && (await headsupStatus.run({})).includes("1 date it noticed in chat needs confirming"), true);

console.log("\nthe brief itself\n");
check("the new text asks for the heads-up line", BRIEF_TASK.includes("call headsup_status"), true);
check("... only briefly, and not when there is nothing", BRIEF_TASK.includes("say nothing if none are waiting"), true);
check("the old text is kept as a fingerprint, and does not mention it", BRIEF_TASK_V1.includes("headsup"), false);
check("they differ", BRIEF_TASK !== BRIEF_TASK_V1, true);

console.log("\nupgrading an existing brief\n");
check("no brief at all: nothing to upgrade", upgradeMorningBrief(), false);
// An install from before heads-ups: seeded with the old default.
store.rawDb.prepare("CREATE TABLE IF NOT EXISTS seeds (name TEXT PRIMARY KEY, created TEXT NOT NULL)").run();
store.rawDb.prepare("INSERT OR IGNORE INTO seeds (name, created) VALUES (?, ?)").run(BRIEF_NAME, "2026-01-01");
const id = store.createSchedule(BRIEF_NAME, BRIEF_TASK_V1, BRIEF_SPEC, true);
check("an unedited old brief is upgraded", [upgradeMorningBrief(), store.getSchedule(id).task === BRIEF_TASK], [true, true]);
check("... and keeps its schedule and enabled state", [store.getSchedule(id).enabled, store.getSchedule(id).name], [1, BRIEF_NAME]);
check("upgrading twice does nothing the second time", upgradeMorningBrief(), false);
store.updateSchedule(id, { task: `${BRIEF_TASK_V1} Also tell me a joke.` });
check("a brief you reworded is NOT touched", [upgradeMorningBrief(), store.getSchedule(id).task], [false, `${BRIEF_TASK_V1} Also tell me a joke.`]);
store.updateSchedule(id, { task: BRIEF_TASK_V1 });
store.updateSchedule(id, { enabled: false });
check("a brief you turned off is still upgraded, and still off", [upgradeMorningBrief(), store.getSchedule(id).enabled], [true, 0]);
store.updateSchedule(id, { name: "My own morning thing", task: BRIEF_TASK_V1 });
check("a brief you renamed is not recognised, so is left alone", [upgradeMorningBrief(), store.getSchedule(id).task === BRIEF_TASK_V1], [false, true]);
store.updateSchedule(id, { name: BRIEF_NAME, task: BRIEF_TASK_V1 });
check("ensureMorningBrief runs the upgrade (it is what the server calls at startup)", [ensureMorningBrief(), store.getSchedule(id).task === BRIEF_TASK], [false, true]);
check("... and does not create a second brief", store.listSchedules().filter((s) => s.name === BRIEF_NAME).length, 1);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
