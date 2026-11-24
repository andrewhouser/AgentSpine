/**
 * Memory provenance (docs/PLAN-open-work.md section 4, Nod N1). Run with `node test/memory-provenance.test.mjs`.
 *
 * Every memory records the route that wrote it (`origin`) and, when there is one, the run (`run_id`). Both
 * are set by code, never by the model, so a poisoned fact cannot say it came from you. What this holds:
 *   - the columns are written, and a row with no source stores NULL, which Settings shows as "before provenance";
 *   - the vocabulary is closed: an origin that is not in ORIGINS is stored as NULL, not as free text;
 *   - a refused duplicate keeps the ORIGINAL row's provenance;
 *   - a memory whose run has been pruned says so, and a memory whose run exists does not;
 *   - every call to remember() in src/ names an origin from the vocabulary, so a new writer cannot forget.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-provenance-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = ""; // keyword fallback, no network

const store = await import("../src/memory/store.ts");
const rag = await import("../src/memory/rag.ts");
const { rawDb } = store;

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(72)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const row = (text) => {
  const r = rawDb.prepare("SELECT kind, origin, run_id AS runId FROM memories WHERE text = ?").get(text);
  return { kind: r.kind, origin: r.origin, runId: r.runId };
};

console.log("\nPROVENANCE IS WRITTEN");
const runId = store.startRun({ kind: "chat", task: "provenance test" });
check("a memory records its origin and run", (await rag.remember("Alex keeps his notes in a folder called Field Notes.", "reflection", { origin: "reflection", runId }), row("Alex keeps his notes in a folder called Field Notes.")), { kind: "reflection", origin: "reflection", runId });
check("a source with no run records the origin and a null run", (await rag.remember("The user dismissed a notification about parking.", "preference", { origin: "interrupt" }), row("The user dismissed a notification about parking.")), { kind: "preference", origin: "interrupt", runId: null });
check("no source at all stores nulls, so the UI can say 'before provenance'", (await rag.remember("An old-style memory with no source given."), row("An old-style memory with no source given.")), { kind: "note", origin: null, runId: null });
check("every origin in the vocabulary is accepted", (await Promise.all(rag.ORIGINS.map((o, i) => rag.remember(`A memory written through the ${o} route number ${i}.`, "note", { origin: o })))).every(Boolean), true);
check("friction rows are tagged by the function that writes them", (rag.rememberFriction("web_read", "timed out", 5), rawDb.prepare("SELECT origin FROM memories WHERE kind = 'friction'").get()), { origin: "friction" });

console.log("\nTHE VOCABULARY IS CLOSED AND THE RUN IS A REAL ID");
check("an origin outside the vocabulary is stored as null, not as free text", (await rag.remember("A memory claiming to come from the owner directly.", "note", { origin: "the owner said so", runId }), row("A memory claiming to come from the owner directly.")), { kind: "note", origin: null, runId });
check("a run id that is not a positive integer is stored as null", (await rag.remember("A memory with a nonsense run id attached to it.", "note", { origin: "tool", runId: "7; DROP TABLE memories" }), row("A memory with a nonsense run id attached to it.")), { kind: "note", origin: "tool", runId: null });
check("the memories table is still there", rawDb.prepare("SELECT count(*) AS n FROM memories").get().n > 0, true);

console.log("\nA REFUSED DUPLICATE KEEPS THE ORIGINAL PROVENANCE");
const first = "Alex's team stand-up is at 9:15 on weekdays.";
await rag.remember(first, "reflection", { origin: "reflection", runId });
const again = await rag.remember(first, "note", { origin: "tool", runId: undefined });
check("the second write is refused", again, false);
check("there is still one row", rawDb.prepare("SELECT count(*) AS n FROM memories WHERE text = ?").get(first).n, 1);
check("it still says reflection and the first run, not tool and no run", row(first), { kind: "reflection", origin: "reflection", runId });
const shouting = await rag.remember(first.toUpperCase(), "note", { origin: "profile" });
check("a case-only variant is refused the same way and changes nothing", [shouting, row(first)], [false, { kind: "reflection", origin: "reflection", runId }]);

console.log("\nTHE LIST SAYS WHETHER THE RUN IS STILL THERE");
// An old memory: inserted the way the table was written before these columns existed.
rawDb.prepare("INSERT INTO memories (ts, kind, text) VALUES (?, 'note', ?)").run(new Date().toISOString(), "A memory from before provenance was tracked.");
// A memory whose run was pruned: its run_id points at a row that is gone.
const prunedRun = store.startRun({ kind: "chat", task: "will be pruned" });
await rag.remember("A fact learned in a run that has since been pruned.", "reflection", { origin: "reflection", runId: prunedRun });
rawDb.prepare("DELETE FROM messages WHERE run_id = ?").run(prunedRun);
rawDb.prepare("DELETE FROM runs WHERE id = ?").run(prunedRun);
const byText = (rows, text) => rows.find((r) => r.text === text);
const all = rag.listMemories(500);
const live = byText(all, "Alex keeps his notes in a folder called Field Notes.");
const pruned = byText(all, "A fact learned in a run that has since been pruned.");
const old = byText(all, "A memory from before provenance was tracked.");
check("a memory whose run exists is not marked pruned", [live.origin, live.runId, live.runPruned], ["reflection", runId, false]);
check("a memory whose run is gone is marked pruned, and keeps its run id", [pruned.origin, pruned.runId, pruned.runPruned], ["reflection", prunedRun, true]);
check("a memory from before provenance has no origin, no run, and is not 'pruned'", [old.origin, old.runId, old.runPruned], [null, null, false]);
check("a memory with no run at all is not marked pruned", byText(all, "The user dismissed a notification about parking.").runPruned, false);
check("search still works and carries the same fields", rag.listMemories(10, "stand-up").map((r) => [r.origin, r.runPruned]), [["reflection", false]]);

console.log("\nEVERY CALL TO remember() NAMES AN ORIGIN");
// Read from the syntax tree, not a regex: the calls span lines and the arguments contain parentheses in strings.
const SRC = path.join(import.meta.dirname, "..", "src");
const calls = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (full.endsWith(".ts") && path.relative(SRC, full) !== path.join("memory", "rag.ts")) {
      const file = ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.ESNext, true);
      const visit = (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "remember") {
          const third = n.arguments[2];
          const origin = third && ts.isObjectLiteralExpression(third) ? third.properties.find((p) => p.name?.getText() === "origin") : null;
          const value = origin && ts.isPropertyAssignment(origin) && ts.isStringLiteral(origin.initializer) ? origin.initializer.text : null;
          calls.push({ file: path.relative(SRC, full), origin: value });
        }
        ts.forEachChild(n, visit);
      };
      visit(file);
    }
  }
};
walk(SRC);
check("there are call sites to check", calls.length >= 10, true);
check("each one passes { origin: <a string from the vocabulary> }", calls.filter((c) => !c.origin || !rag.ORIGINS.includes(c.origin)).map((c) => c.file), []);
check("the origins used are all in the vocabulary, and every one except friction is used", [...new Set(calls.map((c) => c.origin))].sort(), rag.ORIGINS.filter((o) => o !== "friction").sort());

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
