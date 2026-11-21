/**
 * Heads-up outcomes and learning from dismissals (docs/PLAN-open-work.md section 3, workstream B).
 * Run with `node test/headsup-outcomes.test.mjs`.
 *
 * The thresholds are the point: a boundary off by one either nags a kind you ignore or goes quiet on
 * one you use. Every number in the spec is tested on both sides of its line.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-hu-outcomes-"));
const dbPath = path.join(root, "t.db");
process.env.SPINE_DB_PATH = dbPath;
process.env.ATTACHMENTS_DIR = path.join(root, "attachments");
process.env.EMBEDDINGS_URL = "";
process.env.POLICY_PATH = path.join(root, "policy.json");
fs.writeFileSync(process.env.POLICY_PATH, JSON.stringify({ autoExecute: { irreversibleAlwaysConfirm: true, reversible: true }, version: 1 }));

const ledger = await import("../src/headsup/ledger.ts");
const outcomes = await import("../src/headsup/outcomes.ts");
const { rawDb } = await import("../src/memory/store.ts");
const { planOffers } = await import("../src/headsup/plan.ts");
const prefs = await import("../src/headsup/prefs.ts");
const { prefsForClient } = await import("../src/headsup/prefs-view.ts");
const { headsupSection } = await import("../src/headsup/telemetry.ts");
const { pruneHeadsup } = await import("../src/headsup/prune.ts");
const { headsupKindSet } = await import("../src/tools/headsup-kind-set.ts");
const { tools } = await import("../src/tools/index.ts");
const rules = await import("../src/headsup/rules.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(72)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const BASE = new Date();
const DAY = 86_400_000;
const at = (daysFromBase) => new Date(BASE.getTime() + daysFromBase * DAY);
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const reset = () => {
  for (const t of ["headsups", "headsup_outcomes", "headsup_mutes", "confirmations", "kv"]) rawDb.exec(`DELETE FROM ${t}`);
};

let n = 0;
const cand = (kind, startsInDays, over = {}) => ({
  amount: null,
  daysUntil: startsInDays,
  dedupeKey: `${kind}:${++n}`,
  fingerprint: "f",
  flightNumber: null,
  kind,
  location: null,
  startsAt: localDate(at(startsInDays)),
  subject: `${kind} ${n}`,
  timeSensitive: false,
  ...over,
});
const outcomeOf = (id) => {
  const r = rawDb.prepare("SELECT outcome FROM headsup_outcomes WHERE headsup_id = ?").get(id);
  return r ? r.outcome : "(no row)";
};

/** Offer one item `offeredDaysAgo` days ago, due in `dueInDays` (negative: already past). Returns its row. */
const offer = (kind, dueInDays = 10, offeredDaysAgo = 1) => ledger.markOffered(cand(kind, dueInDays), 0, at(-offeredDaysAgo));

/** A kind with this many of each outcome inside the window. */
const seed = (kind, { yes = 0, never = 0, ignored = 0, later = 0, open = 0 }) => {
  for (let i = 0; i < yes; i++) ledger.answer(offer(kind).id, "yes", at(0));
  for (let i = 0; i < never; i++) ledger.answer(offer(kind).id, "never", at(0));
  for (let i = 0; i < ignored; i++) offer(kind, -2, 5);
  for (let i = 0; i < later; i++) ledger.answer(offer(kind).id, "later", at(0));
  for (let i = 0; i < open; i++) offer(kind);
  ledger.expirePast(at(0)); // the ignored ones are the ones already past their date
};
const stats = (kind) => outcomes.statsByKind(at(0)).find((s) => s.kind === kind);
const tier = (kind) => (stats(kind) ? outcomes.tierOf(stats(kind)) : "none");

