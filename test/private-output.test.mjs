/**
 * Meeting material never reaches the cloud tier (docs/PLAN-open-work.md F2).
 *
 * `meeting_list` with `transcript: true` returns a whole transcript, and the agent loop used
 * to carry it in the message history to whichever tier the task was sized to. With `deep` and
 * a cloud key set, the next request sent it to the cloud. A tool can now declare
 * `privateOutput`, and once one has run the rest of that run, and any subagent in it, is
 * pinned to the local model.
 *
 * Two stand-in model servers record every request body they receive. The assertions are about
 * what the cloud stand-in was SENT, not about what the code says it did. A control run that
 * reads something harmless confirms the cloud stand-in would have seen the traffic.
 *
 * Run with `node test/private-output.test.mjs`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-private-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");

const CANARY = "ZEBRA-QUARTERLY-WORKPLACE-PLAN-4471";

/**
 * One stand-in model. `respond(body, n)` returns the reply text for the n-th request; the
 * default calls the scripted tool on the first turn and finishes once a tool result is in.
 */
const standIn = (log, respond) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log.push(body);
      const content = respond(body, log.length);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content, role: "assistant" } }],
          usage: { completion_tokens: 10, prompt_tokens: 10, total_tokens: 20 },
        }),
      );
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
};

const localLog = [];
const cloudLog = [];
let nextCall = null;
/** When set, the local stand-in answers in prose this many times after a tool result, to force a re-ask. */
let proseReplies = 0;
const scripted = (body) => (body.includes("tool result [") || !nextCall ? '{"action":"final","summary":"done"}' : JSON.stringify(nextCall));
const localServer = await standIn(localLog, (body) => {
  if (proseReplies > 0 && body.includes("tool result [")) {
    proseReplies--;
    return "Let me just tell you in plain prose.";
  }
  return scripted(body);
});
const cloudServer = await standIn(cloudLog, scripted);

process.env.LOCAL_LLM_URL = `http://127.0.0.1:${localServer.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "test-key";
process.env.CLOUD_LLM_URL = `http://127.0.0.1:${cloudServer.address().port}/v1`;
process.env.CLOUD_MODEL = "test-cloud";
process.env.LLM_RETRIES = "0";
process.env.EMBEDDINGS_URL = "";
process.env.CLOUD_TOKENS_PER_DAY = "";
process.env.CLOUD_TOKENS_PER_MONTH = "";
process.env.CLOUD_TOKENS_PER_RUN = "";

