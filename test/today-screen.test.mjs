/**
 * The Today screen says the same thing on the web, the iPhone and the Mac
 * (PLAN-open-work section 14, U1 and U2).
 *
 * The three screens are three files in two languages. What they must agree on is the
 * sentences: the three-line brief, how long an approval has left, the line under a task, the
 * word for what a scheduled run did, and a schedule's skipped run. Those are pure functions,
 * `web/src/lib/today.ts` and `TodayWords` in `ios/AgentSpine/Core/Models.swift`, and this runs
 * one list of cases through both and compares every line. The Swift half also decodes a real
 * brief as `src/today.ts` builds it, so a field renamed on the server fails here.
 *
 *   node test/today-screen.test.mjs      (the Swift half is skipped without swiftc)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-today-screen-"));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";

const words = await import("../web/src/lib/today.ts");
const { assembleToday } = await import("../src/today.ts");

const REPO = path.dirname(import.meta.dirname);
const MODELS = path.join(REPO, "ios/AgentSpine/Core/Models.swift");

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
};

// --- one list of cases -----------------------------------------------------------------------
const dones = [
  { failed: 0, ok: 0, skipped: 0, stalled: 0 },
  { failed: 0, ok: 1, skipped: 0, stalled: 0 },
  { failed: 1, ok: 3, skipped: 0, stalled: 0 },
  { failed: 2, ok: 0, skipped: 1, stalled: 1 },
  { failed: 0, ok: 0, skipped: 1, stalled: 0 },
];
const waitings = [
  { approvals: 0, headsups: 0, tasks: 0, threads: 0 },
  { approvals: 1, headsups: 0, tasks: 0, threads: 0 },
  { approvals: 2, headsups: 1, tasks: 1, threads: 1 },
  { approvals: 0, headsups: 3, tasks: 2, threads: 4 },
];
const firsts = [
  { id: null, kind: "none", reason: "none", title: "" },
  { id: 4, kind: "approval", reason: "expiring", title: "Trash 4 messages" },
  { id: 3, kind: "task", reason: "overdue", title: "Call the permit office" },
  { id: 7, kind: "task", reason: "due-today", title: "Send Ridgeline the measurements" },
  { id: 2, kind: "approval", reason: "waiting", title: "Draft an email to jordan@ridgeline.example" },
  { id: 8, kind: "headsup", reason: "waiting", title: "Garrett's birthday" },
  { id: 9, kind: "task", reason: "something-new", title: "A reason a newer server added" },
];
const hours = [null, 0, 1, 2, 47, 48, 49, 72, 200];
const taskLines = [
  { overdue: true, waitingOn: null },
  { overdue: false, waitingOn: null },
  { overdue: true, waitingOn: "Sam Rivera" },
  { overdue: false, waitingOn: "" },
];
const sinceKinds = ["ok", "failed", "stalled", "stopped", "skipped", "something-new"];
const laters = [0, 1, 5];
const skips = [
  ["7:00 AM", "It was 3 hours late, past 2 hours, most likely because the server was asleep or stopped. It will run at its next scheduled time."],
  ["", "It was 3 hours late."],
  ["Nov 26, 7:00 AM", null],
  ["", "   "],
];
const NOW = "2026-06-15T14:30:00.000Z";
const expiries = [null, "2026-06-15T14:29:00.000Z", "2026-06-15T15:29:59.000Z", "2026-06-15T15:30:00.000Z", "2026-06-17T14:30:00Z", "not a date"];

const webLines = [
  ...dones.map(words.todayDoneLine),
  ...waitings.map(words.todayWaitingLine),
  ...firsts.map(words.todayFirstLine),
  ...hours.map(words.todayExpiryLine),
  ...taskLines.map(words.todayTaskLine),
  ...sinceKinds.map(words.todaySinceLabel),
  ...laters.map(words.todayLaterLine),
  ...skips.map(([slot, reason]) => words.scheduleSkipLine(slot, reason)),
  ...expiries.map((e) => String(words.hoursUntil(e, Date.parse(NOW)))),
  words.todayBriefText({ done: dones[2], first: firsts[2], waiting: waitings[2] }),
];

console.log("\nTHE WEB'S WORDS");
check("nothing ran", webLines[0], "No scheduled job has run since you last looked.");
check("what ran, only the kinds that happened", words.todayDoneLine(dones[3]), "Scheduled jobs since you last looked: 2 failed, 1 stalled, 1 skipped.");
check("nothing waiting", words.todayWaitingLine(waitings[0]), "Nothing is waiting on you.");
check("each kind, with its plural", words.todayWaitingLine(waitings[2]), "Waiting on you: 2 approvals, 1 task due, 1 heads-up, 1 unread reply.");
check("plurals the other way", words.todayWaitingLine(waitings[3]), "Waiting on you: 2 tasks due, 3 heads-ups, 4 unread replies.");
check("an expiring approval is first", words.todayFirstLine(firsts[1]), 'Do first: answer "Trash 4 messages" before it expires.');
check("an overdue task", words.todayFirstLine(firsts[2]), 'Do first: "Call the permit office", which is overdue.');
check("a reason this build does not know still reads", words.todayFirstLine(firsts[6]), 'Do first: answer "A reason a newer server added".');
check("no expiry says nothing", words.todayExpiryLine(null), "");
check("the last hour, hours, then days at 48", [0, 1, 47, 48, 72].map(words.todayExpiryLine), ["expires within the hour", "expires in 1 hour", "expires in 47 hours", "expires in 2 days", "expires in 3 days"]);
check("a task's line", taskLines.map(words.todayTaskLine), ["overdue", "due today", "overdue · waiting on Sam Rivera", "due today"]);
check("a skipped run with its time and reason", words.scheduleSkipLine("7:00 AM", "It was 3 hours late."), "Skipped the 7:00 AM run. It was 3 hours late.");
check("a skipped run with neither", words.scheduleSkipLine("", null), "Skipped a run.");
check("whole hours left, never negative", expiries.map((e) => words.hoursUntil(e, Date.parse(NOW))), [null, 0, 0, 1, 48, null]);

// --- the same cases through the Swift ------------------------------------------------------------
const swiftc = (() => {
  try {
    const found = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: ["swiftc"], cmd: "xcrun" };
  } catch {
    /* fall through */
  }
  try {
    const found = execFileSync("which", ["swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: [], cmd: found };
  } catch {
    /* none */
  }
  return null;
})();

