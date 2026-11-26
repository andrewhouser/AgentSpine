/**
 * The Check-in screen says the same thing on web, iPhone and Mac, and the app can read what the
 * server sends. Run with `node test/checkin-screen.test.mjs`.
 *
 * The web's sentences are `web/src/lib/checkin.ts`; the iPhone's and the Mac's are `CheckinWords`
 * in `ios/AgentSpine/Core/Models.swift`. They are written twice, so this runs one set of cases
 * through both and compares every line. The Swift half compiles the real Check-in section of
 * Models.swift, decodes a real preview, status and result produced by `src/checkin`, and skips
 * when there is no `swiftc`, like menu-layout.test.mjs. The TypeScript half always runs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-checkin-screen-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDINGS_URL = "";

const { CHECKIN_SOURCES, checkinGroups, checkinModeLine, checkinOffKinds, checkinOffLine, checkinRunLabel, checkinRunNote, checkinSendLine } = await import("../web/src/lib/checkin.ts");
const { checkinBucketLine, checkinBucketRank, checkinMailOrder, checkinMessageId, checkinSortLine } = await import("../web/src/lib/checkin.ts");
const { previewCheckin, runCheckin } = await import("../src/checkin/run.ts");
const store = await import("../src/checkin/store.ts");
const { INTERVAL_HOURS } = await import("../src/checkin/rules.ts");

const REPO = path.dirname(import.meta.dirname);
const MODELS = path.join(REPO, "ios/AgentSpine/Core/Models.swift");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  if (got === want) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}\n        want ${want}\n        got  ${got}`);
  }
};

// --- one set of cases -------------------------------------------------------------------------
const modes = ["off", "log", "push", "something-new"];
const sends = [
  { heldBy: null, mode: "push", wouldSend: false },
  { heldBy: "off", mode: "off", wouldSend: true },
  { heldBy: "quiet", mode: "push", wouldSend: true },
  { heldBy: "cap", mode: "push", wouldSend: true },
  { heldBy: null, mode: "log", wouldSend: true },
  { heldBy: null, mode: "push", wouldSend: true },
  // Mail switched off in Settings wins over everything: nothing can start a notification.
  { heldBy: null, mode: "push", off: ["mail"], wouldSend: false },
  { heldBy: "quiet", mode: "push", off: ["mail", "task"], wouldSend: true },
  { heldBy: null, mode: "push", off: ["calendar"], wouldSend: true },
];
const statuses = ["sent", "logged", "nothing", "capped", "quiet", "off", "nomail", "error", "something-new"];
// Which sources are switched off, as the server stores them (kind: false), and as nothing at all.
const switchSets = [
  undefined,
  { approval: true, calendar: true, headsup: true, mail: true, task: true },
  { approval: true, calendar: false, headsup: true, mail: true, task: true },
  { approval: false, calendar: true, headsup: false, mail: true, task: false },
  { approval: true, calendar: true, headsup: true, mail: false, task: true },
  { approval: true, calendar: false, headsup: true, mail: false, task: false },
  { calendar: false },
];
// One case per bucket and reason the server has, then the shapes a newer or broken server could send.
const BUCKET_NAMES = ["urgent", "reply-today", "fyi"];
const REASON_NAMES = ["deadline", "asks-you-a-question", "waiting-on-you", "time-or-place-changed", "about-money", "personal", "information-only"];
const bucketCases = [
  ...BUCKET_NAMES.flatMap((bucket) => REASON_NAMES.map((reason) => ({ bucket, reason }))),
  { bucket: null, reason: null },
  { bucket: "urgent", reason: null },
  { bucket: "urgent", reason: "a reason this build has not heard of" },
  { bucket: "a bucket this build has not heard of", reason: "deadline" },
  undefined,
];
const orderItems = ["mail:a", "mail:b", "mail:c", "mail:d", "mail:e", "mail:f"].map((key) => ({ key }));
const orderBuckets = {
  "mail:a": { bucket: "fyi", reason: "information-only" },
  "mail:b": { bucket: null, reason: null },
  "mail:c": { bucket: "urgent", reason: "deadline" },
  "mail:e": { bucket: "reply-today", reason: "waiting-on-you" },
  "mail:f": { bucket: "urgent", reason: "about-money" },
};
const TITLE = "New message from Sam Rivera";
const ERRORS = ["mail: 503 from Gmail", "calendar: timed out"];

const webLines = [
  ...modes.map((m) => checkinModeLine(m, INTERVAL_HOURS)),
  ...sends.map((s) => checkinSendLine(s)),
  ...statuses.map((s) => checkinRunNote({ errors: ERRORS, status: s, title: TITLE })),
  checkinRunNote({ errors: [], status: "error", title: "" }),
  ...statuses.map((s) => checkinRunLabel({ status: s })),
  ...switchSets.map((set) => `[${checkinOffKinds(set).join(",")}] ${checkinOffLine(checkinOffKinds(set))}`),
  ...CHECKIN_SOURCES.map((src) => `${src.kind}|${src.label}|${src.hint}`),
  // Inbox buckets (section 14, U7): every label the server can store, and the ones it cannot.
  ...bucketCases.map((b) => `${checkinBucketRank(b)} ${checkinBucketLine(b)}`),
  ...["on", "log", "off", undefined, "typo"].map((m) => checkinSortLine(m)),
  ...["mail:18c2ab", "task:4", "mail:", ""].map((k) => `[${checkinMessageId(k)}]`),
  checkinMailOrder(orderItems, orderBuckets).map((i) => i.key).join(","),
  checkinMailOrder(orderItems, undefined).map((i) => i.key).join(","),
];

console.log("\nTHE WEB'S WORDS");
check("switched off says how to switch it on", webLines[0].includes("CHECKIN_MODE=log"), true);
check("log mode says nothing is sent", webLines[1].includes("without sending"), true);
check("no new mail says so", webLines[modes.length], "No new mail from a person, so a check now would send nothing.");
check("a held message says it stays new", webLines[modes.length + 2].includes("stays new") && webLines[modes.length + 3].includes("stays new"), true);
check("mail switched off says no notification will be sent", checkinOffLine(["mail"]), "Mail is switched off. Only mail can start a notification, so the check-in sends none until it is back on.");
check("another source off is named, and mail is not blamed", checkinOffLine(["calendar", "task"]), "Switched off, so not read: Calendar, Tasks.");
check("everything on says nothing", checkinOffLine([]), "");
check("with mail off, a check would send nothing whatever else is true", checkinSendLine({ heldBy: "quiet", mode: "push", off: ["mail"], wouldSend: true }), "Mail is switched off, so a check now would send nothing.");
check("mail is the first switch and says it is the one that notifies", CHECKIN_SOURCES[0].kind === "mail" && CHECKIN_SOURCES[0].hint.includes("only thing that can start a notification"), true);
check("an error names what failed", checkinRunNote({ errors: ERRORS, status: "error", title: "" }), "Couldn't read mail: mail: 503 from Gmail; calendar: timed out");

// --- real payloads from the server code, for the grouping and for the app to decode ------------
const at = new Date(2026, 10, 24, 12);
const mail = (id, from, subject) => ({ date: "", from, id, labelIds: ["INBOX", "UNREAD"], listUnsubscribe: false, snippet: "", subject });
const deps = {
  approvals: () => [{ id: 7, summary: "Send an email to sam@example.com" }],
  detail: () => "senders",
  events: async () => [{ attendees: 2, location: "", start: new Date(2026, 10, 24, 14).toISOString(), title: "Standup" }],
  googleEnabled: () => true,
  headsups: () => [{ id: 3, kind: "birthday", subject: "Jordan's birthday" }],
  mail: async () => [mail("m1", "Sam Rivera <sam@example.com>", "Q3 budget"), mail("m2", "Jordan Lee <jordan@example.com>", "Lunch Thursday?")],
  mode: () => "log",
  quiet: () => false,
  send: async () => {},
  sentToday: () => 0,
  tasks: () => [{ due: new Date(2026, 10, 24, 9).toISOString(), id: 11, kind: "task", title: "Call the dentist" }],
};
store.resetForTests();
const preview = await previewCheckin(at, deps);
const result = await runCheckin(at, {}, deps);
const failedRun = await runCheckin(new Date(at.getTime() + 5 * 3_600_000), {}, { ...deps, mail: async () => { throw new Error("503 from Gmail"); } });
// What GET /api/checkin sends (src/server.ts), built from the same pieces.
const SWITCHES = { approval: true, calendar: false, headsup: true, mail: true, task: true };
const status = { intervalHours: INTERVAL_HOURS, lastError: store.lastError(), lastRun: store.lastRun(), mode: "log", pushDetail: "senders", runs: store.listRuns(20), sortMode: "on", sources: SWITCHES };
// The same world with the calendar switched off in Settings: it is not read, and the preview says so.
// The setting is the server's own (store.setSourcePrefs), so it is set there and put back after.
store.setSourcePrefs(SWITCHES);
const previewOff = await previewCheckin(at, deps);
store.setSourcePrefs({ calendar: true });

console.log("\nINBOX BUCKETS");
check("a label reads as our words for it", checkinBucketLine({ bucket: "urgent", reason: "deadline" }), "Urgent: it has a deadline");
check("an answer that was not a label reads Unsorted", checkinBucketLine({ bucket: null, reason: null }), "Unsorted");
check("a mail nobody has labelled yet says nothing", checkinBucketLine(undefined), "");
check("a reason this build does not know is left off, never shown raw", checkinBucketLine({ bucket: "urgent", reason: "call 555-0100 now" }), "Urgent");
check("every reason the server has has words here", REASON_NAMES.every((reason) => checkinBucketLine({ bucket: "fyi", reason }).includes(": ")), true);
check("urgent first, unlabelled last, order kept inside a bucket", checkinMailOrder(orderItems, orderBuckets).map((i) => i.key).join(), "mail:c,mail:f,mail:e,mail:a,mail:b,mail:d");
check("the sorting line says a label never notifies", checkinSortLine("on").includes("never decides whether you are notified"), true);
check("off, or a server without it, says nothing", checkinSortLine("off") + checkinSortLine(undefined), "");
{
  // The two lists are the server's. If one grows there, this fails until the words exist here and in Swift.
  const server = await import("../src/checkin/buckets.ts");
  check("the buckets here are the server's", server.BUCKETS.join(), BUCKET_NAMES.join());
  check("the reasons here are the server's", server.REASONS.join(), REASON_NAMES.join());
}

console.log("\nTHE LIST");
const groups = checkinGroups(preview.items);
const webGroups = groups.map((g) => `${g.label}=${g.items.map((i) => i.title).join("|")}`);
check("mail first, then what rides along, in a fixed order", groups.map((g) => g.kind).join(), "mail,approval,calendar,task,headsup");
check("an empty kind has no section", checkinGroups(preview.items.filter((i) => i.kind !== "task")).some((g) => g.kind === "task"), false);
check("a source switched off has no section and is named as off", [checkinGroups(previewOff.items).some((g) => g.kind === "calendar"), checkinOffKinds(SWITCHES).join()].join(), "false,calendar");
check("the run was recorded for the log", [status.runs.length, status.runs[0].status, status.runs[1].status].join(), "2,error,logged");

// --- the same cases through the app's Swift ----------------------------------------------------
const swiftc = (() => {
  try {
    const found = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return found && fs.existsSync(found) ? { args: ["swiftc"], cmd: "xcrun" } : null;
  } catch {
    return null;
  }
})();

console.log("\nTHE APP'S WORDS, AND WHAT IT CAN DECODE");
if (swiftc) {
  const models = fs.readFileSync(MODELS, "utf8");
  const from = models.indexOf("// MARK: - Check-in");
  const to = from < 0 ? -1 : models.indexOf("\n// MARK:", from + 1);
  if (from < 0 || to < 0) throw new Error(`could not find the Check-in section in ${MODELS}`);
  const section = models.slice(from, to);
  for (const needle of ["struct CheckinPreview", "struct CheckinStatus", "struct CheckinResult", "enum CheckinWords"]) {
    if (!section.includes(needle)) throw new Error(`the Check-in section is missing ${needle} (markers moved?)`);
  }

  const str = (s) => JSON.stringify(s);
  const opt = (s) => (s === null ? "nil" : str(s));
  const main = `
func read<T: Decodable>(_ name: String, _ type: T.Type) -> T {
    let url = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent(name)
    return try! JSONDecoder().decode(type, from: try! Data(contentsOf: url))
}
let errors: [String] = [${ERRORS.map(str).join(", ")}]
${modes.map((m) => `print(CheckinWords.modeLine(mode: ${str(m)}, intervalHours: ${INTERVAL_HOURS}))`).join("\n")}
${sends.map((s) => `print(CheckinWords.sendLine(wouldSend: ${s.wouldSend}, heldBy: ${opt(s.heldBy)}, mode: ${str(s.mode)}, off: ${s.off ? `[${s.off.map(str).join(", ")}]` : "nil"}))`).join("\n")}
${statuses.map((s) => `print(CheckinWords.runNote(status: ${str(s)}, title: ${str(TITLE)}, errors: errors))`).join("\n")}
print(CheckinWords.runNote(status: "error", title: "", errors: []))
${statuses.map((s) => `print(CheckinWords.runLabel(${str(s)}))`).join("\n")}
${switchSets.map((set) => `do { let off = CheckinWords.offKinds(${set ? `[${Object.entries(set).map(([k, v]) => `${str(k)}: ${v}`).join(", ")}]` : "nil"}); print("[\\(off.joined(separator: ","))] \\(CheckinWords.offLine(off))") }`).join("\n")}
for s in CheckinWords.sources { print("\\(s.kind)|\\(s.label)|\\(s.hint)") }
${bucketCases.map((b) => `do { let b: CheckinBucket? = ${b ? `CheckinBucket(bucket: ${opt(b.bucket)}, reason: ${opt(b.reason)})` : "nil"}; print("\\(CheckinWords.bucketRank(b)) \\(CheckinWords.bucketLine(b))") }`).join("\n")}
${["on", "log", "off", null, "typo"].map((m) => `print(CheckinWords.sortLine(${opt(m)}))`).join("\n")}
${["mail:18c2ab", "task:4", "mail:", ""].map((k) => `print("[\\(CheckinWords.messageId(${str(k)}))]")`).join("\n")}
let orderItems = [${orderItems.map((i) => `CheckinItem(key: ${str(i.key)}, kind: "mail", title: "", detail: "", fresh: false, triggers: true)`).join(", ")}]
let orderBuckets: [String: CheckinBucket] = [${Object.entries(orderBuckets).map(([k, v]) => `${str(k)}: CheckinBucket(bucket: ${opt(v.bucket)}, reason: ${opt(v.reason)})`).join(", ")}]
print(CheckinWords.mailOrder(orderItems, buckets: orderBuckets).map(\\.key).joined(separator: ","))
print(CheckinWords.mailOrder(orderItems, buckets: nil).map(\\.key).joined(separator: ","))
print("--")
let preview = read("preview.json", CheckinPreview.self)
for g in CheckinWords.groups(preview.items) { print("\\(g.label)=\\(g.items.map(\\.title).joined(separator: "|"))") }
print("--")
print(preview.title)
print(preview.wouldSend, preview.heldBy ?? "nil", preview.mode, preview.items.filter { $0.fresh && $0.triggers }.count)
let status = read("status.json", CheckinStatus.self)
print(status.intervalHours, status.mode, status.pushDetail, status.runs.count, status.runs[0].status, status.runs[0].errors.count, status.lastRun != nil, status.lastError != nil)
let results = read("results.json", [CheckinResult].self)
print(results.map { "\\($0.status):\\($0.fresh):\\($0.total)" }.joined(separator: ","))
let previewOff = read("preview-off.json", CheckinPreview.self)
print(previewOff.off ?? [], CheckinWords.groups(previewOff.items).map(\\.kind), preview.off ?? ["nil"], CheckinWords.offKinds(status.sources))
let labelled = read("preview-buckets.json", CheckinPreview.self)
print(status.sortMode ?? "nil", preview.buckets == nil, CheckinWords.bucketLine(labelled.buckets?["mail:m1"]), CheckinWords.bucketLine(labelled.buckets?["mail:m2"]), CheckinWords.bucketLine(labelled.buckets?["mail:m3"]) == "")
let reply = read("reply.json", CheckinReply.self)
print(reply.ok, reply.confirmationId ?? -1, reply.message)
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-screen-"));
  try {
    fs.writeFileSync(path.join(dir, "preview.json"), JSON.stringify(preview));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
    // What GET /api/checkin/preview adds when sorting is on, and what "Draft a reply" answers.
    fs.writeFileSync(path.join(dir, "preview-buckets.json"), JSON.stringify({ ...preview, buckets: { "mail:m1": { bucket: "urgent", reason: "deadline" }, "mail:m2": { bucket: null, reason: null } } }));
    fs.writeFileSync(path.join(dir, "reply.json"), JSON.stringify({ confirmationId: 12, message: "A reply is drafted and waiting for you to read and approve.", ok: true }));
    fs.writeFileSync(path.join(dir, "preview-off.json"), JSON.stringify(previewOff));
    fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify([result, failedRun]));
    fs.writeFileSync(path.join(dir, "Checkin.swift"), `import Foundation\n\n${section}\n`);
    fs.writeFileSync(path.join(dir, "main.swift"), `import Foundation\n${main}`);
    const bin = path.join(dir, "run");
    const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(dir, "mc") };
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(dir, "mc"), path.join(dir, "Checkin.swift"), path.join(dir, "main.swift"), "-o", bin], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [words, grouped, decoded] = execFileSync(bin, [dir], { encoding: "utf8" }).trim().split("\n--\n").map((part) => part.split("\n"));
    check("every sentence is the same on the app as on the web", words.join("\n"), webLines.join("\n"));
    check("the same number of sentences were compared", String(words.length), String(webLines.length));
    check("the list is grouped the same way", grouped.join("\n"), webGroups.join("\n"));
    check("the app reads the preview's notification", decoded[0], preview.title);
    check("... and its flags and new mail", decoded[1], `true nil log 2`);
    check("the app reads the status and its log", decoded[2], `${INTERVAL_HOURS} log senders 2 error 1 true true`);
    // The server's preview does not list what is off; the app reads that from the status alone.
    check("the app reads which sources are off from the status", decoded[4], `[] ["mail", "approval", "task", "headsup"] ["nil"] ["calendar"]`);
    check("the app reads the sorting mode and a mail's label, and an older server's preview has none", decoded[5], "on true Urgent: it has a deadline Unsorted true");
    check("the app reads what Draft a reply answers", decoded[6], "true 12 A reply is drafted and waiting for you to read and approve.");
    check("the app reads what Check now reports", decoded[3], `logged:2:${result.total},error:0:${failedRun.total}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  could not compile or run the Check-in section of Models.swift\n${error.stderr?.toString() ?? error}`);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
} else {
  console.log("  SKIP  no swiftc, so the app half did not run");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
