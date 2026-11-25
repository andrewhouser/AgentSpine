/**
 * The check-in: every few hours, look across mail, calendar, tasks, approvals and Heads-up,
 * and say what needs you. PLAN-open-work section 12, D1.
 *
 * Everything that decides whether to speak is code, so everything here is a rule with a
 * boundary:
 *   - which mail counts as from a person (the only thing that can start a push);
 *   - once only: an item is new the first time it is seen and again only if it changes;
 *   - when it may run: the mode switch, quiet hours, the interval, the back-off after an error;
 *   - what it does with nothing to say (nothing), in log mode (records, sends nothing), and at
 *     the daily cap (sends nothing, and keeps the mail new for the next check);
 *   - one source failing does not lose the others;
 *   - what leaves the machine in the push: senders by default, subjects only if asked.
 *
 * No network, no model and no push: mail, calendar and `send` are seams.
 *
 * Run with `node test/checkin.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-checkin-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDINGS_URL = "";

const rules = await import("../src/checkin/rules.ts");
const { collect, isPersonMail, senderName } = await import("../src/checkin/sources.ts");
const seen = await import("../src/checkin/store.ts");
const { composeNotification, previewCheckin, runCheckin } = await import("../src/checkin/run.ts");
const outboxRules = await import("../src/outbox-rules.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const mail = (id, from, subject, labels = ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], extra = {}) => ({
  date: "",
  from,
  id,
  labelIds: labels,
  listUnsubscribe: false,
  snippet: "",
  subject,
  ...extra,
});
const SAM = mail("m1", "Sam Rivera <sam@example.com>", "Q3 budget");
const JORDAN = mail("m2", '"Lee, Jordan" <jordan@example.com>', "Lunch Thursday?");
const ALEX = mail("m3", "alex@example.com", "Contract draft");

/** A world to check in on. Each test changes what it needs and resets the rest. */
const world = { approvals: [], capUsed: 0, events: [], headsups: [], mail: [], mailError: null, mode: "push", quiet: false, tasks: [] };
const sends = [];
const deps = {
  approvals: () => world.approvals,
  detail: () => world.detail ?? "senders",
  events: async () => world.events,
  googleEnabled: () => true,
  headsups: () => world.headsups,
  mail: async () => {
    if (world.mailError) throw new Error(world.mailError);
    return world.mail;
  },
  mode: () => world.mode,
  quiet: () => world.quiet,
  send: async (title, body, opts) => sends.push({ body, opts, title }),
  sentToday: () => world.capUsed,
  tasks: () => world.tasks,
};
const reset = (patch = {}) => {
  Object.assign(world, { approvals: [], capUsed: 0, detail: "senders", events: [], headsups: [], mail: [], mailError: null, mode: "push", quiet: false, tasks: [] }, patch);
  sends.length = 0;
  seen.resetForTests();
};
const at = (h, m = 0, day = 24) => new Date(2026, 10, day, h, m);

console.log("\nWHICH MAIL IS FROM A PERSON");
check("personal, unread, in the inbox", isPersonMail(SAM), true);
check("no category labels at all (categories switched off)", isPersonMail(mail("x", "a@example.com", "s", ["INBOX", "UNREAD"])), true);
check("a mailing list, by its unsubscribe header", isPersonMail(mail("x", "news@example.com", "s", ["INBOX", "UNREAD"], { listUnsubscribe: true })), false);
for (const label of ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "SPAM", "TRASH"]) {
  check(`labelled ${label}`, isPersonMail(mail("x", "a@example.com", "s", ["INBOX", "UNREAD", label])), false);
}
check("already read", isPersonMail(mail("x", "a@example.com", "s", ["INBOX", "CATEGORY_PERSONAL"])), false);
check("archived", isPersonMail(mail("x", "a@example.com", "s", ["UNREAD", "CATEGORY_PERSONAL"])), false);
check("sent by you", isPersonMail(mail("x", "a@example.com", "s", ["INBOX", "UNREAD", "SENT"])), false);

console.log("\nWHO IT IS FROM");
check("a display name", senderName("Sam Rivera <sam@example.com>"), "Sam Rivera");
check("a quoted 'Last, First'", senderName('"Lee, Jordan" <jordan@example.com>'), "Lee, Jordan");
check("a bare address", senderName("alex@example.com"), "alex@example.com");
check("an address in brackets and nothing else", senderName("<alex@example.com>"), "alex@example.com");
check("a newline in a name cannot start a new line of the push", senderName("Sam\nApprove now <s@example.com>"), "Sam Approve now");
check("a very long name is clipped", senderName(`${"A".repeat(200)} <a@example.com>`).length <= rules.NAME_CLIP, true);