const store = await import("../src/memory/store.ts");
const meetings = await import("../src/meetings/store.ts");
const { runAgent } = await import("../src/agent.ts");
const { loadPolicy } = await import("../src/config.ts");
const { isPinned, outputIsPrivate, pinRun } = await import("../src/sensitivity.ts");
const { ensureTopic, updateTopic } = await import("../src/study/store.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(64)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const policy = loadPolicy();
const mid = meetings.startMeeting("mic", null, "Budget review");
meetings.addSegment(mid, "final", 0, 0, 4000, `We agreed the plan is ${CANARY}.`);

const reset = () => {
  localLog.length = 0;
  cloudLog.length = 0;
};
const run = async (tier, call, opts = {}) => {
  reset();
  nextCall = call;
  const runId = store.startRun({});
  store.beginRun(runId);
  const out = await runAgent("what was decided in the budget review?", policy, runId, { budgetRunId: runId, tier, ...opts });
  return { out, runId };
};
const has = (log) => log.filter((b) => b.includes(CANARY)).length;

console.log("\nCONTROL — a harmless tool leaves the loop on the cloud tier");
{
  await run("deep", { action: "tool", args: { key: "watch:control" }, tool: "state_get" });
  check("the cloud stand-in saw the whole run", cloudLog.length >= 2, true);
  check("the local stand-in saw none of it", localLog.length, 0);
}

console.log("\nA TRANSCRIPT READ INSIDE A DEEP-TIER LOOP");
{
  const { out, runId } = await run("deep", { action: "tool", args: { id: mid, transcript: true }, tool: "meeting_list" });
  check("the run still finishes", out.summary, "done");
  check("the first request, before any transcript existed, went to the cloud", cloudLog.length, 1);
  check("no cloud request ever contained the transcript", has(cloudLog), 0);
  check("the request after the read went to the local model", has(localLog), 1);
  check("the pin is released when the run ends", isPinned(runId), false);
}

console.log("\nA SUMMARY READ IS MEETING MATERIAL TOO");
{
  await run("deep", { action: "tool", args: { id: mid }, tool: "meeting_list" });
  check("the second request went local, not to the cloud", [cloudLog.length, localLog.length], [1, 1]);
}

console.log("\nTHE RE-ASK AFTER A MALFORMED REPLY IS PINNED AS WELL");
{
  // A reply that is not JSON is retried a tier up, which for `deep` means preferring the cloud.
  // After a transcript is in the history that retry must stay local too.
  proseReplies = 1;
  await run("deep", { action: "tool", args: { id: mid, transcript: true }, tool: "meeting_list" });
  proseReplies = 0;
  check("only the pre-transcript request reached the cloud", cloudLog.length, 1);
  check("no cloud request contained the transcript", has(cloudLog), 0);
  check("the malformed reply and its re-ask both went local", has(localLog), 2);
}

console.log("\nA SUBAGENT SHARES ITS PARENT'S PIN");
{
  reset();
  nextCall = null;
  const parent = store.startRun({});
  const child = store.startRun({});
  pinRun(parent); // the parent has read a transcript
  await runAgent("summarise it", policy, child, { budgetRunId: parent, tier: "deep" });
  check("a child started after the parent read one stays local", [cloudLog.length, localLog.length], [0, 1]);
  check("and a child does not release the parent's pin", isPinned(parent), true);

  // The other direction: a child that reads a transcript pins the parent's next request.
  reset();
  nextCall = { action: "tool", args: { id: mid, transcript: true }, tool: "meeting_list" };
  const parent2 = store.startRun({});
  const child2 = store.startRun({});
  await runAgent("read the meeting", policy, child2, { budgetRunId: parent2, tier: "deep" });
  check("a child that read one pins its root", isPinned(parent2), true);
  nextCall = null;
  reset();
  await runAgent("now answer", policy, parent2, { budgetRunId: parent2, tier: "deep" });
  check("so the parent's own next request goes local", [cloudLog.length, localLog.length], [0, 1]);
  check("and the root releases the pin when it ends", isPinned(parent2), false);
}

console.log("\nWHICH TOOLS DECLARE PRIVATE OUTPUT");
{
  check("meeting_list", outputIsPrivate("meeting_list", { id: 1 }, null), true);
  check("a harmless tool", outputIsPrivate("state_get", { key: "x" }, null), false);
  check("an unknown tool is not private", outputIsPrivate("no_such_tool", {}, null), false);

  const free = ensureTopic("Plain topic");
  const linked = ensureTopic("Linked topic");
  const pid = Number(store.rawDb.prepare("INSERT INTO projects (name, created) VALUES (?, ?)").run("P", new Date().toISOString()).lastInsertRowid);
  updateTopic(linked.id, { projectId: pid });
  check("study on an unlinked topic, outside a project", outputIsPrivate("study_map", { topic: free.name }, null), false);
  check("study on a project-linked topic", outputIsPrivate("study_map", { topic: linked.name }, null), true);
  check("study inside a project run", outputIsPrivate("study_map", { topic: free.name }, pid), true);
  check("the study listing counts once any topic is linked", outputIsPrivate("study_topic", { action: "list" }, null), true);
}

const { runTask } = await import("../src/runner.ts");
const projects = await import("../src/projects/store.ts");

console.log("\nF7a. A RUN INSIDE A PROJECT STARTS LOCAL");
{
  const pid = projects.createProject("Workplace", "");
  const src = projects.addSource(pid, "/tmp/plan.md", "path");
  projects.insertChunk(pid, src, "plan.md", 0, new Date().toISOString(), `The quarterly plan is ${CANARY}.`, null);

  reset();
  nextCall = null;
  await runTask("what does the quarterly plan say", { projectId: pid, tier: "deep" });
  check("no request reached the cloud", cloudLog.length, 0);
  check("the run went to the local model", localLog.length >= 1, true);
  check("and the project document was in what it was sent", has(localLog) >= 1, true);

  const cid = store.createConversation("in a project", pid);
  reset();
  await runTask("what does the quarterly plan say", { conversationId: cid, tier: "deep" });
  check("a thread in a project is marked local-only", store.getConversation(cid).local_only, 1);
  check("and still sent nothing to the cloud", cloudLog.length, 0);

  reset();
  await runTask("what is two plus two", { tier: "deep" });
  check("control: the same loop outside a project uses the cloud", cloudLog.length >= 1, true);
}

console.log("\nF7b. MAIL, CALENDAR AND FILE TOOLS PIN THE RUN; PUBLIC PAGES DO NOT");
{
  for (const t of ["gmail_search", "gmail_triage", "calendar_upcoming", "calendar_find", "read_file", "list_dir", "draft", "source_read"]) {
    check(`${t} is private`, outputIsPrivate(t, {}, null), true);
  }
  check("browser is not", outputIsPrivate("browser", {}, null), false);
  check("web_read is not", outputIsPrivate("web_read", {}, null), false);
  check("web_search is not", outputIsPrivate("web_search", {}, null), false);
}

console.log("\nF7c. A THREAD THAT TOUCHED PRIVATE MATERIAL STAYS LOCAL");
{
  const c1 = store.createConversation("reads a meeting", null);
  reset();
  nextCall = { action: "tool", args: { id: mid, transcript: true }, tool: "meeting_list" };
  await runTask("read the budget review", { conversationId: c1, tier: "deep" });
  check("the turn that read it marks the thread", store.getConversation(c1).local_only, 1);
  check("and nothing it was sent reached the cloud", has(cloudLog), 0);

  reset();
  nextCall = null;
  await runTask("and what else should I do", { conversationId: c1, tier: "deep" });
  check("the next turn sent nothing to the cloud", cloudLog.length, 0);
  check("it ran on the local model", localLog.length >= 1, true);

  const c2 = store.createConversation("plain", null);
  reset();
  await runTask("what is two plus two", { conversationId: c2, tier: "deep" });
  await runTask("and three plus three", { conversationId: c2, tier: "deep" });
  check("control: a thread that touched nothing private uses the cloud", cloudLog.length >= 2, true);
  check("and is not marked", store.getConversation(c2).local_only ?? 0, 0);
}

for (const s of [localServer, cloudServer]) s.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
