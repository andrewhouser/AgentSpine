/**
 * The iOS models against real server output — a contract test across a language boundary.
 * Run with `node test/ios-models.test.mjs`.
 *
 * ## The failure this exists to catch
 *
 * `/api/builds` is produced by src/builds.ts and consumed by `Build` in
 * ios/AgentSpine/Core/Models.swift, and nothing connects the two but a field name. Rename a
 * column on the server, or make a nullable one non-optional in Swift, and **both sides still
 * compile**: the app type-checks, the server type-checks, and `JSONDecoder` throws on a real
 * device with a real user watching. Xcode cannot catch it, `tsc` cannot catch it, and the
 * iOS app has no test target of its own.
 *
 * So this runs the actual decode. The structs are **extracted from Models.swift**, never
 * retyped here — a copy would drift from the app and then pass forever while the app broke.
 * If the extraction markers go missing it throws rather than quietly testing nothing.
 *
 * ## Why it may skip
 *
 * It needs `swiftc`, which not every machine running `npm test` has. Without it the test
 * prints SKIP and exits 0: a missing compiler is not a failing contract. `Codable` needs no
 * SwiftUI macros, so this works where a full `-typecheck` of the app does not — which is the
 * whole reason this check is possible at all in a sandbox.
 *
 * It also compiles those structs against Foundation ALONE. If a future field drags SwiftUI
 * into `Build`, this fails at the compile step. That is intentional: a wire model should be
 * plain data.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.dirname(import.meta.dirname);

/**
 * How to invoke the compiler.
 *
 * On a Mac it has to go THROUGH `xcrun`, not via the path `xcrun --find` returns: that path
 * is real and executable, but running it directly leaves SDKROOT unset and the compiler
 * cannot load the standard library — `unable to load standard library for target …`, which
 * reads like a broken toolchain and is really a missing environment. Elsewhere (a Linux
 * toolchain, say) there is no xcrun and a plain `swiftc` on PATH is invoked directly.
 */
