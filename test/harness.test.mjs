/**
 * The harness context: one code-owned account of what a run is (docs/PLAN-open-work.md, section 9, S1 and S2).
 *
 * Pure pieces first (the context, the child's context, the contract, the envelope), then an end
 * to end run against a stand-in model server to see what the model is actually sent and what the
 * trace keeps. Prompt substrings are tripwires; the broker still decides every call.
 *
 * Run with `node test/harness.test.mjs`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-harness-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";

const bodies = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    bodies.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"action":"final","summary":"done"}', role: "assistant" } }], usage: { total_tokens: 1 } }));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${model.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_RETRIES = "0";

const h = await import("../src/harness.ts");
const store = await import("../src/memory/store.ts");
const { runAgent } = await import("../src/agent.ts");
const { runTask } = await import("../src/runner.ts");
const { loadPolicy } = await import("../src/config.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(66)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

console.log("\nMODES AND AUDIENCE");
{
  const ctx = (kind) => h.buildHarnessContext({ kind, runId: 1, tier: "standard", tools: [] });
  check("chat and approval face a person", [ctx("chat").audience, ctx("approval").audience], ["person", "person"]);
  check("a schedule and the heartbeat face the ledger", [ctx("schedule").mode, ctx("schedule").audience, ctx("heartbeat").audience], ["scheduled", "ledger", "ledger"]);
  check("a one-off task faces the ledger", [ctx("do").mode, ctx("do").audience], ["task", "ledger"]);
  check("a subagent kind reports to its parent", ctx("subagent").audience, "parent");
}

console.log("\nTHE ENVELOPE");
{
  const chat = h.buildHarnessContext({ conversationId: 7, history: true, kind: "chat", memory: true, project: { id: 3, name: "Reorg" }, projectKnowledge: true, runId: 42, tier: "deep", tools: ["write_file"], writeDir: "/docs/reorg" });
  const text = h.renderEnvelope(chat, false);
  check("names the run, the mode and the audience", text.includes("Run 42: a live chat turn"), true);
  check("names the conversation and project", text.includes("Conversation #7") && text.includes('Project: "Reorg" (#3)'), true);
  check("states where a bare filename is saved", text.includes("saved in /docs/reorg"), true);
  check("lists what it can draw on", text.includes("earlier turns, saved memories, the project's documents"), true);
  check("says plainly that mail is never sent", text.includes("sending email"), true);
  check("a normal run is not described as private", text.includes("Privacy: normal"), true);

  const priv = h.renderEnvelope({ ...chat, private: true }, false);
  check("a private run says it is local and why the tier differs", priv.includes("Privacy: private") && priv.includes("running on the local model because it is private"), true);
  check("pinned mid-run reads the same as private", h.renderEnvelope(chat, true).includes("Privacy: private"), true);

  const job = h.renderEnvelope(h.buildHarnessContext({ kind: "schedule", preApproved: true, runId: 9, tier: "standard", tools: [] }), false);
  check("an unattended run names the ledger and standing approval", job.includes("run ledger") && job.includes("Standing approval"), true);
  check("a run with nothing to draw on says so", job.includes("only this task and your tools"), true);
  check("no write folder and no write_file: nothing claimed about saving", job.includes("saved in"), false);

  const noSecrets = JSON.stringify(h.renderEnvelope(chat)) + JSON.stringify(h.harnessContract(["write_file"], true));
  check("no token, key or raw policy field appears", /token|apikey|api_key|password|policy\.json|fetchAllowlist|readableDirs/i.test(noSecrets), false);
}

console.log("\nTHE CONTRACT");
{
  const base = h.harnessContract(["web_search"], true);
  check("always states the broker, QUEUED, untrusted text and the limits of the model", [/capability broker gates every tool call/, /QUEUED means/, /UNTRUSTED/, /cannot edit policy/].every((r) => r.test(base)), true);
  check("without schedule_create it makes no claim about a scheduler", /scheduler|standing instructions/.test(base), false);
  check("with schedule_create it does", /a scheduler/.test(h.harnessContract(["schedule_create"], true)), true);
  check("without meeting tools it does not mention meetings", /recorded meetings/.test(base), false);
  check("with meeting_list it does", /recorded meetings/.test(h.harnessContract(["meeting_list"], true)), true);
  check("a chat says the decision returns as the next turn", /next turn/.test(base), true);
  check("an unattended run says it waits in the Approvals list", /Approvals list/.test(h.harnessContract([], false)), true);
  check("notify is only mentioned when it is visible", [/notify/.test(h.harnessContract([], false)), /notify/.test(h.harnessContract(["notify"], false))], [false, true]);
  check("the same tools give the same bytes", h.harnessContract(["a", "memory_save"], true) === h.harnessContract(["a", "memory_save"], true), true);
  check("the contract carries nothing run-specific", /Run \d|#\d|Reorg/.test(h.harnessContract(["schedule_create", "memory_save", "meeting_list", "notify"], false)), false);
}

console.log("\nA HELPER GETS ITS OWN CONTEXT");
{
  const parent = h.buildHarnessContext({ conversationId: 7, history: true, kind: "chat", memory: true, preApproved: true, private: true, project: { id: 3, name: "Reorg" }, projectKnowledge: true, runId: 42, tier: "deep", tools: ["a", "b", "c"], writeDir: "/docs" });
  const child = h.childHarness(parent, { runId: 43, tier: "fast", tools: ["a"] });
  check("it reports to its parent, not to a person", [child.mode, child.audience], ["subagent", "parent"]);
  check("it sees only its own tools and tier", [child.tools, child.tier, child.runId], [["a"], "fast", 43]);
  check("it has no conversation, history, memory or project documents of its own", [child.conversationId, child.history, child.memory, child.projectKnowledge], [null, false, false, false]);
  check("it keeps what is still true: project, privacy, standing approval", [child.project?.name, child.private, child.preApproved], ["Reorg", true, true]);
  check("the parent is untouched", parent.tools, ["a", "b", "c"]);
  check("its envelope does not say a person is reading", h.renderEnvelope(child).includes("reading your reply"), false);
}

console.log("\nWHAT THE MODEL IS ACTUALLY SENT");
{
  bodies.length = 0;
  const policy = loadPolicy();
  const runId = store.startRun({});
  store.beginRun(runId);
  const harness = h.buildHarnessContext({ kind: "schedule", preApproved: true, runId, tier: "standard", tools: [] });
  const out = await runAgent("say done", policy, runId, { budgetRunId: runId, harness, tier: "standard" });
  const sent = JSON.parse(bodies[0]).messages.map((m) => m.content).join("\n");
  check("the run finishes", out.summary, "done");
  check("the request carries the envelope for this run", sent.includes(`Run ${runId}: a scheduled run`), true);
  check("and the contract", sent.includes("How AgentSpine works"), true);
  check("the envelope comes after the stable prompt", sent.indexOf("How AgentSpine works") < sent.indexOf("This run, as the application records it"), true);
  check("the trace keeps the exact envelope", out.trace.some((m) => m.role === "system" && String(m.content).includes(`Run ${runId}:`)), true);
  check("a scheduled run is not told a person is reading", sent.includes("is reading your reply as it happens"), false);
  check("the registered context is released when the run ends", h.getHarness(runId), undefined);

  // The same contract bytes for two different runs: nothing run-specific in the stable part.
  bodies.length = 0;
  const r2 = store.startRun({});
  store.beginRun(r2);
  await runAgent("say done", policy, r2, { budgetRunId: r2, harness: { ...harness, runId: r2 }, tier: "standard" });
  const contractIn = (b) => {
    const all = JSON.parse(b).messages.map((m) => m.content).join("\n");
    return all.slice(all.indexOf("How AgentSpine works"), all.indexOf("Rules:"));
  };
  check("the contract the model was sent is byte-identical for two runs", contractIn(bodies[0]) !== "" && contractIn(bodies[0]) === contractIn(bodies[bodies.length - 1]) && bodies.length >= 1, true);
  check("while the envelope differs by run id", JSON.parse(bodies[0]).messages.map((m) => m.content).join("\n").includes(`Run ${r2}:`), true);
}

console.log("\nTHE RUNNER BUILDS IT");
{
  bodies.length = 0;
  const pid = (await import("../src/projects/store.ts")).createProject("Q3 plan", "");
  await runTask("say done", { kind: "chat", projectId: pid, tier: "standard" });
  const sent = JSON.parse(bodies[0]).messages.map((m) => m.content).join("\n");
  check("a project run's envelope names the project", sent.includes('Project: "Q3 plan"'), true);
  check("and says it is private", sent.includes("Privacy: private"), true);
  check("a chat turn is described as a live chat", sent.includes("a live chat turn"), true);
}

model.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