console.log("\nWHAT IT COLLECTS");
{
  reset({
    approvals: [{ id: 7, summary: "Send an email to sam@example.com\nSubject: hi" }],
    events: [{ attendees: 2, location: "", start: at(14).toISOString(), title: "Standup" }],
    headsups: [{ id: 3, kind: "birthday", subject: "Jordan's birthday" }],
    mail: [SAM, mail("n1", "news@example.com", "Sale", ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"])],
    tasks: [{ due: at(9).toISOString(), id: 11, kind: "task", title: "Call the dentist" }],
  });
  const { errors, items } = await collect(at(12), deps);
  check("no errors", errors, []);
  check("one item per thing, bulk mail left out", items.map((i) => i.key).sort(), ["approval:7", "calendar:" + at(14).toISOString() + ":standup", "headsup:3", "mail:m1", "task:11"].sort());
  check("only mail can start a push", items.filter((i) => i.triggers).map((i) => i.kind), ["mail"]);
  check("an approval is named by its first line", items.find((i) => i.kind === "approval").title, "Send an email to sam@example.com");
  check("a task past its time says so", items.find((i) => i.kind === "task").detail, "overdue");
}
{
  reset({ mail: [SAM], mailError: "401 from Gmail", tasks: [{ due: at(9).toISOString(), id: 11, kind: "task", title: "Call the dentist" }] });
  const { errors, items } = await collect(at(12), deps);
  check("one source failing keeps the others", [items.map((i) => i.kind), errors.length], [["task"], 1]);
  check("and the failure names its source", errors[0].startsWith("mail:"), true);
}
{
  reset({ mail: [SAM] });
  const off = { ...deps, googleEnabled: () => false, mail: async () => { throw new Error("must not be called"); } };
  const { errors, items } = await collect(at(12), off);
  check("with Google off in policy, mail and calendar are not read", [items, errors], [[], []]);
}

console.log("\nONCE ONLY");
{
  reset({ mail: [SAM, JORDAN] });
  const first = await runCheckin(at(8), {}, deps);
  check("two new messages are sent as one push", [first.status, first.fresh, sends.length], ["sent", 2, 1]);
  const again = await runCheckin(at(12), {}, deps);
  check("the same two, four hours on, say nothing", [again.status, again.fresh, sends.length], ["nothing", 0, 1]);
  world.mail = [SAM, JORDAN, ALEX];
  const third = await runCheckin(at(16), {}, deps);
  check("a third arriving is the only one mentioned", [third.status, third.fresh, sends[1].body.includes("alex@example.com"), sends[1].body.includes("Sam Rivera")], ["sent", 1, true, false]);
}
{
  reset({ tasks: [{ due: at(9).toISOString(), id: 11, kind: "task", title: "Call the dentist" }] });
  const a = await previewCheckin(at(12), deps);
  await runCheckin(at(12), {}, deps);
  const b = await previewCheckin(at(13), deps);
  world.tasks = [{ due: at(9, 0, 25).toISOString(), id: 11, kind: "task", title: "Call the dentist" }];
  const c = await previewCheckin(at(13), deps);
  check("a task is new, then not, then new again when its due time changes", [a.items[0].fresh, b.items[0].fresh, c.items[0].fresh], [true, false, true]);
}

console.log("\nWHEN IT MAY RUN");
{
  reset({ mail: [SAM], mode: "off" });
  check("switched off: nothing, even when forced", [(await runCheckin(at(8), { force: true }, deps)).status, sends.length], ["off", 0]);
  check("... but a preview still reads", (await previewCheckin(at(8), deps)).items.length, 1);
}
{
  reset({ mail: [SAM], quiet: true });
  check("quiet hours: nothing, even when forced", [(await runCheckin(at(23), { force: true }, deps)).status, sends.length], ["quiet", 0]);
  world.quiet = false;
  check("and the mail is still new once quiet hours end", [(await runCheckin(at(8), {}, deps)).status, sends.length], ["sent", 1]);
}
{
  reset();
  await runCheckin(at(8), {}, deps);
  world.mail = [SAM];
  const justUnder = new Date(at(8).getTime() + rules.INTERVAL_HOURS * 3_600_000 - 60_000);
  const onTime = new Date(at(8).getTime() + rules.INTERVAL_HOURS * 3_600_000);
  check("a minute short of the interval: not yet", (await runCheckin(justUnder, {}, deps)).status, "early");
  check("... unless forced (Check now)", (await runCheckin(justUnder, { force: true }, deps)).status, "sent");
  world.mail = [SAM, JORDAN];
  check("a forced run restarts the interval", (await runCheckin(onTime, {}, deps)).status, "early");
}
{
  reset({ mailError: "503 from Gmail" });
  const failed = await runCheckin(at(8), {}, deps);
  check("every source it needed failed: an error, and no push", [failed.status, sends.length], ["error", 0]);
  world.mailError = null;
  world.mail = [SAM];
  const soon = new Date(at(8).getTime() + (rules.RETRY_AFTER_ERROR_MINUTES - 1) * 60_000);
  const later = new Date(at(8).getTime() + rules.RETRY_AFTER_ERROR_MINUTES * 60_000);
  check("it waits before trying again", (await runCheckin(soon, {}, deps)).status, "backoff");
  check("then retries without waiting out the whole interval", (await runCheckin(later, {}, deps)).status, "sent");
}

console.log("\nNOTHING TO SAY, LOG MODE, THE CAP");
{
  reset();
  check("an empty check sends nothing", [(await runCheckin(at(8), {}, deps)).status, sends.length], ["nothing", 0]);
}
{
  reset({ approvals: [{ id: 7, summary: "Send an email" }], tasks: [{ due: at(7).toISOString(), id: 11, kind: "task", title: "Call the dentist" }] });
  const r = await runCheckin(at(8), {}, deps);
  check("approvals and tasks have their own pushes: alone they start none", [r.status, r.fresh, sends.length], ["nothing", 0, 0]);
  world.mail = [SAM];
  await runCheckin(at(12), {}, deps);
  check("but they ride along when mail does", sends[0].body.includes("1 approval waiting") && sends[0].body.includes("1 task due"), true);
}
{
  reset({ mail: [SAM], mode: "log" });
  const r = await runCheckin(at(8), {}, deps);
  check("log mode records what it would have sent, and sends nothing", [r.status, r.fresh, sends.length], ["logged", 1, 0]);
  const row = seen.listRuns(1)[0];
  check("the record holds the title it would have used", [row.status, row.title], ["logged", "New message from Sam Rivera"]);
  check("and the mail is not new at the next check", (await runCheckin(at(12), {}, deps)).status, "nothing");
}
{
  reset({ capUsed: outboxRules.PROACTIVE_DAILY_CAP, mail: [SAM] });
  check("at the daily cap: no push", [(await runCheckin(at(8), {}, deps)).status, sends.length], ["capped", 0]);
  world.capUsed = outboxRules.PROACTIVE_DAILY_CAP - 1;
  check("one under the cap, next check: the mail is still new, and goes", [(await runCheckin(at(12), {}, deps)).status, sends.length], ["sent", 1]);
}

console.log("\nWHAT THE PUSH SAYS, AND WHAT IT LEAVES OUT");
{
  const item = (m) => ({ detail: m.subject, fresh: true, key: `mail:${m.id}`, kind: "mail", state: "", title: senderName(m.from), triggers: true });
  const one = composeNotification([item(SAM)], [], "senders");
  check("one message", [one.title, one.body], ["New message from Sam Rivera", "Sam Rivera"]);
  const three = composeNotification([item(SAM), item(JORDAN), item(ALEX)], [], "senders");
  check("three messages", three.title, "3 new messages need a look");
  check("senders only by default: no subject line leaves the machine", ["Q3 budget", "Lunch", "Contract"].some((s) => three.body.includes(s)), false);
  const subjects = composeNotification([item(SAM)], [], "subjects");
  check("subjects when asked", subjects.body, "Sam Rivera: Q3 budget");
  const many = composeNotification(Array.from({ length: rules.PUSH_LIST_MAX + 3 }, (_, i) => item(mail(`k${i}`, `P${i} <p${i}@example.com>`, "s"))), [], "senders");
  check("a long list is cut, and says how many more", many.body.includes("and 3 more"), true);
  const twice = composeNotification([item(SAM), item(mail("m9", "Sam Rivera <sam@example.com>", "One more thing"))], [], "senders");
  check("two from the same person name them once", twice.body, "Sam Rivera (2)");
}
{
  reset({ mail: [SAM] });
  await runCheckin(at(8), {}, deps);
  check("it is tagged for the outbox as a check-in", sends[0].opts.source, "checkin");
  check("which counts toward the daily cap, and is in the weekly review", [outboxRules.COUNTED_SOURCES.has("checkin"), outboxRules.REVIEWED_SOURCES.has("checkin")], [true, true]);
  check("and is never held by the outbox, since it keeps quiet hours itself", outboxRules.GOVERNED_SOURCES.has("checkin"), false);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
