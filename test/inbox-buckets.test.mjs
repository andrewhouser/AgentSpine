/**
 * Inbox buckets and replies drafted on request (src/checkin/buckets.ts, PLAN-open-work section 14, U7).
 *
 * What this pins:
 *   - the model's reply is read as two words from two fixed lists and nothing else;
 *   - the three modes: off reads nothing, log records and shows nothing, on shows;
 *   - only mail the check-in calls "from a person" ever reaches the model, one mail per call;
 *   - the cap per pass, a model that is down, the interval and the retention;
 *   - mail goes to the local model only, with a cloud tier configured and listening;
 *   - the check-in's own code does not know the buckets exist, so no label can start,
 *     stop or change a push;
 *   - a drafted reply is addressed, titled and styled by code.
 * The hostile-mail cases are in test/injection.test.mjs.
 *
 *   node test/inbox-buckets.test.mjs
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-buckets-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";

const standIn = (log, respond) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: respond(body), role: "assistant" } }], usage: { completion_tokens: 5, prompt_tokens: 50, total_tokens: 55 } }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
};
const localLog = [];
const cloudLog = [];
let answer = '{"bucket":"fyi","reason":"information-only"}';
const localServer = await standIn(localLog, () => answer);
const cloudServer = await standIn(cloudLog, () => '{"bucket":"urgent","reason":"deadline"}');
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${localServer.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
// A cloud tier that is configured and answering: the proof is that it is never asked.
process.env.OPENAI_API_KEY = "test-key";
process.env.CLOUD_LLM_URL = `http://127.0.0.1:${cloudServer.address().port}/v1`;
process.env.CLOUD_MODEL = "test-cloud";
process.env.LLM_RETRIES = "0";
process.env.CLOUD_TOKENS_PER_DAY = "";
process.env.CLOUD_TOKENS_PER_MONTH = "";
process.env.CLOUD_TOKENS_PER_RUN = "";

const store = await import("../src/memory/store.ts");
const b = await import("../src/checkin/buckets.ts");
const { route } = await import("../src/router.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const NOW = new Date("2026-06-15T12:00:00.000Z");
const mail = (id, from, subject, snippet = "", labelIds = ["INBOX", "UNREAD"], extra = {}) => ({ date: "", from, id, labelIds, snippet, subject, ...extra });
const sam = mail("msg000001", "Sam Rivera <sam@example.com>", "Contract by Friday", "Can you sign the contract by Friday noon?");
const alex = mail("msg000002", "Alex Chen <alex@example.com>", "Lunch", "Free on Thursday?");
const news = mail("msg000003", "Acme News <news@acme.example>", "Weekly digest", "Top stories", ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]);
const list = mail("msg000004", "Dev List <list@example.org>", "Thread", "Re: thread", ["INBOX", "UNREAD"], { listUnsubscribe: true });

let inbox = [sam, alex, news, list];
let reads = 0;
let mode = "on";
const deps = (over = {}) => ({
  googleEnabled: () => true,
  mail: async () => {
    reads++;
    return inbox;
  },
  mailOn: () => true,
  mode: () => mode,
  route,
  style: () => null,
  ...over,
});
const reset = () => {
  store.rawDb.exec("DELETE FROM inbox_labels");
  store.kvSet("checkin:last-sort", "");
  localLog.length = 0;
  reads = 0;
};
const stored = (id) => {
  const l = b.getLabel(id);
  return l ? [l.bucket, l.reason, l.mode] : null;
};

console.log("\nREADING THE MODEL'S REPLY — two words from two lists, or nothing");
for (const [label, text, want] of [
  ["a clean reply", '{"bucket":"urgent","reason":"deadline"}', { bucket: "urgent", reason: "deadline" }],
  ["with words around it", 'Here you go: {"bucket":"reply-today","reason":"asks-you-a-question"} hope that helps', { bucket: "reply-today", reason: "asks-you-a-question" }],
  ["extra keys are dropped", '{"bucket":"fyi","reason":"information-only","note":"call 555-0100"}', { bucket: "fyi", reason: "information-only" }],
  ["a bucket that is not on the list", '{"bucket":"critical","reason":"deadline"}', null],
  ["a reason that is not on the list", '{"bucket":"urgent","reason":"call 555-0100 now"}', null],
  ["a bucket in the wrong case", '{"bucket":"Urgent","reason":"deadline"}', null],
  ["no reason", '{"bucket":"urgent"}', null],
  ["a bucket that is a list", '{"bucket":["urgent"],"reason":"deadline"}', null],
  ["prose", "This one is urgent because of the deadline.", null],
  ["broken JSON", '{"bucket":"urgent","reason":', null],
  ["nothing", "", null],
]) {
  check(label, b.parseLabel(text), want);
}
check("every bucket and reason is a plain lowercase word", [...b.BUCKETS, ...b.REASONS].every((w) => /^[a-z-]+$/.test(w)), true);

console.log("\nMODE OFF — nothing is read and no model is asked");
{
  reset();
  mode = "off";
  const r = await b.sortInbox(NOW, deps());
  check("the pass says off", [r.status, reads, localLog.length], ["off", 0, 0]);
  check("the timer does nothing either", [await b.sweepInboxSort(deps(), NOW), reads], [null, 0]);
  check("nothing is shown", b.shownLabels("off"), {});
}

console.log("\nPREVIEW — reads and asks, stores nothing, works with the mode off");
{
  reset();
  mode = "off";
  answer = '{"bucket":"urgent","reason":"deadline"}';
  const rows = await b.previewSort(deps());
  check("it labels the two mails from people", rows.map((r) => [r.sender, r.bucket]), [["Sam Rivera", "urgent"], ["Alex Chen", "urgent"]]);
  check("it stores nothing", store.rawDb.prepare("SELECT COUNT(*) AS n FROM inbox_labels").get().n, 0);
}

console.log("\nMODE LOG — recorded, never shown");
{
  reset();
  mode = "log";
  answer = '{"bucket":"reply-today","reason":"waiting-on-you"}';
  const r = await b.sortInbox(NOW, deps());
  check("two labelled", [r.status, r.labelled, r.unsorted, r.waiting], ["sorted", 2, 0, 0]);
  check("stored with the mode it was made in", stored("msg000001"), ["reply-today", "waiting-on-you", "log"]);
  check("not shown in log mode", b.shownLabels("log"), {});
  check("not shown after switching to on, until it is labelled again", b.shownLabels("on"), {});
  check("the log lists both", b.listLabels().map((l) => l.messageId).sort(), ["msg000001", "msg000002"]);
}

console.log("\nMODE ON — shown, keyed the way the check-in keys its mail items");
{
  mode = "on";
  localLog.length = 0;
  answer = '{"bucket":"urgent","reason":"deadline"}';
  const r = await b.sortInbox(NOW, deps());
  check("labels made in log mode are made again", [r.labelled, localLog.length], [2, 2]);
  check("shown by item key", b.shownLabels("on"), { "mail:msg000001": { bucket: "urgent", reason: "deadline" }, "mail:msg000002": { bucket: "urgent", reason: "deadline" } });
  localLog.length = 0;
  const again = await b.sortInbox(NOW, deps());
  check("a mail already labelled is not asked about again", [again.labelled, localLog.length], [0, 0]);
  check("the stored sender is the display name on one line", b.getLabel("msg000001").sender, "Sam Rivera");
}

console.log("\nWHAT REACHES THE MODEL — mail from people only, one mail per call, local only");
{
  reset();
  mode = "on";
  await b.sortInbox(NOW, deps());
  const sent = localLog.map((body) => JSON.parse(body));
  check("one call per mail from a person", sent.length, 2);
  check("the newsletter and the mailing list were never sent", localLog.some((x) => x.includes("Weekly digest") || x.includes("Dev List")), false);
  check("each call holds one mail", [localLog[0].includes("Lunch"), localLog[1].includes("Contract by Friday")], [false, false]);
  check("the mail is the last message, wrapped as untrusted", sent.map((s) => [s.messages.at(-1).role, s.messages.at(-1).content.startsWith("[UNTRUSTED CONTENT from gmail]\n")]), [["user", true], ["user", true]]);
  check("the instructions are the same bytes on every call", sent[0].messages[0].content === sent[1].messages[0].content, true);
  check("they went to the local model", sent.map((s) => s.model), ["test-local", "test-local"]);
  check("the cloud tier, configured and listening, was never asked", cloudLog.length, 0);
  check("the reply is capped short", sent[0].max_tokens, b.SORT_MAX_TOKENS);
}

console.log("\nSWITCHES — mail off or Google off means no read");
{
  reset();
  check("mail switched off in Settings", [(await b.sortInbox(NOW, deps({ mailOn: () => false }))).status, reads, localLog.length], ["nomail", 0, 0]);
  check("Google not enabled in policy", [(await b.sortInbox(NOW, deps({ googleEnabled: () => false }))).status, reads], ["nomail", 0]);
  const broke = await b.sortInbox(NOW, deps({ mail: async () => Promise.reject(new Error("HTTP 503")) }));
  check("a failed mail read is an error and stores nothing", [broke.status, b.listLabels().length], ["error", 0]);
}

console.log("\nTHE CAP, AND A MODEL THAT IS DOWN");
{
  reset();
  const many = Array.from({ length: b.SORT_MAX_PER_PASS + 3 }, (_, i) => mail(`many${String(i).padStart(4, "0")}`, `Person ${i} <p${i}@example.com>`, `Subject ${i}`));
  const first = await b.sortInbox(NOW, deps({ mail: async () => many }));
  check("one pass labels up to the cap and leaves the rest", [first.labelled, first.waiting, localLog.length], [b.SORT_MAX_PER_PASS, 3, b.SORT_MAX_PER_PASS]);
  const second = await b.sortInbox(NOW, deps({ mail: async () => many }));
  check("the next pass takes the rest", [second.labelled, second.waiting], [3, 0]);

  reset();
  const down = await b.sortInbox(NOW, deps({ route: async () => Promise.reject(new Error("connection refused")) }));
  check("a model that is down labels nothing and stores nothing", [down.status, down.labelled, down.waiting, b.listLabels().length], ["sorted", 0, 2, 0]);
  answer = "I think this is important.";
  const prose = await b.sortInbox(NOW, deps());
  check("an answer that is not a label is stored as unsorted", [prose.labelled, prose.unsorted, stored("msg000001")], [0, 2, [null, null, "on"]]);
  check("unsorted mail is shown as unsorted, not hidden", b.shownLabels("on")["mail:msg000001"], { bucket: null, reason: null });
  localLog.length = 0;
  await b.sortInbox(NOW, deps());
  check("... and is not asked about again", localLog.length, 0);
  answer = '{"bucket":"fyi","reason":"information-only"}';
}

console.log("\nTHE TIMER — the check-in's interval, and labels are kept 30 days");
{
  reset();
  mode = "on";
  const first = await b.sweepInboxSort(deps(), NOW);
  check("the first tick sorts", first?.labelled, 2);
  check("a tick ten minutes later does nothing", await b.sweepInboxSort(deps(), new Date(NOW.getTime() + 10 * 60_000)), null);
  check("a tick just short of four hours does nothing", await b.sweepInboxSort(deps(), new Date(NOW.getTime() + 4 * 3_600_000 - 1)), null);
  inbox = [sam, alex, mail("msg000009", "Jordan Lee <jordan@example.com>", "Keys")];
  const later = await b.sweepInboxSort(deps(), new Date(NOW.getTime() + 4 * 3_600_000));
  check("at four hours it sorts what is new", later?.labelled, 1);
  inbox = [];
  await b.sweepInboxSort(deps(), new Date(NOW.getTime() + (b.LABEL_RETENTION_DAYS + 1) * 86_400_000));
  check("labels older than the retention are dropped", b.listLabels().length, 0);
  inbox = [sam, alex, news, list];
}

console.log("\nTHE CHECK-IN DOES NOT KNOW THE BUCKETS EXIST");
{
  const src = (f) => fs.readFileSync(path.join(import.meta.dirname, "..", "src", "checkin", f), "utf8");
  for (const f of ["run.ts", "sources.ts", "store.ts", "rules.ts", "prefs.ts"]) {
    check(`${f} imports nothing from buckets`, /from "\.\/buckets(-deps)?\.ts"/.test(src(f)), false);
  }
  check("run.ts makes no model call", /router\.ts|llm\.ts/.test(src("run.ts")), false);
  // The same inbox with every mail labelled fyi and with every mail labelled urgent gives the same check.
  const { previewCheckin } = await import("../src/checkin/run.ts");
  const cdeps = { approvals: () => [], detail: () => "senders", events: async () => [], googleEnabled: () => true, headsups: () => [], mail: async () => [sam, alex, news], mode: () => "push", quiet: () => false, send: async () => {}, sentToday: () => 0, tasks: () => [] };
  const say = async (bucket) => {
    reset();
    answer = `{"bucket":"${bucket}","reason":"information-only"}`;
    await b.sortInbox(NOW, deps());
    const p = await previewCheckin(NOW, cdeps);
    return [p.wouldSend, p.title, p.body];
  };
  check("labels do not change what a check would send", await say("fyi"), await say("urgent"));
  answer = '{"bucket":"fyi","reason":"information-only"}';
}

console.log("\nA REPLY, DRAFTED ON REQUEST — code picks the mail, the recipient, the subject and the style");
{
  check("an address in angle brackets", b.addressOf("Sam Rivera <Sam@Example.com>"), "sam@example.com");
  check("a bare address", b.addressOf("alex@example.com"), "alex@example.com");
  check("no address", b.addressOf("Sam Rivera"), null);
  check("message ids are plain", ["msg000001", "a/b", "", "x".repeat(65), 42].map((v) => b.isMessageId(v)), [true, false, false, false, false]);

  localLog.length = 0;
  answer = "Hi Sam,\n\nYes, I can sign by Friday. Send it over.\n\nAlex";
  const made = await b.draftReply("msg000001", deps({ style: (to) => (to === "sam@example.com" ? { name: "client", note: "Short sentences. Sign off with first name." } : null) }));
  check("a draft for the sender, as a reply", made.ok && [made.args.kind, made.args.to, made.args.subject, made.args.style], ["email_reply", "sam@example.com", "Re: Contract by Friday", "client"]);
  check("the body is the model's", made.ok && made.args.body.startsWith("Hi Sam,"), true);
  check("the reason says it was written from the preview only", made.ok && /not the whole email/.test(made.args.reason), true);
  const req = JSON.parse(localLog.at(-1));
  check("the style note is in the instructions, the mail is last and untrusted", [req.messages[0].content.includes("Short sentences."), req.messages.at(-1).content.startsWith("[UNTRUSTED CONTENT from gmail]\n")], [true, true]);
  check("it stayed on the local model", [req.model, cloudLog.length], ["test-local", 0]);

  const re = await b.draftReply("msg000005", deps({ mail: async () => [mail("msg000005", "Sam Rivera <sam@example.com>", "RE: Contract")] }));
  check("a subject that is already a reply is not prefixed twice", re.ok && re.args.subject, "RE: Contract");
  check("no style saved means none is named", "style" in ((await b.draftReply("msg000002", deps())).args ?? {}), false);
  check("a newsletter is not replied to", (await b.draftReply("msg000003", deps())).ok, false);
  check("mail switched off means no reply", (await b.draftReply("msg000001", deps({ mailOn: () => false }))).ok, false);
  check("a sender with no address is refused", (await b.draftReply("msg000006", deps({ mail: async () => [mail("msg000006", "Sam Rivera", "Hello")] }))).ok, false);
  answer = "   ";
  check("an empty reply from the model is not a draft", (await b.draftReply("msg000001", deps())).ok, false);
}

localServer.close();
cloudServer.close();
fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
