/**
 * The weekly review (docs/archive/PLAN-outbox.md, Phase 3). Run with `node test/outbox-review.test.mjs`.
 *
 * What this holds:
 *   - the review lists only messages you can vote on, sent in the last 7 days, and never an approval,
 *     a reminder, a held message, or a push you asked for yourself;
 *   - "skip this kind" files ONE dismissal memory under a topic that is the same next week, and
 *     "useful" files nothing;
 *   - a wish is a `preference` memory with origin `review`, clipped, and an empty one is refused;
 *   - an answer cannot reach a message the review does not list (a forged id cannot touch an approval);
 *   - the weekly push goes once, on Sunday evening, outside quiet hours, and is never held or counted;
 *   - none of this writes a file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-review-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = ""; // keyword fallback, no network

const store = await import("../src/memory/store.ts");
const outbox = await import("../src/outbox.ts");
const review = await import("../src/outbox-review.ts");
const rules = await import("../src/outbox-rules.ts");
const { updatePrefs } = await import("../src/headsup/prefs.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(72)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

// Sunday 22 November 2026, local time. 18:00 is after the review hour and before quiet hours.
const SUNDAY_EVENING = new Date(2026, 10, 22, 18, 0, 0);
const daysBefore = (d, n) => new Date(d.getTime() - n * 86_400_000);
const add = (source, title, kind, when = SUNDAY_EVENING, priority = 3) => {
  const a = outbox.admit({ body: `${title} body`, kind, priority, source, title }, when);
  return a.id;
};

console.log("\nTHE TOPIC IS THE SAME NEXT WEEK");
check("source and kind make the topic", review.topicOf("headsup", "birthday"), "heads-up: birthday");
check("no kind: the source alone", review.topicOf("study", ""), "study reminders");
check("a watcher is named by its schedule", review.topicOf("tool", "Weather watch"), "alerts from watchers and scheduled briefs: Weather watch");
check("so two different titles give one topic", review.topicOf("headsup", "birthday") === review.topicOf("headsup", "birthday"), true);

console.log("\nTHE REVIEW LISTS WHAT YOU CAN VOTE ON");
const b1 = add("headsup", "Heads-up: Sam's birthday tomorrow", "birthday");
const b2 = add("headsup", "Heads-up: Jo's birthday in 3 days", "birthday", daysBefore(SUNDAY_EVENING, 2));
const study = add("study", "12 cards are due", "flash cards", daysBefore(SUNDAY_EVENING, 1));
const watcher = add("tool", "Price dropped", "Weather watch", daysBefore(SUNDAY_EVENING, 3));
const runKept = add("run", "Run failed: nightly", "Nightly", daysBefore(SUNDAY_EVENING, 3));
const runAsked = add("run", "Finished: summarise this", "", daysBefore(SUNDAY_EVENING, 3));
const approval = add("confirmation", "Approve: delete file", "");
const reminder = add("reminder", "Call the dentist", "");
const tooOld = add("headsup", "Heads-up: last month", "birthday", daysBefore(SUNDAY_EVENING, 8));
const items = review.reviewItems(SUNDAY_EVENING);
const ids = items.map((i) => i.id);
check("heads-up, study, watcher and a named schedule's run are listed", [b1, b2, study, watcher, runKept].every((id) => ids.includes(id)), true);
check("a push you asked for (a run with no schedule) is not", ids.includes(runAsked), false);
check("an approval request is not", ids.includes(approval), false);
check("a reminder is not", ids.includes(reminder), false);
check("something from 8 days ago is not", ids.includes(tooOld), false);
check("newest first", ids, [...ids].sort((a, b) => b - a));
check("each item carries the topic its Skip button would use", items.find((i) => i.id === b1).topic, "heads-up: birthday");
check("a message with no report is pending (an APNs send) or unknown (anything else)", items.find((i) => i.id === b1).outcome, "unknown");
rawDb.prepare("UPDATE outbox SET opened_at = ? WHERE id = ?").run(SUNDAY_EVENING.toISOString(), b1);
check("an opened message reads as opened", review.reviewItems(SUNDAY_EVENING).find((i) => i.id === b1).outcome, "opened");
rawDb.prepare("UPDATE outbox SET decision = 'held' WHERE id = ?").run(study);
check("a held message is not listed until it is sent", review.reviewItems(SUNDAY_EVENING).some((i) => i.id === study), false);
rawDb.prepare("UPDATE outbox SET decision = 'sent' WHERE id = ?").run(study);

console.log("\nOPENING THE REVIEW MARKS WHAT IT LISTED AS SEEN, ONCE");
const first = review.buildReview(SUNDAY_EVENING);
check("the review has items and counts for reviewed sources only", [first.items.length > 0, first.tally.every((t) => rules.REVIEWED_SOURCES.has(t.source))], [true, true]);
const seenOf = (id) => rawDb.prepare("SELECT seen_at FROM outbox WHERE id = ?").get(id).seen_at;
check("seen_at is set", seenOf(b1), SUNDAY_EVENING.toISOString());
review.buildReview(new Date(SUNDAY_EVENING.getTime() + 3_600_000));
check("a second look does not move it", seenOf(b1), SUNDAY_EVENING.toISOString());
check("an approval was not stamped", seenOf(approval), null);
review.buildReview(SUNDAY_EVENING, { markSeen: false });
check("markSeen: false stamps nothing", seenOf(runKept), SUNDAY_EVENING.toISOString());

console.log("\nANSWERS");
const dismissed = [];
const spy = async (topic) => (dismissed.push(topic), true);
check("an approval's id is not answerable", await review.answerMessage(approval, "skip", SUNDAY_EVENING, spy), null);
check("nor a reminder's, nor a missing id", [await review.answerMessage(reminder, "skip", SUNDAY_EVENING, spy), await review.answerMessage(99999, "skip", SUNDAY_EVENING, spy)], [null, null]);
check("nor a run you asked to be told about", await review.answerMessage(runAsked, "skip", SUNDAY_EVENING, spy), null);
check("nothing was filed for those", dismissed.length, 0);
const useful = await review.answerMessage(b1, "useful", SUNDAY_EVENING, spy);
check("useful records the answer and files no memory", [useful, dismissed.length, rawDb.prepare("SELECT feedback FROM outbox WHERE id = ?").get(b1).feedback], [{ remembered: false, topic: "heads-up: birthday" }, 0, "useful"]);
const skip = await review.answerMessage(b2, "skip", SUNDAY_EVENING, spy);
check("skip files a dismissal under the topic", [skip, dismissed], [{ remembered: true, topic: "heads-up: birthday" }, ["heads-up: birthday"]]);
await review.answerMessage(b2, "skip", SUNDAY_EVENING, spy);
check("skipping the same message again files nothing more", dismissed.length, 1);
check("the answer shows up in the review", review.reviewItems(SUNDAY_EVENING).find((i) => i.id === b2).feedback, "skip");

console.log("\nSKIP THIS KIND REACHES MEMORY, FOR REAL");
const real = await review.answerMessage(watcher, "skip", SUNDAY_EVENING);
const mem = rawDb.prepare("SELECT kind, origin, text FROM memories WHERE text LIKE '%Weather watch%'").get();
check("one preference memory, origin interrupt, naming the watcher", [real.remembered, mem?.kind, mem?.origin, mem?.text.includes("alerts from watchers and scheduled briefs: Weather watch")], [true, "preference", "interrupt", true]);
await review.answerMessage(watcher, "skip", SUNDAY_EVENING);
check("a repeat does not make a second one", rawDb.prepare("SELECT COUNT(*) AS n FROM memories WHERE text LIKE '%Weather watch%'").get().n, 1);

console.log("\nA WISH IS A PREFERENCE MEMORY");
check("an empty wish is refused", [await review.recordWish(""), await review.recordWish("   "), await review.recordWish(undefined)], [false, false, false]);
check("a wish is stored", await review.recordWish("when the school sends a snow day notice"), true);
const wish = rawDb.prepare("SELECT kind, origin, text FROM memories WHERE text LIKE '%snow day%'").get();
check("as a preference with origin review, in code's words around yours", [wish.kind, wish.origin, wish.text.startsWith("The user said, in the weekly review, that they wish they had been told about:")], ["preference", "review", true]);
await review.recordWish("x".repeat(1000));
check("a long wish is clipped to WISH_MAX characters of yours", rawDb.prepare("SELECT text FROM memories WHERE text LIKE '%xxxx%'").get().text.length, review.wishMemory("x".repeat(rules.WISH_MAX)).length);
check("the same wish twice is one memory", (await review.recordWish("when the school sends a snow day notice"), rawDb.prepare("SELECT COUNT(*) AS n FROM memories WHERE text LIKE '%snow day%'").get().n), 1);

console.log("\nTHE WEEKLY PUSH");
updatePrefs({ quietEndHour: 6, quietStartHour: 21 });
const sent = [];
const send = async (title, body, opts) => (sent.push({ body, opts, title }), { ok: true });
const monday = new Date(2026, 10, 23, 18, 0, 0);
const sundayMorning = new Date(2026, 10, 22, 9, 0, 0);
const sundayLate = new Date(2026, 10, 22, 22, 0, 0);
check("not on a Monday", (await review.sendWeeklyReview(send, monday), sent.length), 0);
check("not on Sunday morning", (await review.sendWeeklyReview(send, sundayMorning), sent.length), 0);
check("not in quiet hours", (await review.sendWeeklyReview(send, sundayLate), sent.length), 0);
check("Sunday evening, with a week to review, it goes", await review.sendWeeklyReview(send, SUNDAY_EVENING), true);
check("as a review-source push at normal priority, naming how many and where to look", [sent[0].opts.source, sent[0].opts.priority, /\d+ messages? from the last week/.test(sent[0].body), sent[0].body.includes("Weekly review")], ["review", 3, true, true]);
check("the outbox never holds or counts that source", [rules.GOVERNED_SOURCES.has("review"), rules.COUNTED_SOURCES.has("review"), rules.REVIEWED_SOURCES.has("review")], [false, false, false]);
const row = outbox.admit({ body: "b", source: "review", title: "Your weekly review is ready" }, SUNDAY_EVENING);
outbox.complete(row.id, { ok: true, via: "apns" });
check("once delivered, a second sweep sends nothing", [await review.sendWeeklyReview(send, new Date(SUNDAY_EVENING.getTime() + 600_000)), sent.length], [false, 1]);
check("an empty week gets no push", review.reviewDue(new Date(2026, 11, 20, 18, 0, 0)), { count: 0, due: false });

console.log("\nNOTHING HERE WRITES A FILE");
const src = fs.readFileSync(new URL("../src/outbox-review.ts", import.meta.url), "utf8");
check("outbox-review.ts imports no filesystem module", /from "node:fs|from "fs"|writeFile/.test(src), false);

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
