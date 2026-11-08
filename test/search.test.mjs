/**
 * Searching past conversations, starring, and the "context used" record.
 * Run with `node test/search.test.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-search-${process.pid}.db`);
process.env.SPINE_DB_PATH = dbPath;
const store = await import("../src/memory/store.ts");
const { findPastOutput } = await import("../src/tools/conversation.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const mk = (title, task, note, kind = "chat") => {
  const convo = store.createConversation(title);
  const id = store.startRun({ conversationId: convo, kind, task });
  store.finishRun(id, "ok", note);
  return { convo, id };
};

const plan = mk("Agency plan", "write a business plan for an AI agency", "Executive summary. " + "Niche and pricing. ".repeat(80));
const weather = mk("Weather", "what is the weather in Boston", "Boston: 41F and clear.");
const job = mk("Cron", "daily brief", "business news digest", "schedule");

console.log("\nsearching\n");
check("finds by words in the question", store.searchRuns("business plan").map((r) => r.id), [plan.id]);
check("every word must match", store.searchRuns("business weather").length, 0);
check("finds by words in the answer", store.searchRuns("boston clear").map((r) => r.id), [weather.id]);
check("finds by conversation title", store.searchRuns("agency").map((r) => r.id), [plan.id]);
check("scheduled runs are not conversations", store.searchRuns("digest").length, 0);
check("long_only keeps just the substantial outputs", store.searchRuns("boston", { minNoteChars: 800 }).length, 0);
check("a one-letter query finds nothing", store.searchRuns("a").length, 0);

console.log("\nthe tool\n");
const out = await findPastOutput.run({ query: "business plan", long_only: true });
check("lists the run id and the way to fetch it", out.startsWith(`#${plan.id} (Agency plan`), true);
check("says so when nothing matches", /Nothing/.test(await findPastOutput.run({ query: "zebra" })), true);

console.log("\nstars and context\n");
check("starring works", store.setRunStarred(weather.id, true), true);
check("starred list carries the thread", store.starredRuns().map((r) => [r.id, r.conversationTitle]), [[weather.id, "Weather"]]);
store.setRunStarred(weather.id, false);
check("unstarring removes it", store.starredRuns().length, 0);
check("starring a missing run reports false", store.setRunStarred(99999, true), false);
store.setRunContext(plan.id, ["your profile", "memory: likes tea"]);
check("context used round-trips as JSON", JSON.parse(store.getRun(plan.id).context_used), ["your profile", "memory: likes tea"]);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
