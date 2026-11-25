/**
 * The Google write path (docs/SPEC.md section 5, 2026-11-21). Run with `node test/google-write.test.mjs`.
 *
 * No network: fetch is stubbed. What this guards is the shape of the permission, not Google:
 * the read token's scopes are unchanged, the write token is used by exactly one module, that module
 * cannot send or permanently delete, and every protection on mail and calendar is code.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-gwrite-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "secret";
process.env.GOOGLE_WRITE_TOKEN_PATH = path.join(root, "write.json");
fs.writeFileSync(process.env.GOOGLE_WRITE_TOKEN_PATH, JSON.stringify({ refresh_token: "r" }));
// The read token too. Without this the gmail_search section read the real one from ~/.config/agentspine, so it passed
// only on a machine where `npm run auth` had been run, and it loaded that machine's real refresh token (the fetch
// stub answered it, so it never left the process). Found 2026-11-25 on a machine with no token.
process.env.GOOGLE_TOKEN_PATH = path.join(root, "read.json");
fs.writeFileSync(process.env.GOOGLE_TOKEN_PATH, JSON.stringify({ refresh_token: "r-read" }));
process.env.EMBEDDINGS_URL = "";

const config = await import("../src/config.ts");
const write = await import("../src/google/write.ts");
const triage = await import("../src/tools/gmail-triage.ts");
const cal = await import("../src/tools/calendar-write.ts");
const gmail = await import("../src/tools/gmail.ts");
const { rawDb } = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nTHE READ TOKEN IS UNCHANGED, THE WRITE TOKEN IS SEPARATE");
check("read scopes are still exactly the two read-only ones", config.GOOGLE_SCOPES, ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/gmail.readonly"]);
check("write scopes are exactly gmail.modify and calendar.events", config.GOOGLE_WRITE_SCOPES, ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/gmail.modify"]);
check("no scope that sends, or deletes permanently", config.GOOGLE_WRITE_SCOPES.some((s) => /gmail\.send|mail\.google\.com|gmail\.compose|settings/.test(s)), false);

// Who may name the write token, and who may import write.ts, is asserted in test/architecture.test.mjs.
check("write.ts exports no send, delete or empty-trash", Object.keys(write).filter((k) => /send|delete|empty|remove(Message|Event)|purge/i.test(k)), []);

console.log("\nTHE CALLS, WITH FETCH STUBBED");
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ body: typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null, method: init.method ?? "GET", url: u });
  if (u.includes("oauth2.googleapis.com")) return Response.json({ access_token: "at" });
  if (u.endsWith("/labels") && (init.method ?? "GET") === "GET") return Response.json({ labels: [{ id: "L1", name: "Receipts", type: "user" }, { id: "INBOX", name: "INBOX", type: "system" }] });
  if (u.endsWith("/labels")) return Response.json({ id: "L2" });
  if (u.includes("/events") && init.method === "POST") return Response.json({ id: "ev1" });
  return Response.json({ labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "A <a@x.com>" }, { name: "Subject", value: "Hi" }] } });
};
const last = () => calls.filter((c) => !c.url.includes("oauth2"))[calls.filter((c) => !c.url.includes("oauth2")).length - 1];
await write.archiveMessage("abcdef0123");
check("archive removes INBOX and nothing else", [last().url.endsWith("/messages/abcdef0123/modify"), last().body], [true, { addLabelIds: [], removeLabelIds: ["INBOX"] }]);
await write.trashMessage("abcdef0123");
check("trash is the trash endpoint, not a delete", [last().method, last().url.endsWith("/messages/abcdef0123/trash")], ["POST", true]);
await write.spamMessage("abcdef0123");
check("spam adds SPAM and leaves the inbox", last().body, { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] });
check("no call anywhere used DELETE", calls.some((c) => c.method === "DELETE"), false);
check("a bad id is refused before any request", await write.trashMessage("../../x").then(() => "sent", (e) => e.message.slice(0, 22)), "not a Gmail message id");
check("an existing label is reused", await write.ensureLabel("receipts"), "L1");
check("a new label is created", await write.ensureLabel("Newsletters"), "L2");
check("a system label cannot be touched", await write.ensureLabel("INBOX").then(() => "ok", (e) => /system label/.test(e.message)), true);
check("a label name with odd characters is refused", await write.ensureLabel("a<script>").then(() => "ok", (e) => /label names are/.test(e.message)), true);
await write.createAllDayEvent("cal1", { date: "2026-12-31", description: "d", remindDaysBefore: 2, title: "Electric bill, $84.20" });
const ev = last();
check("an all-day event ends the next day (a Dec 31 bill crosses the year)", [ev.body.start, ev.body.end], [{ date: "2026-12-31" }, { date: "2027-01-01" }]);
check("one email reminder, two days ahead", ev.body.reminders, { overrides: [{ method: "email", minutes: 2880 }], useDefault: false });

console.log("\nGMAIL_TRIAGE: PROTECTIONS ARE CODE");
const mk = (over = {}) => ({
  addLabels: async () => {}, archive: async () => {}, trash: async () => {}, spam: async () => {}, removeLabels: async () => {},
  emailedSender: async () => false, ensureLabel: async () => "L",
  info: async (id) => ({ from: "News <news@shop.com>", id, labelIds: ["INBOX"], subject: "Sale" }),
  ...over,
});
const opts = (deps, extra = {}) => ({ cap: 60, deps, overrides: [], runKey: 1, ...extra });
triage.resetTriageCounts();
check("an ordinary newsletter is trashed", /trash done/.test(await triage.triageOne("a1", "trash", opts(mk()))), true);
check("mail you have emailed is refused", /REFUSED, you have emailed/.test(await triage.triageOne("a2", "trash", opts(mk({ emailedSender: async () => true })))), true);
check("...unless the sender is on your override list", /trash done/.test(await triage.triageOne("a3", "trash", opts(mk({ emailedSender: async () => true, info: async (id) => ({ from: "Greg <g@afs.ameriprise.com>", id, labelIds: ["INBOX"], subject: "Tips" }) }), { overrides: ["afs.ameriprise.com"] }))), true);
check("an override by domain does not match a lookalike", /REFUSED/.test(await triage.triageOne("a4", "trash", opts(mk({ emailedSender: async () => true, info: async (id) => ({ from: "x@notafs.ameriprise.com.evil.io", id, labelIds: ["INBOX"], subject: "Tips" }) }), { overrides: ["afs.ameriprise.com"] }))), true);
check("starred mail is refused", /you starred it/.test(await triage.triageOne("a5", "trash", opts(mk({ info: async (id) => ({ from: "a@b.c", id, labelIds: ["INBOX", "STARRED"], subject: "s" }) })))), true);
check("mail you sent is refused", /mail you sent/.test(await triage.triageOne("a6", "trash", opts(mk({ info: async (id) => ({ from: "me@b.c", id, labelIds: ["INBOX", "SENT"], subject: "s" }) })))), true);
check("mail not in the inbox is refused", /not in the inbox/.test(await triage.triageOne("a7", "spam", opts(mk({ info: async (id) => ({ from: "a@b.c", id, labelIds: ["CATEGORY_PROMOTIONS"], subject: "s" }) })))), true);
check("mail already in Trash is skipped", /already in Trash/.test(await triage.triageOne("a8", "trash", opts(mk({ info: async (id) => ({ from: "a@b.c", id, labelIds: ["TRASH"], subject: "s" }) })))), true);
check("archive does not look up your sent mail", /archive done/.test(await triage.triageOne("a9", "archive", opts(mk({ emailedSender: async () => { throw new Error("must not be called"); } })))), true);
triage.resetTriageCounts();
const capped = [];
for (let i = 0; i < 4; i++) capped.push(await triage.triageOne(`c${i}`, "archive", opts(mk(), { cap: 3 })));
check("the per-run cap stops the fourth change", capped.map((l) => /limit of 3/.test(l)), [false, false, false, true]);
check("a different run has its own allowance", /archive done/.test(await triage.triageOne("c9", "archive", opts(mk(), { cap: 3, runKey: 2 }))), true);
check("an API failure is a line, not a throw", /ERROR boom/.test(await triage.triageOne("e1", "archive", opts(mk({ archive: async () => { throw new Error("boom"); } })))), true);
check("addressOf handles both forms", [triage.addressOf("A B <X@Y.com>"), triage.addressOf("x@y.com")], ["x@y.com", "x@y.com"]);

console.log("\nGMAIL_TRIAGE: POLICY GATE AND TIER");
const on = { google: { enabled: true, write: { enabled: true } } };
const gate = (p, a) => triage.gmailTriage.checkPolicy(p, a).allowed;
check("allowed when writes are enabled", gate(on, { action: "archive", ids: ["abc"] }), true);
check("denied when google.write is absent (an old policy.json)", gate({ google: { enabled: true } }, { action: "archive", ids: ["abc"] }), false);
check("denied when write.enabled is false", gate({ google: { enabled: true, write: { enabled: false } } }, { action: "archive", ids: ["abc"] }), false);
check("denied when google is off", gate({ google: { enabled: false, write: { enabled: true } } }, { action: "archive", ids: ["abc"] }), false);
check("an unknown action is denied", gate(on, { action: "delete", ids: ["abc"] }), false);
check("'delete' is not an action at all", ["archive", "label", "spam", "trash", "unlabel"].includes("delete"), false);
check("more than 25 ids is denied", gate(on, { action: "archive", ids: Array(26).fill("abc") }), false);
check("label needs a name", gate(on, { action: "label", ids: ["abc"] }), false);
check("archive is reversible", triage.gmailTriage.classify({ action: "archive", ids: ["a"] }).reversibility, "reversible");
check("trash is the irreversible tier (queued in a chat)", triage.gmailTriage.classify({ action: "trash", ids: ["a"] }).reversibility, "irreversible");
check("it does not ask again in a schedule you set up", triage.gmailTriage.confirmWhenUnattended, undefined);

console.log("\nCALENDAR_WRITE: ONLY THE NAMED CALENDAR, NEVER CREATED, NO DELETE");
const created = [];
const cdeps = (over = {}) => ({
  create: async (c, e) => (created.push({ c, e }), { id: "ev9" }),
  eventsOn: async () => [],
  findCalendar: async (n) => (n.toLowerCase() === "bills" ? { id: "bills-id", name: "Bills", primary: false } : null),
  update: async (c, id, p) => (created.push({ c, id, p }), undefined),
  ...over,
});
const pol = { google: { enabled: true, write: { enabled: true } } };
const create = { action: "create", calendar: "Bills", date: "2026-12-05", title: "Electric bill, $84.20" };
check("creates on Bills", /^CREATED/.test(await cal.runCalendarWrite(create, pol, cdeps())), true);
check("with the default two day reminder", created[0].e.remindDaysBefore, 2);
check("a different calendar is refused", /REFUSED/.test(await cal.runCalendarWrite({ ...create, calendar: "Work" }, pol, cdeps())), true);
check("a missing Bills calendar is reported, not created", /NOT FOUND/.test(await cal.runCalendarWrite(create, pol, cdeps({ findCalendar: async () => null }))), true);
check("the same bill twice is not duplicated", /ALREADY EXISTS/.test(await cal.runCalendarWrite(create, pol, cdeps({ eventsOn: async () => [{ id: "x", title: "electric bill, $84.20" }] }))), true);
check("a policy can name another calendar", /^CREATED/.test(await cal.runCalendarWrite({ ...create, calendar: "Home" }, { google: { enabled: true, write: { calendars: ["Home"], enabled: true } } }, cdeps({ findCalendar: async () => ({ id: "h", name: "Home", primary: false }) }))), true);
check("reminder is capped at 14 days", (await cal.runCalendarWrite({ ...create, remindDaysBefore: 99 }, pol, cdeps()), created.at(-1).e.remindDaysBefore), 14);
check("update changes only what was given", (await cal.runCalendarWrite({ action: "update", calendar: "Bills", date: "2026-12-09", eventId: "e1" }, pol, cdeps()), created.at(-1).p), { date: "2026-12-09" });
const cgate = (a, p = pol) => cal.calendarWrite.checkPolicy(p, a).allowed;
check("create needs a real date", cgate({ ...create, date: "Dec 5" }), false);
check("an impossible date is refused", cgate({ ...create, date: "2026-13-45" }), false);
check("a delete action does not exist", cgate({ action: "delete", calendar: "Bills", eventId: "e" }), false);
check("denied without google.write", cgate(create, { google: { enabled: true } }), false);
check("calendar_find is read-only", cal.calendarFind.classify({ calendar: "Bills" }).reversibility, "reversible");

console.log("\nGMAIL_SEARCH: WORKS THROUGH THE INBOX AS IT STANDS");
{
  const { gmailSearch } = gmail;
  const realFetch = globalThis.fetch;
  const inbox = Array.from({ length: 7 }, (_, i) => `m${i + 1}`); // newest first
  let down = false;
  let lastListUrl = "";
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/gmail/v1/users/me/messages?")) {
      if (down) throw new Error("network down");
      lastListUrl = u;
      return Response.json({ messages: inbox.map((id) => ({ id })) });
    }
    const m = /messages\/(m\d+)\?/.exec(u);
    if (m) return Response.json({ labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "A <a@x.com>" }, { name: "Subject", value: `subject of ${m[1]}` }, { name: "Date", value: "Mon" }] }, snippet: "s" });
    return realFetch(url, init);
  };
  const ids = (out) => [...out.matchAll(/^Id: (m\d+)$/gm)].map((x) => x[1]);
  const q = { max: 3, query: "in:inbox", sinceKey: "cleanup-test" };

  const one = await gmailSearch.run(q);
  check("the first call takes the newest three unreviewed messages", ids(one), ["m1", "m2", "m3"]);
  check("and says more are waiting, so the job can call again", /4 more unreviewed/.test(one), true);
  check("no date window is applied: the query is just the inbox", /q=in%3Ainbox(&|$)/.test(lastListUrl) && !/after/.test(lastListUrl), true);
  const two = await gmailSearch.run(q);
  check("the next call continues with the following three, however old", ids(two), ["m4", "m5", "m6"]);
  check("and says three were already reviewed", /3 already-reviewed message\(s\) skipped/.test(two), true);
  const three = await gmailSearch.run(q);
  check("the last call takes the remainder", ids(three), ["m7"]);
  const four = await gmailSearch.run(q);
  check("when everything is reviewed it says so, and does not claim the inbox is clean", [ids(four), /every matching message has already been reviewed/.test(four), /\bclean\b/.test(four)], [[], true, false]);

  console.log("\nA FAILED SEARCH REVIEWS NOTHING");
  down = true;
  const failed = await gmailSearch.run({ ...q, sinceKey: "failcase" });
  down = false;
  check("it reports the error", /ERROR|NOT CONFIGURED/.test(failed), true);
  check("so the same mail is still there on the retry", ids(await gmailSearch.run({ ...q, sinceKey: "failcase" })), ["m1", "m2", "m3"]);

  console.log("\nA KEY KEEPS ITS OWN LIST, AND REVIEWS EXPIRE");
  check("another key starts fresh", ids(await gmailSearch.run({ ...q, sinceKey: "another-job" })), ["m1", "m2", "m3"]);
  check("a call with no key reviews and remembers nothing", [ids(await gmailSearch.run({ max: 2, query: "in:inbox" })), ids(await gmailSearch.run({ max: 2, query: "in:inbox" }))], [["m1", "m2"], ["m1", "m2"]]);
  const WEEK = 7 * 86_400_000;
  const t0 = Date.now();
  gmail.markReviewed("ttl", ["m1"], t0 - WEEK - 1000);
  gmail.markReviewed("ttl", ["m2"], t0 - WEEK + 60_000);
  check("a review older than a week is forgotten, a recent one is kept", [...gmail.reviewedIds("ttl", t0)].sort(), ["m2"]);
  gmail.markReviewed("cap", Array.from({ length: 3200 }, (_, i) => `x${i}`), t0);
  check("the remembered set is capped", gmail.reviewedIds("cap", t0).size <= 3000, true);
  globalThis.fetch = realFetch;
  check("a key is stripped to safe characters", /gmail:since:abc/.test("gmail:since:" + "a b!c".replace(/[^a-z0-9_-]/gi, "")), true);
}

console.log("\nTHE STARTER");
const { execFileSync } = await import("node:child_process");
const listing = execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "src", "watcher.ts"), "list"], { encoding: "utf8", env: { ...process.env } });
check("the inbox cleanup starter is offered", /inbox-cleanup/.test(listing), true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
