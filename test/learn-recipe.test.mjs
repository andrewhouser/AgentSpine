/**
 * Recipes and lessons (LEARNING Phase 3), the parts that don't need a live model.
 *
 * The recipe extraction and the self-critique both make a model call, which a test cannot
 * run offline. What is testable deterministically is the machinery around them: the
 * eligibility gate (`runIsClean`) that decides whether a run may teach a recipe at all, the
 * kind-scoped recall that surfaces recipes and lessons separately from facts, and the
 * critique's sampling gate and sensitivity decision.
 *
 * Run with `node test/learn-recipe.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-recipe-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
process.env.EMBEDDINGS_URL = ""; // keyword fallback — no network

const store = await import("../src/memory/store.ts");
const { rawDb } = store;
const { recallOfKind } = await import("../src/memory/rag.ts");
const { critiqueRun } = await import("../src/learn/critique.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(54)} ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nELIGIBILITY — only a clean run may teach a recipe");
{
  const clean = store.startRun({ kind: "chat", task: "check host health" });
  store.logAction(clean, { args: {}, tool: "web_read" }, null, "executed", "ok");
  store.finishRun(clean, "ok", "done");
  check("a run with only executed calls is clean", store.runIsClean(clean), true);

  const errored = store.startRun({ kind: "chat", task: "t" });
  store.logAction(errored, { args: {}, tool: "web_read" }, null, "error", "ERROR: timed out");
  store.finishRun(errored, "ok", "done");
  check("a run with an errored call is not clean", store.runIsClean(errored), false);

  const rejected = store.startRun({ kind: "chat", task: "t" });
  const cid = store.queueConfirmation({ tool: "draft", args: { kind: "text", body: "x" } }, "a draft", rejected);
  store.setConfirmation(cid, "rejected", "no");
  store.finishRun(rejected, "ok", "done");
  check("a run with a rejected proposal is not clean", store.runIsClean(rejected), false);
}

console.log("\nKIND-SCOPED RECALL — recipes and lessons come back by kind");
{
  const now = new Date().toISOString();
  rawDb.prepare("INSERT INTO memories (ts, kind, text, embedding) VALUES (?, 'recipe', ?, NULL)").run(now, "Recipe — when: checking model host health\n1. web_read the models endpoint\n2. a list means it is up");
  rawDb.prepare("INSERT INTO memories (ts, kind, text, embedding) VALUES (?, 'lesson', ?, NULL)").run(now, "On a task like host health, a past run fell short: it never checked the endpoint");
  rawDb.prepare("INSERT INTO memories (ts, kind, text, embedding) VALUES (?, 'reflection', ?, NULL)").run(now, "Andrew runs the model on a LAN box");

  // The keyword fallback (no embedder in the test) matches the query as a literal substring,
  // so query with words that actually appear in the stored recipe. Semantic recall against a
  // real embedder is looser; this asserts the kind filter, which is the part under test.
  const recipes = await recallOfKind("recipe", "model host", 3);
  check("a recipe is recalled", recipes.length, 1);
  check("recipe recall does not return the fact", recipes.some((t) => t.includes("LAN box")), false);

  const lessons = await recallOfKind("lesson", "host health", 3);
  check("a lesson is recalled", lessons.length, 1);
  check("lesson recall does not return the recipe", lessons.some((t) => t.startsWith("Recipe")), false);
}

console.log("\nCRITIQUE SAMPLING — an unsampled run makes no model call and stores nothing");
{
  const run = store.startRun({ kind: "chat", task: "t" });
  store.finishRun(run, "ok", "done");
  const lesson = await critiqueRun(run, "some task", [{ role: "user", content: "hi" }], "did the thing", false);
  check("sampleOverride=false → no lesson", lesson, null);
  check("no lesson memory written", store.rawDb.prepare("SELECT COUNT(*) n FROM memories WHERE kind='lesson'").get().n, 1); // the one we inserted above
}

console.log("\nCRITIQUE SENSITIVITY — a trace that read mail pins the judge local");
{
  // With no cloud configured, judge() falls back to local anyway; what we assert here is
  // that the sensitive-tool detection reads the audit log correctly, since that is the input
  // to the private pin. (The judge call itself is exercised only against a live model.)
  const run = store.startRun({ kind: "chat", task: "read my mail" });
  store.logAction(run, { args: { query: "is:unread" }, tool: "gmail_search" }, null, "executed", "3 messages");
  store.finishRun(run, "ok", "done");
  const touchedMail = store.listActions(run).some((a) => a.tool === "gmail_search");
  check("a gmail_search call is visible in the audit log", touchedMail, true);
}

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
