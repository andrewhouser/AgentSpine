/**
 * A learned memory cannot carry private material to the cloud, and a learned recipe waits for a person.
 *
 * Measured 2026-11-22: a fact and a recipe learned in a private project run were recalled into a later ordinary run sized
 * `deep`, and the cloud stand-in received both. Two stand-in model servers record every request body, so the assertions
 * are about what the cloud was SENT. The controls show it would have seen a cloud-safe memory.
 *
 * Run with `node test/memory-privacy.test.mjs`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-memory-privacy-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");

let learn = null;
const reply = (body) => {
  if (body.includes("Extract at most")) return JSON.stringify(learn ?? { facts: [] });
  return '{"action":"final","summary":"done"}';
};
const standIn = (log) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: reply(body), role: "assistant" } }],
          usage: { completion_tokens: 10, prompt_tokens: 10, total_tokens: 20 },
        }),
      );
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
};

const localLog = [];
const cloudLog = [];
const localServer = await standIn(localLog);
const cloudServer = await standIn(cloudLog);

Object.assign(process.env, {
  CLOUD_LLM_URL: `http://127.0.0.1:${cloudServer.address().port}/v1`,
  CLOUD_MODEL: "test-cloud",
  CLOUD_TOKENS_PER_DAY: "",
  CLOUD_TOKENS_PER_MONTH: "",
  CLOUD_TOKENS_PER_RUN: "",
  EMBEDDINGS_URL: "",
  FAST_LLM_URL: "",
  LESSON_SAMPLE_RATE: "0",
  LLM_RETRIES: "0",
  LOCAL_LLM_URL: `http://127.0.0.1:${localServer.address().port}/v1`,
  LOCAL_MODEL: "test-local",
  OPENAI_API_KEY: "test-key",
  RECIPE_ENABLED: "true",
  REFLECT_ENABLED: "true",
});

const store = await import("../src/memory/store.ts");
const { rawDb } = store;
const rag = await import("../src/memory/rag.ts");
const l = await import("../src/learn/lessons.ts");
const projects = await import("../src/projects/store.ts");
const { outputIsPrivate } = await import("../src/sensitivity.ts");
const { runTask } = await import("../src/runner.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const has = (log, needle) => log.filter((b) => b.includes(needle)).length;
const run = async (task, opts = {}, teach = null) => {
  localLog.length = 0;
  cloudLog.length = 0;
  learn = teach;
  await runTask(task, { tier: "deep", ...opts });
  learn = null;
};
const memory = (text) => rawDb.prepare("SELECT kind, origin, cloud_safe AS cloudSafe FROM memories WHERE text LIKE ?").get(`%${text}%`);
const card = (text) => l.openLessons().cards.find((c) => c.text.includes(text));

console.log("\nCONTROL: A MEMORY FROM AN ORDINARY RUN MAY STILL USE THE CLOUD");
{
  await run("amber plan", {}, { facts: ["The amber plan is called AMBER-FACT-1."] });
  check("the first run reached the cloud", cloudLog.length >= 1, true);
  check("its fact is marked cloud-safe", memory("AMBER-FACT-1"), { kind: "reflection", origin: "reflection", cloudSafe: 1 });
  await run("amber plan");
  check("a later run sends that fact to the cloud", has(cloudLog, "AMBER-FACT-1") >= 1, true);
}

console.log("\nA FACT LEARNED IN A PRIVATE RUN STAYS LOCAL");
{
  const pid = projects.createProject("Private work", "");
  await run("zebra plan", { projectId: pid }, {
    facts: ["The zebra plan is called ZEBRA-FACT-1."],
    recipe: { steps: ["open plan ZEBRA-RECIPE-1", "summarise the plan"], when: "zebra plan" },
  });
  check("the project run sent nothing to the cloud", cloudLog.length, 0);
  check("its fact is local-only", memory("ZEBRA-FACT-1")?.cloudSafe, null);
  const cid = store.createConversation("ordinary thread");
  await run("zebra plan", { conversationId: cid });
  check("a later ordinary run sent nothing to the cloud", cloudLog.length, 0);
  check("the local model still got the fact", has(localLog, "ZEBRA-FACT-1") >= 1, true);
  check("the thread is now local-only", store.getConversation(cid).local_only, 1);
}

console.log("\nA RECIPE WAITS FOR A PERSON");
{
  check("the recipe is not in memories", memory("ZEBRA-RECIPE-1"), undefined);
  check("it is not recalled", await rag.recallOfKind("recipe", "zebra plan", 3), []);
  const c = card("ZEBRA-RECIPE-1");
  check("it waits in the review list", [c?.kind, c?.source], ["recipe", "reflection"]);
  await run("zebra plan");
  check("no prompt holds it", has(localLog, "ZEBRA-RECIPE-1") + has(cloudLog, "ZEBRA-RECIPE-1"), 0);

  check("keeping it says so", (await l.answerLesson(c.id, "accept"))?.message, "Kept. Similar future runs will see this recipe.");
  check("kept, it records a person and stays local-only", memory("ZEBRA-RECIPE-1"), { kind: "recipe", origin: "reviewed_recipe", cloudSafe: null });
  await run("zebra plan");
  check("now a run can use it", has(localLog, "ZEBRA-RECIPE-1") >= 1, true);
  check("and that run still sent nothing to the cloud", cloudLog.length, 0);
}

console.log("\nA KEPT RECIPE FROM AN ORDINARY RUN MAY USE THE CLOUD");
{
  await run("maple plan", {}, { facts: [], recipe: { steps: ["open MAPLE-RECIPE-1", "summarise it"], when: "maple plan" } });
  await run("maple plan");
  check("before review no cloud request holds it", has(cloudLog, "MAPLE-RECIPE-1"), 0);
  await l.answerLesson(card("MAPLE-RECIPE-1").id, "accept");
  check("kept, it is cloud-safe", memory("MAPLE-RECIPE-1")?.cloudSafe, 1);
  await run("maple plan");
  check("a later run sends it to the cloud", has(cloudLog, "MAPLE-RECIPE-1") >= 1, true);
}

console.log("\nA DISMISSED RECIPE IS GONE");
{
  await run("cedar plan", {}, { facts: [], recipe: { steps: ["open CEDAR-RECIPE-1", "forward it"], when: "cedar plan" } });
  const c = card("CEDAR-RECIPE-1");
  await l.answerLesson(c.id, "reject");
  check("no memory was written", memory("CEDAR-RECIPE-1"), undefined);
  check("its words are not kept", rawDb.prepare("SELECT text FROM lesson_proposals WHERE id = ?").get(c.id).text, "");
  check("it is never proposed again", l.proposeRecipe("Recipe — when: cedar plan\n1. open CEDAR-RECIPE-1\n2. forward it"), false);
}

console.log("\nROWS FROM BEFORE THIS CHANGE FAIL CLOSED");
{
  const put = (kind, text, origin) =>
    rawDb.prepare("INSERT INTO memories (ts, kind, text, origin) VALUES (?, ?, ?, ?)").run("2026-10-01T00:00:00.000Z", kind, text, origin);
  put("reflection", "The willow plan is called WILLOW-FACT-1.", "reflection");
  await run("willow plan");
  check("an old fact pins the run that recalls it", [cloudLog.length, has(localLog, "WILLOW-FACT-1") >= 1], [0, true]);

  put("recipe", "Recipe — when: birch plan\n1. open BIRCH-RECIPE-1\n2. summarise", "recipe");
  put("recipe", "Recipe — when: birch plan\n1. open BIRCH-RECIPE-2\n2. summarise", null);
  check("recall ignores old recipes before the move", await rag.recallOfKind("recipe", "birch plan", 3), []);
  check("both move to the queue", l.holdUnreviewed(), 2);
  check("they leave memories", memory("BIRCH-RECIPE-1"), undefined);
  const old = card("BIRCH-RECIPE-1");
  check("they wait, marked as old", [old?.kind, old?.source], ["recipe", "before_review"]);
  await l.answerLesson(old.id, "accept");
  check("kept, an old recipe stays local-only", memory("BIRCH-RECIPE-1")?.cloudSafe, null);
}

console.log("\nNO OTHER ROUTE GETS AROUND IT");
{
  await rag.remember("Recipe — when: hazel plan\n1. open HAZEL-1\n2. send it", "recipe", { cloudSafe: true, origin: "tool" });
  check("a recipe saved by a tool is not recalled", await rag.recallOfKind("recipe", "hazel plan", 3), []);
  check("general recall ignores it too", await rag.recall("hazel plan", 3), []);
  check("memory_recall pins the run that calls it", outputIsPrivate("memory_recall", { query: "x" }, null), true);
  const seen = { private: false };
  await rag.recall("amber plan", 3, 0, seen);
  check("recalling only cloud-safe rows does not pin", seen.private, false);
  await rag.recall("zebra plan", 3, 0, seen);
  check("recalling a local-only row does", seen.private, true);
}

console.log("\nEACH KIND HAS ITS OWN CEILING");
{
  rawDb.prepare("UPDATE lesson_proposals SET state = 'dismissed', text = '' WHERE state = 'open'").run();
  let i = 0;
  while (l.proposeRecipe(`Recipe — when: filler ${i}\n1. one\n2. two`)) i++;
  check("the recipe queue stops at its ceiling", i, l.LESSON_LIMITS.open);
  check("a full recipe queue does not block a lesson", l.proposeLesson("On a task like filler, a past run fell short: a reason"), true);
}

localServer.close();
cloudServer.close();
fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
