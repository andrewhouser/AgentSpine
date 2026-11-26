/**
 * SC5 (PLAN-open-work section 10): a change to AgentSpine's own code starts as a card. The card is always shown,
 * approving it starts the builder unit as a run of its own on a branch, and accepting a code-change card in the
 * weekly review queues one. Uses throwaway checkouts, a throwaway agents folder and a stand-in model.
 *
 * Run with `node test/propose-change.test.mjs`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-sc5-")));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
process.env.NOTIFY_ON_FAILURE = "false";

const checkout = (name, pkg = "agentspine") => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg }));
  return dir;
};
const clone = checkout("agentspine-builder");
const served = checkout("agentspine-served");
const stranger = checkout("other-project", "something-else");

const policyWith = (repos) => ({
  apps: { allow: [] },
  autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true },
  browser: { enabled: false, navigateAllowlist: [] },
  build: { enabled: true, repos },
  fs: { readableDirs: [] },
  google: { enabled: false },
  version: 1,
  web: { fetchAllowlist: [], searchEnabled: false },
});
process.env.POLICY_PATH = path.join(root, "policy.json");
fs.writeFileSync(process.env.POLICY_PATH, JSON.stringify(policyWith({ [clone]: { gitWrite: true }, [served]: { gitWrite: true } })));

// A small builder unit, so the run can be checked for what a unit brings: its instructions and its tool ceiling.
process.env.AGENTS_DIR = path.join(root, "agents");
fs.mkdirSync(process.env.AGENTS_DIR);
fs.writeFileSync(
  path.join(process.env.AGENTS_DIR, "builder.md"),
  "---\nname: builder\ndescription: makes a change\ntier: standard\nmaxSteps: 3\ntools: git_status, read_file\n---\nBUILDER-INSTRUCTIONS: branch first.\n",
);

const prompts = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    prompts.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"action":"final","summary":"branch agentspine/fix-x, checks passed"}', role: "assistant" } }], usage: { completion_tokens: 5, prompt_tokens: 50 } }));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${model.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_RETRIES = "0";

const store = await import("../src/memory/store.ts");
const { executeCall } = await import("../src/broker.ts");
const { approveConfirmation } = await import("../src/confirmations.ts");
const { registry } = await import("../src/tools/index.ts");
const { chooseRepo, readProposal } = await import("../src/tools/propose-change.ts");
const { answerRetro } = await import("../src/learn/retro.ts");
const { startTask } = await import("../src/runner.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(68)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const tool = registry.propose_change;
const good = { files: ["src/broker.ts", "test/x.test.mjs"], runIds: [12, 12, "13", -1], testPlan: "npm run check", title: "Stop the loop re-asking forever", why: "Runs 12 and 13 re-asked eleven times before the cap stopped them." };

console.log("\nREADING A PROPOSAL");
{
  const r = readProposal(good);
  check("a good one is accepted, with runs cleaned", [r.proposal.title, r.proposal.runIds], ["Stop the loop re-asking forever", [12, 13]]);
  check("a missing title is refused, worded to fix", readProposal({ ...good, title: "fix" }).error.startsWith('a proposal needs a "title"'), true);
  check("a missing why is refused", readProposal({ ...good, why: "because" }).error.startsWith('a proposal needs a "why"'), true);
  check("an absolute path is refused", /not a path inside the repository/.test(readProposal({ ...good, files: ["/etc/passwd"] }).error), true);
  check("a climbing path is refused", /not a path inside/.test(readProposal({ ...good, files: ["src/../../x"] }).error), true);
  check("too many files is several proposals", /at most 20 files/.test(readProposal({ ...good, files: Array.from({ length: 21 }, (_, i) => `f${i}.ts`) }).error), true);
  check("no test plan gets the default one", /npm run check passes/.test(readProposal({ ...good, testPlan: "" }).proposal.testPlan), true);
}

console.log("\nWHICH CHECKOUT");
{
  const both = policyWith({ [clone]: { gitWrite: true }, [served]: { gitWrite: true } });
  check("a separate clone is chosen, not the served one", chooseRepo(both, served), { repo: clone });
  // Decided 2026-11-26: a crash or a reboot while the builder was on its branch in the served checkout would
  // restart the service on code nobody has read, so that checkout is never the builder's.
  const onlyServed = policyWith({ [served]: { gitWrite: true } });
  check("the served checkout is never chosen, even when it is the only one", chooseRepo(onlyServed, served), null);
  check("nor under another spelling of its path", chooseRepo(policyWith({ [served.toUpperCase()]: { gitWrite: true } }), served), null);
  // Through the tool, "served" is this repository itself, which is what the suite is running from.
  const { BASE } = await import("../src/config.ts");
  const onlyThis = tool.checkPolicy(policyWith({ [BASE]: { gitWrite: true } }), good);
  check("and the tool is then unavailable, saying what to declare", [onlyThis.allowed, /second AgentSpine clone/.test(onlyThis.reason)], [false, true]);
  check("a repo that is not AgentSpine is never chosen", chooseRepo(policyWith({ [stranger]: { gitWrite: true } }), served), null);
  check("nor one without gitWrite", chooseRepo(policyWith({ [clone]: { gitWrite: false } }), served), null);
}

console.log("\nTHE CARD");
{
  const c = tool.classify(good);
  check("it always shows the card", [c.reversibility, c.alwaysConfirm], ["irreversible", true]);
  for (const part of ["Proposed change to AgentSpine: Stop the loop", "Why: Runs 12", "Files expected to change: src/broker.ts, test/x.test.mjs", "How it will be shown to work: npm run check", "Prompted by: run #12, run #13", "Merging, pushing, update.sh and the restart stay yours."]) {
    check(`it says "${part.slice(0, 40)}"`, c.summary.includes(part), true);
  }
  check("refused without a declared AgentSpine checkout", tool.checkPolicy(policyWith({}), good).allowed, false);
  check("refused when build is off", tool.checkPolicy({ ...policyWith({ [clone]: { gitWrite: true } }), build: { enabled: false, repos: { [clone]: { gitWrite: true } } } }, good).allowed, false);
}

console.log("\nWHO MAY PROPOSE: A LIVE CHAT AND THE WEEKLY REVIEW, NOTHING UNWATCHED");
{
  // The card's words become the builder's task once approved, so they must not come from a run nobody was
  // reading, which may have taken them from a page. Decided 2026-11-26.
  const p = policyWith({ [clone]: { gitWrite: true } });
  const pendingBefore = store.listConfirmations("pending").length;
  const from = async (run, kind) => {
    const runId = store.startRun({ kind, task: "probe" });
    return (await executeCall({ args: good, tool: "propose_change" }, p, runId, runId, run)).status;
  };
  check("a scheduled run is refused", await from({ conversational: false, goal: "nightly", preApproved: true }, "schedule"), "denied");
  check("a helper (subagent) is refused", await from({ conversational: false, goal: "a brief the model wrote" }, "do"), "denied");
  check("and nothing was queued by either", store.listConfirmations("pending").length, pendingBefore);
  check("a live chat queues the card", await from({ conversational: true, goal: "the plan card label is wrong, fix it" }, "chat"), "queued");
  check("the weekly review's own yes passes (no run rides along)", tool.checkPolicy(p, good).allowed, true);
  check("the refusal says where a proposal may come from", /live chat or the weekly review/.test(tool.checkPolicy(p, good, { conversational: false, goal: "" }).reason), true);
}

console.log("\nTHROUGH THE BROKER: TRUST CANNOT SKIP IT");
{
  const p = { ...policyWith({ [clone]: { gitWrite: true } }), autoApprove: [{ target: "agentspine", tool: "propose_change" }], autoExecute: { dryRun: true, irreversibleAlwaysConfirm: false, reversible: true }, trust: { chatAutoTools: ["propose_change"] } };
  const runId = store.startRun({ kind: "schedule", task: "probe" });
  const r = await executeCall({ args: good, tool: "propose_change" }, p, runId, runId, { conversational: true, goal: "x", preApproved: true });
  check("every skip set, and it would still queue", /would have been QUEUED/.test(r.output), true);
}

console.log("\nAPPROVING STARTS THE BUILDER, AS A RUN OF ITS OWN");
{
  const cid = store.queueConfirmation({ args: good, tool: "propose_change" }, tool.classify(good).summary, null);
  const before = new Set(store.rawDb.prepare("SELECT id FROM runs").all().map((r) => r.id));
  const out = await approveConfirmation(cid, { resume: false });
  check("the approval says which run started", /Started the builder as run #\d+ in .*agentspine-builder/.test(out.message), true);
  const runId = Number(/run #(\d+)/.exec(out.message)?.[1]);
  // The builder takes the model in its own turn; wait for it to finish.
  for (let i = 0; i < 100 && !store.getRun(runId)?.finished; i++) await new Promise((r) => setTimeout(r, 50));
  const row = store.getRun(runId);
  check("it is a new run of kind build", [before.has(runId), row?.kind], [false, "build"]);
  check("its task names the clone, the branch rule and no push", [row.task.includes(clone), /Branch to agentspine\//.test(row.task), /Do not push/.test(row.task)], [true, true, true]);
  const sent = prompts.find((p) => p.includes("BUILDER-INSTRUCTIONS")) ?? "";
  check("the unit's own instructions were in its context", sent.length > 0, true);
  // The unit's tools are the ceiling: its prompt offers what the unit file lists and nothing it does not.
  // Each offered tool is a "- name: description" line in the prompt (toolDocs in src/agent.ts).
  const offered = (name) => sent.includes(`\\n- ${name}: `);
  check("it was offered the unit's tools only", [offered("git_status"), offered("read_file"), offered("notify"), offered("propose_change")], [true, true, false, false]);
  check("it finished with the builder's report", [row.status, row.note], ["ok", "branch agentspine/fix-x, checks passed"]);
}

console.log("\nAN UNKNOWN UNIT FAILS THE RUN");
{
  const r = startTask("anything", { kind: "build", unit: "no-such-unit" });
  const result = await r.done.then(() => "finished", (e) => String(e.message));
  check("it does not run without the unit", /no unit called "no-such-unit"/.test(result) || store.getRun(r.runId)?.status === "failed", true);
}

console.log("\nTHE WEEKLY REVIEW FEEDS IT");
{
  const add = (title) =>
    Number(store.rawDb.prepare("INSERT INTO retro_proposals (week, kind, title, why, run_ids, shape_hash, created) VALUES (?,?,?,?,?,?,?)")
      .run("2026-W48", "code_change", title, "Five runs this week hit a step or token limit.", "[21,22]", title, new Date().toISOString()).lastInsertRowid);
  const pendingBefore = store.listConfirmations("pending").length;
  const res = answerRetro(add("Runs keep hitting the step limit"), "accept");
  check("accepting a code-change card queues a change proposal", [/Queued as a change proposal/.test(res.message), res.queued != null], [true, true]);
  const row = store.getConfirmation(res.queued);
  check("on the propose_change tool, with the card's runs", [row.tool, JSON.parse(row.args).runIds], ["propose_change", [21, 22]]);
  check("one new card is waiting", store.listConfirmations("pending").length - pendingBefore, 1);
  fs.writeFileSync(process.env.POLICY_PATH, JSON.stringify(policyWith({})));
  const none = answerRetro(add("Another limit card for the review"), "accept");
  check("without a checkout it says nothing was started", [/Nothing was started/.test(none.message), none.queued], [true, null]);
}

model.close();
fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