console.log("\nthe tiers, at every boundary\n");
const t = (counted, bad) => outcomes.tierOf({ counted, rate: counted ? bad / counted : 0 });
check("the constants are the spec's", [rules.QUIETEN_MIN_COUNTED, rules.QUIETEN_MIN_RATE, rules.OFF_MIN_COUNTED, rules.OFF_MIN_RATE, rules.OUTCOME_WINDOW_DAYS, rules.OFF_SUPPRESS_DAYS], [6, 0.7, 10, 0.85, 90, 90]);
check("5 offers, all 5 ignored: nothing (too few)", t(5, 5), "none");
check("6 offers, 4 ignored (0.67): nothing", t(6, 4), "none");
check("6 offers, 5 ignored (0.83): quieten", t(6, 5), "quiet");
check("10 offers, 7 passed on (0.70 exactly): quieten", t(10, 7), "quiet");
check("10 offers, 6 passed on (0.60): nothing", t(10, 6), "none");
check("9 offers, all 9 ignored: quieten, not yet a proposal", t(9, 9), "quiet");
check("10 offers, 8 passed on (0.80): quieten, no proposal", t(10, 8), "quiet");
check("10 offers, 9 passed on (0.90): propose off", t(10, 9), "off");
check("20 offers, 17 passed on (0.85 exactly): propose off", t(20, 17), "off");
check("20 offers, 16 passed on (0.80): quieten only", t(20, 16), "quiet");
check("no offers at all: nothing", t(0, 0), "none");

console.log("\nrecording what happened\n");
reset();
const a = offer("bill");
check("an offer writes one open outcome row", [outcomeOf(a.id), rawDb.prepare("SELECT COUNT(*) AS c FROM headsup_outcomes").get().c], [null, 1]);
ledger.markOffered(cand("bill", 3, { dedupeKey: a.dedupe_key }), 1, at(0));
check("a reminder for the same heads-up adds no second row", rawDb.prepare("SELECT COUNT(*) AS c FROM headsup_outcomes").get().c, 1);
ledger.answer(a.id, "yes", at(0));
check("yes is recorded", outcomeOf(a.id), "yes");
const b = offer("bill");
ledger.answer(b.id, "later", at(0));
check("later is recorded", outcomeOf(b.id), "later");
ledger.answer(b.id, "never", at(0));
check("a later answer of never replaces later", outcomeOf(b.id), "never");
const c = offer("bill");
ledger.answer(c.id, "later", at(0));
ledger.answer(c.id, "yes", at(0));
check("a later answer of yes replaces later", outcomeOf(c.id), "yes");
const d = offer("bill", -2, 5);
check("an unanswered item is open until its date passes", outcomeOf(d.id), null);
ledger.expirePast(at(0));
check("... then it is ignored", outcomeOf(d.id), "ignored");
const e = offer("bill", -2, 5);
ledger.answer(e.id, "later", at(-1));
ledger.expirePast(at(0));
check("an item you snoozed and then left to expire stays later", outcomeOf(e.id), "later");
const f = offer("bill", -2, 5);
ledger.answer(f.id, "yes", at(-1));
ledger.expirePast(at(0));
check("an accepted item that finishes stays yes", outcomeOf(f.id), "yes");
check("an item not yet due is not ignored by a sweep", (() => { const g = offer("bill", 5); ledger.expirePast(at(0)); return outcomeOf(g.id); })(), null);
check("a heads-up never offered has no row (only offers count)", rawDb.prepare("SELECT COUNT(*) AS c FROM headsup_outcomes WHERE headsup_id = 999999").get().c, 0);

console.log("\ncounting\n");
reset();
seed("bill", { yes: 2, never: 1, ignored: 3, later: 4, open: 5 });
let s = stats("bill");
check("later and open are not counted", [s.counted, s.later, s.open, s.offered], [6, 4, 5, 15]);
check("the rate is (never + ignored) / (yes + never + ignored)", Math.round(s.rate * 100), 67);
check("... so 4 of 6 passed on is under the line", tier("bill"), "none");
reset();
seed("bill", { yes: 1, never: 2, ignored: 3 });
check("6 counted, 5 passed on: quieten", tier("bill"), "quiet");
seed("bill", { yes: 3 });
check("yes answers lift it back under 0.7 (9 counted, 5 passed on)", tier("bill"), "none");
reset();
seed("bill", { ignored: 5 });
check("5 ignored: nothing, however bad", tier("bill"), "none");
reset();
const old = offer("bill", -2, 100); // offered 100 days ago: outside the window
rawDb.prepare("UPDATE headsup_outcomes SET outcome = 'ignored' WHERE headsup_id = ?").run(old.id);
for (let i = 0; i < 5; i++) {
  const r = offer("bill", -2, 100);
  rawDb.prepare("UPDATE headsup_outcomes SET outcome = 'ignored' WHERE headsup_id = ?").run(r.id);
}
check("outcomes older than 90 days stop counting", stats("bill"), undefined);
seed("bill", { ignored: 5 });
check("... and the ones inside the window still do", stats("bill").counted, 5);
check("the kinds do not mix", stats("birthday"), undefined);