const findSwiftc = () => {
  try {
    const found = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: ["swiftc"], cmd: "xcrun" };
  } catch {
    /* no xcrun — fall through to a bare toolchain */
  }
  try {
    const found = execFileSync("which", ["swiftc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && fs.existsSync(found)) return { args: [], cmd: found };
  } catch {
    /* no swiftc at all */
  }
  return null;
};

const swiftc = findSwiftc();
if (!swiftc) {
  console.log("\n  SKIP  no swiftc on this machine — the iOS models cannot be checked here\n");
  process.exit(0);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-ios-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.AGENTSPINE_BACKUP_DIR = path.join(root, "backups");

// --- a repository with a branch, a commit, and an untracked file ---
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
const policyPath = path.join(root, "policy.json");
fs.writeFileSync(
  policyPath,
  JSON.stringify({
    autoExecute: { irreversibleAlwaysConfirm: true, reversible: true },
    build: { enabled: true, repos: { [repo]: { defaultBranch: "main", gitWrite: true } } },
    fs: { readableDirs: [root], writableDirs: [root] },
    version: 1,
  }),
);
process.env.POLICY_PATH = policyPath;

const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
git("config", "user.email", "test@example.invalid");
git("config", "user.name", "Test");
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
git("add", "-A");
git("commit", "-m", "initial");
git("switch", "-c", "agentspine/demo");
fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
git("add", "-A");
git("commit", "-m", "second line");
fs.writeFileSync(path.join(repo, "new.rs"), "fn main() {}\n");

const store = await import("../src/memory/store.ts");
const { recordDeliverable } = await import("../src/deliverables.ts");
const { buildDiff, listBuilds } = await import("../src/builds.ts");

const log = (runId, tool, args, target, decision, output) =>
  store.logAction(runId, { args, tool }, { reversibility: "reversible", summary: "", target }, decision, output);

// A full build…
const full = store.startRun({ kind: "subagent", task: "add a --json flag" });
log(full, "git_write", { branch: "agentspine/demo", repo, verb: "branch" }, `${repo}@main`, "executed", "created");
log(full, "run_command", { name: "test", repo }, `${repo}#test`, "executed", "$ cargo test\nin r — FAILED (exit 101) in 9.2s");
log(full, "run_command", { name: "test", repo }, `${repo}#test`, "executed", "$ cargo test\nin r — PASSED (exit 0) in 9.4s");
log(full, "git_write", { message: "second line", repo, verb: "commit" }, `${repo}@agentspine/demo`, "executed", "committed");
log(full, "run_command", { name: "deploy", repo }, `${repo}#deploy`, "denied", "DENIED: not declared");
recordDeliverable(path.join(repo, "a.txt"), "edit", full);
store.finishRun(full, "ok", "Done.");

// …and the null cases, which are the ones an optional in Swift gets wrong.
const branchOnly = store.startRun({ kind: "do", task: null });
log(branchOnly, "git_write", { branch: "agentspine/x", repo, verb: "branch" }, `${repo}@main`, "executed", "created");

const noTarget = store.startRun({ kind: "do", task: "unresolvable" });
log(noTarget, "run_command", { name: "test" }, "", "error", "ERROR: could not run");

fs.writeFileSync(path.join(root, "builds.json"), JSON.stringify(listBuilds()));
fs.writeFileSync(path.join(root, "diff.json"), JSON.stringify(await buildDiff(full)));

// --- /api/meetings/live while recording ---
// The phone polls this every few seconds. `elapsedMs` comes from the listener's byte count,
// and ffmpeg's pipe reads are arbitrary lengths, so the count is rarely a whole number of
// milliseconds. 2,749,066 bytes is the reading that produced 85908.3125 on a real device and
// failed the whole decode. Shaped exactly as `liveStatus()` in src/meetings/session.ts
// returns it, which can't be called here without a running ffmpeg capture.
const { Listener } = await import("../src/senses/listen.ts");
const listener = new Listener({ device: "USB PnP Sound Device", live: true });
listener.retainedBytes = 2_749_066;
fs.writeFileSync(
  path.join(root, "live.json"),
  JSON.stringify({
    device: "USB PnP Sound Device",
    elapsedMs: listener.elapsedMs,
    meetingId: 12,
    pendingChunks: listener.pendingChunks,
    recording: true,
  }),
);

// --- /api/study, /api/study/due and a review, from src/study/review.ts ---
// The grade comes from a scripted asker; the shapes are the real ones. Two topics: one with a
// project, a goal, a level and a curriculum, and one with none of those, because the nulls
// are what an optional in Swift gets wrong.
const study = await import("../src/study/store.ts");
const { __setAsker } = await import("../src/study/roles.ts");
const { dueForScreen, reviewWithRecall, studyOverview } = await import("../src/study/review.ts");
__setAsker(async () => ({ feedback: "close enough", score: 0.8 }));
const okta = study.ensureTopic("OAuth and Okta");
study.updateTopic(okta.id, {
  goal: "answer identity questions at PI planning",
  level: 3,
  map: [{ dependsOn: [], name: "Tokens", stumbling: ["scopes"], summary: "what a token is" }],
  projectId: 7,
});
study.ensureTopic("Bare topic");
const c1 = study.addCard(okta.id, "What does PKCE protect?", "The authorization code.");
study.addCard(okta.id, "Name the PKCE values", "verifier, challenge, method");
fs.writeFileSync(path.join(root, "study-due.json"), JSON.stringify(dueForScreen()));
fs.writeFileSync(path.join(root, "study-review.json"), JSON.stringify(await reviewWithRecall(c1, "the auth code")));
fs.writeFileSync(path.join(root, "study-overview.json"), JSON.stringify(studyOverview()));

// --- heads-up: real server output, for the app's Headsup models ---
// Everything here is produced by the server's own functions, so a renamed field breaks this test
// instead of a phone. The cards are set explicitly so the assertions in Swift are exact.
process.env.EMBEDDINGS_URL = "";
const hLedger = await import("../src/headsup/ledger.ts");
const hCards = await import("../src/headsup/research/cards.ts");
const hDates = await import("../src/headsup/dates.ts");
const { researchHeadsup } = await import("../src/headsup/research/run.ts");
const { runMorningHeadsup } = await import("../src/headsup/morning.ts");
const hNow = new Date(2026, 10, 18, 8, 0);
const hCand = (kind, subject, key, extra = {}) => ({ daysUntil: 10, dedupeKey: key, fingerprint: "", kind, location: "", sourceId: key, startsAt: "2026-11-28", subject, timeSensitive: false, ...extra });

// A birthday, answered yes and researched. The first research run (no web) and a failing one are
// kept as the "what Look again reports" fixtures; then the cards are replaced with exact ones.
const bday = hLedger.markOffered(hCand("birthday", "Garrett's Birthday", "ios:b"), 0, hNow);
hLedger.answer(bday.id, "yes", hNow);
const researchDeps = (over = {}) => ({
  allNames: () => ["Garrett"], getPage: async () => ({ ok: false, reason: "HTTP 403" }), image: async () => null, now: () => hNow, place: () => "Asheville, NC",
  recipient: async () => ({ cuisines: [], interests: ["coffee"], namesSeen: [], relationship: "sibling" }),
  search: async () => [], searchAllowed: () => true, send: async () => {}, ...over,
});
const researchOk = await researchHeadsup(bday.id, researchDeps());
const researchErr = await researchHeadsup(bday.id, researchDeps({ search: async () => { throw new Error("provider down"); } }));
fs.writeFileSync(path.join(root, "headsup-research.json"), JSON.stringify([researchOk, researchErr]));
hCards.replaceCards(bday.id, [
  { amount: 42.5, currency: "USD", host: "shop.example", imageId: 3, kind: "gift", note: "A pour-over set", priceText: "$42.50", title: "Pour-Over Set", url: "https://shop.example/p/1" },
  { host: "guide.example", kind: "link", note: "A blocked page", title: "Best coffee gifts", url: "https://guide.example/best" },
], hNow);
hLedger.markResearched(bday.id, { note: "", query: "birthday gift ideas for a sibling who likes coffee" }, hNow);

hLedger.markOffered(hCand("bill", "Electric bill $140", "ios:bill", { amount: "$140", daysUntil: 5, startsAt: "2026-11-23T09:00:00-05:00" }), 0, hNow);
const anniv = hLedger.markOffered(hCand("anniversary", "Your Anniversary", "ios:a"), 0, hNow);
hLedger.answer(anniv.id, "later", hNow);
// A flight with a watch started: the "watch" object an app has to decode.
const { enableWatch: hEnableWatch } = await import("../src/headsup/watch/enable.ts");
const flightRow = hLedger.markOffered(hCand("flight", "Flight to Denver", "ios:f", { flightNumber: "UA 482", startsAt: "2026-11-20T14:00:00-05:00" }), 0, hNow);
hLedger.answer(flightRow.id, "yes", hNow);
hEnableWatch(hLedger.getById(flightRow.id), hNow);
const headsupsJson = JSON.stringify(hLedger.listForClient("all", 500));
// The narrow push token must never be part of what any client is sent.
if (/answer_token|answerToken|headsupToken/i.test(headsupsJson)) throw new Error("a push token leaked into the /api/headsups payload");
fs.writeFileSync(path.join(root, "headsups.json"), headsupsJson);

// Dates: one remembered, one noticed in chat and waiting to be confirmed.
hDates.addDate({ day: 4, month: 3, occasion: "birthday", who: "Garrett" }, hNow);
hDates.proposeDatesFromChat("Mia's birthday is June 9");
fs.writeFileSync(path.join(root, "headsup-dates.json"), JSON.stringify(hDates.datesForClient()));

// What "Check now" reports: a quiet day, and a calendar that could not be read.
const runDeps = (fetchEvents) => ({ fetchEvents, googleEnabled: () => true, remembered: () => [], send: async () => {} });
const runNothing = await runMorningHeadsup(hNow, { force: true }, runDeps(async () => ({ errors: [], events: [] })));
const runError = await runMorningHeadsup(hNow, { force: true }, runDeps(async () => { throw new Error("Google API HTTP 401"); }));
fs.writeFileSync(path.join(root, "headsup-run.json"), JSON.stringify([runNothing, runError]));

// --- the models, taken from the app rather than restated ---
const modelsPath = path.join(REPO, "ios", "AgentSpine", "Core", "Models.swift");
const models = fs.readFileSync(modelsPath, "utf8");
const START = "// MARK: - Builds";
const END = "/// A file the assistant wrote for you.";
const from = models.indexOf(START);
const to = models.indexOf(END);
if (from < 0 || to < 0 || to < from) {
  throw new Error(`could not find the Builds section in ${modelsPath} (markers: "${START}" … "${END}")`);
}
const section = models.slice(from, to);
for (const needle of ["struct BuildCommand", "struct Build:", "struct BuildDiff"]) {
  if (!section.includes(needle)) throw new Error(`the extracted section is missing ${needle} — markers moved?`);
}
const liveFrom = models.indexOf("struct MeetingLiveStatus:");
const liveTo = liveFrom < 0 ? -1 : models.indexOf("\n}\n", liveFrom);
if (liveFrom < 0 || liveTo < 0) throw new Error(`could not find struct MeetingLiveStatus in ${modelsPath}`);
const liveSection = models.slice(liveFrom, liveTo + 3);

const studyFrom = models.indexOf("// MARK: - Study");
const studyTo = studyFrom < 0 ? -1 : models.indexOf("\n// MARK:", studyFrom + 1);
if (studyFrom < 0 || studyTo < 0) throw new Error(`could not find the Study section in ${modelsPath}`);
const studySection = models.slice(studyFrom, studyTo);
for (const needle of ["struct StudyOverview", "struct StudyTopic", "struct StudyDueCard", "struct StudyReview"]) {
  if (!studySection.includes(needle)) throw new Error(`the Study section is missing ${needle} — markers moved?`);
}

const hFrom = models.indexOf("// MARK: - Heads-up");
const hTo = hFrom < 0 ? -1 : models.indexOf("\n// MARK:", hFrom + 1);
if (hFrom < 0 || hTo < 0) throw new Error(`could not find the Heads-up section in ${modelsPath}`);
const headsupSection = models.slice(hFrom, hTo);
for (const needle of ["struct HeadsupCard", "struct HeadsupWatch", "struct Headsup:", "struct HeadsupProposal", "struct RememberedDate", "struct HeadsupDates", "struct HeadsupRunResult", "struct HeadsupResearchResult"]) {
  if (!headsupSection.includes(needle)) throw new Error(`the Heads-up section is missing ${needle} — markers moved?`);
}

const main = [
  "",
  "let dec = JSONDecoder()",
  'func load(_ p: String) -> Data { try! Data(contentsOf: URL(fileURLWithPath: p)) }',
  "var failed = 0",
  "var passed = 0",
  'func check(_ label: String, _ ok: Bool, _ detail: String = "") {',
  '    print("  \\(ok ? "PASS" : "FAIL")  \\(label.padding(toLength: 54, withPad: " ", startingAt: 0))\\(ok ? "" : detail)")',
  "    if ok { passed += 1 } else { failed += 1 }",
  "}",
  "do {",
  "    let builds = try dec.decode([Build].self, from: load(CommandLine.arguments[1]))",
  '    check("the list decodes at all", builds.count == 3, "got \\(builds.count)")',
  '    let b = builds.first(where: { $0.branch == "agentspine/demo" })!',
  '    check("run_id maps onto runID", b.runID > 0, "\\(b.runID)")',
  '    check("id is the run id", b.id == b.runID)',
  '    check("every command survives the wire", b.commands.count == 5, "\\(b.commands.count)")',
  '    check("a verdict string arrives intact", b.commands[2].verdict == "PASSED (exit 0)", b.commands[2].verdict)',
  '    check("a denial keeps its decision", b.commands[4].decision == "denied", b.commands[4].decision)',
  '    check("ok true renders as passed", b.verdict == "passed", b.verdict)',
  '    check("repoName shortens the path", b.repoName == "repo", b.repoName)',
  '    check("commits are a number", b.commits == 1, "\\(b.commits)")',
  '    check("files written", b.files == ["a.txt"], "\\(b.files)")',
  '    check("the task comes through", b.task == "add a --json flag", b.task ?? "nil")',
  "    let none = builds.first(where: { $0.ok == nil })",
  '    check("a null ok decodes to nil, not false", none != nil)',
  '    check("and stays three-valued in the UI", none?.verdict == "no command ran", none?.verdict ?? "nil")',
  '    check("a null task decodes to nil", builds.contains { $0.task == nil })',
  '    check("a null repo never breaks repoName", builds.allSatisfy { !$0.repoName.isEmpty })',
  "",
  "    let diff = try dec.decode(BuildDiff.self, from: load(CommandLine.arguments[2]))",
  '    check("the diff decodes", diff.branch == "agentspine/demo", diff.branch ?? "nil")',
  '    check("against the right base", diff.base == "main", diff.base ?? "nil")',
  '    check("stat is populated", diff.stat.contains("a.txt"), diff.stat)',
  '    check("the patch carries the change", diff.patch.contains("+two"))',
  '    check("untracked is a list of names", diff.untracked == ["new.rs"], "\\(diff.untracked)")',
  "} catch {",
  '    print("  FAIL  decoding threw: \\(error)")',
  "    failed += 1",
  "}",
  "do {",
  "    let live = try dec.decode(MeetingLiveStatus.self, from: load(CommandLine.arguments[3]))",
  '    check("live status decodes mid-recording", live.recording)',
  '    check("elapsedMs is whole milliseconds", live.elapsedMs == 85908, "\\(live.elapsedMs)")',
  '    check("meetingId maps onto meetingID", live.meetingID == 12, "\\(live.meetingID ?? -1)")',
  "} catch {",
  '    print("  FAIL  live status threw: \\(error)")',
  "    failed += 1",
  "}",
  "do {",
  "    let ov = try dec.decode(StudyOverview.self, from: load(CommandLine.arguments[4]))",
  '    check("the study overview decodes", ov.topics.count == 2, "\\(ov.topics.count)")',
  '    let t = ov.topics.first(where: { $0.name == "OAuth and Okta" })!',
  '    check("projectId maps onto projectID", t.projectID == 7, "\\(t.projectID ?? -1)")',
  '    check("a level and a goal come through", t.level == 3 && t.goal != nil)',
  '    check("the curriculum decodes in order", t.map.first?.name == "Tokens")',
  '    let bare = ov.topics.first(where: { $0.name == "Bare topic" })!',
  '    check("a topic with no goal/level/project decodes nils", bare.goal == nil && bare.level == nil && bare.projectID == nil)',
  '    check("an empty curriculum is an empty list", bare.map.isEmpty)',
  "    let due = try dec.decode([StudyDueCard].self, from: load(CommandLine.arguments[5]))",
  '    check("due cards decode", due.count == 2, "\\(due.count)")',
  '    check("topicId maps onto topicID", due[0].topicID == t.id, "\\(due[0].topicID)")',
  "    let r = try dec.decode(StudyReview.self, from: load(CommandLine.arguments[6]))",
  '    check("a review decodes", r.score == 0.8, "\\(r.score)")',
  '    check("cardId maps onto cardID", r.cardID == due[0].id, "\\(r.cardID)")',
  '    check("interval arrives as a number of days", r.interval == 1, "\\(r.interval)")',
  "} catch {",
  '    print("  FAIL  study threw: \\(error)")',
  "    failed += 1",
  "}",
  "do {",
  "    let hs = try dec.decode([Headsup].self, from: load(CommandLine.arguments[7]))",
  '    check("heads-ups decode", hs.count == 4, "\\(hs.count)")',
  '    let b = hs.first(where: { $0.kind == "birthday" })!',
  '    check("a researched birthday keeps its state", b.state == "researched", b.state)',
  '    check("its cards arrive in order", b.cards.map { $0.title } == ["Pour-Over Set", "Best coffee gifts"], "\\(b.cards.map { $0.title })")',
  '    check("the exact query comes through", b.query == "birthday gift ideas for a sibling who likes coffee", b.query ?? "nil")',
  '    let g = b.cards[0]',
  '    check("priceText arrives", g.priceText == "$42.50", g.priceText ?? "nil")',
  '    check("amount is a number", g.amount == 42.5, "\\(g.amount ?? -1)")',
  '    check("imageUrl maps onto imageURL", g.imageURL == "/api/headsups/images/3", g.imageURL ?? "nil")',
  '    check("a card kind is a string", g.kind == "gift", g.kind)',
  '    let l = b.cards[1]',
  '    check("a link card has no price or photo", l.priceText == nil && l.imageURL == nil && l.amount == nil)',
  '    check("a note survives", l.note == "A blocked page", l.note ?? "nil")',
  '    let bill = hs.first(where: { $0.kind == "bill" })!',
  '    check("a bill keeps its amount", bill.amount == "$140", bill.amount ?? "nil")',
  '    check("a bill is open and has no cards", bill.state == "offered" && bill.cards.isEmpty)',
  '    check("a timed due date is a string", bill.dueAt == "2026-11-23T09:00:00-05:00", bill.dueAt)',
  '    check("unset fields decode as nil, not absent", bill.query == nil && bill.researchError == nil && bill.researchNote == nil && bill.snoozeUntil == nil)',
  '    check("an all-day due date stays a bare date", b.dueAt == "2026-11-28", b.dueAt)',
  '    let a = hs.first(where: { $0.kind == "anniversary" })!',
  '    check("a snoozed item has its snooze time", a.state == "snoozed" && a.snoozeUntil != nil)',
  '    check("the server says what Yes does on a birthday", b.yesAction == "research" && b.yesLabel == "Yes, find gift ideas", b.yesLabel)',
  '    check("... and on a bill", bill.yesAction == "ack" && bill.yesLabel == "Got it", bill.yesLabel)',
  '    check("... and an item with no watch has none", b.watch == nil && bill.watch == nil)',
  '    let fl = hs.first(where: { $0.kind == "flight" })!',
  '    check("a flight offers to track itself", fl.yesAction == "watch" && fl.yesLabel == "Yes, track this flight", fl.yesLabel)',
  '    check("its watch decodes", fl.watch != nil && fl.watch!.kind == "flight" && fl.watch!.active)',
  '    check("... lastPolled is nil before the first check", fl.watch!.lastPolled == nil)',
  '    check("... and the note says what is needed", (fl.watch!.note ?? "").contains("Tracking starts once it is"), fl.watch!.note ?? "nil")',
  '    check("the answer is recorded", a.answer == "later", a.answer ?? "nil")',
  "",
  "    let d = try dec.decode(HeadsupDates.self, from: load(CommandLine.arguments[8]))",
  '    check("remembered dates decode", d.remembered.count == 1 && d.remembered[0].who == "Garrett", "\\(d.remembered.count)")',
  '    check("with their month and day", d.remembered[0].month == 3 && d.remembered[0].day == 4)',
  '    check("and a readable title", d.remembered[0].title == "Garrett\'s Birthday, every March 4", d.remembered[0].title)',
  '    check("a proposal decodes", d.proposals.count == 1, "\\(d.proposals.count)")',
  '    check("confirmationId maps onto confirmationID", d.proposals[0].confirmationID > 0, "\\(d.proposals[0].confirmationID)")',
  '    check("the proposal names who and when", d.proposals[0].who == "Mia" && d.proposals[0].month == 6 && d.proposals[0].day == 9)',
  '    check("id is the confirmation id", d.proposals[0].id == d.proposals[0].confirmationID)',
  '    check("the card text is the server\'s", d.proposals[0].summary.hasPrefix("REMEMBER A DATE:"), d.proposals[0].summary)',
  "",
  "    let runs = try dec.decode([HeadsupRunResult].self, from: load(CommandLine.arguments[9]))",
  '    check("run results decode", runs.count == 2, "\\(runs.count)")',
  '    check("a quiet day", runs[0].status == "nothing" && runs[0].offered == 0 && runs[0].errors.isEmpty)',
  '    check("a calendar failure carries its reason", runs[1].status == "error" && runs[1].errors == ["Google API HTTP 401"], "\\(runs[1].errors)")',
  "",
  "    let rs = try dec.decode([HeadsupResearchResult].self, from: load(CommandLine.arguments[10]))",
  '    check("research results decode", rs.count == 2, "\\(rs.count)")',
  '    check("a finished run has no error and reports its query", rs[0].status == "done" && rs[0].error == nil && rs[0].query != nil)',
  '    check("a failed run has an error and no query", rs[1].status == "error" && rs[1].error == "provider down" && rs[1].query == nil)',
  "} catch {",
  '    print("  FAIL  heads-up threw: \\(error)")',
  "    failed += 1",
  "}",
  'print("RESULT \\(passed) \\(failed)")',
  "exit(failed == 0 ? 0 : 1)",
].join("\n");

const swiftFile = path.join(root, "decode.swift");
fs.writeFileSync(swiftFile, "import Foundation\n\n" + section + "\n" + liveSection + "\n" + studySection + "\n" + headsupSection + main);

// --- compile and run ---
const binary = path.join(root, "decode");
try {
  execFileSync(swiftc.cmd, [...swiftc.args, "-module-cache-path", path.join(root, "mc"), swiftFile, "-o", binary], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (err) {
  console.log("\n  FAIL  the models do not compile against Foundation alone\n");
  console.log(String(err.stderr ?? err.message).split("\n").slice(0, 20).join("\n"));
  fs.rmSync(root, { force: true, recursive: true });
  process.exit(1);
}

let output = "";
let code = 0;
try {
  output = execFileSync(binary, [
    path.join(root, "builds.json"),
    path.join(root, "diff.json"),
    path.join(root, "live.json"),
    path.join(root, "study-overview.json"),
    path.join(root, "study-due.json"),
    path.join(root, "study-review.json"),
    path.join(root, "headsups.json"),
    path.join(root, "headsup-dates.json"),
    path.join(root, "headsup-run.json"),
    path.join(root, "headsup-research.json"),
  ], {
    encoding: "utf8",
  });
} catch (err) {
  output = String(err.stdout ?? "");
  code = 1;
}

console.log("\nthe app's own Build/BuildCommand/BuildDiff, MeetingLiveStatus, Study and Heads-up models, decoding real server output\n");
console.log(output.split("\n").filter((l) => !l.startsWith("RESULT")).join("\n").trimEnd());

const tally = /RESULT (\d+) (\d+)/.exec(output);
const [, passed, failed] = tally ? tally : [null, "0", code ? "1" : "0"];
console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(Number(failed) ? 1 : 0);
