/**
 * Heads-up lead-time overrides (docs/PLAN-open-work.md section 3, workstream D).
 * Run with `node test/headsup-leadtime.test.mjs`.
 *
 * The trap: the ledger used to remember the index into the kind's list, so editing the list partway
 * through a sequence re-offered or skipped a mention. The ledger now remembers the threshold in days.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-lead-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.ATTACHMENTS_DIR = path.join(root, "attachments");
process.env.EMBEDDINGS_URL = "";
process.env.POLICY_PATH = path.join(root, "policy.json");
fs.writeFileSync(process.env.POLICY_PATH, JSON.stringify({ autoExecute: { irreversibleAlwaysConfirm: true, reversible: true }, version: 1 }));

const ledger = await import("../src/headsup/ledger.ts");
const { rawDb } = await import("../src/memory/store.ts");
const { planOffers } = await import("../src/headsup/plan.ts");
const prefs = await import("../src/headsup/prefs.ts");
const { prefsForClient } = await import("../src/headsup/prefs-view.ts");
const { kvGet } = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(72)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const NOW = new Date(2027, 5, 10, 8, 0);
const reset = () => {
  for (const t of ["headsups", "headsup_outcomes", "headsup_mutes", "kv"]) rawDb.exec(`DELETE FROM ${t}`);
};
const cand = (daysUntil, over = {}) => ({
  amount: null, daysUntil, dedupeKey: "bill:water", fingerprint: "f", flightNumber: null, kind: "bill",
  location: null, startsAt: "2027-06-20", subject: "Water", timeSensitive: false, ...over,
});
/** One morning: plan with the lead times now in force, record what it offers, return [reason, stageDays] pairs. */
const morning = (daysUntil, over = {}) => {
  const p = planOffers([cand(daysUntil, over)], { get: ledger.getByKey, lead: prefs.leadDaysFor, muted: () => false }, NOW);
  for (const o of p.offers) ledger.markOffered(o.candidate, o.stage, NOW, o.stageDays);
  return p.offers.map((o) => [o.reason, o.stageDays]);
};
const days = () => ledger.getByKey("bill:water")?.stage_days;

// --- validation: exact, all or nothing
const bad = (label, v) => check(label, "error" in prefs.validLeadDays(v), true);
check("a good list is accepted as given", prefs.validLeadDays([7, 3, 0]), { ok: [7, 3, 0] });
check("one entry is fine", prefs.validLeadDays([0]), { ok: [0] });
check("45 is the top", prefs.validLeadDays([45]), { ok: [45] });
bad("46 is too far", [46]);
bad("-1 is below zero", [-1]);
bad("empty", []);
bad("four entries", [9, 6, 3, 0]);
bad("a repeat", [5, 5]);
bad("ascending is refused, not sorted", [1, 5]);
bad("a fraction", [2.5]);
bad("a string", ["5"]);
bad("not a list", 5);

reset();
check("defaults before any change", prefs.getPrefs().leadDays.bill, [5, 1, 0]);
const refused = prefs.updatePrefs({ dailyCap: 5, leadDays: { bill: [7, 3], birthday: [1, 5] } });
check("a patch with one bad list is refused whole", refused.ok, false);
check("... naming the kind", refused.error.startsWith("leadDays.birthday:"), true);
check("... and nothing was applied, not even the good part", [prefs.getPrefs().dailyCap, prefs.getPrefs().leadDays.bill], [3, [5, 1, 0]]);
check("recurring has no list to change", prefs.updatePrefs({ leadDays: { recurring: [2] } }).ok, false);
check("an unknown kind is refused", prefs.updatePrefs({ leadDays: { chore: [2] } }).ok, false);

const set = prefs.updatePrefs({ leadDays: { bill: [7, 3] } });
check("a good change is kept", [set.ok, prefs.getPrefs().leadDays.bill, prefs.getPrefs().leadDays.birthday], [true, [7, 3], [10, 2]]);
check("only the difference is stored, so a shipped default still reaches you", JSON.parse(kvGet("headsup:prefs").value).leadDays, { bill: [7, 3] });
const view = prefsForClient();
check("the client gets the list in force and the default", [view.leadDays.bill, view.leadDaysDefault.bill], [[7, 3], [5, 1, 0]]);
prefs.updatePrefs({ leadDays: { bill: null } });
check("null puts the default back", [prefs.getPrefs().leadDays.bill, JSON.parse(kvGet("headsup:prefs").value).leadDays], [[5, 1, 0], {}]);

