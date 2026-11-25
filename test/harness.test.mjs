/**
 * The harness context: one code-owned account of what a run is (docs/PLAN-open-work.md, section 9, S1 and S2).
 *
 * Pure pieces first (the context, the child's context, the contract, the envelope), then an end
 * to end run against a stand-in model server to see what the model is actually sent and what the
 * trace keeps. Prompt substrings are tripwires; the broker still decides every call.
 *
 * Run with `node test/harness.test.mjs`.
 */
import "./helpers/example-policy.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-harness-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";

const bodies = [];
/** Replies to give, in order, before falling back to a plain final answer. */
const script = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    bodies.push(body);
    const content = script.shift() ?? '{"action":"final","summary":"done"}';
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content, role: "assistant" } }], usage: { total_tokens: 1 } }));
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
  check("with no capabilities recorded it still states a limit that is always true", text.includes("Cannot: permanently delete mail"), true);
  const noMac = h.summarizeCapabilities(["gmail_search"], { apps: { allow: ["com.apple.mail"] }, google: { enabled: true } }, { cloudPrivateBlocked: false });
  check("without mac_control, mail is drafted and never sent", noMac.cannot.includes("send email (mail is drafted, never sent)"), true);
  const withMac = h.summarizeCapabilities(["mac_control"], { apps: { allow: ["com.apple.mail", "com.apple.MobileSMS"] }, userDirected: { actions: ["mac_control.send_mail"], enabled: true } }, { cloudPrivateBlocked: false });
  check("with mac_control and Mail allowed, mail CAN be sent, after approval", withMac.can.some((x) => x.includes("send mail through the Mac's Mail app") && x.includes("approval")), true);
  check("and only Gmail mail is called drafted-never-sent", withMac.cannot.some((x) => x.startsWith("send email through Gmail")), true);
  const trustPolicy = { drafts: { enabled: true }, schedules: { enabled: true }, trust: { chatAutoTools: ["draft", "schedule_create"] } };
  const chatTrusted = h.summarizeCapabilities(["draft", "schedule_create"], trustPolicy, { cloudPrivateBlocked: false, conversational: true });
  check("a chat that trusts drafts and schedules says they run at once", chatTrusted.can.some((x) => x.includes("this chat trusts drafts")) && chatTrusted.can.some((x) => x.includes("create schedules at once")), true);
  const unattended = h.summarizeCapabilities(["draft", "schedule_create"], trustPolicy, { cloudPrivateBlocked: false, conversational: false });
  check("an unattended run can only propose schedules", unattended.can.some((x) => x.startsWith("propose schedule changes")), true);
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

