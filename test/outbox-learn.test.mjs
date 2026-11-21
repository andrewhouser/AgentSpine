/**
 * Outbox Phase 4 (docs/archive/PLAN-outbox.md). Run with `node test/outbox-learn.test.mjs`.
 *
 * What this holds:
 *   - the tier is decided at every boundary (8 counted, 0.7 and 0.85, with float slack);
 *   - Skip, a dismissal and silence count as skipped, Useful cancels the last two, an unreported
 *     message is not counted at all;
 *   - 10 skipped messages from one watcher produce exactly one proposal, and asking again does not
 *     queue a second, whether the first is pending, rejected or approved;
 *   - nothing is switched off: the schedule stays enabled until a confirmation is approved;
 *   - a Heads-up kind or an unnamed schedule is listed but never proposed, and so is a name shared
 *     by two jobs or a job that is already off;
 *   - the review carries the list, and the weekly push says how many kinds are on it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-outbox-learn-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";

const store = await import("../src/memory/store.ts");
const outbox = await import("../src/outbox.ts");
const learn = await import("../src/outbox-learn.ts");
const review = await import("../src/outbox-review.ts");
const rules = await import("../src/outbox-rules.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(72)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const SUNDAY_EVENING = new Date(2026, 10, 22, 18, 0, 0);
const days = (n) => new Date(SUNDAY_EVENING.getTime() - n * 86_400_000);
const stamp = (id, fields) => {
  for (const [k, v] of Object.entries(fields)) rawDb.prepare(`UPDATE outbox SET ${k} = ? WHERE id = ?`).run(v, id);
};
// A message that went to a phone and got `answer`: skip | useful | dismissed | opened | ignored | none.
const send = (source, kind, answer, ageDays = 2) => {
  const when = days(ageDays);
  const a = outbox.admit({ body: "b", kind, priority: 3, source, title: `${kind} ${Math.random()}` }, when);
  outbox.complete(a.id, { ok: true, via: "apns" });
  if (answer === "skip" || answer === "useful") stamp(a.id, { feedback: answer, feedback_at: when.toISOString() });
  if (answer === "dismissed") stamp(a.id, { dismissed_at: when.toISOString() });
  if (answer === "opened") stamp(a.id, { opened_at: when.toISOString() });
  return a.id;
};
const statFor = (source, kind) => learn.skipStats(SUNDAY_EVENING).find((s) => s.source === source && s.kind === kind);
const pending = () => rawDb.prepare("SELECT id, tool, args, state FROM confirmations WHERE tool = 'schedule_update' ORDER BY id").all();

console.log("\nTHE TIER, AT EVERY BOUNDARY");
const t = (counted, skipped) => learn.skipTierOf({ counted, rate: counted ? skipped / counted : 0 });
check("7 counted is too few, even if all skipped", t(7, 7), "none");
check("8 counted, 8 skipped: off", t(8, 8), "off");
check("20 counted at 17 skipped is 0.85: off", t(20, 17), "off");
check("20 counted at 16 skipped is 0.8: quiet", t(20, 16), "quiet");
check("10 counted at 7 skipped is exactly 0.7: quiet", t(10, 7), "quiet");
check("10 counted at 6 skipped: none", t(10, 6), "none");
check("nothing counted: none", t(0, 0), "none");
check("the thresholds are the documented ones", [rules.SKIP_MIN_COUNTED, rules.SKIP_QUIETEN_RATE, rules.SKIP_PROPOSE_RATE, rules.SKIP_SUPPRESS_DAYS], [8, 0.7, 0.85, 90]);

console.log("\nWHAT COUNTS AS SKIPPED");
for (let i = 0; i < 3; i++) send("tool", "Mixed", "skip");
send("tool", "Mixed", "dismissed");
send("tool", "Mixed", "opened");
send("tool", "Mixed", "useful");
send("tool", "Mixed", "none", 0.2); // under 24 hours old: still pending, so not counted
// Silence after 24 hours is "ignored" (an APNs send); Useful overrides it.
send("tool", "Mixed", "none", 3);
const ignoredUseful = send("tool", "Mixed", "useful", 3);
const m = statFor("tool", "Mixed");
check("9 sent", m.sent, 9);
check("8 known: 3 skip, 1 dismissed, 1 opened, 2 useful, 1 ignored (a recent one is pending, not counted)", m.counted, 8);
check("skipped: 3 skip + 1 dismissed + 1 ignored", m.skipped, 5);
check("an old Useful is not skipped", ignoredUseful > 0 && m.skipped, 5);
check("rate is skipped / counted", m.rate, 5 / 8);
check("the topic is the review's topic", m.topic, review.topicOf("tool", "Mixed"));

console.log("\nA RUN WITH NO SCHEDULE, AND A MESSAGE OUTSIDE THE WINDOW, ARE NOT KINDS");
send("run", "", "skip");
check("no stats for an empty kind", learn.skipStats(SUNDAY_EVENING).some((s) => s.kind === ""), false);
for (let i = 0; i < 9; i++) send("tool", "Ancient", "skip", 100);
check("100-day-old messages are outside the 90-day window", statFor("tool", "Ancient"), undefined);

console.log("\nTEN SKIPS FROM ONE WATCHER: EXACTLY ONE PROPOSAL");
const watch = store.createSchedule("Price watch", "check prices", "every day at 08:00", true);
for (let i = 0; i < 10; i++) send("tool", "Price watch", "skip");
check("below the bar before the 10th", statFor("tool", "Price watch").counted, 10);
const first = learn.proposeSchedulesOff(SUNDAY_EVENING);
check("one proposal queued", first.length, 1);
const rows = pending();
check("it is a schedule_update with enabled false for that job", [rows[0].tool, JSON.parse(rows[0].args)], ["schedule_update", { enabled: false, id: watch }]);
check("it is waiting, not applied", rows[0].state, "pending");
check("the schedule is still on", !!store.getSchedule(watch).enabled, true);
check("asking again while it is pending queues nothing", learn.proposeSchedulesOff(SUNDAY_EVENING).length, 0);
rawDb.prepare("UPDATE confirmations SET state = 'rejected' WHERE id = ?").run(rows[0].id);
check("a rejected one is not asked again", learn.proposeSchedulesOff(SUNDAY_EVENING).length, 0);
check("still exactly one row", pending().length, 1);
const later = new Date(SUNDAY_EVENING.getTime() + 91 * 86_400_000);
for (let i = 0; i < 10; i++) send("tool", "Price watch", "skip", -91 + 2);
check("91 days on, with fresh skips, it may ask again", learn.proposeSchedulesOff(later).length, 1);
check("approving is the only thing that changes the job (nothing did)", !!store.getSchedule(watch).enabled, true);

console.log("\nWHAT IS LISTED BUT NEVER PROPOSED");
for (let i = 0; i < 10; i++) send("headsup", "birthday", "skip");
for (let i = 0; i < 10; i++) send("study", "flash cards", "skip");
const before = pending().length;
learn.proposeSchedulesOff(SUNDAY_EVENING);
check("a Heads-up kind and a study kind queue nothing", pending().length, before);
check("but both are listed as mostly skipped", ["birthday", "flash cards"].every((k) => learn.mostlySkipped(SUNDAY_EVENING).some((s) => s.kind === k)), true);

store.createSchedule("Twin", "a", "every day at 09:00", true);
store.createSchedule("Twin", "b", "every day at 10:00", true);
for (let i = 0; i < 10; i++) send("tool", "Twin", "skip");
const off = store.createSchedule("Already off", "x", "every day at 11:00", false);
for (let i = 0; i < 10; i++) send("tool", "Already off", "skip");
for (let i = 0; i < 10; i++) send("tool", "No such job", "skip");
const before2 = pending().length;
learn.proposeSchedulesOff(SUNDAY_EVENING);
check("two jobs with one name, a job already off, and no job at all: nothing queued", pending().length, before2);
check("the already-off job is untouched", off > 0 && !!store.getSchedule(off).enabled, false);

console.log("\nTHE REVIEW CARRIES THE LIST");
const built = review.buildReview(SUNDAY_EVENING, { markSeen: false });
check("quiet lists the Price watch kind at the top tier", built.quiet.find((q) => q.kind === "Price watch")?.tier, "off");
check("and the mixed one (5 of 8 is 0.625) is not listed", built.quiet.some((q) => q.kind === "Mixed"), false);

console.log("\nTHE WEEKLY PUSH SAYS HOW MANY");
let sent = null;
const ok = await review.sendWeeklyReview(async (title, body) => ((sent = { body, title }), { ok: true }), SUNDAY_EVENING);
check("it went", ok, true);
check("and mentions the kinds you mostly skip", /\d+ kinds you mostly skip are listed there too\./.test(sent?.body ?? ""), true);

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
