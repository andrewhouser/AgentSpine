/**
 * What a scheduled run still asks about: buying or moving money through the browser (F8), and
 * mail or messages to someone its own task text does not name (F9, further down).
 *
 *   - A schedule's pre-approval lets its irreversible calls skip the queue, and the browser's
 *     risky clicks and form submits were among them. Found 2026-11-24: a scheduled run would
 *     click "Transfer $500 to external account" unasked, which matters when the browser is
 *     attached to a signed-in Chrome and the job has just read a page it does not control.
 *   - Clicks and submits that read as buying, paying or moving money now queue from an
 *     unattended run. A plain submit or send stays pre-approved, so a scheduled job can still
 *     use a search box.
 *   - `confirmWhenUnattended` can be a function of the call's arguments, which is what lets
 *     one tool queue some of its calls and not others.
 *
 * The browser rows run with `dryRun` on: the broker reports the decision it would take and
 * neither clicks nor queues, so no Chrome is needed.
 *
 * Run with `node test/unattended-asks.test.mjs`.
 */
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-unattended-asks-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";

const store = await import("../src/memory/store.ts");
const { registry } = await import("../src/tools/index.ts");
const { executeCall } = await import("../src/broker.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(62)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const scheduled = { conversational: false, goal: "nightly", preApproved: true };
const chat = { conversational: true, goal: "check the order page" };

/** What the broker would do with one browser call, read off its dry-run report. */
const dry = { autoExecute: { dryRun: true, irreversibleAlwaysConfirm: true, reversible: true }, browser: { enabled: true, navigateAllowlist: [] } };
const wouldBe = async (args, run) => {
  const runId = store.startRun({ kind: run.preApproved ? "schedule" : "chat", task: "probe" });
  const r = await executeCall({ args, tool: "browser" }, dry, runId, runId, run);
  return /would have been (EXECUTED|QUEUED)/.exec(r.output)?.[1] ?? r.output;
};
const click = (description, selector = "#go") => ({ action: "click", description, selector });

console.log("\nA SCHEDULED RUN — money and purchases ask");
for (const [label, args] of [
  ["place order", click("Place order")],
  ["buy now", click("Buy now")],
  ["checkout, named only by the selector", click(undefined, "button.checkout")],
  ["pay", click("Pay $42.00")],
  ["subscribe", click("Subscribe for $9 a month")],
  ["submitting a payment form", { action: "submit", selector: "form#pay" }],
  // Decided 2026-11-25 (D2): deleting or removing something asks from a schedule too.
  ["delete", click("Delete account")],
  ["remove", click("Remove from list")],
  ["delete, named only by the selector", click(undefined, "button.delete-item")],
]) {
  check(label, await wouldBe(args, scheduled), "QUEUED");
}

// Transfer, withdraw, wire and trades are no longer in these lists: they are refused outright,
// whoever approves (test/refused-tier.test.mjs), which is stricter than asking.

console.log("\nA SCHEDULED RUN — its ordinary work still does not ask");
for (const [label, args] of [
  ["submitting a search form", { action: "submit", selector: "form#search" }],
  ["a bare submit", { action: "submit" }],
  ["a click that sends", click("Send message")],
  ["a click that confirms", click("Confirm cookie choices")],
  ["a click with nothing risky in it", click("Next page")],
  ["opening a page", { action: "navigate", url: "https://example.com/" }],
]) {
  check(label, await wouldBe(args, scheduled), "EXECUTED");
}

console.log("\nA CHAT TURN — unchanged, every risky click and submit asks");
for (const [label, args] of [
  ["a click that sends", click("Send message")],
  ["submitting a search form", { action: "submit", selector: "form#search" }],
]) {
  check(label, await wouldBe(args, chat), "QUEUED");
}
check("a click with nothing risky in it runs", await wouldBe(click("Next page"), chat), "EXECUTED");

console.log("\nTHE FLAG AS A FUNCTION — decided per call, by code");
{
  let ran = 0;
  registry.__fake_shop = {
    argsSchema: "{}",
    checkPolicy: () => ({ allowed: true }),
    classify: (args) => ({ reversibility: "irreversible", summary: `do ${args.what}`, target: "shop" }),
    confirmWhenUnattended: (args) => args.what === "pay",
    description: "test",
    name: "__fake_shop",
    run: async () => {
      ran++;
      return "done";
    },
  };
  const policy = { autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true } };
  const runId = store.startRun({ kind: "schedule", task: "nightly" });
  const search = await executeCall({ args: { what: "search" }, tool: "__fake_shop" }, policy, runId, runId, scheduled);
  check("a call the function passes runs from a schedule", [search.status, ran], ["executed", 1]);
  const pay = await executeCall({ args: { what: "pay" }, tool: "__fake_shop" }, policy, runId, runId, scheduled);
  check("a call the function names queues, and does not run", [pay.status, ran], ["queued", 1]);

  // A function that throws must not become a way through the gate.
  registry.__fake_shop.confirmWhenUnattended = () => {
    throw new Error("boom");
  };
  const broken = await executeCall({ args: { what: "search" }, tool: "__fake_shop" }, policy, runId, runId, scheduled);
  check("a function that throws queues the call", [broken.status, ran], ["queued", 1]);
  delete registry.__fake_shop;
}


