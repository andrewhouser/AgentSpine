/**
 * The refusal tier: calls nobody can approve (PLAN-open-work section 12, D2).
 *
 * Every irreversible action could be approved, and four recorded skips could each let one
 * run without asking: `policy.autoApprove`, `policy.userDirected`, `policy.trust.chatAutoTools`
 * and a schedule's pre-approval. `forbidden` is the tier none of them reach. Its first
 * members are browser clicks and submits that read as moving money between accounts or
 * trading, and `policy.browser.neverDomains` refuses by where the page is.
 *
 * What this pins:
 *   - one test per skip path, each proving the call is still refused and never queued;
 *   - an approval card queued before a call became forbidden does not run it;
 *   - the browser's three word lists: refused, queued even unattended, queued in chat;
 *   - a never-domain is refused for both page tools, grows under a project overlay and never
 *     shrinks, and a page that lands on one is left;
 *   - the registry pass: an irreversible tool either asks when unattended or is on a short
 *     list with the reason it does not, so a new one fails here until a person has looked.
 *
 *   node test/forbidden-tier.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-forbidden-"));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.CONFIRM_EXPIRE_AFTER_MIN = "1440";
// The approval path reads policy from disk; give it one of ours, not the owner's.
process.env.POLICY_PATH = path.join(tmp, "policy.json");
fs.writeFileSync(
  process.env.POLICY_PATH,
  JSON.stringify({ apps: { allow: [] }, autoExecute: { irreversibleAlwaysConfirm: true, reversible: true }, browser: { enabled: true, navigateAllowlist: [] }, version: 1 }),
);

const store = await import("../src/memory/store.ts");
const { registry } = await import("../src/tools/index.ts");
const { executeCall } = await import("../src/broker.ts");
const { approveConfirmation } = await import("../src/confirmations.ts");
const { __test: browserTest, neverDomain } = await import("../src/tools/browser.ts");
const { narrowPolicy } = await import("../src/projects/narrow-policy.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const pending = () => rawDb.prepare("SELECT COUNT(*) AS n FROM confirmations WHERE state = 'pending'").get().n;
const newRun = (kind = "chat") => store.startRun({ kind, task: "probe" });

// A stand-in for a forbidden call. `ran` is the proof: it must stay at zero throughout.
let ran = 0;
let tier = "forbidden";
registry.__fake_bank = {
  argsSchema: "{}",
  checkPolicy: () => ({ allowed: true, reason: "ok" }),
  classify: () => ({ reason: "it moves money between accounts", reversibility: tier, summary: "Move $500 out", target: "bank" }),
  description: "test only",
  // Says the user's own message asked for exactly this, the strongest claim a tool can make.
  directed: () => ({ action: "move", reason: "the user asked for it" }),
  name: "__fake_bank",
  run: async () => {
    ran++;
    return "moved";
  },
};
const call = { args: {}, tool: "__fake_bank" };
const base = { autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true } };
const chat = { conversational: true, goal: "move $500 out of checking" };
const scheduled = { approvedTask: "move $500 out of checking every Friday", conversational: false, goal: "nightly", preApproved: true };

const refused = async (label, policy, run) => {
  const before = pending();
  const runId = newRun(run?.preApproved ? "schedule" : "chat");
  const r = await executeCall(call, policy, runId, runId, run);
  check(label, [r.status, ran, pending() - before, r.confirmationId ?? null], ["denied", 0, 0, null]);
  return r;
};

console.log("\nEVERY SKIP PATH — still refused, never queued, never run");
{
  const plain = await refused("with nothing set: denied, not queued", base, chat);
  check("the denial says why", /it moves money between accounts/.test(plain.output), true);
  check("the denial says no approval allows it", /No approval or setting allows it/.test(plain.output), true);

  await refused("policy.autoApprove names this exact tool and target", { ...base, autoApprove: [{ target: "bank", tool: "__fake_bank" }] }, chat);
  await refused(
    "policy.userDirected lists the action and the tool says it was asked for",
    { ...base, userDirected: { actions: ["__fake_bank.move"], enabled: true } },
    chat,
  );
  await refused("policy.trust.chatAutoTools trusts the tool in a live chat", { ...base, trust: { chatAutoTools: ["__fake_bank"] } }, chat);
  await refused("a schedule's pre-approval, with the task text naming it", base, scheduled);
  await refused(
    "all four at once",
    { ...base, autoApprove: [{ target: "bank", tool: "__fake_bank" }], trust: { chatAutoTools: ["__fake_bank"] }, userDirected: { actions: ["__fake_bank.move"], enabled: true } },
    { ...chat, preApproved: true },
  );
  await refused("irreversibleAlwaysConfirm off, when everything else runs unasked", { autoExecute: { dryRun: false, irreversibleAlwaysConfirm: false, reversible: true } }, chat);
  const dry = await refused("a dry run reports a denial, not what it would have done", { autoExecute: { dryRun: true, irreversibleAlwaysConfirm: true, reversible: true } }, chat);
  check("... and does not say EXECUTED or QUEUED", /would have been/.test(dry.output), false);
  await refused("no run context at all", base, undefined);

  const row = rawDb.prepare("SELECT decision, reversibility, output FROM actions WHERE tool = '__fake_bank' ORDER BY id DESC LIMIT 1").get();
  check("the audit row is an ordinary denial with the reason", [row.decision, row.reversibility, /moves money/.test(row.output)], ["denied", "forbidden", true]);
}

console.log("\nAN OLD APPROVAL CARD — approving it does not run a call that became forbidden");
{
  tier = "irreversible";
  const runId = newRun();
  const queued = await executeCall(call, base, runId, runId, chat);
  check("while it was only irreversible it queued", [queued.status, ran], ["queued", 0]);
  tier = "forbidden";
  const outcome = await approveConfirmation(queued.confirmationId, { resume: false });
  const state = rawDb.prepare("SELECT state, result FROM confirmations WHERE id = ?").get(queued.confirmationId);
  check("approving it is refused", [outcome.ok, ran], [false, 0]);
  check("the card is closed as rejected, with the reason", [state.state, /refused whoever approves/.test(state.result ?? "")], ["rejected", true]);

  // A classifier that throws at approval time is not a way through either.
  tier = "irreversible";
  const again = await executeCall(call, base, runId, runId, chat);
  const real = registry.__fake_bank.classify;
  registry.__fake_bank.classify = () => {
    throw new Error("boom");
  };
  const broken = await approveConfirmation(again.confirmationId, { resume: false });
  check("a classifier that throws at approval refuses too", [broken.ok, ran], [false, 0]);
  registry.__fake_bank.classify = real;
  tier = "forbidden";
}
delete registry.__fake_bank;

// --- the browser: the first members ------------------------------------------------------
const browser = registry.browser;
const click = (description, selector = "#go") => ({ action: "click", description, selector });
const tierOf = (args) => browser.classify(args).reversibility;

console.log("\nTHE BROWSER — moving money and trading are refused");
for (const [label, args] of [
  ["transfer", click("Transfer $500 to external account")],
  ["withdraw", click("Withdraw funds")],
  ["a withdrawal", click("Confirm withdrawal")],
  ["a wire", click("Send wire")],
  ["send money", click("Send money to Sam Rivera")],
  ["cash out", click("Cash out balance")],
  ["selling shares", click("Sell 10 shares of ACME")],
  ["buying stock", click("Buy stock")],
  ["buying crypto", click("Buy $50 of bitcoin")],
  ["placing a trade", click("Place trade")],
  ["named only by the selector", click(undefined, "button.transfer-funds")],
  ["submitting a transfer form", { action: "submit", selector: "form#transfer" }],
]) {
  check(label, tierOf(args), "forbidden");
}
check("the reason names moving money", browser.classify(click("Transfer $500")).reason, "it reads as moving money between accounts");
check("the reason names trading", browser.classify(click("Sell 10 shares of ACME")).reason, "it reads as trading securities");

console.log("\nTHE BROWSER — buying goods stays something you can approve");
for (const [label, args, want] of [
  ["place order", click("Place order"), "irreversible"],
  ["buy now", click("Buy now"), "irreversible"],
  ["pay", click("Pay $42.00"), "irreversible"],
  ["buying stock photos is a purchase, not a trade", click("Buy stock photos"), "irreversible"],
  ["a plain submit", { action: "submit", selector: "form#search" }, "irreversible"],
  ["a click with nothing risky in it", click("Next page"), "reversible"],
  ["typing an amount into a transfer form is not the commit", { action: "type", selector: "#transfer-amount", text: "500" }, "reversible"],
  ["opening a page", { action: "navigate", url: "https://example.com/transfer" }, "reversible"],
  ["a word that only contains one", click("Open the wireframe"), "reversible"],
]) {
  check(label, tierOf(args), want);
}

console.log("\nTHE BROWSER THROUGH THE BROKER — refused from a chat and from a schedule");
{
  const policy = { ...base, browser: { enabled: true, navigateAllowlist: [] }, trust: { chatAutoTools: ["browser"] } };
  for (const [label, run] of [
    ["a chat that trusts the browser", chat],
    ["a scheduled run", scheduled],
  ]) {
    const before = pending();
    const runId = newRun();
    const r = await executeCall({ args: click("Transfer $500 to external account"), tool: "browser" }, policy, runId, runId, run);
    check(label, [r.status, pending() - before], ["denied", 0]);
  }
}

// --- neverDomains ------------------------------------------------------------------------
console.log("\nNEVER DOMAINS — refused by where the page is");
{
  const policy = { ...base, browser: { enabled: true, navigateAllowlist: [], neverDomains: ["bank.example", "https://Broker.Example/login", "*.pay.example", ".vault.example"] } };
  for (const [host, want] of [
    ["bank.example", "bank.example"],
    ["www.bank.example", "bank.example"],
    ["online.secure.bank.example", "bank.example"],
    ["broker.example", "broker.example"],
    ["app.pay.example", "pay.example"],
    ["vault.example", "vault.example"],
    ["notbank.example", null],
    ["bank.example.evil.test", null],
    ["example.com", null],
    ["", null],
  ]) {
    check(`${host || "(no host)"}`, neverDomain(policy, host), want);
  }
  check("no list means none", neverDomain({ browser: { enabled: true, navigateAllowlist: [] } }, "bank.example"), null);

  const nav = { action: "navigate", url: "https://www.bank.example/accounts" };
  check("the browser's gate refuses the navigation", browser.checkPolicy(policy, nav).allowed, false);
  check("... and says no approval changes that", /no approval changes that/.test(browser.checkPolicy(policy, nav).reason), true);
  check("another site is still allowed", browser.checkPolicy(policy, { action: "navigate", url: "https://example.com/" }).allowed, true);
  check("web_read refuses it too", registry.web_read.checkPolicy(policy, { url: "https://bank.example/rates" }).allowed, false);
  check("the allowlist does not let it back in", browser.checkPolicy({ ...policy, browser: { ...policy.browser, navigateAllowlist: ["bank.example"] } }, nav).allowed, false);

  // Gate 1, so the confirmation skips never see it.
  for (const [label, p, run] of [
    ["a chat that trusts the browser", { ...policy, trust: { chatAutoTools: ["browser"] } }, chat],
    ["a scheduled run", policy, scheduled],
    ["policy.autoApprove naming the site", { ...policy, autoApprove: [{ target: "www.bank.example", tool: "browser" }] }, chat],
  ]) {
    const before = pending();
    const runId = newRun();
    const r = await executeCall({ args: nav, tool: "browser" }, p, runId, runId, run);
    check(`${label}: denied, not queued`, [r.status, pending() - before], ["denied", 0]);
  }
}

console.log("\nNEVER DOMAINS — a page that lands on one is left");
{
  const policy = { browser: { enabled: true, navigateAllowlist: [], neverDomains: ["bank.example"] } };
  const page = (url) => {
    const p = { at: url, goto: async (to) => void (p.at = to), url: () => p.at };
    return p;
  };
  const landed = page("https://login.bank.example/session");
  const said = await browserTest.leftNeverDomain(landed, policy);
  check("it says it refused", /^REFUSED: the page was on login\.bank\.example/.test(said ?? ""), true);
  check("the tab is left on a blank page", landed.at, "about:blank");
  const fine = page("https://example.com/");
  check("an ordinary page is left alone", [await browserTest.leftNeverDomain(fine, policy), fine.at], [null, "https://example.com/"]);
  check("no policy means nothing to refuse", await browserTest.leftNeverDomain(page("https://bank.example/"), undefined), null);
}

console.log("\nNEVER DOMAINS — a project can add one and can never take one away");
{
  const full = (browser) => ({
    apps: { allow: [] },
    autoExecute: { irreversibleAlwaysConfirm: true, reversible: true },
    browser,
    budgets: {},
    fs: { readableDirs: [] },
    google: { enabled: false },
    version: 1,
    web: { fetchAllowlist: [], searchEnabled: false },
  });
  const owner = full({ enabled: true, navigateAllowlist: [], neverDomains: ["bank.example"] });
  check("an overlay adds a site", narrowPolicy(owner, { browser: { neverDomains: ["broker.example"] } }).browser.neverDomains, ["bank.example", "broker.example"]);
  check("an empty overlay list removes nothing", narrowPolicy(owner, { browser: { neverDomains: [] } }).browser.neverDomains, ["bank.example"]);
  check("an overlay that does not mention it removes nothing", narrowPolicy(owner, { browser: { enabled: true } }).browser.neverDomains, ["bank.example"]);
  check("the same site twice is listed once", narrowPolicy(owner, { browser: { neverDomains: ["bank.example"] } }).browser.neverDomains, ["bank.example"]);
  check("none anywhere leaves the field off", "neverDomains" in narrowPolicy(full({ enabled: true, navigateAllowlist: [] }), {}).browser, false);
}

// --- the registry pass ---------------------------------------------------------------------
//
// F8 and F9 were found one tool at a time, so on 2026-11-26 every tool was read with one
// question: what can a scheduled run, steered by a page or an email it read, do with this?
// A schedule's pre-approval skips the queue for an irreversible call unless the tool sets
// `confirmWhenUnattended` or refuses a run nobody is watching. This reads the source, like
// test/architecture.test.mjs: a tool file that can classify a call irreversible must do one
// of those, or be listed here with the reason it deliberately does neither. A new tool
// therefore fails until a person has asked the question of it.
console.log("\nTHE REGISTRY PASS — an irreversible tool asks when unattended, or says why not");
{
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const reviewed = {
    // Writes proposed text into the drafts folder and nowhere else. Nothing is sent, and a
    // schedule that drafts replies is the ordinary use.
    "tools/draft.ts": "a draft is proposed text in the drafts folder; nothing is sent",
    // The inbox cleanup's own job. Its protections are code: inbox mail only, never anyone you
    // have emailed, never starred or sent mail, a cap on changes per run, and Gmail keeps
    // trashed mail for 30 days.
    "tools/gmail-triage.ts": "trash and spam are the inbox cleanup's job, bounded in code",
    // Same refusals as gmail_triage, and the request is a bare POST with no cookies to the
    // one-click link the mail itself carries.
    "tools/gmail-unsubscribe.ts": "one-click unsubscribe is the inbox cleanup's job, with gmail_triage's refusals",
  };
  // A tool that refuses every run nobody is watching needs no flag: there is no unattended call to ask about.
  const refusesUnattended = (src) => /!run\.conversational|!run\?\.conversational/.test(src);

  const files = [...fs.readdirSync(path.join(root, "tools")).map((f) => `tools/${f}`), "mcp/register.ts"].filter((f) => f.endsWith(".ts"));
  const unanswered = [];
  const stale = new Set(Object.keys(reviewed));
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    if (!/"irreversible"/.test(src)) continue;
    if (/confirmWhenUnattended\s*[:,]/.test(src) || refusesUnattended(src)) continue;
    if (reviewed[rel]) {
      stale.delete(rel);
      continue;
    }
    unanswered.push(rel);
  }
  check("no irreversible tool is unanswered", unanswered, []);
  check("the reviewed list holds nothing that no longer needs it", [...stale], []);

  // The three the pass fixed, pinned by behaviour: each skipped the queue from a schedule.
  for (const name of ["git_write", "write_file", "edit_file", "move_file", "study_topic"]) {
    check(`${name} asks from an unattended run`, registry[name].confirmWhenUnattended, true);
  }
  const runId = newRun("schedule");
  const dry = { autoExecute: { dryRun: true, irreversibleAlwaysConfirm: true, reversible: true } };
  const del = await executeCall({ args: { action: "delete", topic: "Okta" }, tool: "study_topic" }, dry, runId, runId, scheduled);
  check("a scheduled run deleting a study topic would be queued", /would have been QUEUED/.test(del.output), true);
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(tmp, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
