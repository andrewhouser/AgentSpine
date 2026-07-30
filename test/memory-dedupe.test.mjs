/**
 * `remember` refusing what it already knows, and the cleanup for what it let through before.
 *
 * ## The failure this exists for
 *
 * The dedupe used to live in `reflect.ts` — recall the nearest memory, skip anything too
 * similar. It worked, for reflections. It was in the *caller*, so the `memory_save` tool
 * bypassed it entirely and stored 20 identical copies of "User's full name is Dana Whitfield.
 * Married to Sam Okafor…" in under two minutes.
 *
 * The cost was not disk. `MEMORY_RECALL_K` is 5, and a run asking "what is my son's birthday"
 * got all five slots back holding that same sentence — the whole memory budget spent on one
 * fact, five times, while relevant memories could not get in. **A duplicate does not sit
 * quietly beside the original; it evicts something else.**
 *
 * So the guard moved into the function every writer must call. These tests run with no
 * embeddings endpoint, which means the keyword fallback and NaN scores — deliberately the
 * weakest configuration, because the exact-text floor is the part that must hold when
 * similarity scoring cannot.
 *
 * Run with `node test/memory-dedupe.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-dedupe-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
process.env.EMBEDDINGS_URL = ""; // force the keyword fallback: no network, NaN similarity
process.env.NOTE_MEMORY_MAX = "5";

const { countMemories, dedupeMemories, pruneMemories, remember } = await import("../src/memory/rag.ts");
const { rawDb } = await import("../src/memory/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
  );
};

const total = () => rawDb.prepare("SELECT COUNT(*) n FROM memories").get().n;
const FACT = "User's full name is Dana Whitfield. Married to Sam Okafor.";

console.log("\nTHE WRITE GATE — saying the same thing twice stores it once");
check("a new fact is saved", await remember(FACT, "note"), true);
check("the same fact again is refused", await remember(FACT, "note"), false);
check("and again", await remember(FACT, "note"), false);
check("only one row exists", total(), 1);

console.log("\nEVERY WRITER, not just the one that remembered to ask");
// The exact bug: the tool path wrote `note`, reflection wrote `reflection`, and a check
// scoped to one caller could never have caught the other.
check("a different kind does not get its own copy", await remember(FACT, "reflection"), false);
check("nor does a preference", await remember(FACT, "preference"), false);
check("still one row", total(), 1);

console.log("\nNORMALISATION — whitespace and case are not new information");
check("trailing whitespace is the same fact", await remember(`${FACT}   `, "note"), false);
check("leading whitespace too", await remember(`   ${FACT}`, "note"), false);
check("so is a different case", await remember(FACT.toUpperCase(), "note"), false);
check("still one row", total(), 1);

console.log("\nWHAT MUST STILL GET THROUGH — a guard that blocks real facts is worse than none");
check("a genuinely different fact is saved", await remember("The dog is a whippet named Biscuit.", "note"), true);
check("and another", await remember("Priya was born on 3 March 1990.", "note"), true);
check("three rows now", total(), 3);
check("empty text is not a fact", await remember("   ", "note"), false);
check("and stores nothing", total(), 3);

console.log("\nTHE BACKLOG — collapsing what was written before the gate existed");
// Inserted straight into the table, the way the 20 copies arrived: past the front door.
const raw = rawDb.prepare("INSERT INTO memories (ts, kind, text, embedding) VALUES (?,?,?,NULL)");
for (let i = 0; i < 19; i++) raw.run(new Date().toISOString(), "note", FACT);
check("the duplicates are present", total(), 22);
check("a dry run reports without deleting", dedupeMemories(true), 19);
check("and really did not delete", total(), 22);
check("the real run removes them", dedupeMemories(), 19);
check("leaving one of each", total(), 3);
check("running again is a no-op", dedupeMemories(), 0);

console.log("\nOLDEST KEPT — the original survives, the copies go");
const survivor = rawDb.prepare("SELECT id FROM memories WHERE text = ?").all(FACT);
check("exactly one copy of the fact remains", survivor.length, 1);
check("and it is the first one written", survivor[0].id, 1);

console.log("\nTHE CEILING — notes had none, which is how 20 became possible");
for (let i = 0; i < 10; i++) await remember(`Distinct note number ${i}.`, "note");
check("notes are over the cap of 5", countMemories("note") > 5, true);
const dropped = pruneMemories("note", 5);
check("pruning trims to the cap", dropped > 0, true);
check("exactly the cap remains", countMemories("note"), 5);
check("the newest are the ones kept", rawDb.prepare("SELECT text FROM memories WHERE kind='note' ORDER BY id DESC LIMIT 1").get().text, "Distinct note number 9.");

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