// --- Registry pass (2026-11-25) --------------------------------------------------------------
// Every other tool with an irreversible call was asked "what can a steered scheduled run do with
// this". These four could do something that leaves the machine or changes what code runs, and
// no schedule needs them unasked, so they now queue from one. The rest were left as they are on
// purpose, and the reason for each is in PLAN-open-work section 12 D2.
console.log("\nREGISTRY PASS — a scheduled run asks before these");
const fs = await import("node:fs");
const { execFileSync } = await import("node:child_process");
const probe = fs.mkdtempSync(path.join(os.tmpdir(), "spine-regpass-"));
fs.writeFileSync(path.join(probe, "package.json"), "{}\n");
fs.writeFileSync(path.join(probe, "x.json"), "{}\n");
execFileSync("git", ["init", "-q", probe]);
const regPolicy = {
  autoExecute: { dryRun: true, irreversibleAlwaysConfirm: true, reversible: true },
  build: { enabled: true, repos: { [probe]: { allowPush: true, gitWrite: true } } },
  fs: { readableDirs: [probe], writableDirs: [probe] },
};
const regWouldBe = async (tool, args, run) => {
  const runId = store.startRun({ kind: run.preApproved ? "schedule" : "chat", task: "probe" });
  const r = await executeCall({ args, tool }, regPolicy, runId, runId, run);
  return /would have been (EXECUTED|QUEUED)/.exec(r.output)?.[1] ?? r.output.slice(0, 60);
};
for (const [label, tool, args] of [
  ["write a build manifest", "write_file", { content: "{}", path: `${probe}/package.json` }],
  ["edit a build manifest", "edit_file", { find: "a", path: `${probe}/package.json`, replace: "b" }],
  ["move a build manifest away", "move_file", { from: `${probe}/package.json`, to: `${probe}/old-package.json` }],
  ["delete a study topic", "study_topic", { action: "delete", topic: "anything" }],
]) {
  check(label, await regWouldBe(tool, args, scheduled), "QUEUED");
}
check("an ordinary file write in a schedule still runs", await regWouldBe("write_file", { content: "x", path: `${probe}/notes.md` }, scheduled), "EXECUTED");
check("listing study topics in a schedule still runs", await regWouldBe("study_topic", { action: "list" }, scheduled), "EXECUTED");
check("git push asks from a schedule", await regWouldBe("git_write", { repo: probe, verb: "push" }, scheduled), "QUEUED");
check("git diff in a schedule still runs", await regWouldBe("git_write", { repo: probe, verb: "diff" }, scheduled), "EXECUTED");

