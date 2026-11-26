/**
 * AgentSpine changing its own code: the code map (SC3) and propose-then-patch (SC5).
 * Run with `node test/self-change.test.mjs`. It binds a local port for a stand-in model.
 *
 * Like test/protected-paths.test.mjs, it copies `src/` into a scratch folder and imports the
 * copy, so "this checkout" is the scratch folder and nothing here can branch, write or build in
 * the real repository. The model is scripted: these assert what code does around it.
 *
 * What it proves:
 *   - only a run working in this checkout is given the code map, as trusted context, and every
 *     other run's prompt has nothing of it;
 *   - a proposal is refused unless it is whole, in scope and from a live chat;
 *   - the card shows the builder's task word for word;
 *   - nothing starts the builder but an approval, under every skip the broker has;
 *   - an approval starts the `builder` unit with its own ceiling, and a no is remembered.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const REPO = path.join(import.meta.dirname, "..");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-self-")));
fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, "test"));
fs.copyFileSync(path.join(REPO, "test", "architecture.test.mjs"), path.join(root, "test", "architecture.test.mjs"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"));
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "scratch", type: "module" }));
fs.mkdirSync(path.join(root, "notes"));
fs.mkdirSync(path.join(root, "agents"));

const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-self-other-")));
process.env.SPINE_DB_PATH = path.join(elsewhere, "t.db");
process.env.AGENTSPINE_BACKUP_DIR = path.join(elsewhere, "backups");
process.env.EMBEDDINGS_URL = "";
process.env.NOTIFY_ON_CONFIRMATION = "false";
// A finished build notifies. Left for the Mac app, so a test run puts no banner on this machine.
process.env.MAC_BANNER = "app";
process.env.NTFY_TOPIC = "";
process.env.POLICY_PATH = path.join(elsewhere, "policy.json");
process.env.AGENTS_DIR = path.join(root, "agents");

const BUILDER_MARK = "You change code and then prove the change works.";
const builderFile = path.join(root, "agents", "builder.md");
const writeBuilder = () =>
  fs.writeFileSync(
    builderFile,
    `---\nname: builder\ndescription: makes a change and proves it\ntier: standard\nmaxSteps: 7\ntools: commands_list, git_write, read_file, edit_file\n---\n${BUILDER_MARK}\n`,
  );
writeBuilder();

const basePolicy = {
  apps: { allow: [] },
  autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true },
  browser: { enabled: false, navigateAllowlist: [] },
  build: { enabled: true, repos: { [root]: { commands: {}, defaultBranch: "main", gitWrite: true } } },
  fs: { readableDirs: [root], writableDirs: [root] },
  google: { enabled: false },
  version: 1,
  web: { fetchAllowlist: [], searchEnabled: false },
};
const savePolicy = (p) => fs.writeFileSync(process.env.POLICY_PATH, JSON.stringify(p));
savePolicy(basePolicy);

// The stand-in model. Every request is kept, so a test can read what a run was actually told.
const requests = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      requests.push(JSON.parse(body));
    } catch {
      requests.push({ messages: [] });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"action":"final","reply":"done","summary":"done"}', role: "assistant" } }],
        usage: { total_tokens: 1 },
      }),
    );
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
process.env.LOCAL_LLM_URL = `http://127.0.0.1:${model.address().port}/v1`;
process.env.LOCAL_MODEL = "test-local";
process.env.FAST_LLM_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_RETRIES = "0";

const src = (rel) => path.join(root, "src", rel);
const store = await import(src("memory/store.ts"));
const { rawDb } = store;
const areaMap = await import(src("area-map.ts"));
const change = await import(src("change-proposals.ts"));
const { proposeChange } = await import(src("tools/propose-change.ts"));
const { registry } = await import(src("tools/index.ts"));
const { executeCall } = await import(src("broker.ts"));
const { approveConfirmation, rejectConfirmation } = await import(src("confirmations.ts"));
const { runTask } = await import(src("runner.ts"));
const projects = await import(src("projects/store.ts"));
const retro = await import(src("learn/retro.ts"));

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

/** Everything the model was sent as system text since `from`, joined. */
const systemSince = (from) =>
  requests
    .slice(from)
    .flatMap((r) => r.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n\n");
const MAP_MARK = "AgentSpine: where things are";
const MAP_INTRO = "This map of it is supplied by the application";

// ---- SC3. The code map ----------------------------------------------------------------------

console.log("\nTHE CODE MAP: WHO GETS IT\n");
const mapFile = path.join(root, "src", "area-map.md");
const realMap = fs.readFileSync(mapFile, "utf8");
check("the committed map names the areas and the docs to read first", [realMap.includes(MAP_MARK), /src\/broker\.ts/.test(realMap), /docs\/LEARNING\.md/.test(realMap)], [true, true, true]);
check("it holds no address, mail address or home folder", /\d+\.\d+\.\d+\.\d+|@[a-z0-9-]+\.[a-z]{2,}|\/Users\//i.test(realMap), false);
check("it fits under the cut", realMap.length <= areaMap.AREA_MAP_MAX_CHARS, true);
check("this checkout gets it", areaMap.areaMapFor(root)?.text.includes(MAP_MARK), true);
check("a folder inside this checkout gets it", areaMap.areaMapFor(path.join(root, "src", "tools"))?.source, areaMap.AREA_MAP_SOURCE);
check("another folder does not", areaMap.areaMapFor(elsewhere), null);
check("a folder that only starts with the same name does not", areaMap.areaMapFor(`${root}-copy`), null);
check("no folder does not", [areaMap.areaMapFor(null), areaMap.areaMapFor(undefined), areaMap.areaMapFor("")], [null, null, null]);
fs.symlinkSync(path.join(root, "notes"), path.join(elsewhere, "into-repo"));
check("a link into this checkout counts as inside it", areaMap.areaMapFor(path.join(elsewhere, "into-repo")) !== null, true);
check("the block says the application supplied it and that what is read stays untrusted", [areaMap.areaMapFor(root).text.includes(MAP_INTRO), /still untrusted evidence/.test(areaMap.areaMapFor(root).text)], [true, true]);

fs.writeFileSync(mapFile, `${"x".repeat(areaMap.AREA_MAP_MAX_CHARS)}TAIL-THAT-MUST-NOT-APPEAR`);
const cut = areaMap.areaMapFor(root).text;
check("an overlong map is cut and says so", [cut.includes("TAIL-THAT-MUST-NOT-APPEAR"), /was cut here/.test(cut)], [false, true]);
fs.writeFileSync(mapFile, "  \n");
check("an empty map is no map", areaMap.areaMapFor(root), null);
fs.rmSync(mapFile);
check("a missing map is no map, and no error", areaMap.areaMapFor(root), null);
fs.writeFileSync(mapFile, realMap);

console.log("\nTHE CODE MAP: IN A REAL RUN\n");
let mark = requests.length;
await runTask("what is the capital of France", { kind: "do", noMemory: true, policy: basePolicy, tier: "standard" });
const ordinary = systemSince(mark);
check("an ordinary run is told nothing of it", [requests.length > mark, ordinary.includes(MAP_MARK), ordinary.includes(MAP_INTRO)], [true, false, false]);
// A tool the stable prompt names nowhere but in its own entry, so its absence means the ceiling held.
const OUTSIDE_TOOL = /\bcalendar_find\b/;
check("and an ordinary run sees the whole registry", OUTSIDE_TOOL.test(ordinary), true);

const projectId = projects.createProject("Scratch notes");
projects.addSource(projectId, path.join(root, "notes"));
mark = requests.length;
const inProject = await runTask("where is the broker", { kind: "do", noMemory: true, policy: basePolicy, projectId, tier: "standard" });
check("a run in a project whose folder is in this checkout is given it", systemSince(mark).includes(MAP_MARK), true);
check("as trusted context, named in the envelope", systemSince(mark).includes(areaMap.AREA_MAP_SOURCE), true);
check("and the run records that it was used", String(store.getRun(inProject.runId)?.context_used ?? "").includes("code map"), true);

const otherProject = projects.createProject("Somewhere else");
projects.addSource(otherProject, elsewhere);
mark = requests.length;
await runTask("where is the broker", { kind: "do", noMemory: true, policy: basePolicy, projectId: otherProject, tier: "standard" });
check("a project whose folder is elsewhere is not", systemSince(mark).includes(MAP_MARK), false);

mark = requests.length;
await runTask("make the change", { kind: "do", noMemory: true, policy: basePolicy, tier: "standard", unit: "builder", workDir: root });
const asUnit = systemSince(mark);
check("a run started as the builder gets the unit's instructions and the map", [asUnit.includes(BUILDER_MARK), asUnit.includes(MAP_MARK)], [true, true]);
check("and only the unit's tools", [/\bedit_file\b/.test(asUnit), OUTSIDE_TOOL.test(asUnit), /\bpropose_change\b/.test(asUnit)], [true, false, false]);
let unknownUnit = "";
try {
  await runTask("x", { kind: "do", noMemory: true, policy: basePolicy, tier: "standard", unit: "nobody" });
} catch (err) {
  unknownUnit = String(err.message);
}
check("an unknown unit fails the run before any model call", /no "nobody" unit/.test(unknownUnit), true);

// ---- SC5. What a proposal must be -----------------------------------------------------------

console.log("\nA PROPOSAL: WHAT IS REFUSED\n");
const good = {
  files: ["src/plan.ts", "test/plan.test.mjs"],
  run_ids: [41, 42, 42],
  test_plan: "Add a case to test/plan.test.mjs for a remote tool's label and run the declared test command.",
  what: "Give remote MCP tools a readable label in the plan card",
  why: "The plan card shows 'Using acme_lookup' for a remote tool, which reads as raw output.",
};
const problem = (over, p = basePolicy) => change.changeProblem(change.fieldsOf({ ...good, ...over }), p);
check("a whole proposal is accepted", problem({}), null);
check("run ids are whole numbers, once each", change.fieldsOf(good).runIds, [41, 42]);
check("a title too short to mean anything", /"what" must be/.test(problem({ what: "fix it" }) ?? ""), true);
check("a title longer than the card's first line", /"what" must be/.test(problem({ what: "x".repeat(change.CHANGE_LIMITS.whatMax + 1) }) ?? ""), true);
check("the longest title allowed", problem({ what: "x".repeat(change.CHANGE_LIMITS.whatMax) }), null);
check("no reason", /"why" must be/.test(problem({ why: "" }) ?? ""), true);
check("no test plan", /"test_plan" must be/.test(problem({ test_plan: "run it" }) ?? ""), true);
check("no files, from the model", /"files" must name/.test(problem({ files: [] }) ?? ""), true);
check("too many files", /"files" must name/.test(problem({ files: Array.from({ length: change.CHANGE_LIMITS.filesMax + 1 }, (_, i) => `src/f${i}.ts`) }) ?? ""), true);
check("a file in web/ is out of scope, and it says why", /out of scope.*all three/.test(problem({ files: ["web/src/main.tsx"] }) ?? ""), true);
check("a file in ios/ is out of scope", /out of scope/.test(problem({ files: ["src/plan.ts", "ios/AgentSpine/Core/Models.swift"] }) ?? ""), true);
check("policy.json cannot be proposed", /control files/.test(problem({ files: ["policy.json"] }) ?? ""), true);
check("a unit's own file cannot be proposed", /control files/.test(problem({ files: ["agents/builder.md"] }) ?? ""), true);
check("the code map cannot be proposed", /control files/.test(problem({ files: ["src/area-map.md"] }) ?? ""), true);
check("a full path is refused", /relative to the repository root/.test(problem({ files: [path.join(root, "src/plan.ts")] }) ?? ""), true);
check("a path that climbs out is refused", /not a file a change may name/.test(problem({ files: ["../elsewhere/x.ts"] }) ?? ""), true);
check("a hidden file is refused", /not a file a change may name/.test(problem({ files: [".env"] }) ?? ""), true);
check("building switched off", /policy\.build\.enabled is not set/.test(problem({}, { ...basePolicy, build: { ...basePolicy.build, enabled: false } }) ?? ""), true);
check("this checkout not declared", /not declared in policy\.build\.repos/.test(problem({}, { ...basePolicy, build: { enabled: true, repos: { [elsewhere]: { gitWrite: true } } } }) ?? ""), true);
check("declared without gitWrite", /"gitWrite": true/.test(problem({}, { ...basePolicy, build: { enabled: true, repos: { [root]: {} } } }) ?? ""), true);
fs.rmSync(builderFile);
check("no builder unit to hand it to", /no "builder" unit/.test(problem({}) ?? ""), true);
check("and the tool says it is unavailable", proposeChange.available(basePolicy).allowed, false);
writeBuilder();
check("with the unit back, the tool is available", proposeChange.available(basePolicy).allowed, true);

console.log("\nA PROPOSAL: THE CARD\n");
const fields = change.fieldsOf(good);
const task = change.builderTask(fields, root);
check("the task names what, why, the files, the check and the runs", [good.what, good.why, "- src/plan.ts", good.test_plan, "#41, #42"].map((s) => task.includes(s)), [true, true, true, true, true]);
check("the branch is under the agent's prefix, from the title", change.branchOf(fields), "agentspine/give-remote-mcp-tools-a-readable-label-i");
check("the slug is cut at its limit", change.slugOf(good.what).length, change.CHANGE_LIMITS.slugChars);
check("the task says the branch, and that merging is not its job", [task.includes(change.branchOf(fields)), /Do not switch back, merge or push/.test(task)], [true, true]);
check("a title with no letters still makes a branch", change.branchOf(change.fieldsOf({ ...good, what: "!!! ??? ///" })), "agentspine/change");
const card = proposeChange.classify(good);
check("the card shows the builder's task word for word", card.summary.includes(task), true);
check("it says nothing has changed and what stays yours", [/Nothing has been changed/.test(card.summary), /Merging, pushing, update\.sh and the restart stay yours/.test(card.summary)], [true, true]);
check("it is irreversible and asks every time", [card.reversibility, card.alwaysConfirm], ["irreversible", true]);
check("an ordinary proposal has no protected-file warning", /PROTECTED FILES/.test(card.summary), false);
const gated = proposeChange.classify({ ...good, files: ["src/Broker.ts", "src/plan.ts"] });
check("one that names a gate says so, and that each edit asks again", [/THIS NAMES PROTECTED FILES: src\/broker\.ts/.test(gated.summary), /each one will ask you again with its diff/.test(gated.summary)], [true, true]);
check("and the builder is told those edits come back queued", /src\/broker\.ts is a protected gate file/.test(change.builderTask(change.fieldsOf({ ...good, files: ["src/broker.ts"] }), root)), true);

// ---- SC5. Who may propose, and what starts the builder --------------------------------------

console.log("\nWHO MAY PROPOSE\n");
const chat = { conversational: true, goal: "please fix the plan card labels" };
const scheduled = { approvedTask: "improve yourself", conversational: false, goal: "improve yourself", preApproved: true };
const helper = { conversational: false, goal: "a brief the model wrote" };
check("a live chat may", proposeChange.checkPolicy(basePolicy, good, chat).allowed, true);
check("a scheduled run may not", [proposeChange.checkPolicy(basePolicy, good, scheduled).allowed, /only from a live chat/.test(proposeChange.checkPolicy(basePolicy, good, scheduled).reason)], [false, true]);
check("a helper or any unwatched run may not", proposeChange.checkPolicy(basePolicy, good, helper).allowed, false);
check("the tool is registered under its name", registry.propose_change === proposeChange, true);

const call = (args, p = basePolicy, run = chat) => executeCall({ args, tool: "propose_change" }, p, null, null, run);
const runCount = () => rawDb.prepare("SELECT COUNT(*) AS n FROM runs").get().n;
const pending = () => store.listConfirmations("pending").filter((r) => r.tool === "propose_change");
const clearQueue = async () => {
  for (const r of store.listConfirmations("pending")) rawDb.prepare("UPDATE confirmations SET state = 'expired' WHERE id = ?").run(r.id);
};

console.log("\nNOTHING STARTS THE BUILDER BUT AN APPROVAL\n");
let runsBefore = runCount();
const unattended = await call(good, basePolicy, scheduled);
check("the broker denies a scheduled run's proposal", [unattended.status, pending().length, runCount() - runsBefore], ["denied", 0, 0]);
check("called with no approval, the tool starts nothing", [/NOT STARTED/.test(await proposeChange.run(good, { policy: basePolicy, runId: null })), runCount() - runsBefore], [true, 0]);

const skips = {
  "no skip at all": basePolicy,
  "policy.autoApprove names it": { ...basePolicy, autoApprove: [{ target: "agentspine:self-change", tool: "propose_change" }] },
  "policy.trust.chatAutoTools trusts it": { ...basePolicy, trust: { chatAutoTools: ["propose_change"] } },
  "policy.userDirected lists it": { ...basePolicy, userDirected: { actions: ["propose_change.propose"], enabled: true } },
  "irreversibleAlwaysConfirm is switched off": { ...basePolicy, autoExecute: { ...basePolicy.autoExecute, irreversibleAlwaysConfirm: false } },
};
for (const [name, p] of Object.entries(skips)) {
  runsBefore = runCount();
  const r = await call(good, p);
  check(`${name}: queued, one card, no run`, [r.status, pending().length, runCount() - runsBefore], ["queued", 1, 0]);
  await clearQueue();
}

console.log("\nWHAT AN APPROVAL STARTS\n");
const queued = await call(good);
check("a second identical proposal is refused while the first waits", [(await call(good)).status, pending().length], ["denied", 1]);
runsBefore = runCount();
mark = requests.length;
const approved = await approveConfirmation(queued.confirmationId, { resume: false });
check("approving reports the run and the branch", [approved.ok, /Started the builder as run #\d+ on a new branch, agentspine\//.test(approved.message), /Nothing is merged, pushed or restarted/.test(approved.message)], [true, true, true]);
const buildRunId = Number(/run #(\d+)/.exec(approved.message)?.[1]);
for (let i = 0; i < 200 && !store.getRun(buildRunId)?.finished; i++) await new Promise((r) => setTimeout(r, 25));
const buildRun = store.getRun(buildRunId);
check("exactly one run started, and it finished", [runCount() - runsBefore, buildRun?.status], [1, "ok"]);
check("it was handed the task on the card, word for word", buildRun?.task, task);
const built = systemSince(mark);
check("it ran as the builder, with the code map", [built.includes(BUILDER_MARK), built.includes(MAP_MARK)], [true, true]);
check("with the builder's tools only", [/\bgit_write\b/.test(built), OUTSIDE_TOOL.test(built)], [true, false]);
check("it carries no standing approval, so its own irreversible calls still ask", /Standing approval: this run was set up in advance/.test(built), false);
const logged = () => rawDb.prepare("SELECT outcome FROM proposal_log WHERE kind = 'code_change' ORDER BY rowid").all().map((r) => r.outcome);
check("the yes is in the proposal log", logged(), ["accepted"]);

console.log("\nA NO IS REMEMBERED\n");
const second = { ...good, what: "Stop the plan card repeating a finished step" };
const q2 = await call(second);
await rejectConfirmation(q2.confirmationId, "", { resume: false });
check("the no is in the proposal log", logged(), ["accepted", "rejected"]);
const again = await call(second);
check("the same proposal is not made again", [again.status, /not proposed again: you rejected this proposal before/.test(again.output)], ["denied", true]);
check("nor with other capitals and punctuation", (await call({ ...second, what: "stop the plan card: repeating a FINISHED step!" })).status, "denied");
check("a different change still may be", (await call({ ...second, what: "Show the plan card on scheduled runs too" })).status, "queued");
await clearQueue();

console.log("\nFROM THE WEEKLY RETROSPECTIVE\n");
const fromRetro = change.queueChangeProposal({ run_ids: [7, 8], test_plan: change.DEFAULT_TEST_PLAN, what: "Runs keep hitting the step limit", why: "Two runs this week hit a step or token limit." }, basePolicy);
check("code may queue one with no files named", typeof fromRetro.id, "number");
const retroCard = store.getConfirmation(fromRetro.id);
check("the card says the files are to be found first", [retroCard.tool, /Files expected to change: not known yet/.test(retroCard.summary)], ["propose_change", true]);
check("the model may not leave files out", (await call({ ...good, files: [], what: "A change with no files named at all" })).status, "denied");
check("queueing it started nothing", store.getConfirmation(fromRetro.id).state, "pending");
const dup = change.queueChangeProposal({ run_ids: [7], test_plan: change.DEFAULT_TEST_PLAN, what: "Runs keep hitting the step limit", why: "Two runs this week hit a step or token limit." }, basePolicy);
check("the same one is not queued twice", /already waiting/.test(dup.problem ?? ""), true);
savePolicy({ ...basePolicy, build: { enabled: false } });
rawDb
  .prepare("INSERT INTO retro_proposals (week, kind, title, why, run_ids, shape_hash, state, created) VALUES (?,?,?,?,?,?,'open',?)")
  .run("2026-W47", "code_change", "Subagents run out of steps", "Three runs this week stopped at the step limit.", "[11,12,13]", "h1", new Date().toISOString());
const offCard = rawDb.prepare("SELECT id FROM retro_proposals WHERE shape_hash = 'h1'").get().id;
const off = retro.answerRetro(offCard, "accept");
check("with building off, accepting a card queues nothing and says why", [off.queued, /No work has started, because policy\.build\.enabled is not set/.test(off.message)], [null, true]);
savePolicy(basePolicy);
const approvedRetro = await approveConfirmation(fromRetro.id, { resume: false });
check("a retrospective's proposal can be approved though it names no files", approvedRetro.ok, true);
const retroRun = Number(/run #(\d+)/.exec(approvedRetro.message)?.[1]);
for (let i = 0; i < 200 && !store.getRun(retroRun)?.finished; i++) await new Promise((r) => setTimeout(r, 25));

console.log(`\n${passed} passed, ${failed} failed`);
model.close();
fs.rmSync(root, { force: true, recursive: true });
fs.rmSync(elsewhere, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
