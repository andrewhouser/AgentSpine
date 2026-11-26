/**
 * The check on text leaving the machine, in its default log-only mode
 * (src/outbound.ts, PLAN-open-work section 12, D3).
 *
 * Three tests in plain code: a payment card number, a US Social Security number, and what
 * the recipe filter already calls a secret value. This suite pins every boundary of the
 * three, which arguments each tool declares as outgoing, and that with OUTBOUND_ENFORCE unset
 * a match is recorded and changes nothing else: the call runs, the model is told nothing,
 * and the record never holds the text. The enforcing half is test/outbound-enforce.test.mjs,
 * a separate process because the switch is read once at start.
 *
 *   node test/outbound-check.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-outbound-"));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
delete process.env.OUTBOUND_ENFORCE;

const store = await import("../src/memory/store.ts");
const { registry } = await import("../src/tools/index.ts");
const { executeCall } = await import("../src/broker.ts");
const out = await import("../src/outbound.ts");
const { buildDigest } = await import("../src/digest.ts");
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

/** A number of `n` digits that passes Luhn, built from a seed so the test owns its fixtures. */
const luhnNumber = (n, seed = "4539") => {
  let body = seed;
  while (body.length < n - 1) body += String((body.length * 7 + 3) % 10);
  body = body.slice(0, n - 1);
  for (let d = 0; d <= 9; d++) if (out.passesLuhn(body + d)) return body + d;
  throw new Error("unreachable");
};
/** The same digits with the last one changed, so it fails Luhn. */
const broken = (digits) => digits.slice(0, -1) + String((Number(digits.at(-1)) + 1) % 10);
const kinds = (text, opts) => out.scanText(text, opts);

console.log("\nTHE CARD CHECK — 13 to 19 digits that pass Luhn");
{
  const visa = "4111111111111111"; // the published test number
  check("the published test number passes Luhn", out.passesLuhn(visa), true);
  check("one digit off fails Luhn", out.passesLuhn(broken(visa)), false);
  check("bare", kinds(`card ${visa} please`), ["card-number"]);
  check("in groups of four with spaces", kinds("4111 1111 1111 1111"), ["card-number"]);
  check("in groups with dashes", kinds("4111-1111-1111-1111"), ["card-number"]);
  check("15 digits in the 4-6-5 grouping", kinds("3782 822463 10005"), ["card-number"]);
  check("13 digits, the shortest", kinds(luhnNumber(13)), ["card-number"]);
  check("19 digits, the longest", kinds(luhnNumber(19)), ["card-number"]);
  check("12 digits that pass Luhn are too short", kinds(luhnNumber(12)), []);
  check("20 digits that pass Luhn are too long", kinds(luhnNumber(20)), []);
  check("16 digits that fail Luhn", kinds(broken(visa)), []);
  check("a card's digits inside a longer number are not a card", kinds(`${visa}9981`), []);
  check("... nor inside a longer grouped number", kinds("4111 1111 1111 1111 9981"), []);
  check("all zeros passes Luhn and is not a card", kinds("0000 0000 0000 0000"), []);
  check("two spaces between groups is not one number", kinds("4111 1111  1111 1111"), []);
  check("a phone number and a date", kinds("Call 555-867-5309 on 2026-11-30 at 10:30"), []);
  check("a card number in a URL is still found", kinds(`https://example.com/pay?n=${visa}`, { opaque: true }), ["card-number"]);
}

console.log("\nTHE SSN CHECK — with its separators, and only numbers that were ever issued");
for (const [label, text, want] of [
  ["with dashes", "SSN 123-45-6789", ["ssn"]],
  ["with spaces", "123 45 6789", ["ssn"]],
  ["bare nine digits are too common to flag", "123456789", []],
  ["mixed separators", "123-45 6789", []],
  ["area 000 was never issued", "000-12-3456", []],
  ["area 666 was never issued", "666-12-3456", []],
  ["areas from 900 were never issued", "900-12-3456", []],
  ["group 00 was never issued", "123-00-4567", []],
  ["serial 0000 was never issued", "123-45-0000", []],
  ["part of a longer number", "1123-45-67890", []],
  ["a phone number has the wrong shape", "555-867-5309", []],
  ["a ZIP+4", "28801-1234", []],
]) {
  check(label, kinds(text), want);
}

