/**
 * Heads-up telemetry (docs/PLAN-heads-up-next.md workstream F). Run with `node test/headsup-telemetry.test.mjs`.
 * Fixture rows in, exact numbers out. No model, no network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-tel-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.ATTACHMENTS_DIR = path.join(root, "attachments");
process.env.EMBEDDINGS_URL = "";

await import("../src/headsup/ledger.ts");
await import("../src/headsup/watch/store.ts");
const { rawDb } = await import("../src/memory/store.ts");
const { headsupSection, recordCalendarFailure, rungOf } = await import("../src/headsup/telemetry.ts");
const { spend, monthKey, dayKey } = await import("../src/headsup/watch/budget.ts");
const { buildDigest } = await import("../src/digest.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const NOW = new Date(2026, 10, 21, 12);
const ago = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
let n = 0;
const head = (kind, state, answer, daysAgo, payload = {}) =>
  Number(rawDb.prepare("INSERT INTO headsups (dedupe_key, kind, subject, due_at, state, answer, first_offered_at, payload_json, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(`k${n++}`, kind, "s", ago(-3), state, answer, ago(daysAgo), JSON.stringify(payload), ago(daysAgo), ago(daysAgo)).lastInsertRowid);

console.log("\nEMPTY: nothing to say, says nothing");
check("no rows, no section", headsupSection(7, NOW), []);

head("birthday", "researched", "yes", 2, { researchedAt: ago(2), rung: "full" });
head("birthday", "researched", "yes", 3, { researchedAt: ago(3), rung: "link-only" });
head("birthday", "dismissed", "never", 4);
head("birthday", "expired", null, 5);
head("bill", "snoozed", "later", 1);
head("bill", "offered", null, 1);
head("anniversary", "researched", "yes", 2, { researchedAt: ago(2), rung: "fallback" });
head("anniversary", "accepted", "yes", 1, { researchError: "timeout" });
head("birthday", "expired", null, 30); // outside the window
head("birthday", "researched", "yes", 20, { researchedAt: ago(20), rung: "full" }); // outside the window

const text = headsupSection(7, NOW).join("\n");
console.log("\nOFFERS BY KIND, INSIDE THE WINDOW ONLY");
check("birthday: 4 offered (2 yes, 1 never, 1 ignored)", /birthday\s+4 offered — 2 yes, 1 never, 1 ignored/.test(text), true);
check("bill: 2 offered (1 later, 1 open)", /bill\s+2 offered — 1 later, 1 open/.test(text), true);
check("anniversary: 2 offered (2 yes)", /anniversary\s+2 offered — 2 yes/.test(text), true);
check("the 30 day old one is not counted", /birthday\s+5/.test(text), false);

console.log("\nRESEARCH RUNGS");
check("3 runs: one of each rung", /Research: 3 runs — 1 full card, 1 link-only, 1 fallback link/.test(text), true);
check("the old run is outside the window", /4 runs/.test(text), false);
check("the failed run is counted", /1 error/.test(text), true);
check("rungOf: any non-link card is full", rungOf([{ kind: "link" }, { kind: "gift" }], false), "full");
check("rungOf: only link cards is link-only", rungOf([{ kind: "link" }], false), "link-only");
check("rungOf: the fallback wins", rungOf([{ kind: "link" }], true), "fallback");

console.log("\nWATCHES AND BUDGET");
const w = (hid, created, active, ended, notified, note = null) =>
  rawDb.prepare("INSERT INTO headsup_watches (headsup_id, kind, spec, created, active, ended_at, last_notified, note) VALUES (?,?,?,?,?,?,?,?)").run(hid, "flight", "{}", created, active, ended, notified, note);
w(101, ago(2), 1, null, ago(1));
w(102, ago(3), 0, ago(1), null);
w(103, ago(1), 1, null, null, "Paused: this month's flight lookup budget is used up.");
w(104, ago(40), 0, ago(35), ago(36));
const t2 = headsupSection(7, NOW).join("\n");
check("3 started this week, 1 of them has notified", /Watches: 3 started, 1 of those have notified/.test(t2), true);
check("1 ended this week", /1 ended/.test(t2), true);
check("2 active now", /2 active now/.test(t2), true);
check("1 paused on budget", /1 paused on budget/.test(t2), true);
spend("flight", monthKey(NOW), 7);
spend("travel", dayKey(NOW), 3);
check("budget is shown against the configured limits", /flights 7\/400 this month, drives 3\/1000 today/.test(headsupSection(7, NOW).join("\n")), true);

console.log("\nCALENDAR FAILURES");
check("none recorded, none shown", /Calendar read failures/.test(t2), false);
recordCalendarFailure("calendar A: 403", NOW);
recordCalendarFailure("calendar B: timeout", NOW);
const t3 = headsupSection(7, NOW).join("\n");
check("counted for the month", /Calendar read failures this month: 2/.test(t3), true);
check("shows the last message", /calendar B: timeout/.test(t3), true);

console.log("\nIN THE DIGEST");
// buildDigest reads the real clock, so this row is stamped with it rather than the fixture date.
rawDb.prepare("INSERT INTO headsups (dedupe_key, kind, subject, due_at, state, first_offered_at, created, updated) VALUES ('live','bill','s',?,'offered',?,?,?)").run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
rawDb.prepare("INSERT INTO runs (kind, task, status, started) VALUES ('chat','x','ok',?)").run(new Date().toISOString());
const digest = buildDigest({ hours: 24 });
check("npm run digest prints the section", /\nHeads-up \(last 7 days\):/.test(digest), true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