console.log("\nthe planner\n");
reset();
const quietBill = (k) => k === "bill";
{
  const c1 = cand("bill", 1);
  const r1 = ledger.markOffered(cand("bill", 4, { dedupeKey: c1.dedupeKey }), 0, at(-3)); // first mention was stage 0
  const deps = (quiet) => ({ get: (k) => (k === c1.dedupeKey ? ledger.getByKey(k) : undefined), muted: () => false, quiet });
  const normal = planOffers([c1], deps(undefined), at(0));
  check("an ordinary kind gets its reminder", normal.offers.map((o) => o.reason), ["reminder"]);
  const quiet = planOffers([c1], deps(quietBill), at(0));
  check("a quietened kind loses the reminder", quiet.offers.length, 0);
  const first = planOffers([cand("bill", 4)], { get: () => undefined, muted: () => false, quiet: quietBill }, at(0));
  check("... but keeps its first mention", first.offers.map((o) => o.reason), ["new"]);
  const snoozed = { ...r1, snooze_until: at(-1).toISOString(), state: "snoozed" };
  const back = planOffers([c1], { get: () => snoozed, muted: () => false, quiet: quietBill }, at(0));
  check("... and an item you snoozed still comes back", back.offers.map((o) => o.reason), ["snoozed"]);
  const q = cand("bill", 0);
  const o = cand("birthday", 9);
  const capped = planOffers([q, o], { get: () => undefined, muted: () => false, quiet: quietBill }, at(0), 1);
  check("under the cap a quietened kind sorts last, though it is sooner", capped.offers.map((x) => x.candidate.kind), ["birthday"]);
  check("... and the one held back is counted as deferred", capped.deferred, 1);
  const plain = planOffers([q, o], { get: () => undefined, muted: () => false }, at(0), 1);
  check("without the quiet hook the order is unchanged (soonest first)", plain.offers.map((x) => x.candidate.kind), ["bill"]);
}
reset();
seed("bill", { yes: 1, never: 1, ignored: 4 });
{
  const quiet = outcomes.quietKinds(at(0));
  check("quietKinds reads the table", [...quiet], ["bill"]);
  seed("bill", { yes: 4 });
  check("yes answers let the reminders return (10 counted, 5 passed on)", [...outcomes.quietKinds(at(0))], []);
}

console.log("\nproposing a kind off\n");
reset();
const enabled = () => true;
seed("bill", { yes: 1, ignored: 9 });
const proposals = () => rawDb.prepare("SELECT id, state, args, summary FROM confirmations WHERE tool = 'headsup_kind_set'").all();
let ids = outcomes.proposeKindsOff(at(0), enabled);
check("10 offers, 9 ignored: one proposal", [ids.length, proposals().length], [1, 1]);
check("it asks to turn the kind off, through the queue", JSON.parse(proposals()[0].args), { enabled: false, kind: "bill" });
check("the card says the numbers in words", /9 of 10 \(90%\)/.test(proposals()[0].summary), true);
check("the next morning does not propose again", [outcomes.proposeKindsOff(at(1), enabled).length, proposals().length], [0, 1]);
check("... nor the one after, while it still waits", [outcomes.proposeKindsOff(at(2), enabled).length, proposals().length], [0, 1]);
rawDb.prepare("UPDATE confirmations SET state = 'rejected'").run();
check("rejected: quiet for 90 days", outcomes.proposeKindsOff(at(60), enabled).length, 0);
check("... the kind stays quietened meanwhile", tier("bill"), "off");
check("a kind already off is not proposed", (() => { rawDb.exec("DELETE FROM confirmations"); return outcomes.proposeKindsOff(at(0), () => false).length; })(), 0);
rawDb.exec("DELETE FROM confirmations");
const rejectedLongAgo = (() => {
  outcomes.proposeKindsOff(at(0), enabled);
  rawDb.prepare("UPDATE confirmations SET state = 'rejected', ts = ?").run(at(-91).toISOString());
  return outcomes.proposeKindsOff(at(0), enabled).length;
})();
check("rejected more than 90 days ago: it may ask once more", rejectedLongAgo, 1);
reset();
seed("bill", { yes: 1, ignored: 8 });
check("9 offers is quieten only: no proposal", [tier("bill"), outcomes.proposeKindsOff(at(0), enabled).length], ["quiet", 0]);
reset();
seed("bill", { ignored: 10 });
seed("birthday", { yes: 10 });
check("only the kind that earned it is proposed", outcomes.proposeKindsOff(at(0), enabled).length, 1);

