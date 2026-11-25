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

const { checkinGroups, checkinModeLine, checkinRunLabel, checkinRunNote, checkinSendLine } = await import("../web/src/lib/checkin.ts");
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
];
const statuses = ["sent", "logged", "nothing", "capped", "quiet", "off", "error", "something-new"];
const TITLE = "New message from Sam Rivera";
const ERRORS = ["mail: 503 from Gmail", "calendar: timed out"];

const webLines = [
  ...modes.map((m) => checkinModeLine(m, INTERVAL_HOURS)),
  ...sends.map((s) => checkinSendLine(s)),
  ...statuses.map((s) => checkinRunNote({ errors: ERRORS, status: s, title: TITLE })),
  checkinRunNote({ errors: [], status: "error", title: "" }),
  ...statuses.map((s) => checkinRunLabel({ status: s })),
];

console.log("\nTHE WEB'S WORDS");
check("switched off says how to switch it on", webLines[0].includes("CHECKIN_MODE=log"), true);
check("log mode says nothing is sent", webLines[1].includes("without sending"), true);
check("no new mail says so", webLines[modes.length], "No new mail from a person, so a check now would send nothing.");
check("a held message says it stays new", webLines[modes.length + 2].includes("stays new") && webLines[modes.length + 3].includes("stays new"), true);
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
const status = { intervalHours: INTERVAL_HOURS, lastError: store.lastError(), lastRun: store.lastRun(), mode: "log", pushDetail: "senders", runs: store.listRuns(20) };

console.log("\nTHE LIST");
const groups = checkinGroups(preview.items);
const webGroups = groups.map((g) => `${g.label}=${g.items.map((i) => i.title).join("|")}`);
check("mail first, then what rides along, in a fixed order", groups.map((g) => g.kind).join(), "mail,approval,calendar,task,headsup");
check("an empty kind has no section", checkinGroups(preview.items.filter((i) => i.kind !== "task")).some((g) => g.kind === "task"), false);
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
${sends.map((s) => `print(CheckinWords.sendLine(wouldSend: ${s.wouldSend}, heldBy: ${opt(s.heldBy)}, mode: ${str(s.mode)}))`).join("\n")}
${statuses.map((s) => `print(CheckinWords.runNote(status: ${str(s)}, title: ${str(TITLE)}, errors: errors))`).join("\n")}
print(CheckinWords.runNote(status: "error", title: "", errors: []))
${statuses.map((s) => `print(CheckinWords.runLabel(${str(s)}))`).join("\n")}
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
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-screen-"));
  try {
    fs.writeFileSync(path.join(dir, "preview.json"), JSON.stringify(preview));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
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