console.log("\nS1. ONE MEANING OF CHAT AND SCHEDULED FOR THE ENVELOPE AND THE TOOLS");
{
  const kinds = ["chat", "approval", "schedule", "heartbeat", "subagent", "do"];
  const ctxs = Object.fromEntries(kinds.map((k) => [k, h.buildHarnessContext({ kind: k, runId: 1, tier: "standard", tools: [] })]));
  check("conversational: only a chat turn and an approval turn", kinds.filter((k) => ctxs[k].conversational), ["chat", "approval"]);
  check("preApproved: only a schedule and the heartbeat", kinds.filter((k) => ctxs[k].preApproved), ["schedule", "heartbeat"]);
  check("the mode and the shared fact never disagree", kinds.filter((k) => ctxs[k].conversational !== (ctxs[k].audience === "person")), []);
  const child = h.childHarness(ctxs.chat, { runId: 2, tier: "fast", tools: [] });
  check("a helper of a live chat is not conversational", child.conversational, false);

  // The loop reads both facts from the context, so the broker's RunContext cannot disagree with the envelope.
  let seen;
  const { registry } = await import("../src/tools/index.ts");
  registry.run_probe = { argsSchema: "{}", checkPolicy: (_p, _a, run) => { seen = run; return { allowed: true, reason: "test" }; }, classify: () => ({ reversibility: "reversible", summary: "probe", target: "probe" }), description: "test only", name: "run_probe", run: async () => "ok" };
  script.push(JSON.stringify({ action: "tool", args: {}, tool: "run_probe" }));
  const runId = store.startRun({});
  store.beginRun(runId);
  const harness = h.buildHarnessContext({ kind: "schedule", runId, tier: "standard", tools: [] });
  await runAgent("probe", loadPolicy(), runId, { budgetRunId: runId, conversational: true, harness, tier: "standard" });
  check("RunContext is filled from the harness, not from a second copy", [seen?.conversational, seen?.preApproved], [false, true]);
  delete registry.run_probe;
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

console.log("\nS3. THE CAPABILITY SUMMARY, FROM THE EFFECTIVE POLICY");
{
  const { narrowPolicy } = await import("../src/projects/narrow-policy.ts");
  const all = ["web_search", "web_read", "browser", "write_file", "read_file", "gmail_search", "draft", "schedule_create", "subagent", "meeting_list"];
  const open = {
    autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true },
    apps: { allow: [] },
    browser: { enabled: true, navigateAllowlist: ["a.example", "b.example"] },
    drafts: { enabled: true },
    fs: { readableDirs: ["/r"], writableDirs: ["/w"] },
    google: { enabled: true },
    schedules: { enabled: true },
    subagents: { enabled: true },
    version: 1,
    web: { fetchAllowlist: [], searchEnabled: true },
  };
  const on = h.summarizeCapabilities(all, open, { cloudPrivateBlocked: false });
  check("an enabled policy lists what each family can do", ["search the web", "read Gmail and Calendar (read only)", "save files inside the allowed folders", "propose schedule changes, which wait for the user's approval"].every((x) => on.can.includes(x)), true);
  check("it counts the allowed domains", on.can.some((x) => x.includes("2 allowed domains")), true);
  check("meetings are listed as local only", on.can.some((x) => x.includes("recorded meetings (kept on the local model)")), true);
  check("send and permanent delete are always listed as absent", [on.cannot.some((x) => x.startsWith("send email")), on.cannot.includes("permanently delete mail")], [true, true]);

  const off = h.summarizeCapabilities(all, { ...open, browser: { enabled: false, navigateAllowlist: [] }, drafts: { enabled: false }, google: { enabled: false }, subagents: { enabled: false }, web: { fetchAllowlist: [], searchEnabled: false } }, { cloudPrivateBlocked: false });
  check("a switched-off family moves to cannot", ["search the web (switched off)", "read Gmail or Calendar (switched off)", "draft text (switched off)"].every((x) => off.cannot.includes(x)), true);
  check("and is not also claimed as can", off.can.includes("search the web"), false);

  const narrowed = narrowPolicy(open, { browser: { navigateAllowlist: ["elsewhere.example"] } });
  const proj = h.summarizeCapabilities(all, narrowed, { cloudPrivateBlocked: true });
  check("a project that shares no domain says the browser is unavailable there", proj.cannot.some((x) => x.includes("this project allows no domain")), true);
  check("a narrowing only ever removes a capability from can", proj.can.every((x) => on.can.includes(x)), true);
  check("a private run says the cloud is out", proj.cannot.some((x) => x.includes("cloud")), true);

  const helper = h.summarizeCapabilities(["web_search"], open, { cloudPrivateBlocked: false });
  check("a helper is told only about the tools it can see", helper.can, ["search the web"]);
  const dry = h.summarizeCapabilities(["web_search"], { ...open, autoExecute: { ...open.autoExecute, dryRun: true } }, { cloudPrivateBlocked: false });
  check("a dry run says nothing will change", dry.cannot.some((x) => x.includes("dry run")), true);

  // The summary is advice: the broker still refuses what the policy refuses.
  const { executeCall } = await import("../src/broker.ts");
  const denied = await executeCall({ args: { query: "x" }, tool: "web_search" }, { ...loadPolicy(), web: { fetchAllowlist: [], searchEnabled: false } }, null);
  check("a call the policy denies stays denied whatever any summary says", denied.status, "denied");

  const sent = h.renderEnvelope({ ...h.buildHarnessContext({ kind: "chat", runId: 1, tier: "standard", tools: all }), capabilities: proj }, true);
  check("the envelope carries both lists", sent.includes("- Can:") && sent.includes("- Cannot:"), true);
}