console.log("\nTHE CREDENTIAL CHECK — the recipe filter's, reused");
for (const [label, text, opts, want] of [
  ["a value after a password label", "the password: hunter2-horse-staple", undefined, ["credential"]],
  ["a key block", "-----BEGIN OPENSSH PRIVATE KEY-----", undefined, ["credential"]],
  ["a long opaque string", `the key is ${"a1b2c3d4".repeat(5)}`, undefined, ["credential"]],
  ["the word token alone is ordinary", "Remember to refresh the Okta token on Monday.", undefined, []],
  ["a long id in a URL is ordinary", `https://example.com/doc/${"a1b2c3d4".repeat(5)}`, { opaque: true }, []],
  ["ordinary text", "Running ten minutes late, start without me.", undefined, []],
  ["nothing at all", "   ", undefined, []],
]) {
  check(label, kinds(text, opts), want);
}
check("two kinds in one text, in a stable order", kinds("card 4111 1111 1111 1111 and SSN 123-45-6789"), ["card-number", "ssn"]);

console.log("\nWHAT A TOOL DECLARES AS OUTGOING");
{
  const args = (name, a) => out.outboundTexts(registry[name], a).map((t) => t.arg);
  check("draft: subject, body and location", args("draft", { body: "Hello", kind: "email", location: "Room 4", subject: "Hi", to: "sam@example.com" }), ["subject", "body", "location"]);
  check("draft: an empty field is not text", args("draft", { body: "Hello", kind: "text" }), ["body"]);
  check("notify: title and body", args("notify", { body: "It finished", title: "Build" }), ["title", "body"]);
  check("mac_control send_mail: subject and body", args("mac_control", { action: "send_mail", body: "Here it is.", subject: "Numbers", to: "sam@example.com" }), ["subject", "body"]);
  check("mac_control send_message: text", args("mac_control", { action: "send_message", text: "Running late.", to: "Sam" }), ["text"]);
  check("mac_control create_note stays on the machine", args("mac_control", { action: "create_note", body: "4111 1111 1111 1111", title: "Card" }), []);
  check("web_search: the query", args("web_search", { query: "weather in Asheville" }), ["query"]);
  check("browser type: the text", args("browser", { action: "type", selector: "#q", text: "sourdough" }), ["text"]);
  check("browser navigate: the address", args("browser", { action: "navigate", url: "https://example.com/" }), ["url"]);
  check("browser click: nothing", args("browser", { action: "click", description: "Next page", selector: "#next" }), []);
  check("web_read: the address", args("web_read", { url: "https://example.com/" }), ["url"]);
  check("an address is marked opaque", out.outboundTexts(registry.web_read, { url: "https://example.com/" })[0].opaque, true);
  check("instagram_approve: a row that does not exist has no caption", args("instagram_approve", { ids: ["nope"] }), []);
  check("instagram_approve: taking an approval back sends nothing", args("instagram_approve", { approved: false, ids: ["nope"] }), []);
  check("a tool that declares nothing is not checked", out.outboundTexts(registry.read_file, { path: "4111 1111 1111 1111" }), []);
  check(
    "every string in an MCP call's arguments, however nested",
    out.everyString({ a: "one", b: { c: ["two", { d: "three" }], n: 4 } }).map((t) => t.text),
    ["one", "two", "three"],
  );
  const throws = {
    outboundText: () => {
      throw new Error("boom");
    },
  };
  check("a declaration that throws falls back to every string", out.checkOutbound(throws, { note: "4111 1111 1111 1111" }), [{ arg: "arguments", kind: "card-number" }]);
}

console.log("\nTHE DENIAL — names the argument and the kind, never the text");
{
  const findings = out.checkOutbound(registry.draft, { body: "My card is 4111 1111 1111 1111 and SSN 123-45-6789.", kind: "email", subject: "password: hunter2-horse-staple" });
  check("one finding per argument and kind, sorted", findings, [
    { arg: "body", kind: "card-number" },
    { arg: "body", kind: "ssn" },
    { arg: "subject", kind: "credential" },
  ]);
  const text = out.outboundDenial(findings);
  check("it names each argument", [/"body"/.test(text), /"subject"/.test(text)], [true, true]);
  check("it names each kind in words", [/payment card number/.test(text), /Social Security number/.test(text), /credential/.test(text)], [true, true, true]);
  check("it never repeats what matched", /4111|6789|hunter2/.test(text), false);
  check("it says nothing was sent", /Nothing was sent/.test(text), true);
}

