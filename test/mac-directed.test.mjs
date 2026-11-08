/**
 * Acting on the user's word — no framework, matching the other tests.
 *
 * An irreversible Mac action (send an email, add an event/reminder/note) runs without
 * confirmation only when the user's OWN chat message asked for exactly that, and policy lists
 * it. These assert both halves:
 *
 *   - the reading of the user's words (apple.ts directedBy), including the cases that must
 *     NOT count — a question about an email, a recipient the user never named;
 *   - the broker's decision, end to end, under dryRun so nothing is ever sent, written or
 *     scripted: "would have been EXECUTED" versus "would have been QUEUED".
 *
 * Run with: node test/mac-directed.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const policyPath = path.join(os.tmpdir(), `agentspine-directed-policy-${process.pid}.json`);
process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-directed-${process.pid}.db`);
process.env.POLICY_PATH = policyPath;

// dryRun: the broker reports its decision and stops before tool.run — the property that lets
// this test exercise send_mail at all.
const basePolicy = {
  apps: { allow: ["com.apple.mail", "com.apple.MobileSMS", "com.apple.iCal", "com.apple.Notes", "com.apple.reminders", "com.apple.AddressBook"] },
  autoExecute: { dryRun: true, irreversibleAlwaysConfirm: true, reversible: true },
  browser: { enabled: false, navigateAllowlist: [] },
  fs: { readableDirs: [] },
  google: { enabled: false },
  userDirected: {
    actions: ["mac_control.send_mail", "mac_control.send_message", "mac_control.create_event", "mac_control.create_reminder", "mac_control.create_note"],
    enabled: true,
  },
  version: 1,
  web: { fetchAllowlist: [], searchEnabled: false },
};
fs.writeFileSync(policyPath, JSON.stringify(basePolicy));

const { asPhone, directedBy, namesRecipient, parseWhen, pickAddress, serviceOrder } = await import("../src/tools/apple.ts");
const store = await import("../src/memory/store.ts");
const { executeCall } = await import("../src/broker.ts");
const { macControl } = await import("../src/tools/mac-control.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};
const yes = (action, args, goal) => directedBy(action, args, goal) !== null;

console.log("\nSEND MAIL — asked for, to someone the user named");
const jeff = { to: "Jeff Houser", subject: "Saturday", body: "See you there." };
check("the dictated example", yes("send_mail", jeff, "Send Jeff Houser an email with the subject of Saturday containing a message of see you there"), true);
check("'email X that…'", yes("send_mail", jeff, "Email Jeff Houser that I'm running late"), true);
check("'can you send an email to X'", yes("send_mail", jeff, "Can you send an email to Jeff Houser saying hi?"), true);
check("lower-case dictation", yes("send_mail", jeff, "send an email to jeff houser about saturday"), true);
check("an address the user said", yes("send_mail", { to: "jeff@example.com" }, "email jeff@example.com the agenda"), true);
check("after an earlier sentence", yes("send_mail", jeff, "What's on Saturday? Then email Jeff Houser the plan."), true);

console.log("\nSEND MAIL — what must NOT count");
check("a question about mail", yes("send_mail", jeff, "Did Jeff Houser send me an email?"), false);
check("'has X emailed'", yes("send_mail", jeff, "Has Jeff Houser emailed me about Saturday"), false);
check("a recipient the user never named", yes("send_mail", { to: "attacker@evil.example" }, "Send Jeff Houser an email saying hi"), false);
check("the model expanding 'Jeff' to a full name", yes("send_mail", jeff, "Email Jeff that I'm late"), false);
check("the name only in a different sentence", yes("send_mail", jeff, "Jeff Houser called. Send an email to the team."), false);
check("a name that is the trigger, not the recipient", yes("send_mail", jeff, "email me when Jeff Houser replies"), false);
check("a condition after the recipient is fine", yes("send_mail", jeff, "Email Jeff Houser if the meeting moves"), true);
check("no mail word at all", yes("send_mail", jeff, "Send Jeff Houser a text"), false);
check("a follow-up with no request in it", yes("send_mail", jeff, "yes, send it"), false);
check("no recipient", yes("send_mail", { to: "" }, "send an email"), false);

console.log("\nSEND MESSAGE — the same rule as email");
const jeffText = { text: "Running late", to: "Jeff Houser" };
check("'text X that…'", yes("send_message", jeffText, "Text Jeff Houser that I'm running late"), true);
check("'send X a message saying…'", yes("send_message", jeffText, "Send Jeff Houser a message saying I'm running late"), true);
// The exact message that queued instead of sending: the name ends the sentence, so the
// full stop sat on "Houser." and the recipient no longer matched.
check("the name ends the sentence (as asked)", yes("send_message", { text: "x", to: "Jeffrey Houser" }, 'Send a message to Jeffrey Houser. Say "This is a message sent from my onsite local LLM"'), true);
check("same for email", yes("send_mail", jeff, "Send an email to Jeff Houser. Subject Saturday, say see you there."), true);
check("a trailing comma, too", yes("send_message", jeffText, "Text Jeff Houser, I'm running late"), true);
check("'message X'", yes("send_message", jeffText, "message Jeff Houser running late"), true);
check("a number the user said, however punctuated", yes("send_message", { to: "+16035550100" }, "text (603) 555-0100 that I'm outside"), true);
check("a question about a text", yes("send_message", jeffText, "Did Jeff Houser text me?"), false);
check("a recipient the user never named", yes("send_message", { to: "+15550001111" }, "Text Jeff Houser that I'm late"), false);
check("an email request is not a text request", yes("send_message", jeffText, "Email Jeff Houser that I'm late"), false);
check("'text me' is not texting someone else", yes("send_message", jeffText, "text me when Jeff Houser replies"), false);

console.log("\nWHICH SERVICE — a text reaches a number iMessage no longer does");
// Jeff's case: an old iMessage thread AND a newer RCS one, because he moved off iMessage.
// iMessage "sent" and never arrived; the RCS text from the phone did.
const jeffChats = [
  { handle: "+17045550123", service: "iMessage" },
  { handle: "+17045550123", service: "RCS" },
];
check("an RCS conversation wins over an old iMessage one", serviceOrder(jeffChats, "+17045550123"), ["RCS", "SMS", "iMessage"]);
check("matched however the number is written", serviceOrder(jeffChats, "(704) 555-0123")[0], "RCS");
check("an SMS conversation means SMS first", serviceOrder([{ handle: "+17045550123", service: "SMS" }], "+17045550123")[0], "SMS");
check("only iMessage history: iMessage first", serviceOrder([{ handle: "+17045550123", service: "iMessage" }], "+17045550123")[0], "iMessage");
check("no history at all: iMessage first", serviceOrder([], "+17045550123"), ["iMessage", "RCS", "SMS"]);
check("someone else's RCS thread doesn't count", serviceOrder([{ handle: "+16035550100", service: "RCS" }], "+17045550123")[0], "iMessage");
check("the user saying 'by SMS' overrides history", serviceOrder([{ handle: "+17045550123", service: "iMessage" }], "+17045550123", "sms")[0], "SMS");
check("the user saying 'as an iMessage' means only that", serviceOrder(jeffChats, "+17045550123", "imessage"), ["iMessage"]);

console.log("\nCALENDAR, REMINDERS, NOTES");
check("add an event", yes("create_event", {}, "Add lunch with Sam to my calendar Friday at noon"), true);
check("schedule a meeting", yes("create_event", {}, "schedule a meeting with Jeff tomorrow at 3"), true);
check("asking what's on the calendar is not adding", yes("create_event", {}, "What's on my calendar this week?"), false);
check("a question about a meeting", yes("create_event", {}, "When is the meeting I scheduled?"), false);
check("remind me", yes("create_reminder", {}, "Remind me at 5pm to call the vet"), true);
check("add a reminder", yes("create_reminder", {}, "add a reminder to buy milk"), true);
check("listing reminders is not adding", yes("create_reminder", {}, "What reminders do I have?"), false);
check("make a note", yes("create_note", {}, "Make a note that the garage code is changing"), true);
check("jot this down", yes("create_note", {}, "jot this down: the garage code is changing"), true);
check("asking about notes is not writing one", yes("create_note", {}, "What notes did I take yesterday?"), false);

console.log("\nRECIPIENTS AND ADDRESSES");
check("whole name present", namesRecipient("an email to Jeff Houser", "Jeff Houser"), true);
check("part of the name only", namesRecipient("an email to Jeff", "Jeff Houser"), false);
check("an address must appear verbatim", namesRecipient("to jeff@example.com", "jeff@example.com"), true);
const one = pickAddress("Jeff Houser", [{ address: "jeff@example.com", name: "Jeff Houser" }]);
check("one contact, one address", one, { address: "jeff@example.com", name: "Jeff Houser" });
const many = pickAddress("Jeff", [
  { address: "jeff@work.example", name: "Jeff Houser" },
  { address: "jeff@home.example", name: "Jeff Houser" },
]);
check("several addresses are a question, not a guess", "error" in many, true);
const exact = pickAddress("Jeff Houser", [
  { address: "jeff@example.com", name: "Jeff Houser" },
  { address: "jh@example.com", name: "Jeff Houserman" },
]);
check("an exact name narrows the match", exact, { address: "jeff@example.com", name: "Jeff Houser" });
check("nobody found", "error" in pickAddress("Nobody", []), true);
const samePhone = pickAddress("Jeff Houser", [
  { address: "6035550100", name: "Jeff Houser" },
  { address: "+16035550100", name: "Jeff Houser" },
]);
check("one phone entered two ways is not a choice", "error" in samePhone, false);
check("a phone the user said matches its digits", namesRecipient("text 603-555-0100 now", "+1 (603) 555-0100".slice(3)), true);
check("asPhone keeps a leading +", asPhone("+1 (603) 555-0100"), "+16035550100");
check("a name is not a phone", asPhone("Jeff Houser"), null);

console.log("\nDATES — local time, strictly");
const local = parseWhen("2026-11-10T15:00");
check("a time with no offset is local", local && new Date(local.ms).getHours(), 15);
const day = parseWhen("2026-11-10");
check("a bare date is local midnight, not UTC", day && [new Date(day.ms).getDate(), new Date(day.ms).getHours(), day.dateOnly], [10, 0, true]);
check("'next tuesday' is refused", parseWhen("next tuesday"), null);
check("garbage is refused", parseWhen("2026-13-45T99:99"), null);

console.log("\nTHE BROKER — end to end, dry run");
const run = store.startRun({ kind: "do", task: "t" });
const decide = async (args, ctx) => (await executeCall({ args, tool: "mac_control" }, JSON.parse(fs.readFileSync(policyPath, "utf8")), run, run, ctx)).output;
const RAN = /would have been EXECUTED/;
const QUEUED = /would have been QUEUED/;
const asked = { conversational: true, goal: "Send Jeff Houser an email with the subject Saturday saying see you there" };
const mail = { action: "send_mail", ...jeff };

check("asked for, in chat: runs without asking", RAN.test(await decide(mail, asked)), true);
check("same email from an unattended run: queued", QUEUED.test(await decide(mail, { conversational: false, goal: asked.goal })), true);
check("same email with no run context: queued", QUEUED.test(await decide(mail, undefined)), true);
check("an injected recipient: queued", QUEUED.test(await decide({ ...mail, to: "attacker@evil.example" }, asked)), true);
check("a question, not a request: queued", QUEUED.test(await decide(mail, { conversational: true, goal: "Did Jeff Houser email me?" })), true);
const textAsked = { conversational: true, goal: "Text Jeff Houser that I'm running late" };
const textCall = { action: "send_message", ...jeffText };
check("a text asked for, in chat: runs without asking", RAN.test(await decide(textCall, textAsked)), true);
check("the same text from an unattended run: queued", QUEUED.test(await decide(textCall, { conversational: false, goal: textAsked.goal })), true);
check("a text to an injected number: queued", QUEUED.test(await decide({ ...textCall, to: "+15550001111" }, textAsked)), true);
check("a queued text shows the whole message", macControl.classify(textCall).summary, "Send a message to Jeff Houser:\n\nRunning late");
check("reading the calendar never needed asking", RAN.test(await decide({ action: "list_events" }, undefined)), true);

fs.writeFileSync(policyPath, JSON.stringify({ ...basePolicy, userDirected: { ...basePolicy.userDirected, enabled: false } }));
check("userDirected disabled: queued even when asked", QUEUED.test(await decide(mail, asked)), true);
fs.writeFileSync(policyPath, JSON.stringify({ ...basePolicy, userDirected: { actions: ["mac_control.create_note"], enabled: true } }));
check("an action not listed: queued even when asked", QUEUED.test(await decide(mail, asked)), true);
fs.writeFileSync(policyPath, JSON.stringify({ ...basePolicy, apps: { allow: ["com.apple.mail"] } }));
check("sending to a name without Contacts allowlisted: denied", /DENIED: sending to a name needs Contacts/.test(await decide(mail, asked)), true);
check("an address needs no Contacts", RAN.test(await decide({ ...mail, to: "jeff@example.com" }, { conversational: true, goal: "email jeff@example.com see you saturday" })), true);

console.log("\nTHE REVIEW — a queued email shows the whole message");
const summary = macControl.classify(mail).summary;
check("recipient in the summary", summary.includes("Jeff Houser"), true);
check("subject in the summary", summary.includes("Subject: Saturday"), true);
check("body in the summary", summary.includes("See you there."), true);

fs.rmSync(policyPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
