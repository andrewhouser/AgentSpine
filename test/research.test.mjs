/**
 * Kept sources, and the seeded morning brief. Run with `node test/research.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-research-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
const sources = await import("../src/research/sources.ts");
const { sourcesList, sourceRead } = await import("../src/tools/sources.ts");
const { ensureMorningBrief, BRIEF_NAME } = await import("../src/briefing.ts");
const store = await import("../src/memory/store.ts");
const rawDbReset = () => store.rawDb.prepare("DELETE FROM seeds WHERE name = ?").run(BRIEF_NAME);

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nsources\n");
const a = sources.saveSource("https://example.com/a", "Page A", "mac mini power draw is about 7 watts idle", 5);
const a2 = sources.saveSource("https://example.com/a", "Page A", "updated text", 5);
check("a refetch in the same run reuses the row", a2, a);
const b = sources.saveSource("https://example.com/b", null, "x".repeat(70_000), 5);
check("text is capped", sources.getSource(b).text.length, sources.MAX_SOURCE_CHARS);
check("the list finds by words in the page", sources.listSources("updated").map((r) => r.id), [a]);
check("the list is newest first", sources.listSources().map((r) => r.id), [b, a]);
check("source_list tool shows ids and urls", (await sourcesList.run({})).includes(`#${a} https://example.com/a`), true);
const first = await sourceRead.run({ id: b });
check("source_read windows and says how to continue", first.includes('"offset": 6000'), true);
check("and labels the text untrusted", /UNTRUSTED/.test(first), true);
check("a missing id is explained", /No source/.test(await sourceRead.run({ id: 999 })), true);
check("pruning removes only old rows", sources.pruneSources(60), 0);

console.log("\nthe morning brief\n");
// An existing brief with different capitalisation must be respected, not duplicated.
store.createSchedule("morning BRIEF", "x", "weekdays at 8am", true);
check("an existing brief of any capitalisation is respected", ensureMorningBrief(), false);
check("and nothing was added", store.listSchedules().length, 1);
for (const s of store.listSchedules()) store.deleteSchedule(s.id);
rawDbReset();
check("seeds once", ensureMorningBrief(), true);
check("creates an ordinary, enabled schedule", store.listSchedules().filter((s) => s.name === BRIEF_NAME && s.enabled).length, 1);
check("does not seed twice", ensureMorningBrief(), false);
for (const s of store.listSchedules()) store.deleteSchedule(s.id);
check("a deleted brief is never recreated", ensureMorningBrief(), false);
check("and nothing came back", store.listSchedules().length, 0);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