console.log("\nLOG-ONLY THROUGH THE BROKER — recorded, and nothing else changes");
{
  let sent = [];
  registry.__fake_post = {
    argsSchema: "{}",
    checkPolicy: (_p, a) => (a?.blocked ? { allowed: false, reason: "not on the list" } : { allowed: true, reason: "ok" }),
    classify: () => ({ reversibility: "reversible", summary: "post", target: "example" }),
    description: "test only",
    name: "__fake_post",
    outboundText: (a) => [{ arg: "message", text: String(a?.message ?? "") }],
    run: async (a) => {
      sent.push(a.message);
      return "posted";
    },
  };
  const policy = { autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true } };
  const rows = () => rawDb.prepare("SELECT run_id, tool, arg, kind, refused FROM outbound_checks ORDER BY id").all();
  const runId = store.startRun({ kind: "chat", task: "probe" });

  const clean = await executeCall({ args: { message: "see you at four" }, tool: "__fake_post" }, policy, runId, runId, { conversational: true, goal: "post it" });
  check("clean text: runs, and nothing is recorded", [clean.status, rows().length], ["executed", 0]);

  const card = "4111 1111 1111 1111";
  const hit = await executeCall({ args: { message: `use ${card}` }, tool: "__fake_post" }, policy, runId, runId, { conversational: true, goal: "post it" });
  check("a card number: the call still runs", [hit.status, sent.at(-1)], ["executed", `use ${card}`]);
  check("... the model is told nothing about it", hit.output, "posted");
  check("... and one row says what matched", rows(), [{ arg: "message", kind: "card-number", refused: 0, run_id: runId, tool: "__fake_post" }]);

  const columns = rawDb.prepare("PRAGMA table_info(outbound_checks)").all().map((c) => c.name);
  check("the table has no column that could hold the text", columns, ["id", "ts", "run_id", "tool", "arg", "kind", "refused"]);
  check("no stored value contains the number", JSON.stringify(rawDb.prepare("SELECT * FROM outbound_checks").all()).includes("4111"), false);

  const before = rows().length;
  const denied = await executeCall({ args: { blocked: true, message: card }, tool: "__fake_post" }, policy, runId, runId, { conversational: true, goal: "post it" });
  check("a call the allowlist refused is not recorded", [denied.status, rows().length - before], ["denied", 0]);
  delete registry.__fake_post;

  // The digest is how the fortnight's log is read.
  const digest = buildDigest({ hours: 24 });
  check("the digest lists the match", /Outgoing text that matched a check \(1 match, log-only: nothing was stopped\)/.test(digest), true);
  check("... by tool and kind", /__fake_post\s+card-number\s+1/.test(digest), true);

  // Retention, with the clock handed in so the suite does not depend on today.
  const day = 86_400_000;
  const t0 = new Date("2026-06-15T12:00:00.000Z");
  rawDb.exec("DELETE FROM outbound_checks");
  out.recordOutbound(null, "draft", [{ arg: "body", kind: "ssn" }], false, new Date(t0.getTime() - 91 * day));
  out.recordOutbound(null, "draft", [{ arg: "body", kind: "ssn" }], true, new Date(t0.getTime() - 89 * day));
  out.recordOutbound(null, "notify", [{ arg: "title", kind: "credential" }], false, new Date(t0.getTime() - 2 * day));
  check("the tally counts by tool and kind inside the window", out.tallyOutbound(14, t0), [{ count: 1, kind: "credential", refused: 0, tool: "notify" }]);
  check("... and says how many were refused", out.tallyOutbound(100, t0).find((r) => r.tool === "draft"), { count: 2, kind: "ssn", refused: 1, tool: "draft" });
  check("pruning drops only rows past 90 days", [out.pruneOutbound(out.OUTBOUND_RETENTION_DAYS, t0), rows().length], [1, 2]);
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(tmp, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
