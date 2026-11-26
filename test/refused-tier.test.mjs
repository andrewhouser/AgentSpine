/**
 * The refused tier (PLAN-open-work section 12 D2): a call a tool's `refuse` names never happens,
 * whoever approves. Each way past the confirmation queue is tried against the same call and must
 * still end in a denial: policy.autoApprove, policy.userDirected, policy.trust.chatAutoTools, a
 * scheduled run's pre-approval, and the confirmation queue itself (nothing is queued). Also
 * policy.browser.neverDomains, and that a refuser which throws refuses.
 *
 * No Chrome is needed: a refused call is stopped before the tool runs, and the control rows use
 * dry run. Run with `node test/refused-tier.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-refused-${process.pid}-${Date.now()}.db`);
// Approving a card reads the policy file, so the approval rows below get one of their own with the browser on.
process.env.POLICY_PATH = path.join(os.tmpdir(), `agentspine-refused-policy-${process.pid}-${Date.now()}.json`);
fs.writeFileSync(
  process.env.POLICY_PATH,
  JSON.stringify({ autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true }, browser: { enabled: true, navigateAllowlist: [], neverDomains: ["bank.example"] } }),
);
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";

const store = await import("../src/memory/store.ts");
const { registry } = await import("../src/tools/index.ts");
const { executeCall } = await import("../src/broker.ts");
const { approveConfirmation } = await import("../src/confirmations.ts");
const { narrowPolicy } = await import("../src/projects/narrow-policy.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const base = {
  autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true },
  browser: { enabled: true, navigateAllowlist: [] },
};
const chat = { conversational: true, goal: "move $500 to my savings" };
const job = { conversational: false, goal: "nightly", preApproved: true };

const call = async (args, policy, run) => {
  const runId = store.startRun({ kind: run.preApproved ? "schedule" : "chat", task: "probe" });
  const r = await executeCall({ args, tool: "browser" }, policy, runId, runId, run);
  return r.status;
};
const click = (description, selector = "#go") => ({ action: "click", description, selector });
const transfer = click("Transfer $500 to external account");

console.log("\nEVERY WAY PAST THE QUEUE — the same refused call, still refused");
{
  const pending = () => store.pendingConfirmationsBefore("9999-01-01T00:00:00.000Z").length;
  const queuedBefore = pending();
  check("plain chat turn", await call(transfer, base, chat), "denied");
  check("plain scheduled run", await call(transfer, base, job), "denied");
  check(
    "policy.autoApprove names this exact shape",
    await call(transfer, { ...base, autoApprove: [{ target: "browser", tool: "browser" }] }, chat),
    "denied",
  );
  check(
    "policy.trust.chatAutoTools lists the browser",
    await call(transfer, { ...base, trust: { chatAutoTools: ["browser"] } }, chat),
    "denied",
  );
  check(
    "policy.userDirected enabled, and the chat asked for it",
    await call(transfer, { ...base, userDirected: { actions: ["browser.click"], enabled: true } }, chat),
    "denied",
  );
  check("a scheduled run pre-approved", await call(transfer, base, { ...job, approvedTask: "move $500 to savings" }), "denied");
  check("nothing was queued, so there is nothing to approve", pending() - queuedBefore, 0);
  check(
    "dry run reports a refusal, not what it would have done",
    await call(transfer, { ...base, autoExecute: { ...base.autoExecute, dryRun: true } }, chat),
    "denied",
  );
}

console.log("\nWHAT READS AS MOVING MONEY OR TRADING");
for (const [label, args] of [
  ["withdraw", click("Withdraw funds")],
  ["wire transfer", click("Send wire")],
  ["buy shares", click("Buy 10 shares of VTI")],
  ["sell stock", click("Sell stock")],
  ["place a trade", click("Place trade")],
  ["a submit whose selector says transfer", { action: "submit", selector: "form#transfer" }],
]) {
  check(label, await call(args, base, job), "denied");
}

console.log("\nWHAT STAYS WHERE IT WAS (queue or run, not refused)");
const dry = { ...base, autoExecute: { ...base.autoExecute, dryRun: true } };
const would = async (args, run) => {
  const runId = store.startRun({ kind: "chat", task: "probe" });
  const r = await executeCall({ args, tool: "browser" }, dry, runId, runId, run);
  return /would have been (EXECUTED|QUEUED)/.exec(r.output)?.[1] ?? r.output;
};
check("placing an order for goods still queues", await would(click("Place order"), chat), "QUEUED");
check("paying still queues", await would(click("Pay $42.00"), chat), "QUEUED");
check("an ordinary click runs", await would(click("Next page"), chat), "EXECUTED");
check("a wireless router page is not 'wire'", await would(click("Wireless settings"), chat), "EXECUTED");

console.log("\npolicy.browser.neverDomains");
{
  const never = { ...base, browser: { ...base.browser, neverDomains: ["bank.example.com", "broker.example.org"] } };
  const nav = (url) => ({ action: "navigate", url });
  const wouldNav = async (url, policy) => {
    const runId = store.startRun({ kind: "chat", task: "probe" });
    const r = await executeCall({ args: nav(url), tool: "browser" }, { ...policy, autoExecute: { ...policy.autoExecute, dryRun: true } }, runId, runId, chat);
    return /would have been (EXECUTED|QUEUED)/.exec(r.output)?.[1] ?? r.output;
  };
  check("the host itself", await call(nav("https://bank.example.com/login"), never, chat), "denied");
  check("a subdomain", await call(nav("https://secure.broker.example.org/"), never, job), "denied");
  check("a host that only ends the same way is not matched", await wouldNav("https://notbank.example.com/", never), "EXECUTED");
  check("web_read refuses it too", registry.web_read.checkPolicy(never, { url: "https://bank.example.com/" }).allowed, false);
  check("web_read still reads another host", registry.web_read.checkPolicy(never, { url: "https://example.com/" }).allowed, true);
  const narrowed = narrowPolicy(never, { browser: { neverDomains: ["more.example.net"] } });
  check("a project overlay adds to the list and keeps the base's", narrowed.browser.neverDomains, ["bank.example.com", "broker.example.org", "more.example.net"]);
  const kept = narrowPolicy(never, { browser: { enabled: true } });
  check("an overlay that says nothing keeps the list", kept.browser.neverDomains, ["bank.example.com", "broker.example.org"]);
}

console.log("\nA REFUSER THAT THROWS REFUSES");
{
  let ran = 0;
  registry.__fake_refused = {
    argsSchema: "{}",
    checkPolicy: () => ({ allowed: true }),
    classify: () => ({ reversibility: "reversible", summary: "do it", target: "x" }),
    description: "test",
    name: "__fake_refused",
    refuse: () => {
      throw new Error("boom");
    },
    run: async () => {
      ran++;
      return "done";
    },
  };
  const runId = store.startRun({ kind: "chat", task: "probe" });
  const r = await executeCall({ args: {}, tool: "__fake_refused" }, base, runId, runId, chat);
  check("denied, and the tool did not run", [r.status, ran], ["denied", 0]);
  delete registry.__fake_refused;
}

console.log("\nAN OLD CARD — approving it does not run a call that is refused now");
{
  // The broker never queues a refused call, so this card is put in the queue the way an older version
  // left it: a transfer click from before the tier existed, when moving money only asked. (A click on a
  // page that has since gone onto neverDomains needs no row here: the browser checks where the page is
  // when it runs, approved or not.)
  const state = (id) => store.getConfirmation(id).state;
  let ran = 0;
  const real = registry.browser.run;
  registry.browser.run = async () => {
    ran++;
    return "clicked";
  };
  const runId = store.startRun({ kind: "chat", task: "probe" });
  const old = store.queueConfirmation({ args: transfer, tool: "browser" }, "Click Transfer $500 to external account", runId);
  const outcome = await approveConfirmation(old, { resume: false });
  check("approving a transfer card is refused, and nothing ran", [outcome.ok, ran, state(old)], [false, 0, "rejected"]);
  check("the answer says an approval does not change it", /approving it does not change that/.test(outcome.message), true);

  // Control: a card for an ordinary risky click still runs when approved.
  const buy = store.queueConfirmation({ args: click("Buy now"), tool: "browser" }, "Click Buy now", runId);
  const buyOutcome = await approveConfirmation(buy, { resume: false });
  check("control: an ordinary card runs when approved", [buyOutcome.ok, ran, state(buy)], [true, 1, "done"]);

  // A refuser that throws at approval refuses, as it does in the broker.
  const realRefuse = registry.browser.refuse;
  registry.browser.refuse = () => {
    throw new Error("boom");
  };
  const broken = store.queueConfirmation({ args: click("Buy now"), tool: "browser" }, "Click Buy now", runId);
  const brokenOutcome = await approveConfirmation(broken, { resume: false });
  check("a refuser that throws at approval refuses too", [brokenOutcome.ok, ran, state(broken)], [false, 1, "rejected"]);
  registry.browser.refuse = realRefuse;
  registry.browser.run = real;
}
fs.rmSync(process.env.POLICY_PATH, { force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
