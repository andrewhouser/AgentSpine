/**
 * The outgoing-text check (PLAN-open-work section 12 D3): the scanner, then the broker with the
 * check log-only (the default) and enforcing (a second run of this file with OUTGOING_ENFORCE on).
 * Numbers here are invented or the well-known test numbers; none is a real card or person.
 *
 * Run with `node test/outgoing.test.mjs`.
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const enforcing = process.argv.includes("--enforce");
process.env.SPINE_DB_PATH = path.join(os.tmpdir(), `agentspine-outgoing-${enforcing ? "e" : "l"}-${process.pid}-${Date.now()}.db`);
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.OUTGOING_ENFORCE = enforcing ? "true" : "false";

const store = await import("../src/memory/store.ts");
const { scanOutgoing, stringLeaves } = await import("../src/outgoing.ts");
const { executeCall } = await import("../src/broker.ts");
const { registry } = await import("../src/tools/index.ts");
const { makeTool } = await import("../src/mcp/register.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const kinds = (s) => scanOutgoing([s]).map((f) => f.kind);

const policy = {
  apps: { allow: ["com.apple.mail", "com.apple.MobileSMS", "com.apple.AddressBook", "com.apple.Notes"] },
  autoExecute: { dryRun: true, irreversibleAlwaysConfirm: true, reversible: true },
  drafts: { enabled: true, dir: "/tmp/spine-drafts-unused" },
  mcp: { enabled: true, servers: { shop: { enabled: true, url: "http://127.0.0.1:1/" } } },
  web: { fetchAllowlist: [], searchEnabled: true },
};
const chat = { conversational: true, goal: "x" };
// A notification is refused in a live chat that did not ask for one, so those calls come from a job.
const job = { conversational: false, goal: "nightly" };
const call = async (tool, args, run = chat) => {
  const runId = store.startRun({ kind: "chat", task: "probe" });
  const r = await executeCall({ args, tool }, policy, runId, runId, run);
  const row = store.rawDb.prepare("SELECT output FROM actions WHERE run_id = ? ORDER BY id DESC LIMIT 1").get(runId);
  return { output: r.output, row: String(row?.output ?? ""), status: r.status };
};

if (!enforcing) {
  console.log("\nTHE SCANNER");
  check("a test Visa number", kinds("card 4111 1111 1111 1111 exp 12/29"), ["card number"]);
  check("dashes, and a 15-digit Amex test number", kinds("3782-822463-10005"), ["card number"]);
  check("no separators", kinds("4111111111111111"), ["card number"]);
  check("a 16-digit number that fails Luhn is not a card", kinds("order 4111 1111 1111 1112"), []);
  check("12 digits is too short, 20 too long", [kinds("411111111111"), kinds("41111111111111111111")], [[], []]);
  check("a phone number is not a card", kinds("call 415-555-0134 tomorrow"), []);
  check("an SSN with dashes", kinds("his number is 123-45-6789."), ["social security number"]);
  check("an SSN with spaces", kinds("123 45 6789"), ["social security number"]);
  check("nine bare digits are not an SSN", kinds("reference 123456789"), []);
  check("an area code the SSA never issued is not one", [kinds("000-12-3456"), kinds("666-12-3456"), kinds("912-12-3456")], [[], [], []]);
  check("a password after a label", kinds("the password: hunter2hunter2"), ["secret"]);
  check("a private key header", kinds("-----BEGIN RSA PRIVATE KEY-----"), ["secret"]);
  check("ordinary words are clean", kinds("Lunch at noon on Friday? Bring the Q3 deck."), []);
  check("a finding never repeats the value", JSON.stringify(scanOutgoing(["4111 1111 1111 1111"])).includes("4111"), false);
  check("non-strings are ignored", scanOutgoing([undefined, null, 5]).length, 0);
  check("stringLeaves reaches nested strings", stringLeaves({ a: "x", b: { c: ["y", 3] } }), ["x", "y"]);

  console.log("\nWHICH TOOLS DECLARE WHAT LEAVES");
  check("draft: subject and body", registry.draft.outgoingText({ body: "B", subject: "S", to: "t@example.com" }), ["S", "B"]);
  check("notify: title and body", registry.notify.outgoingText({ body: "B", title: "T" }), ["T", "B"]);
  check("web_search: the query", registry.web_search.outgoingText({ query: "q" }), ["q"]);
  check("mac_control: a mail send", registry.mac_control.outgoingText({ action: "send_mail", body: "B", subject: "S" }), ["S", "B"]);
  check("mac_control: a message send", registry.mac_control.outgoingText({ action: "send_message", text: "T" }), ["T"]);
  check("mac_control: a note stays on the machine", registry.mac_control.outgoingText({ action: "create_note", body: "B" }), []);
  check("browser: typing", registry.browser.outgoingText({ action: "type", selector: "#a", text: "T" }), ["T"]);
  check("browser: a click sends no text", registry.browser.outgoingText({ action: "click", text: "T" }), []);
  const mcp = makeTool("shop", { callTool: async () => "" }, { description: "d", inputSchema: { properties: { note: { type: "string" } } }, name: "order" });
  check("an MCP tool: every string argument", mcp.outgoingText({ note: "N", n: { deep: "D" } }), ["N", "D"]);
}

console.log(enforcing ? "\nTHE BROKER, ENFORCING" : "\nTHE BROKER, LOG ONLY (the default)");
{
  const dirty = await call("notify", { body: "card 4111 1111 1111 1111", title: "hi" }, job);
  const clean = await call("notify", { body: "back at 3", title: "hi" }, job);
  if (enforcing) {
    check("a card number in a notification is refused", dirty.status, "denied");
    check("the refusal names what matched, not the number", [/card number/.test(dirty.output), dirty.output.includes("4111")], [true, false]);
    check("the audit row says the same", /card number/.test(dirty.row), true);
  } else {
    check("a card number in a notification still goes ahead", dirty.status === "denied", false);
    check("and the audit row carries the note", /\[outgoing check, log only: contains a card number\]/.test(dirty.row), true);
    check("the note does not hold the number", dirty.row.includes("4111"), false);
  }
  check("clean text is untouched either way", [clean.status === "denied", /outgoing check/.test(clean.row)], [false, false]);

  const search = await call("web_search", { query: "refund for 123-45-6789" });
  check("an SSN in a search query is caught", enforcing ? search.status : /social security number/.test(search.row), enforcing ? "denied" : true);
  const note = await call("mac_control", { action: "create_note", body: "card 4111 1111 1111 1111", title: "x" });
  check("a note with a card number is not checked", [note.status === "denied", /outgoing check/.test(note.row)], [false, false]);
}

if (!enforcing) {
  console.log("\nA tool whose declaration throws is not blocked by it");
  registry.__fake_out = {
    argsSchema: "{}",
    checkPolicy: () => ({ allowed: true }),
    classify: () => ({ reversibility: "reversible", summary: "s", target: "t" }),
    description: "test",
    name: "__fake_out",
    outgoingText: () => {
      throw new Error("boom");
    },
    run: async () => "done",
  };
  const r = await call("__fake_out", {});
  check("it still runs", r.status === "denied", false);
  delete registry.__fake_out;

  const child = spawnSync(process.execPath, [process.argv[1], "--enforce"], { encoding: "utf8" });
  process.stdout.write(child.stdout);
  if (child.status !== 0) {
    failed++;
    console.log("  FAIL  the enforcing half of the suite exited non-zero");
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
