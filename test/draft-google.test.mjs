/**
 * CP2 (PLAN-open-work section 10; SPEC section 5, third amendment): an approved draft goes into Gmail Drafts, or
 * onto a named calendar as a timed event with no attendees, unless it could have come from work material, in which
 * case it stays a local file. Google's API is stubbed: nothing here reaches the network.
 *
 * Run with `node test/draft-google.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-draft-google-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "secret";
process.env.GOOGLE_WRITE_TOKEN_PATH = path.join(root, "write.json");
fs.writeFileSync(process.env.GOOGLE_WRITE_TOKEN_PATH, JSON.stringify({ refresh_token: "w" }));
process.env.GOOGLE_TOKEN_PATH = path.join(root, "read.json");
fs.writeFileSync(process.env.GOOGLE_TOKEN_PATH, JSON.stringify({ refresh_token: "r" }));

const policyOf = (over = {}) => ({
  autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true },
  drafts: { calendar: "Home", dir: path.join(root, "drafts"), enabled: true, gmail: true },
  google: { enabled: true, write: { calendars: ["Bills", "Home"], enabled: true } },
  version: 1,
  ...over,
});
process.env.POLICY_PATH = path.join(root, "policy.json");
const setPolicy = (p) => fs.writeFileSync(process.env.POLICY_PATH, JSON.stringify(p));
setPolicy(policyOf());

// Google, stubbed. Every call is recorded; nothing leaves the process.
const calls = [];
let failDrafts = false;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null;
  calls.push({ body, method: init.method ?? "GET", url: u });
  if (u.includes("oauth2.googleapis.com")) return Response.json({ access_token: "at" });
  if (u.includes("/messages/abc123def456?format=metadata"))
    return Response.json({ payload: { headers: [{ name: "Message-ID", value: "<orig@mail.example>" }, { name: "References", value: "<older@mail.example>" }] }, threadId: "thread9" });
  if (u.endsWith("/drafts")) return failDrafts ? new Response("no", { status: 403 }) : Response.json({ id: "draft1" });
  if (u.includes("calendarList")) return Response.json({ items: [{ id: "home-cal", summary: "Home" }, { id: "bills-cal", summary: "Bills" }] });
  if (u.includes("/events?sendUpdates=none")) return Response.json({ id: "event1" });
  return new Response("unexpected", { status: 500 });
};

const store = await import("../src/memory/store.ts");
const projects = await import("../src/projects/store.ts");
const { executeCall } = await import("../src/broker.ts");
const { draft, durationMinutes, workReason } = await import("../src/tools/draft.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const lastDraft = () => calls.filter((c) => c.url.endsWith("/drafts")).at(-1);
const rawOf = (c) => Buffer.from(c.body.message.raw, "base64url").toString("utf8");
const chatRun = () => store.startRun({ conversationId: store.createConversation("t"), kind: "chat", task: "x" });
const reply = { body: "Thanks, Tuesday works.", kind: "email_reply", replyTo: "abc123def456", subject: "Re: plans", to: "sam@example.com" };

console.log("\nA GMAIL DRAFT");
{
  const out = await draft.run(reply, { policy: policyOf(), runId: chatRun() });
  check("it is saved in Gmail Drafts", /Draft saved in Gmail Drafts, in the conversation it answers/.test(out), true);
  const raw = rawOf(lastDraft());
  check("addressed and titled as drafted", [raw.includes("To: sam@example.com"), raw.includes("Subject: Re: plans"), raw.endsWith("Thanks, Tuesday works.")], [true, true, true]);
  check("threaded onto the message it answers", [lastDraft().body.message.threadId, raw.includes("In-Reply-To: <orig@mail.example>"), raw.includes("References: <older@mail.example> <orig@mail.example>")], ["thread9", true, true]);
  check("nothing was sent: no call anywhere ends in /send", calls.some((c) => /\/send\b/.test(c.url)), false);
  await draft.run({ ...reply, replyTo: undefined, subject: "Hi\r\nBcc: mallory@example.net" }, { policy: policyOf(), runId: chatRun() });
  check("a line break in the subject cannot add a header", /\r\nBcc:/.test(rawOf(lastDraft())), false);
  await draft.run({ ...reply, replyTo: undefined, subject: "Café plans" }, { policy: policyOf(), runId: chatRun() });
  check("a non-ASCII subject is encoded", rawOf(lastDraft()).includes("Subject: =?UTF-8?B?"), true);
}

console.log("\nWORK TEXT STAYS A FILE");
{
  const before = calls.filter((c) => c.url.endsWith("/drafts")).length;
  const pid = projects.createProject("Client work", "");
  const inProject = store.startRun({ conversationId: store.createConversation("p", pid), kind: "chat", task: "x" });
  const out1 = await draft.run(reply, { policy: policyOf(), runId: inProject });
  check("a draft written in a project", /Draft saved to .*kept as a file because it was written in a project/.test(out1), true);
  const recalled = chatRun();
  store.markRunWorkPrivate(recalled);
  check("a run that started with private recall", /private context/.test(await workReason(recalled)), true);
  const meeting = chatRun();
  store.logAction(meeting, { args: {}, tool: "meeting_list" }, null, "executed", "transcript");
  check("a run that read a meeting", await workReason(meeting), "it was written after meeting_list read private material");
  // An earlier turn of the same conversation counts: its words are in this turn's history.
  const conv = store.createConversation("two turns");
  const turn1 = store.startRun({ conversationId: conv, kind: "chat", task: "read the notes" });
  store.logAction(turn1, { args: {}, tool: "read_file" }, null, "executed", "notes");
  const turn2 = store.startRun({ conversationId: conv, kind: "chat", task: "draft it" });
  check("an earlier turn in the same conversation that read a file", await workReason(turn2), "it was written after read_file read private material");
  const child = store.startRun({ kind: "subagent", parentRunId: meeting, task: "help" });
  check("a subagent of a run that read a meeting", (await workReason(child)) !== null, true);
  const mail = chatRun();
  store.logAction(mail, { args: {}, tool: "gmail_search" }, null, "executed", "mail");
  store.logAction(mail, { args: {}, tool: "calendar_upcoming" }, null, "executed", "events");
  check("reading Gmail and the calendar does not count", await workReason(mail), null);
  check("an unknown run counts as work, to be safe", await workReason(null), "the run it came from is not known");
  check("none of those reached Gmail", calls.filter((c) => c.url.endsWith("/drafts")).length - before, 0);
}

console.log("\nON APPROVAL, THE RUN THAT QUEUED IT IS WHAT COUNTS");
{
  const pid = projects.createProject("Another client", "");
  const queuedIn = store.startRun({ conversationId: store.createConversation("p2", pid), kind: "chat", task: "x" });
  const out = await draft.run(reply, { policy: policyOf(), queuedByRunId: queuedIn });
  check("a card queued in a project stays a file when approved", /kept as a file because it was written in a project/.test(out), true);
  const ok = await draft.run(reply, { policy: policyOf(), queuedByRunId: chatRun() });
  check("one queued in an ordinary chat goes to Gmail", /Gmail Drafts/.test(ok), true);
}

console.log("\nA TIMED EVENT");
{
  const ev = { body: "Bring the forms.", duration: "45 minutes", kind: "event", location: "Clinic", start: "2026-12-02T15:00", subject: "Dentist" };
  const out = await draft.run(ev, { policy: policyOf(), runId: chatRun() });
  check("it is put on the named calendar", /Event "Dentist" put on Home at 2026-12-02T15:00, 45 minutes/.test(out), true);
  const made = calls.filter((c) => c.url.includes("/events?sendUpdates=none")).at(-1);
  check("on that calendar, with no notifications", made.url.includes("/home-cal/events?sendUpdates=none"), true);
  check("start and end in the same zone, 45 minutes apart", [made.body.start.dateTime, made.body.end.dateTime, made.body.start.timeZone === made.body.end.timeZone], ["2026-12-02T15:00:00", "2026-12-02T15:45:00", true]);
  check("and no one is invited", "attendees" in made.body, false);
  check("a vague start stays a file, saying why", /kept as a file because the start "Tuesday 2pm" is not an exact time/.test(await draft.run({ ...ev, start: "Tuesday 2pm" }, { policy: policyOf(), runId: chatRun() })), true);
  check("a calendar not on the list stays a file", /not in policy\.google\.write\.calendars/.test(await draft.run(ev, { policy: policyOf({ drafts: { calendar: "Work", enabled: true, dir: path.join(root, "drafts") } }), runId: chatRun() })), true);
  const gone = policyOf({ drafts: { calendar: "Bills", dir: path.join(root, "drafts"), enabled: true }, google: { enabled: true, write: { calendars: ["Bills"], enabled: true } } });
  check("a calendar that exists is used, by name", /put on Bills/.test(await draft.run(ev, { policy: gone, runId: chatRun() })), true);
  check("durations are read the ways people write them", [durationMinutes("1h"), durationMinutes("1h30m"), durationMinutes("90"), durationMinutes(""), durationMinutes("a while")], [60, 90, 90, 60, null]);
}

console.log("\nWITH THE SWITCHES OFF, OR GOOGLE REFUSING, IT IS A FILE");
{
  const before = calls.length;
  const off = await draft.run(reply, { policy: policyOf({ drafts: { dir: path.join(root, "drafts"), enabled: true } }), runId: chatRun() });
  check("no gmail switch: a file, and no Google call", [/Draft saved to /.test(off), calls.length - before], [true, 0]);
  const noWrite = await draft.run(reply, { policy: policyOf({ google: { enabled: true } }), runId: chatRun() });
  check("no write token policy: a file", /Draft saved to /.test(noWrite), true);
  failDrafts = true;
  const refused = await draft.run(reply, { policy: policyOf(), runId: chatRun() });
  check("Google refusing: a file, with the reason", /Draft saved to .*kept as a file because Google refused it/.test(refused), true);
  failDrafts = false;
  check("a note never goes to Google", /Draft saved to /.test(await draft.run({ body: "x", kind: "text", subject: "n" }, { policy: policyOf(), runId: chatRun() })), true);
}

console.log("\nCHAT TRUST AND SCHEDULES");
{
  const dry = (p) => ({ ...p, autoExecute: { ...p.autoExecute, dryRun: true } });
  const would = async (p, run) => {
    const runId = store.startRun({ kind: run.preApproved ? "schedule" : "chat", task: "probe" });
    const r = await executeCall({ args: reply, tool: "draft" }, dry(p), runId, runId, run);
    return /would have been (EXECUTED|QUEUED)/.exec(r.output)?.[1] ?? r.output.slice(0, 60);
  };
  const chat = { conversational: true, goal: "reply to Sam" };
  const job = { approvedTask: "nightly", conversational: false, goal: "nightly", preApproved: true };
  check("a chat draft shows its card by default", await would(policyOf(), chat), "QUEUED");
  check("with draft in chat trust it goes straight through", await would(policyOf({ trust: { chatAutoTools: ["draft"] } }), chat), "EXECUTED");
  setPolicy(policyOf());
  check("a scheduled run's email draft asks, with Gmail on", await would(policyOf(), job), "QUEUED");
  setPolicy(policyOf({ drafts: { dir: path.join(root, "drafts"), enabled: true } }));
  check("with Gmail off it saves its file unasked, as before", await would(policyOf(), job), "EXECUTED");
  setPolicy(policyOf());
  const runId = store.startRun({ kind: "schedule", task: "probe" });
  const note = await executeCall({ args: { body: "x", kind: "text" }, tool: "draft" }, dry(policyOf()), runId, runId, job);
  check("a scheduled note still saves unasked", /would have been EXECUTED/.test(note.output), true);
}

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