// --- F9: mail and messages from a scheduled run ---------------------------------------------
//
// `mac_control` sends took the same path: with Mail or Messages allowlisted, a scheduled run
// could send to any address unasked, and a job that has just read a hostile page or email is
// the one that would. Now an unattended send asks unless the job's own task text, which the
// user wrote when they set it up, tells it to send to that recipient. A subagent's task is
// written by the model, so what counts is the root job's text, carried down as `approvedTask`.
// Dry run again: nothing is sent.
const macDry = {
  apps: { allow: ["com.apple.mail", "com.apple.MobileSMS", "com.apple.AddressBook", "com.apple.Notes"] },
  autoExecute: { dryRun: true, irreversibleAlwaysConfirm: true, reversible: true },
};
const macWouldBe = async (args, run) => {
  const runId = store.startRun({ kind: "schedule", task: "probe" });
  const r = await executeCall({ args, tool: "mac_control" }, macDry, runId, runId, run);
  return /would have been (EXECUTED|QUEUED)/.exec(r.output)?.[1] ?? r.output;
};
const job = (task, extra = {}) => ({ approvedTask: task, conversational: false, goal: task, preApproved: true, ...extra });
const mail = (to) => ({ action: "send_mail", body: "Here it is.", subject: "Weekly numbers", to });
const text = (to) => ({ action: "send_message", text: "Running late.", to });

console.log("\nA SCHEDULED SEND — to someone the job's own text names, it does not ask");
check("an address the task says to email", await macWouldBe(mail("sam@example.com"), job("Every Friday, email sam@example.com the weekly numbers.")), "EXECUTED");
check("a name the task says to email", await macWouldBe(mail("Sam Rivera"), job("Each morning send Sam Rivera an email with today's calendar.")), "EXECUTED");
check("a number the task says to text", await macWouldBe(text("+16035550100"), job("At 8am text (603) 555-0100 the forecast.")), "EXECUTED");

console.log("\nA SCHEDULED SEND — to anyone else, it asks");
const digestJob = "Every Friday, email sam@example.com the weekly numbers.";
check("an address the task never mentions", await macWouldBe(mail("mallory@example.net"), job(digestJob)), "QUEUED");
check("a message, when the task only asked for email", await macWouldBe(text("+16035550199"), job(digestJob)), "QUEUED");
check("no recipient at all", await macWouldBe(mail(undefined), job(digestJob)), "QUEUED");
check(
  "an address the task mentions, but not as who to send to",
  await macWouldBe(mail("billing@example.org"), job("Archive mail from billing@example.org. Then email sam@example.com a summary.")),
  "QUEUED",
);
check("a task with no send in it", await macWouldBe(mail("sam@example.com"), job("Summarise my unread mail and save it to a note.")), "QUEUED");

console.log("\nWHOSE WORDS COUNT — the user's task, never the model's");
// A subagent's goal is the brief its caller wrote. Naming a recipient there approves nothing.
check(
  "a subagent's brief names the address, the job's text does not",
  await macWouldBe(mail("mallory@example.net"), job(digestJob, { goal: "Email mallory@example.net the weekly numbers." })),
  "QUEUED",
);
check(
  "a subagent of the job may still send to who the job named",
  await macWouldBe(mail("sam@example.com"), job(digestJob, { goal: "Send the numbers on." })),
  "EXECUTED",
);
check(
  "pre-approved with no approved text on record asks",
  await macWouldBe(mail("sam@example.com"), { conversational: false, goal: digestJob, preApproved: true }),
  "QUEUED",
);

console.log("\nWHAT F9 LEAVES ALONE");
check("a scheduled job still writes a note unasked", await macWouldBe({ action: "create_note", body: "x", title: "Daily" }, job("Save a daily note.")), "EXECUTED");
check("a send nobody pre-approved queues, as before", await macWouldBe(mail("sam@example.com"), { conversational: false, goal: digestJob }), "QUEUED");

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(probe, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