// --- the planner uses the list in force
reset();
prefs.updatePrefs({ leadDays: { bill: [7, 2] } });
check("a longer first lead: day 7 is the first mention", morning(7), [["new", 7]]);
check("day 6: nothing new", morning(6), []);
check("day 2: the reminder", morning(2), [["reminder", 2]]);
check("... recorded as 2 days", days(), 2);
check("day 1: already past its last stage, silent", morning(1), []);

// --- the trap: edit the list mid-sequence
reset();
check("default list: first mention at 5", morning(5), [["new", 5]]);
prefs.updatePrefs({ leadDays: { bill: [8, 4] } }); // the 5 was index 0; now index 0 means 8
check("list edited to [8, 4]: day 5 is NOT offered again", morning(5), []);
check("... and the ledger still says 5", days(), 5);
check("day 4 is the next real threshold: one reminder", morning(4), [["reminder", 4]]);
check("day 3: silent", morning(3), []);

reset();
morning(5); // offered at 5 under [5,1,0]
prefs.updatePrefs({ leadDays: { bill: [3, 1] } }); // index 0 is now 3, a LATER threshold than what was offered
check("list edited to [3, 1]: day 4 is silent", morning(4), []);
check("day 3 is a reminder, not skipped", morning(3), [["reminder", 3]]);

reset();
morning(5);
prefs.updatePrefs({ leadDays: { bill: [9, 6] } }); // everything offered so far is already past the new list
check("list edited to [9, 6]: nothing to repeat at day 4", morning(4), []);

reset();
prefs.updatePrefs({ leadDays: { bill: [3] } });
check("a shorter list: one mention at 3", morning(3), [["new", 3]]);
prefs.updatePrefs({ leadDays: { bill: null } });
check("back to default after the 3: day 1 is a reminder, day 3 and 2 are not", [morning(2), morning(1)], [[], [["reminder", 1]]]);

// --- a snooze comes back at its stage, whatever the list says now
reset();
morning(5);
rawDb.prepare("UPDATE headsups SET state='snoozed', snooze_until=? WHERE dedupe_key='bill:water'").run("2027-06-09T00:00:00.000Z");
prefs.updatePrefs({ leadDays: { bill: [9, 6] } });
const back = planOffers([cand(4)], { get: ledger.getByKey, lead: prefs.leadDaysFor, muted: () => false }, NOW);
check("a snooze returns at the threshold it had, 5 days", back.offers.map((o) => [o.reason, o.stageDays]), [["snoozed", 5]]);

// --- recurring is untouched
reset();
check("recurring still offers once", morning(2, { dedupeKey: "recurring:x", kind: "recurring" }), [["new", 2]]);

// --- migration: an old table with only an index gets the days it meant
const out = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-lead-mig-"));
  const code = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(path.join(dir, "old.db"))});
    db.exec(\`CREATE TABLE headsups (id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, subject TEXT NOT NULL, due_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'offered', stage INTEGER NOT NULL DEFAULT -1, fingerprint TEXT NOT NULL DEFAULT '', first_offered_at TEXT, last_nudged_at TEXT, snooze_until TEXT, answer TEXT, payload_json TEXT, created TEXT NOT NULL, updated TEXT NOT NULL)\`);
    const ins = db.prepare("INSERT INTO headsups (dedupe_key, kind, subject, due_at, stage, created, updated) VALUES (?,?,?,?,?, 'x','x')");
    ins.run("a", "bill", "A", "2027-01-01", 0); ins.run("b", "bill", "B", "2027-01-01", 2); ins.run("c", "birthday", "C", "2027-01-01", 1); ins.run("d", "bill", "D", "2027-01-01", -1);
    db.close();
    process.env.SPINE_DB_PATH = ${JSON.stringify(path.join(dir, "old.db"))};
    process.env.EMBEDDINGS_URL = "";
    await import(${JSON.stringify(pathToFileURL(path.resolve("src/headsup/ledger.ts")).href)});
    const { rawDb } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/memory/store.ts")).href)});
    console.log(JSON.stringify(rawDb.prepare("SELECT dedupe_key k, stage_days d FROM headsups ORDER BY id").all()));
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, SPINE_DB_PATH: path.join(dir, "old.db") } });
})();
check("backfill: bill 0 -> 5, bill 2 -> 0, birthday 1 -> 2, none stays null", JSON.parse(out.trim().split("\n").pop()), [{ k: "a", d: 5 }, { k: "b", d: 0 }, { k: "c", d: 2 }, { k: "d", d: null }]);

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
