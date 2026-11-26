/**
 * Today: one screen of everything waiting, and the three-line brief
 * (src/today.ts, PLAN-open-work section 14, U1 and U2).
 *
 * `assembleToday` is pure, so the clock is handed in and nothing here depends on the hour the
 * suite runs at. Times are built with the local-time Date constructor, because "due today"
 * and "until the next morning" are local-day rules. What is pinned:
 *   - every edge of due-today and overdue;
 *   - Later: until the next local morning, and it never touches a confirmation's expiry;
 *   - the fixed do-first order;
 *   - where "since you last looked" starts, and what lands in it;
 *   - the one "waiting on you" count;
 *   - empty states, and the stored half through a throwaway database.
 *
 *   node test/today.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-today-"));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.CONFIRM_EXPIRE_AFTER_MIN = "4320";

const t = await import("../src/today.ts");
const store = await import("../src/memory/store.ts");
const tasks = await import("../src/tasks/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// A Monday, 10:30 in the morning, local time. Well clear of midnight and of the morning hour.
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 5, 15 + dayOffset, h, m);
const NOW = at(10, 30);
const iso = (d) => d.toISOString();
const empty = { approvals: [], expireAfterMin: 4320, headsups: [], later: {}, looked: null, runs: [], schedules: [], tasks: [], threads: [] };
const make = (over, now = NOW) => t.assembleToday({ ...empty, ...over }, now);
const offer = (id, subject, dueAt, state = "offered") => ({ dueAt, id, kind: "bill", state, subject });

console.log("\nNOTHING AT ALL");
{
  const today = make({});
  check("no rows anywhere", [today.approvals, today.tasks, today.headsups, today.since, today.threads, today.mail], [[], [], [], [], [], []]);
  check("the count is zero", today.count, 0);
  check("nothing to do first", today.brief.first, { id: null, kind: "none", reason: "none", title: "" });
  check("the brief counts are all zero", [today.brief.done, today.brief.waiting], [
    { failed: 0, ok: 0, skipped: 0, stalled: 0 },
    { approvals: 0, headsups: 0, tasks: 0, threads: 0 },
  ]);
}

console.log("\nDUE — overdue, due today, and where today ends");
{
  const today = make({
    tasks: [
      { due: iso(at(23, 59)), id: 1, title: "last minute of today", waiting_on: null },
      { due: iso(at(0, 0, 1)), id: 2, title: "midnight is tomorrow", waiting_on: null },
      { due: iso(at(10, 29)), id: 3, title: "a minute ago", waiting_on: null },
      { due: iso(NOW), id: 4, title: "due this instant", waiting_on: "Sam Rivera" },
      { due: iso(at(9, 0, -3)), id: 5, title: "three days ago", waiting_on: null },
      { due: null, id: 6, title: "no date", waiting_on: null },
      { due: "not a date", id: 7, title: "a date that does not parse", waiting_on: null },
    ],
  });
  check("overdue first, then the rest of today, by time", today.tasks.map((x) => x.id), [5, 3, 4, 1]);
  check("before now is overdue; now itself is not", today.tasks.map((x) => x.overdue), [true, true, false, false]);
  check("tomorrow's midnight, no date and a bad date are left out", today.tasks.some((x) => [2, 6, 7].includes(x.id)), false);
  check("who it is waiting on comes through", today.tasks.find((x) => x.id === 4).waitingOn, "Sam Rivera");
  check("the end of the local day is the next midnight", [t.endOfLocalDay(at(0, 0)).getTime(), t.endOfLocalDay(at(23, 59)).getTime()], [at(0, 0, 1).getTime(), at(0, 0, 1).getTime()]);
}

console.log("\nLATER — until the next local morning");
{
  check("at 05:59 it comes back at 06:00 the same day", t.laterUntil(at(5, 59)).getTime(), at(6, 0).getTime());
  check("at 06:00 exactly it comes back tomorrow", t.laterUntil(at(6, 0)).getTime(), at(6, 0, 1).getTime());
  check("mid-morning it comes back tomorrow", t.laterUntil(NOW).getTime(), at(6, 0, 1).getTime());
  check("at 23:59 it comes back in six hours", t.laterUntil(at(23, 59)).getTime(), at(6, 0, 1).getTime());

  const until = iso(t.laterUntil(NOW));
  const input = {
    approvals: [{ conversation_id: 3, id: 9, summary: "Draft an email to sam@example.com\nHi Sam", tool: "draft", ts: iso(at(9, 0)) }],
    headsups: [offer(4, "Power bill", iso(at(0, 0, 2)))],
    later: { "approval:9": until, "headsup:4": until, "task:1": until, "thread:7": until },
    tasks: [{ due: iso(at(9, 0)), id: 1, title: "Call the permit office", waiting_on: null }],
    threads: [{ id: 7, title: "Trip planning", updated: iso(at(8, 0)) }],
  };
  const hidden = make(input);
  check("all four kinds are hidden", [hidden.approvals.length, hidden.tasks.length, hidden.headsups.length, hidden.threads.length], [0, 0, 0, 0]);
  check("... and it says how many", hidden.later, 4);
  check("... and they leave the count", hidden.count, 0);
  check("a minute before the morning they are still hidden", make(input, at(5, 59, 1)).approvals.length, 0);
  const back = make(input, at(6, 0, 1));
  check("at the morning they are back", [back.approvals.length, back.tasks.length, back.headsups.length, back.threads.length, back.later], [1, 1, 1, 1, 0]);
  check("putting it off did not move its expiry", back.approvals[0].expiresAt, iso(new Date(at(9, 0).getTime() + 4320 * 60_000)));
  check("a time that does not parse hides nothing", make({ ...input, later: { "approval:9": "soon" } }).approvals.length, 1);
  check("pruning drops what has come back", t.pruneLater({ a: iso(at(6, 0, 1)), b: iso(at(6, 0)) }, NOW), { a: iso(at(6, 0, 1)) });
}

console.log("\nAPPROVALS — the full text, and when one is close to expiring");
{
  const asked = (hoursAgo) => iso(new Date(NOW.getTime() - hoursAgo * 3_600_000));
  const today = make({
    approvals: [
      { conversation_id: 3, id: 1, summary: "Draft an email to sam@example.com\n\nHi Sam,\nRunning late.", tool: "draft", ts: asked(1) },
      { conversation_id: null, id: 2, summary: "Trash 4 messages", tool: "gmail_triage", ts: asked(48) }, // 24h left: exactly on the line
      { id: 3, summary: "Create a note", tool: "mac_control", ts: asked(47) }, // 25h left
    ],
  });
  check("the one close to expiring goes first, then oldest first", today.approvals.map((a) => a.id), [2, 3, 1]);
  check("exactly 24 hours left counts as close; 25 does not", today.approvals.map((a) => a.expiringSoon), [true, false, false]);
  check("the row is the first line", today.approvals[2].summary, "Draft an email to sam@example.com");
  check("the full text is kept whole", today.approvals[2].text, "Draft an email to sam@example.com\n\nHi Sam,\nRunning late.");
  check("the thread it belongs to", today.approvals.map((a) => a.conversationId), [null, null, 3]);
  const never = make({ approvals: [{ id: 1, summary: "x", tool: "draft", ts: asked(500) }], expireAfterMin: 0 });
  check("with expiry switched off nothing is close to expiring", [never.approvals[0].expiresAt, never.approvals[0].expiringSoon], [null, false]);
}

console.log("\nDO FIRST — a fixed order, in code");
{
  const asked = (hoursAgo) => iso(new Date(NOW.getTime() - hoursAgo * 3_600_000));
  const soon = { id: 1, summary: "Trash 4 messages", tool: "gmail_triage", ts: asked(60) };
  const sooner = { id: 5, summary: "Push the branch", tool: "git_write", ts: asked(70) };
  const fresh = { id: 2, summary: "Create a note", tool: "mac_control", ts: asked(1) };
  const overdue = { due: iso(at(9, 0, -1)), id: 3, title: "Call the permit office", waiting_on: null };
  const older = { due: iso(at(9, 0, -4)), id: 6, title: "Renew the registration", waiting_on: null };
  const later = { due: iso(at(16, 0)), id: 4, title: "Send the measurements", waiting_on: null };
  const earlier = { due: iso(at(12, 0)), id: 7, title: "Lunch order", waiting_on: null };
  const bill = offer(8, "Power bill", iso(at(0, 0, 2)));
  const first = (over) => make(over).brief.first;
  check("an approval close to expiring beats everything", first({ approvals: [fresh, soon], headsups: [bill], tasks: [overdue, later] }), { id: 1, kind: "approval", reason: "expiring", title: "Trash 4 messages" });
  check("of two expiring, the one that expires sooner", first({ approvals: [soon, sooner] }).id, 5);
  check("then an overdue task, over an approval that is not expiring", first({ approvals: [fresh], tasks: [later, overdue] }), { id: 3, kind: "task", reason: "overdue", title: "Call the permit office" });
  check("of two overdue, the one overdue longest", first({ tasks: [overdue, older] }).id, 6);
  check("then the earliest thing due today", first({ approvals: [fresh], tasks: [later, earlier] }), { id: 7, kind: "task", reason: "due-today", title: "Lunch order" });
  check("then an approval that is only waiting", first({ approvals: [fresh], headsups: [bill] }), { id: 2, kind: "approval", reason: "waiting", title: "Create a note" });
  check("then the nearest open heads-up", first({ headsups: [offer(9, "Garrett's birthday", iso(at(0, 0, 9))), bill] }), { id: 8, kind: "headsup", reason: "waiting", title: "Power bill" });
  check("something put off is not what to do first", first({ approvals: [soon], later: { "approval:1": iso(at(6, 0, 1)) }, tasks: [later] }).id, 4);
}

console.log("\nHEADS-UP — open offers only");
{
  const today = make({ headsups: [offer(1, "Power bill", iso(at(0, 0, 2))), offer(2, "Garrett's birthday", iso(at(0, 0, 9)), "researched"), offer(3, "Dentist", iso(at(0, 0, 1)), "snoozed")] });
  check("an answered or snoozed one is not waiting on you", today.headsups.map((h) => h.id), [1]);
}

console.log("\nSINCE YOU LAST LOOKED");
{
  const hoursAgo = (h) => iso(new Date(NOW.getTime() - h * 3_600_000));
  check("never looked: the last 24 hours", t.sinceStart(null, NOW).getTime(), NOW.getTime() - 24 * 3_600_000);
  check("looked two hours ago: from then", t.sinceStart(hoursAgo(2), NOW).getTime(), NOW.getTime() - 2 * 3_600_000);
  check("looked a month ago: no further back than seven days", t.sinceStart(hoursAgo(24 * 30), NOW).getTime(), NOW.getTime() - 7 * 86_400_000);
  check("a stamp in the future is treated as now", t.sinceStart(iso(at(12, 0, 1)), NOW).getTime(), NOW.getTime());
  check("a stamp that does not parse is treated as never", t.sinceStart("yesterday", NOW).getTime(), NOW.getTime() - 24 * 3_600_000);

  const today = make({
    looked: hoursAgo(12),
    runs: [
      { finished: hoursAgo(3), id: 1, note: "Three things today.", schedule_id: 1, scheduleName: "Morning brief", status: "ok", task: "Summarise today" },
      { finished: hoursAgo(5), id: 2, note: "The mail read failed (HTTP 401).", schedule_id: 2, status: "failed", task: "Work through the inbox" },
      { finished: hoursAgo(6), id: 3, note: "Stalled: no model or tool activity for 10 minutes, so it was interrupted.", schedule_id: 2, status: "failed", task: "Work through the inbox" },
      { finished: hoursAgo(7), id: 4, note: "Stopped before it finished.", schedule_id: null, status: "stopped", task: "Check the heartbeat goals and act on the first one that needs it" },
      { finished: hoursAgo(13), id: 5, note: "before you looked", schedule_id: 1, status: "ok", task: "Summarise today" },
      { finished: hoursAgo(12), id: 6, note: "at the instant you looked", schedule_id: 1, status: "ok", task: "Summarise today" },
      { finished: null, id: 7, note: null, schedule_id: 1, status: "running", task: "still going" },
    ],
    schedules: [
      { id: 1, last_skip_at: null, last_skip_reason: null, last_skip_slot: null, name: "Morning brief" },
      { id: 2, last_skip_at: hoursAgo(1), last_skip_reason: "It was 3 hours late, past 2 hours.", last_skip_slot: hoursAgo(4), name: "Inbox cleanup" },
      { id: 3, last_skip_at: hoursAgo(40), last_skip_reason: "old", last_skip_slot: hoursAgo(44), name: "Weekly numbers" },
    ],
  });
  check("newest first: the skip, then the runs", today.since.map((s) => s.key.split(":").slice(0, 2).join(":")), ["skip:2", "run:1", "run:2", "run:3", "run:4"]);
  check("each is the right kind", today.since.map((s) => s.kind), ["skipped", "ok", "failed", "stalled", "stopped"]);
  check("named by the job, from the row or the schedule list", today.since.slice(0, 3).map((s) => s.title), ["Inbox cleanup", "Morning brief", "Inbox cleanup"]);
  check("a run with no job is named by its task, clipped", today.since[4].title.length <= 80, true);
  check("the skip carries its reason", today.since[0].detail, "It was 3 hours late, past 2 hours.");
  check("the brief counts what happened", today.brief.done, { failed: 1, ok: 1, skipped: 1, stalled: 1 });
  check("it says where it starts", today.sinceFrom, hoursAgo(12));

  const many = make({ runs: Array.from({ length: 40 }, (_, i) => ({ finished: hoursAgo(1 + i / 10), id: i + 1, note: "ok", schedule_id: 1, scheduleName: "Every 30 minutes", status: "ok", task: "x" })) });
  check("a busy job cannot fill the screen", many.since.length, t.TODAY_SINCE_MAX_ROWS);
}

console.log("\nTHE COUNT — places that need you: a thread once, a loose approval once");
{
  const today = make({
    approvals: [{ id: 1, summary: "x", tool: "draft", ts: iso(at(9, 0)) }, { id: 2, summary: "y", tool: "draft", ts: iso(at(9, 5)) }],
    headsups: [offer(1, "Power bill", iso(at(0, 0, 2)))],
    tasks: [{ due: iso(at(9, 0)), id: 1, title: "Call the permit office", waiting_on: null }],
    threads: [{ id: 7, title: null, updated: iso(at(8, 0)) }],
  });
  check("two approvals with no thread and one unread thread", today.count, 3);
  const same = { conversation_id: 7, id: 3, summary: "z", tool: "draft", ts: iso(at(9, 6)) };
  check("an approval inside the unread thread adds nothing", make({ approvals: [same], threads: [{ id: 7, title: "a", updated: iso(at(8, 0)) }] }).count, 1);
  check("two approvals in one thread are one place", make({ approvals: [same, { ...same, id: 4 }] }).count, 1);
  check("tasks and heads-ups are not counted", make({ headsups: [offer(1, "Power bill", iso(at(0, 0, 2)))], tasks: [{ due: iso(at(9, 0)), id: 1, title: "x", waiting_on: null }] }).count, 0);
  check("a thread with no title still has a name", today.threads[0].title, "Untitled");
  check("the brief's waiting line counts each kind", today.brief.waiting, { approvals: 2, headsups: 1, tasks: 1, threads: 1 });
  check("the mail slot is there and empty until U7", today.mail, []);
  const mail = [{ bucket: "urgent", key: "mail:1", sender: "Sam Rivera", subject: "Lease" }];
  check("mail rows pass through untouched when something supplies them", make({ mail }).mail, mail);
}

console.log("\nTHE STORED HALF — a throwaway database");
{
  const conversation = store.createConversation("Contractor quotes");
  const run = store.startRun({ conversationId: conversation, kind: "chat", task: "draft a reply" });
  const cid = store.queueConfirmation({ args: { body: "Hi Jordan" }, tool: "draft" }, "Draft an email to jordan@example.com\nHi Jordan", run);
  store.finishRun(run, "ok", "Drafted.");
  const taskId = tasks.addTask({ due: iso(new Date(Date.now() - 3_600_000)), title: "Call the permit office" });
  const job = store.createSchedule("Morning brief", "Summarise today.", "every day at 7:00am");
  const jobRun = store.startRun({ kind: "schedule", scheduleId: job, task: "Summarise today." });
  store.finishRun(jobRun, "ok", "Three things today.");
  const child = store.startRun({ kind: "subagent", parentRunId: jobRun, task: "look something up" });
  store.finishRun(child, "ok", "found it");

  const today = t.readToday();
  check("the pending approval, with its thread", [today.approvals.map((a) => a.id), today.approvals[0].conversationId], [[cid], conversation]);
  check("the overdue task", today.tasks.map((x) => [x.id, x.overdue]), [[taskId, true]]);
  check("the thread with an unread reply", today.threads.map((x) => x.id), [conversation]);
  check("the scheduled run, and not its helper or the chat turn", today.since.map((s) => [s.runId, s.title]), [[jobRun, "Morning brief"]]);
  check("the count for a push's badge agrees: one thread", [today.count, t.waitingNow()], [1, 1]);

  check("a key of the wrong shape is refused", [t.setLater("policy:1"), t.setLater("approval:1; drop"), t.setLater("")], [false, false, false]);
  check("putting the approval off is accepted", t.setLater(`approval:${cid}`), true);
  const after = t.readToday();
  check("it leaves the screen; the thread's unread reply still counts", [after.approvals.length, after.later, after.count, t.waitingNow()], [0, 1, 1, 1]);
  check("the confirmation itself is untouched", [store.getConfirmation(cid).state, store.getConfirmation(cid).ts === today.approvals[0].ts], ["pending", true]);
  t.setLater(`approval:${cid}`, new Date(), true);
  check("undo brings it back", t.readToday().approvals.length, 1);
  t.setLater(`task:${taskId}`);
  t.clearLater();
  check("clearing brings everything back", [t.readToday().tasks.length, t.readToday().later], [1, 0]);

  t.markLooked(new Date(Date.now() + 1000));
  check("after Seen, what ran before is gone from the list", t.readToday(new Date(Date.now() + 2000)).since, []);
}

console.log("\nMAIL — labelled mail still unread at the last inbox pass, from the database only");
{
  const b = await import("../src/checkin/buckets.ts");
  // The model is a stand-in that labels by subject, so each case says what it means.
  let calls = 0;
  const route = async (messages) => {
    calls++;
    const text = messages.map((m) => m.content).join("\n");
    if (text.includes("Contract due")) return { text: '{"bucket":"urgent","reason":"deadline"}' };
    if (text.includes("Dinner")) return { text: '{"bucket":"reply-today","reason":"asks-you-a-question"}' };
    if (text.includes("Photos")) return { text: '{"bucket":"fyi","reason":"personal"}' };
    return { text: "not a label" };
  };
  const mail = (id, from, subject) => ({ date: "", from, id, labelIds: ["INBOX", "UNREAD"], snippet: "", subject });
  const photos = mail("msg100001", "Robin Vale <robin@example.com>", "Photos from Saturday");
  const contract = mail("msg100002", "Sam Rivera <sam@example.com>", "Contract due Friday");
  const dinner = mail("msg100003", "Alex Moreno <alex@example.com>", "Dinner on Thursday?");
  const odd = mail("msg100004", "Jo Park <jo@example.com>", "Something else");
  let inbox = [photos, contract, dinner, odd];
  let mode = "on";
  let mailOn = true;
  const deps = { googleEnabled: () => true, mail: async () => inbox, mailOn: () => mailOn, mode: () => mode, route };
  const keys = () => b.todayMail("on", true).map((m) => m.key);

  check("the switch off: nothing, even with labels stored", (await b.sortInbox(new Date(), { ...deps, mode: () => "off" })).status, "off");
  check("... and Today has no mail", b.todayMail("off", true), []);
  check("Today itself, with INBOX_SORT_MODE unset, has no mail", t.readToday().mail, []);

  mode = "log";
  await b.sortInbox(new Date(), deps);
  check("log mode labels and records ...", b.listLabels(10).length, 4);
  check("... and Today shows none of it, even read as 'on'", keys(), []);
  check("asked in log mode, nothing", b.todayMail("log", true), []);

  mode = "on";
  await b.sortInbox(new Date(), deps);
  const shown = b.todayMail("on", true);
  check("on: urgent first, then reply today, then for your information", shown.map((m) => m.bucket), ["urgent", "reply-today", "fyi"]);
  check("each row is keyed as the Check-in screen keys it", keys(), ["mail:msg100002", "mail:msg100003", "mail:msg100001"]);
  check("sender and subject come from code's own clipping", [shown[0].sender, shown[0].subject], ["Sam Rivera", "Contract due Friday"]);
  check("an unsorted mail is left to the Check-in screen", keys().includes("mail:msg100004"), false);
  check("the mail source switched off: nothing", b.todayMail("on", false), []);

  inbox = [contract, dinner, odd];
  await b.sortInbox(new Date(), deps);
  check("a mail read in Gmail drops off at the next pass", keys(), ["mail:msg100002", "mail:msg100003"]);

  await b.sortInbox(new Date(), { ...deps, mail: async () => Promise.reject(new Error("HTTP 503")) });
  check("Gmail down: Today keeps what the last pass saw", keys(), ["mail:msg100002", "mail:msg100003"]);

  mailOn = false;
  await b.sortInbox(new Date(), deps);
  mailOn = true;
  check("mail switched off at a pass: nothing is unread as far as Today knows", keys(), []);

  inbox = [photos, contract, dinner, odd];
  const before = calls;
  await b.sortInbox(new Date(), deps);
  check("back on: the labels made before show again, with no new model call", [keys(), calls - before], [["mail:msg100002", "mail:msg100003", "mail:msg100001"], 0]);
  check("the cap is code's", b.TODAY_MAIL_MAX, 10);
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(tmp, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