console.log("\nS4. harness_status");
{
  const { registry } = await import("../src/tools/index.ts");
  const { pinRun } = await import("../src/sensitivity.ts");
  const tool = registry.harness_status;
  check("it is registered, reversible and always permitted", [Boolean(tool), tool.classify({}).reversibility, tool.checkPolicy({}).allowed], [true, "reversible", true]);

  const parent = { ...h.buildHarnessContext({ conversationId: 7, kind: "chat", project: { id: 3, name: "Reorg" }, runId: 700, tier: "deep", tools: ["web_search", "secret_tool", "harness_status"], writeDir: "/docs" }), capabilities: { can: ["search the web"], cannot: ["send email (mail is drafted, never sent)"] } };
  h.registerHarness(parent);
  const out = JSON.parse(await tool.run({}, { policy: {}, runId: 700 }));
  check("it answers from structured state", [out.mode, out.project, out.saveFolder, out.privacy], ["chat", "Reorg", "/docs", "normal"]);
  check("including whether it can send email", out.cannot[0].startsWith("send email"), true);
  check("and where the result is kept", out.resultKeptIn.includes("the conversation history"), true);
  check("a number of approvals waiting is reported", typeof out.approvalsWaiting, "number");

  pinRun(700);
  check("it notices when the run has since become private", JSON.parse(await tool.run({}, { policy: {}, runId: 700 })).privacy, "private (local model only)");

  const child = h.childHarness(parent, { runId: 701, tier: "fast", tools: ["web_search"] });
  h.registerHarness(child);
  const cout = JSON.parse(await tool.run({}, { policy: {}, runId: 701 }));
  check("a restricted helper sees only its own tools", cout.visibleTools, ["web_search"]);
  check("and cannot discover a hidden tool through it", JSON.stringify(cout).includes("secret_tool"), false);
  check("it reports itself as a helper, and still private through its root", [cout.mode, cout.privacy], ["subagent", "private (local model only)"]);

  const text = JSON.stringify(out);
  check("no secret, raw policy or prompt appears", /token|apikey|password|fetchAllowlist|readableDirs|How AgentSpine works/i.test(text), false);
  check("with no recorded context it says so rather than guessing", (await tool.run({}, { policy: {}, runId: 999999 })).startsWith("No run context"), true);
  const { releaseRun } = await import("../src/sensitivity.ts");
  releaseRun(700);
  h.releaseHarness(700);
  h.releaseHarness(701);
}

