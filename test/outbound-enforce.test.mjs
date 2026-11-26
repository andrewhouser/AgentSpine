/**
 * The check on text leaving the machine, with OUTBOUND_ENFORCE on
 * (src/outbound.ts, PLAN-open-work section 12, D3).
 *
 * The switch is read once at start, so this half runs in its own process;
 * test/outbound-check.test.mjs covers the three tests and the default log-only mode. Here a
 * match denies the call: it does not run, it is not queued for an approval card that would
 * show the text, a dry run does not report it as something that would have happened, and
 * the denial and the audit row name what matched without repeating it.
 *
 *   node test/outbound-enforce.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-outbound-enforce-"));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.OUTBOUND_ENFORCE = "true";

const store = await import("../src/memory/store.ts");
const { registry } = await import("../src/tools/index.ts");
const { executeCall } = await import("../src/broker.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
/** Key order is the database's, not ours, so rows are compared with their keys sorted. */
const sorted = (v) =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const CARD = "4111 1111 1111 1111";
const pending = () => rawDb.prepare("SELECT COUNT(*) AS n FROM confirmations WHERE state = 'pending'").get().n;
const chat = { conversational: true, goal: "send it" };
const scheduled = { approvedTask: "send the numbers every Friday", conversational: false, goal: "nightly", preApproved: true };
const policy = { autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true } };

let sent = 0;
const fake = (reversibility) => ({
  argsSchema: "{}",
  checkPolicy: () => ({ allowed: true, reason: "ok" }),
  classify: () => ({ reversibility, summary: "post", target: "example" }),
  description: "test only",
  name: "__fake_post",
  outboundText: (a) => [{ arg: "message", text: String(a?.message ?? "") }],
  run: async () => {
    sent++;
    return "posted";
  },
});
const post = async (message, p = policy, run = chat) => {
  const runId = store.startRun({ kind: run.preApproved ? "schedule" : "chat", task: "probe" });
  return executeCall({ args: { message }, tool: "__fake_post" }, p, runId, runId, run);
};

console.log("\nA MATCH DENIES THE CALL");
{
  registry.__fake_post = fake("reversible");
  const clean = await post("see you at four");
  check("clean text still runs", [clean.status, sent], ["executed", 1]);

  const hit = await post(`use ${CARD}`);
  check("a card number is denied and nothing is sent", [hit.status, sent], ["denied", 1]);
  check("the denial names the argument and the kind", [/"message"/.test(hit.output), /payment card number/.test(hit.output)], [true, true]);
  check("the denial never repeats the number", hit.output.includes("4111"), false);
  check("an SSN is denied", (await post("my SSN is 123-45-6789")).status, "denied");
  check("a credential is denied", (await post("password: hunter2-horse-staple")).status, "denied");

  const row = rawDb.prepare("SELECT tool, arg, kind, refused FROM outbound_checks ORDER BY id LIMIT 1").get();
  check("the match is recorded as refused", row, { arg: "message", kind: "card-number", refused: 1, tool: "__fake_post" });
  const audit = rawDb.prepare("SELECT decision, output FROM actions WHERE tool = '__fake_post' AND decision = 'denied' ORDER BY id LIMIT 1").get();
  check("the audit row is a denial that does not hold the number", [audit.decision, audit.output.includes("4111")], ["denied", false]);
}

console.log("\nIT IS NOT QUEUED EITHER — a card would show the text and could be approved");
{
  registry.__fake_post = fake("irreversible");
  const before = pending();
  const hit = await post(`use ${CARD}`);
  check("an irreversible call with a match is denied, not queued", [hit.status, pending() - before, hit.confirmationId ?? null], ["denied", 0, null]);
  const ok = await post("see you at four");
  check("the same call with clean text queues as before", [ok.status, pending() - before], ["queued", 1]);
  check("a scheduled run's pre-approval does not carry it through", [(await post(`use ${CARD}`, policy, scheduled)).status, sent], ["denied", 1]);
  const dry = await post(`use ${CARD}`, { autoExecute: { dryRun: true, irreversibleAlwaysConfirm: true, reversible: true } });
  check("a dry run reports the denial", [dry.status, /would have been/.test(dry.output)], ["denied", false]);
  delete registry.__fake_post;
}

console.log("\nTHE REAL TOOLS — refused before anything leaves");
{
  // Each call is stopped at the check, so nothing here reaches a network, a browser or Mail.
  const open = {
    apps: { allow: ["com.apple.mail", "com.apple.MobileSMS"] },
    autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true },
    browser: { enabled: true, navigateAllowlist: [] },
    web: { fetchAllowlist: [], searchEnabled: true },
  };
  for (const [label, tool, args, run] of [
    ["web_search query", "web_search", { query: `is ${CARD} a valid card` }, chat],
    ["browser typing", "browser", { action: "type", selector: "#card", text: CARD }, chat],
    ["browser address", "browser", { action: "navigate", url: `https://example.com/?card=4111111111111111` }, chat],
    ["web_read address", "web_read", { url: "https://example.com/?ssn=123-45-6789" }, chat],
    ["mac_control send_mail body", "mac_control", { action: "send_mail", body: `card ${CARD}`, subject: "Card", to: "sam@example.com" }, chat],
    ["mac_control send_message text", "mac_control", { action: "send_message", text: "SSN 123-45-6789", to: "sam@example.com" }, chat],
    ["notify body, asked for in the chat", "notify", { body: `card ${CARD}`, title: "Card" }, { conversational: true, goal: "send my card number to my phone as a notification" }],
  ]) {
    const runId = store.startRun({ kind: "chat", task: "probe" });
    const r = await executeCall({ args, tool }, open, runId, runId, run);
    check(label, [r.status, /Nothing was sent/.test(r.output)], ["denied", true]);
  }
  const runId = store.startRun({ kind: "chat", task: "probe" });
  const long = await executeCall({ args: { url: `https://example.com/doc/${"a1b2c3d4".repeat(5)}` }, tool: "web_read" }, { ...open, autoExecute: { ...open.autoExecute, dryRun: true } }, runId, runId, chat);
  check("an address with a long id is not a credential", long.status, "dry-run");
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(tmp, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
