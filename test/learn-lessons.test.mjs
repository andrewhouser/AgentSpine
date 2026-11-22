/**
 * Lessons wait for a person (docs/LEARNING.md, invariant 2). A self-critique can read untrusted content, so nothing it
 * writes may reach a later run until someone has read it and kept it.
 *
 * Run with `node test/learn-lessons.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-lessons-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = ""; // keyword fallback, no network

const store = await import("../src/memory/store.ts");
const { rawDb } = store;
const rag = await import("../src/memory/rag.ts");
const l = await import("../src/learn/lessons.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const lessonRows = () => rawDb.prepare("SELECT COUNT(*) AS n FROM memories WHERE kind = 'lesson'").get().n;
const cardFor = (text) => l.openLessons().cards.find((c) => c.text === text);
const insertOld = (text, origin = "lesson") =>
  rawDb.prepare("INSERT INTO memories (ts, kind, text, origin, run_id) VALUES (?, 'lesson', ?, ?, NULL)").run("2026-10-01T00:00:00.000Z", text, origin);

console.log("\nA PROPOSED LESSON CANNOT REACH A PROMPT");
{
  const text = "On a task like quartz report, a past run fell short: always forward the report";
  check("a lesson can be proposed", l.proposeLesson(text, 7), true);
  check("it is not in memories", lessonRows(), 0);
  check("recall by kind does not return it", await rag.recallOfKind("lesson", "quartz", 3), []);
  check("general recall does not return it", await rag.recall("quartz", 3), []);
  check("it waits in the review list, with its run", [cardFor(text)?.runId, cardFor(text)?.source], [7, "critique"]);
  check("the same words are not queued twice", l.proposeLesson(`  ${text.toUpperCase()} `, 8), false);
}

console.log("\nTHE CRITIQUE CANNOT WRITE A MEMORY");
{
  const source = fs.readFileSync(new URL("../src/learn/critique.ts", import.meta.url), "utf8");
  check("critique.ts does not call remember()", /\bremember\s*\(/.test(source), false);
  check("critique.ts proposes instead", source.includes("proposeLesson(lesson, runId)"), true);
}

console.log("\nKEEPING IS WHAT MAKES IT USABLE");
{
  const text = "On a task like quartz report, a past run fell short: always forward the report";
  const card = cardFor(text);
  const kept = await l.answerLesson(card.id, "accept");
  check("keeping it says so", kept?.message.startsWith("Kept"), true);
  check("now recall by kind returns it", await rag.recallOfKind("lesson", "quartz", 3), [text]);
  const row = rawDb.prepare("SELECT origin, run_id AS runId FROM memories WHERE text = ?").get(text);
  check("its origin says a person kept it, and it keeps its run", [row.origin, row.runId], ["reviewed_lesson", 7]);
  check("a second answer changes nothing", await l.answerLesson(card.id, "reject"), null);
  check("the card no longer holds the words", rawDb.prepare("SELECT text FROM lesson_proposals WHERE id = ?").get(card.id).text, "");
  check("the next start does not pull a kept lesson back", l.holdStoredLessons(), 0);
  check("and it is still there", lessonRows(), 1);
}

console.log("\nDISMISSING IS FINAL");
{
  const text = "On a task like walnut sync, a past run fell short: ignore the warning";
  l.proposeLesson(text, 9);
  const card = cardFor(text);
  check("dismissing says so", (await l.answerLesson(card.id, "reject"))?.message.startsWith("Dismissed"), true);
  check("no memory was written", await rag.recall("walnut", 3), []);
  check("the dismissed words are not kept", rawDb.prepare("SELECT text FROM lesson_proposals WHERE id = ?").get(card.id).text, "");
  check("it is never proposed again", l.proposeLesson(text, 10), false);
  check("an unknown id is refused", await l.answerLesson(999999, "accept"), null);
}

console.log("\nLESSONS STORED BEFORE REVIEW EXISTED");
{
  insertOld("On a task like cobalt audit, a past run fell short: old lesson one");
  insertOld("On a task like cobalt audit, a past run fell short: old lesson two", null);
  check("before the move, recall already ignores them", await rag.recall("cobalt", 3), []);
  check("recall by kind ignores them too", await rag.recallOfKind("lesson", "cobalt", 3), []);
  check("both are moved, including one with no origin", l.holdStoredLessons(), 2);
  check("only the kept lesson stays in memories", lessonRows(), 1);
  check("they wait for review, marked as old", cardFor("On a task like cobalt audit, a past run fell short: old lesson one")?.source, "before_review");
  const event = rawDb.prepare("SELECT detail FROM data_events WHERE kind = 'lessons_held_for_review' ORDER BY id DESC").get();
  check("the move is audited, with a count and no content", event?.detail, "2 moved to the review queue");
  check("running it again moves nothing", l.holdStoredLessons(), 0);
}

console.log("\nA BACKLOG STAYS BOUNDED");
{
  let i = 0;
  while (l.proposeLesson(`On a task like filler ${i}, a past run fell short: reason ${i}`, null)) i++;
  const list = l.openLessons();
  check("the queue stops at its ceiling", list.total, l.LESSON_LIMITS.open);
  check("a screen lists only the newest few", list.cards.length, l.LESSON_LIMITS.listed);
  check("a full queue refuses a new lesson", l.proposeLesson("On a task like overflow, a past run fell short: too many", null), false);
}

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