console.log("\nS2. THE LIFECYCLE HAS ONE OWNER IN EVERY PROMPT");
{
  const systemFor = async (tools, conversational) => {
    bodies.length = 0;
    const runId = store.startRun({});
    store.beginRun(runId);
    await runAgent("say done", loadPolicy(), runId, { budgetRunId: runId, conversational, tier: "standard", tools });
    // From the contract on: the tool descriptions above it may use these words about their own tool.
    const sys = JSON.parse(bodies[0]).messages.find((m) => m.role === "system").content;
    return sys.slice(sys.indexOf("The application you run") >= 0 ? sys.indexOf("The application you run") : sys.indexOf("You are not a chat window") >= 0 ? sys.indexOf("You are not a chat window") : sys.indexOf("How AgentSpine works"));
  };
  const count = (s, re) => (s.match(re) ?? []).length;
  const full = ["state_get", "schedule_create", "draft", "notify"];
  for (const conversational of [true, false]) {
    const p = await systemFor(full, conversational);
    const label = conversational ? "chat" : "unattended";
    check(`${label}: what QUEUED means is stated once`, count(p, /QUEUED means/g), 1);
    check(`${label}: the verbatim hand-off to a later run is stated once`, count(p, /verbatim/g), 1);
    check(`${label}: it says where the run ends`, conversational ? /ends on the user's screen/.test(p) : /ends in the run ledger/.test(p), true);
    check(`${label}: it never claims the other mode's ending`, conversational ? /ends in the run ledger/.test(p) : /ends on the user's screen/.test(p), false);
  }
  const bare = await systemFor(["state_get"], true);
  check("without schedule_create no claim about scheduling survives, in the contract or the advice", /schedul|standing instructions|verbatim|every morning/i.test(bare), false);
  const noDraft = await systemFor(["state_get"], false);
  check("without draft or notify an unattended run is not lectured about either", [/never as a draft/.test(noDraft), /Information you gathered reaches/.test(noDraft)], [false, false]);
}

console.log("\nS3. THE SUMMARY ASKS THE TOOLS, AND THE TWO READINGS AGREE");
{
  const { registry } = await import("../src/tools/index.ts");
  const names = ["web_search", "web_read", "browser", "write_file", "read_file", "list_dir", "gmail_search", "calendar_upcoming", "draft", "schedule_create", "subagent", "run_command", "git_write"];
  check("every family tool defines available()", names.filter((n) => typeof registry[n]?.available !== "function"), []);
  const base = { apps: { allow: [] }, autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true }, web: { searchEnabled: false } };
  const variants = [
    base,
    { ...base, web: { searchEnabled: true }, browser: { enabled: true }, drafts: { enabled: true }, fs: { readableDirs: ["/r"], writableDirs: ["/w"] }, google: { enabled: true }, schedules: { enabled: true }, subagents: { enabled: true }, build: { enabled: true } },
    { ...base, browser: { denyAll: true, enabled: true, navigateAllowlist: [] } },
    { ...base, schedules: { enabled: false } },
  ];
  const lines = (s) => JSON.stringify(s);
  for (const [i, pol] of variants.entries()) {
    const viaTools = h.summarizeCapabilities(names, pol, { availability: (n) => registry[n]?.available?.(pol).allowed, cloudPrivateBlocked: false });
    const viaFields = h.summarizeCapabilities(names, pol, { cloudPrivateBlocked: false });
    check(`variant ${i}: asking the tools gives the same summary as reading the policy fields`, lines(viaTools), lines(viaFields));
  }
  // The drift this closes: an absent schedules.enabled used to read as ON in the summary while the tool's own gate refused.
  const s = h.summarizeCapabilities(["schedule_create"], base, { availability: (n) => registry[n]?.available?.(base).allowed, cloudPrivateBlocked: false });
  check("no schedules section: the summary says schedules are off, as the tool's gate does", [s.cannot.some((l) => /change schedules \(switched off\)/.test(l)), registry.schedule_create.checkPolicy(base, { name: "a", task: "b", every: "1h" }).allowed], [true, false]);
  // available() is the first half of checkPolicy: when it says no, checkPolicy says no for any arguments.
  const denied = names.filter((n) => !registry[n].available(base).allowed && registry[n].checkPolicy(base, { path: "/r/x", name: "x", repo: "/r", verb: "status", agent: "x", url: "https://a.example", action: "navigate", query: "q" }).allowed);
  check("a tool that is unavailable never passes checkPolicy", denied, []);
}

console.log("\nS5. WHAT A TOOL RESULT MEANS");
{
  const d = h.describeResult;
  check("executed read: observed", [d("web_search", "executed", "x").effect, d("web_search", "executed", "x").nextStep], ["observed", "use what it returned"]);
  check("executed write: applied", d("write_file", "executed", "saved").effect, "applied");
  const q = d("schedule_create", "queued", "QUEUED", 42);
  check("queued: no effect, carries the confirmation id, says approval is pending", [q.effect, q.confirmationId, /approval is pending/.test(q.nextStep), q.retryable], ["none", 42, true, false]);
  const ex = d("schedule_create", "executing", "", 7);
  check("executing reads as queued: no effect, not retryable, not done", [ex.effect, ex.retryable, ex.confirmationId, /do not say it happened/.test(ex.nextStep)], ["none", false, 7, true]);
  check("dry-run: no effect, not done", [d("x", "dry-run", "").effect, /do not claim it is done/.test(d("x", "dry-run", "").nextStep)], ["none", true]);
  check("denied: no effect, do not repeat", [d("x", "denied", "").effect, d("x", "denied", "").retryable, /do not repeat/.test(d("x", "denied", "").nextStep)], ["none", false, true]);
  check("an error is unknown, and a timeout may be retried", [d("x", "error", "bad").effect, d("x", "error", "bad").retryable, d("x", "error", "request timed out").retryable], ["unknown", false, true]);
  check("only a successful run is ever `applied`", ["queued", "dry-run", "denied", "error"].some((st) => d("write_file", st, "").effect === "applied"), false);

  const { registry } = await import("../src/tools/index.ts");
  const missing = [...h.READ_ONLY_TOOLS].filter((n) => !registry[n]);
  check("every name in the read-only set is a real tool", missing, []);

  // End to end: the model is sent the envelope beside the prose.
  registry.env_probe = { argsSchema: "{}", checkPolicy: () => ({ allowed: true, reason: "test" }), classify: () => ({ reversibility: "irreversible", summary: "probe the thing", target: "probe" }), description: "test only", name: "env_probe", run: async () => "probed" };
  const policy = loadPolicy();
  const go = async (call) => {
    bodies.length = 0;
    script.push(JSON.stringify({ action: "tool", args: call.args ?? {}, tool: call.tool }));
    const runId = store.startRun({});
    store.beginRun(runId);
    await runAgent("do it", policy, runId, { budgetRunId: runId, conversational: true, tier: "standard" });
    return JSON.parse(bodies[1]).messages.map((m) => m.content).join("\n");
  };
  const readSent = await go({ args: { key: "watch:x" }, tool: "state_get" });
  check("a read arrives marked observed", /\[result \{[^}]*"effect":"observed"/.test(readSent), true);
  const queuedSent = await go({ tool: "env_probe" });
  check("a queued action arrives with effect none and its confirmation id", /"status":"queued"[^}]*"effect":"none"/.test(queuedSent) || /"effect":"none"[^}]*"confirmationId":\d+/.test(queuedSent), true);
  check("and the prose still says it has not run", queuedSent.includes("It has NOT run"), true);
  const deniedSent = await go({ tool: "no_such_tool_at_all" });
  check("a call to an unavailable tool is not retryable", deniedSent.includes("is not available to you"), true);
}

model.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
