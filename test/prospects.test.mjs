/**
 * Prospects (PLAN-open-work section 14, U4): src/clients/prospects.ts and the columns it reads.
 *
 * A prospect is a client row whose status says so. What must be plain code is tested here:
 * reading a pasted list (every way a line can be wrong), the ranking, and every sentence a
 * screen shows, since the server makes them all and the three clients only display them. The
 * ranking is arithmetic over a site audit's findings and each reason is one of those findings;
 * nothing here asks a model, and nothing here reads a web page.
 *
 *   node test/prospects.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-prospects-"));
process.env.SPINE_DB_PATH = path.join(tmp, "spine.db");
process.env.EMBEDDINGS_URL = "";

const p = await import("../src/clients/prospects.ts");
const clients = await import("../src/clients/store.ts");
const score = await import("../src/siteaudit/score.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nA SITE AS WRITTEN IN A LIST");
for (const [label, raw, want] of [
  ["a bare domain is read as https", "rivera-plumbing.example", "https://rivera-plumbing.example/"],
  ["an address keeps its scheme and path", "http://oak-iron.example/contact", "http://oak-iron.example/contact"],
  ["spaces around it are dropped", "  marlow.example  ", "https://marlow.example/"],
  ["a single word is not a site", "ridgeline", null],
  ["localhost is not a site", "localhost", null],
  ["an address with a password is refused", "https://sam:pw@marlow.example/", null],
  ["another scheme is refused", "ftp://marlow.example/", null],
  ["nothing", "", null],
]) {
  check(label, p.siteAddress(raw), want);
}

console.log("\nA PASTED LIST");
{
  const r = p.parsePastedList(
    [
      "Rivera Plumbing, rivera-plumbing.example",
      "",
      "# a note to myself",
      "Oak & Iron\thttps://oak-iron.example/",
      "Acme, Inc., acme.example",
      "Acme, Inc.",
      "Marlow Kitchens",
      '"Ridgeline Cabinets", "ridgeline.example"',
      "rivera plumbing, other.example",
      "Springfield Bakery, not a site",
      "Harbor Dental, harbor dental .com",
      "lonely-site.example",
      ", nameless.example",
    ].join("\n"),
  );
  check("the rows it kept", r.rows, [
    { name: "Rivera Plumbing", site: "https://rivera-plumbing.example/" },
    { name: "Oak & Iron", site: "https://oak-iron.example/" },
    { name: "Acme, Inc.", site: "https://acme.example/" },
    { name: "Marlow Kitchens", site: null },
    { name: "Ridgeline Cabinets", site: "https://ridgeline.example/" },
    { name: "Springfield Bakery, not a site", site: null },
  ]);
  check("what it skipped, and why", r.skipped.map((s) => [s.line, s.reason]), [
    ["Acme, Inc.", "this name is already in the list"],
    ["rivera plumbing, other.example", "this name is already in the list"],
    ["Harbor Dental, harbor dental .com", '"harbor dental .com" is not a website address'],
    ["lonely-site.example", "this line has a site and no name"],
    [", nameless.example", "this line has no name"],
  ]);
  check("nothing at all", p.parsePastedList("\n  \n# only a comment"), { rows: [], skipped: [] });
  const long = p.parsePastedList(`${"x".repeat(p.NAME_MAX)}, a.example\n${"y".repeat(p.NAME_MAX + 1)}, b.example`);
  check("a name of exactly the limit is kept, one over is not", [long.rows.length, long.skipped[0]?.reason], [1, `the name is over ${p.NAME_MAX} characters`]);
  const many = p.parsePastedList(Array.from({ length: p.PASTE_MAX_LINES + 1 }, (_, i) => `Shop ${i}, shop${i}.example`).join("\n"));
  check("only the first 200 lines are read", [many.rows.length, many.skipped.length, many.skipped[0]?.reason], [p.PASTE_MAX_LINES, 1, "only the first 200 lines of a paste are read"]);
}

console.log("\nFIT — arithmetic over the audit, and each reason is one of its findings");
const summary = (findings, at = "2026-06-15T12:00:00.000Z") => ({ at, findings, url: "https://rivera-plumbing.example/" });
{
  check("no audit and a site", p.fitOf("https://a.example/", null), { line: "Not audited yet.", reasons: [], score: null });
  check("no audit and no site", p.fitOf(null, null), { line: "No website on file, so there is nothing to audit.", reasons: [], score: null });
  check("an audit that found nothing", p.fitOf("https://a.example/", summary([])), { line: "Audited 2026-06-15: nothing over a threshold, so little to raise about the website.", reasons: [], score: 0 });
  const one = p.fitOf("https://a.example/", summary([{ id: "no-https", number: "http" }]));
  check("one finding", one, { line: "Audited 2026-06-15: 1 thing worth fixing.", reasons: ["The page is not served over HTTPS (http)."], score: 100 });
  const four = p.fitOf(
    "https://a.example/",
    summary([
      { id: "title-long", number: "71 characters" },
      { id: "phone-overflow", number: "810 px wider than a 390 px screen" },
      { id: "no-contact", number: "no phone, email, form or booking link" },
      { id: "heavy-images", number: "2 images, 2.1 MB" },
    ]),
  );
  check("the score is the weights added up", four.score, 15 + 80 + 90 + 50);
  check("the line counts every finding", four.line, "Audited 2026-06-15: 4 things worth fixing.");
  check("the reasons are the three that matter most, in order", four.reasons, [
    "A visitor has no way to get in touch from this page (no phone, email, form or booking link).",
    "The page scrolls sideways on a phone (810 px wider than a 390 px screen).",
    "Some images are very large files (2 images, 2.1 MB).",
  ]);
  check("every reason is a finding's own words", four.reasons.every((r) => score.FINDING_IDS.some((id) => r.startsWith(score.finding(id, "").what))), true);
}

console.log("\nSTATUSES");
check("the prospect statuses, in the order the work goes", [...p.PROSPECT_STATUSES], ["new", "contacted", "replied", "pilot", "not-a-fit"]);
check("the old ones are still there", ["active", "lead", "paused", "done"].every((s) => p.ALL_STATUSES.includes(s)), true);
check("labels", ["new", "not-a-fit", "pilot", "active", "something-else"].map(p.statusLabel), ["New", "Not a fit", "Pilot", "Active", "something-else"]);
check("which are prospects", ["new", "contacted", "replied", "pilot", "not-a-fit", "lead", "active"].map(p.isProspectStatus), [true, true, true, true, true, false, false]);

console.log("\nTHE STORE — a prospect is a client row");
{
  const a = clients.upsertClient("Rivera Plumbing", { site: "https://rivera-plumbing.example/", source: "pasted list", status: "new" });
  check("site and source are kept", [a.site, a.source, a.status, a.audit], ["https://rivera-plumbing.example/", "pasted list", "new", null]);
  const b = clients.upsertClient("Rivera Plumbing", { status: "contacted" });
  check("a later update leaves them alone", [b.id === a.id, b.site, b.source, b.status], [true, "https://rivera-plumbing.example/", "pasted list", "contacted"]);
  const s = summary([{ id: "no-https", number: "http" }, { id: "no-description", number: "none" }]);
  const c = clients.setClientAudit(a.id, JSON.stringify(s));
  const v = p.clientView(c);
  check("the view carries every sentence, made", [v.prospect, v.status_label, v.audit_at, v.fit_score, v.fit_line, v.fit_reasons], [
    true,
    "Contacted",
    "2026-06-15T12:00:00.000Z",
    130,
    "Audited 2026-06-15: 2 things worth fixing.",
    ["The page is not served over HTTPS (http).", "There is no search description (none)."],
  ]);
  check("the raw summary is not sent to a screen", "audit" in v, false);
  const plain = p.clientView(clients.upsertClient("Sam Rivera", { email: "sam@example.com", status: "active" }));
  check("an ordinary client is not a prospect", [plain.prospect, plain.status_label, plain.fit_score], [false, "Active", null]);
  check("a row whose stored audit is damaged reads as not audited", p.clientView({ ...c, audit: "{not json" }).fit_line, "Not audited yet.");
}

console.log("\nTHE RANKING");
{
  const row = (id, name, status, findings, site = "https://x.example/") =>
    p.clientView({ audit: findings ? JSON.stringify(summary(findings)) : null, created: "", email: null, id, name, next_action: null, next_action_due: null, notes: null, project_id: null, site, source: null, status, updated: "" });
  const https = { id: "no-https", number: "http" };
  const title = { id: "title-long", number: "70 characters" };
  const ranked = p.rankProspects([
    row(1, "Zed Motors", "new", null),
    row(2, "Alba Cafe", "new", null),
    row(3, "Marlow Kitchens", "contacted", [title]),
    row(4, "Oak & Iron", "new", [https, title]),
    row(5, "Ridgeline Cabinets", "not-a-fit", [https, title, { id: "no-contact", number: "x" }]),
    row(6, "Harbor Dental", "new", []),
    row(7, "Sam Rivera", "active", [https]),
    row(8, "Birch Yoga", "pilot", [https, title]),
  ]);
  check(
    "most to talk about first, then nothing found, then unaudited by name, and not-a-fit last",
    ranked.map((r) => r.name),
    ["Birch Yoga", "Oak & Iron", "Marlow Kitchens", "Harbor Dental", "Alba Cafe", "Zed Motors", "Ridgeline Cabinets"],
  );
  check("an ordinary client is never in it", ranked.some((r) => r.name === "Sam Rivera"), false);
  check("the same input in another order ranks the same", p.rankProspects([...ranked].reverse()).map((r) => r.id), ranked.map((r) => r.id));
}

console.log("\nTHE OUTREACH REQUEST — made by code, with nothing from the prospect's page");
{
  const base = { created: "", email: null, id: 1, name: "Rivera Plumbing", next_action: null, next_action_due: null, notes: "NOTES MUST NOT APPEAR", project_id: null, site: "https://rivera-plumbing.example/", source: null, status: "new", updated: "" };
  const audited = p.outreachTask({ ...base, audit: JSON.stringify(summary([{ id: "title-long", number: "70 characters" }, { id: "no-https", number: "http" }, { id: "no-contact", number: "x" }, { id: "heavy-images", number: "2 images, 2.1 MB" }])), email: "hello@rivera-plumbing.example" });
  check("it names who and where", audited.split("\n")[0], "Draft a first outreach email to Rivera Plumbing (https://rivera-plumbing.example/), to hello@rivera-plumbing.example.");
  check("it says draft, in the learned style, and send nothing", [/Do not send anything/.test(audited), /style_for/.test(audited), /draft tool/.test(audited)], [true, true, true]);
  check("it lists the three findings that matter most, in order", audited.split("\n").filter((l) => /^\d\. /.test(l)), [
    "1. The page is not served over HTTPS (http).",
    "2. A visitor has no way to get in touch from this page (x).",
    "3. Some images are very large files (2 images, 2.1 MB).",
  ]);
  check("it limits what may be claimed", [/at most two/.test(audited), /promise no result/.test(audited), /using what they already have/.test(audited)], [true, true, true]);
  check("your notes about them are not in it", audited.includes("NOTES MUST NOT APPEAR"), false);
  const bare = p.outreachTask({ ...base, audit: null, site: null });
  check("with no audit it is told not to comment on the site", [/Draft a first outreach email to Rivera Plumbing\./.test(bare), /do not comment on it/.test(bare), /^\d\. /m.test(bare)], [true, true, false]);
}

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(tmp, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