console.log("\nthe tool that applies it\n");
check("it is registered", tools.some((x) => x.name === "headsup_kind_set"), true);
check("it is irreversible-tier, so it always waits for you", headsupKindSet.classify({ enabled: false, kind: "bill" }).reversibility, "irreversible");
check("... and queues even from a scheduled run", headsupKindSet.confirmWhenUnattended, true);
check("a bad kind is refused with a sentence", /kind must be one of/.test(await headsupKindSet.run({ enabled: false, kind: "weather" })), true);
check("a non-boolean is refused", /true or false/.test(await headsupKindSet.run({ enabled: "no", kind: "bill" })), true);
check("nothing changed after a refusal", prefs.getPrefs().kinds.bill, true);
check("approving turns the kind off", (await headsupKindSet.run({ enabled: false, kind: "bill" }), prefs.getPrefs().kinds.bill), false);
check("... and nothing else", Object.entries(prefs.getPrefs().kinds).filter(([, v]) => v === false).map(([k]) => k), ["bill"]);
check("it can turn it back on", (await headsupKindSet.run({ enabled: true, kind: "bill" }), prefs.getPrefs().kinds.bill), true);

console.log("\nwhat Settings is sent\n");
reset();
seed("bill", { yes: 2, ignored: 12 });
const view = prefsForClient().learning.find((x) => x.kind === "bill");
check("the client view carries offered, acted-on and the tier", [view.offered, view.yes, view.tier], [14, 2, "off"]);
check("... and nothing writable (it is a read-only field)", Object.keys(prefs.getPrefs()).includes("learning"), false);

console.log("\ntelemetry and retention\n");
const lines = headsupSection(7, at(0)).join("\n");
check("the digest reads the history: bill 14 offered with its answers", /bill\s+14 offered — 2 yes, 12 ignored/.test(lines), true);
rawDb.prepare("INSERT INTO headsup_outcomes (headsup_id, kind, offered_at, outcome) VALUES (?,?,?,?)").run(900001, "bill", at(-401).toISOString(), "yes");
rawDb.prepare("INSERT INTO headsup_outcomes (headsup_id, kind, offered_at, outcome) VALUES (?,?,?,?)").run(900002, "bill", at(-399).toISOString(), "yes");
const pruned = pruneHeadsup(at(0));
check("prune removes outcomes older than 400 days, only", [pruned.outcomes, rawDb.prepare("SELECT COUNT(*) AS c FROM headsup_outcomes WHERE headsup_id IN (900001, 900002)").get().c], [1, 1]);

console.log("\nrows from before this table existed\n");
reset();
const ins = (key, kind, state, answer, offered) =>
  Number(rawDb.prepare("INSERT INTO headsups (dedupe_key, kind, subject, due_at, state, answer, first_offered_at, created, updated) VALUES (?,?,?,?,?,?,?,?,?)").run(key, kind, key, localDate(at(5)), state, answer, offered, offered, offered).lastInsertRowid);
const h1 = ins("a", "bill", "accepted", "yes", at(-3).toISOString());
const h2 = ins("b", "bill", "dismissed", "never", at(-3).toISOString());
const h3 = ins("c", "bill", "expired", null, at(-3).toISOString());
const h4 = ins("d", "bill", "offered", null, at(-3).toISOString());
const h5 = ins("e", "bill", "expired", "later", at(-3).toISOString());
rawDb.exec("DROP TABLE headsup_outcomes");
const out = execFileSync(
  process.execPath,
  ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.resolve("src/headsup/ledger.ts")).href)}); const { rawDb } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/memory/store.ts")).href)}); console.log(JSON.stringify(rawDb.prepare("SELECT headsup_id, outcome FROM headsup_outcomes ORDER BY headsup_id").all()));`],
  { encoding: "utf8", env: { ...process.env } },
);
const got = JSON.parse(out.trim().split("\n").pop());
check("a fresh table is filled from the ledger: answers, expiry, open", got.map((r) => [r.headsup_id, r.outcome]), [[h1, "yes"], [h2, "never"], [h3, "ignored"], [h4, null], [h5, "later"]]);

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(root, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