console.log("\nTHE APP'S WORDS, AND WHAT IT CAN DECODE");
if (!swiftc) {
  console.log("  SKIP  no swiftc on this machine");
} else {
  try {
    const source = fs.readFileSync(MODELS, "utf8");
    const start = source.indexOf("// MARK: - Today\n");
    const end = source.indexOf("\n// MARK:", start + 10);
    if (start < 0) throw new Error("Models.swift has no '// MARK: - Today' section");
    const section = `import Foundation\n${source.slice(start, end < 0 ? undefined : end)}`;
    for (const need of ["struct TodayBrief", "struct TodayApproval", "enum TodayWords"]) if (!section.includes(need)) throw new Error(`the Today section has no ${need}`);

    // A real brief, as the server builds it, for the decode half.
    const at = (h) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
    const today = assembleToday(
      {
        approvals: [{ conversation_id: 3, id: 9, summary: "Draft an email to sam@example.com\nHi Sam", tool: "draft", ts: at(60) }],
        expireAfterMin: 4320,
        headsups: [],
        later: {},
        looked: at(12),
        runs: [{ finished: at(2), id: 1, note: "Three things today.", schedule_id: 1, scheduleName: "Morning brief", status: "ok", task: "Summarise today" }],
        schedules: [{ id: 2, last_skip_at: at(1), last_skip_reason: "It was 3 hours late.", last_skip_slot: at(4), name: "Inbox cleanup" }],
        tasks: [{ due: at(30), id: 5, title: "Call the permit office", waiting_on: "Sam Rivera" }],
        threads: [{ id: 7, title: "Trip planning", updated: at(3) }],
      },
      new Date(NOW),
    );
    const s = (v) => JSON.stringify(v ?? "");
    const opt = (v) => (v === null ? "nil" : typeof v === "number" ? String(v) : JSON.stringify(v));
    const main = `import Foundation
let dones: [(Int, Int, Int, Int)] = [${dones.map((d) => `(${d.ok}, ${d.failed}, ${d.stalled}, ${d.skipped})`).join(", ")}]
for d in dones { print(TodayWords.doneLine(TodayBrief.Done(failed: d.1, ok: d.0, skipped: d.3, stalled: d.2))) }
let waitings: [(Int, Int, Int, Int)] = [${waitings.map((w) => `(${w.approvals}, ${w.tasks}, ${w.headsups}, ${w.threads})`).join(", ")}]
for w in waitings { print(TodayWords.waitingLine(TodayBrief.Waiting(approvals: w.0, headsups: w.2, tasks: w.1, threads: w.3))) }
let firsts: [(String, String, String)] = [${firsts.map((f) => `(${s(f.kind)}, ${s(f.reason)}, ${s(f.title)})`).join(", ")}]
for f in firsts { print(TodayWords.firstLine(TodayBrief.First(id: nil, kind: f.0, reason: f.1, title: f.2))) }
let hours: [Int?] = [${hours.map(opt).join(", ")}]
for h in hours { print(TodayWords.expiryLine(h)) }
let taskLines: [(Bool, String?)] = [${taskLines.map((t) => `(${t.overdue}, ${opt(t.waitingOn)})`).join(", ")}]
for t in taskLines { print(TodayWords.taskLine(overdue: t.0, waitingOn: t.1)) }
for k in [${sinceKinds.map(s).join(", ")}] { print(TodayWords.sinceLabel(k)) }
for n in [${laters.join(", ")}] { print(TodayWords.laterLine(n)) }
let skips: [(String, String?)] = [${skips.map(([slot, reason]) => `(${s(slot)}, ${opt(reason)})`).join(", ")}]
for k in skips { print(TodayWords.scheduleSkipLine(slot: k.0, reason: k.1)) }
let now = TodayWords.parse(${s(NOW)})!
let expiries: [String?] = [${expiries.map(opt).join(", ")}]
for e in expiries { print(TodayWords.hoursUntil(e, now: now).map(String.init) ?? "null") }
print(TodayWords.briefText(TodayBrief(
  done: TodayBrief.Done(failed: ${dones[2].failed}, ok: ${dones[2].ok}, skipped: ${dones[2].skipped}, stalled: ${dones[2].stalled}),
  first: TodayBrief.First(id: nil, kind: ${s(firsts[2].kind)}, reason: ${s(firsts[2].reason)}, title: ${s(firsts[2].title)}),
  waiting: TodayBrief.Waiting(approvals: ${waitings[2].approvals}, headsups: ${waitings[2].headsups}, tasks: ${waitings[2].tasks}, threads: ${waitings[2].threads}))))
print("--")
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
func load<T: Decodable>(_ name: String, _ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: Data(contentsOf: dir.appendingPathComponent(name))) }
do {
  let brief = try load("brief.json", TodayBrief.self)
  print(TodayWords.briefText(brief))
  let approvals = try load("approvals.json", [TodayApproval].self)
  print(approvals.map { "\\($0.id) \\($0.conversationId ?? -1) \\($0.expiringSoon) \\($0.text.count) \\(TodayWords.hoursUntil($0.expiresAt, now: now) ?? -1)" }.joined(separator: ","))
  let tasks = try load("tasks.json", [TodayTask].self)
  print(tasks.map { "\\($0.id) \\(TodayWords.taskLine(overdue: $0.overdue, waitingOn: $0.waitingOn))" }.joined(separator: ","))
  let since = try load("since.json", [TodaySince].self)
  print(since.map { "\\($0.title): \\(TodayWords.sinceLabel($0.kind))" }.joined(separator: ","))
  let threads = try load("threads.json", [TodayThread].self)
  let mail = try load("mail.json", [TodayMail].self)
  print("\\(threads.count) \\(mail.count) \\(mail.first?.bucket ?? "")")
} catch { print("DECODE FAILED: \\(error)") }
`;
    fs.writeFileSync(path.join(tmp, "Today.swift"), section);
    fs.writeFileSync(path.join(tmp, "main.swift"), main);
    for (const [name, value] of [
      ["brief.json", today.brief],
      ["approvals.json", today.approvals],
      ["tasks.json", today.tasks],
      ["since.json", today.since],
      ["threads.json", today.threads],
      ["mail.json", [{ bucket: "urgent", key: "mail:1", sender: "Sam Rivera", subject: "Lease" }]],
    ])
      fs.writeFileSync(path.join(tmp, name), JSON.stringify(value));
    const bin = path.join(tmp, "run");
    const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(tmp, "mc") };
    execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(tmp, "mc"), path.join(tmp, "Today.swift"), path.join(tmp, "main.swift"), "-o", bin], { env, stdio: ["ignore", "pipe", "pipe"] });
    const [lines, decoded] = execFileSync(bin, [tmp], { encoding: "utf8" }).trimEnd().split("\n--\n");
    const swiftLines = lines.split("\n");
    check("the same number of sentences", swiftLines.length, webLines.length);
    const differ = webLines.map((w, i) => (w === swiftLines[i] ? null : { got: swiftLines[i], i, want: w })).filter(Boolean);
    check("every sentence matches the web's", differ, []);
    const d = decoded.split("\n");
    check("a real brief decodes and reads the same", d[0], words.todayBriefText(today.brief));
    check("an approval decodes with its thread, its full text and its hours", d[1], `9 3 true ${today.approvals[0].text.length} ${words.hoursUntil(today.approvals[0].expiresAt, Date.parse(NOW))}`);
    check("a task decodes", d[2], "5 overdue · waiting on Sam Rivera");
    check("what happened since decodes, newest first", d[3], "Inbox cleanup: skipped,Morning brief: finished");
    check("threads and the mail slot decode", d[4], "1 1 urgent");
  } catch (error) {
    failed++;
    console.log(`  FAIL  could not compile or run the Today section\n${error.stderr?.toString() ?? error}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(tmp, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
