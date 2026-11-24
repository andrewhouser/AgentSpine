/**
 * The overview page's prune list (src/overview.ts) and the "get to know me" tools
 * (src/tools/profile.ts). Run with `node test/overview-profile.test.mjs`. No model, no network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-ov-"));
process.env.SPINE_DB_PATH = path.join(root, "t.db");
process.env.EMBEDDINGS_URL = "";
// Pinned to a file that does not exist. Without this the suite reads the real profile.md in the
// repo root, so "with nothing known" was only true on a machine that had never written one.
process.env.PROFILE_PATH = path.join(root, "profile.md");
process.env.POLICY_PATH = path.join(root, "policy.json");
fs.writeFileSync(
  process.env.POLICY_PATH,
  JSON.stringify({ autoExecute: { dryRun: false, irreversibleAlwaysConfirm: true, reversible: true }, schedules: { enabled: true }, version: 1, web: { searchEnabled: true } }),
);

const store = await import("../src/memory/store.ts");
const recipes = await import("../src/recipes/store.ts");
const { flagsFrom, overview, FAILING_RUNS } = await import("../src/overview.ts");
const { __setAsker, profileGaps, profileSave, FIELDS } = await import("../src/tools/profile.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(62)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const yes = (label, v) => check(label, !!v, true);

const now = new Date("2026-11-17T12:00:00Z");
const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000).toISOString();
const empty = {
  connectors: [],
  memory: [],
  policy: { autoApprove: [], chatAutoTools: [], dryRun: false, irreversibleAlwaysConfirm: true, readableDirs: [], schedulesEnabled: true, userDirected: [], webSearch: true, writableDirs: [] },
  projects: [],
  recipes: [],
  schedules: [],
  study: [],
  tools: [],
};
const texts = (o) => flagsFrom({ ...empty, ...o }, now).map((f) => f.text);

console.log("\nthe prune list (pure rules)\n");
check("nothing set up, nothing flagged", texts({}), []);
const failing = { created: daysAgo(40), enabled: true, id: 1, last_run: daysAgo(1), name: "inbox triage", next_run: null, recent: ["failed", "failed", "failed"], spec: "every hour" };
yes("a schedule that failed its last runs is a warning", texts({ schedules: [failing] })[0].includes(`failed its last ${FAILING_RUNS} runs`));
check("one success among them is not", texts({ schedules: [{ ...failing, recent: ["failed", "ok", "failed"] }] }), []);
check("too few runs to judge is not", texts({ schedules: [{ ...failing, recent: ["failed"] }] }), []);
yes("a long-paused schedule is suggested for deletion", texts({ schedules: [{ ...failing, enabled: false, last_run: daysAgo(45), recent: [] }] })[0].includes("paused over"));
check("a recently paused one is left alone", texts({ schedules: [{ ...failing, enabled: false, last_run: daysAgo(3), recent: [] }] }), []);
yes("a tool erroring all week is a warning", texts({ tools: [{ errors7d: 4, name: "gmail_search", uses30d: 9 }] })[0].startsWith("gmail_search errored 4"));
check("an occasional error is not", texts({ tools: [{ errors7d: 1, name: "gmail_search", uses30d: 9 }] }), []);
yes("a recipe never used since saving is flagged", texts({ recipes: [{ created: daysAgo(20), last_used: null, name: "pi-brief", uses: 0 }] })[0].includes("never been used"));
check("a brand-new unused recipe is not", texts({ recipes: [{ created: daysAgo(2), last_used: null, name: "pi-brief", uses: 0 }] }), []);
yes("a recipe idle for months is flagged", texts({ recipes: [{ created: daysAgo(200), last_used: daysAgo(90), name: "pi-brief", uses: 3 }] })[0].includes("over 60 days"));
yes("a source that didn't index is a warning", texts({ projects: [{ badSources: ["/x: error: path not found"], chunks: 0, id: 2, name: "Acme", sources: 1 }] })[0].includes("didn't index"));
yes("a memory kind near its cap is flagged", texts({ memory: [{ cap: 500, count: 470, kind: "reflection" }] })[0].includes("near the cap"));
check("an uncapped kind never is", texts({ memory: [{ cap: null, count: 9000, kind: "note" }] }), []);
yes("cards waiting on an idle topic are flagged", texts({ study: [{ cards: 10, due: 4, lastActivity: daysAgo(20), name: "Okta", projectId: null }] })[0].includes("4 cards"));
check("cards due on an active topic are not", texts({ study: [{ cards: 10, due: 4, lastActivity: daysAgo(1), name: "Okta", projectId: null }] }), []);
yes("dry run left on is a warning", texts({ policy: { ...empty.policy, dryRun: true } })[0].startsWith("Dry run is on"));
const mixed = flagsFrom({ ...empty, memory: [{ cap: 10, count: 10, kind: "lesson" }], tools: [{ errors7d: 5, name: "web_read", uses30d: 5 }] }, now);
check("warnings sort above info", mixed.map((f) => f.severity), ["warn", "info"]);
yes("every flag links somewhere to act on it", mixed.every((f) => f.href.startsWith("/")));

console.log("\nthe overview, gathered from a real database\n");
const sid = store.createSchedule("nightly digest", "summarise the day", "every day");
for (let i = 0; i < 3; i++) {
  const r = store.startRun({ kind: "schedule", scheduleId: sid, task: "summarise" });
  store.logAction(r, { args: {}, tool: "web_read" }, { reversibility: "reversible", summary: "", target: "x" }, "error", "ERROR: timeout");
  store.finishRun(r, "failed", "timeout");
}
recipes.saveRecipe(recipes.fieldsOf({ name: "pi-brief", steps: ["read the notes", "draft it"], when: "PI planning" }));
const o = overview(now);
const s = o.schedules.find((x) => x.name === "nightly digest");
check("a schedule carries its recent run statuses", s.recent, ["failed", "failed", "failed"]);
yes("and is flagged", o.flags.some((f) => f.text.includes('"nightly digest" failed')));
check("tool use is counted from the audit log", o.tools.find((t) => t.name === "web_read").errors7d, 3);
yes("it is flagged too", o.flags.some((f) => f.text.startsWith("web_read errored 3")));
check("every registered tool is listed, used or not", o.tools.some((t) => t.name === "recipe_save" && t.uses30d === 0), true);
check("named recipes are listed", o.recipes.map((r) => r.name), ["pi-brief"]);
check("the policy is summarised, not dumped", [o.policy.webSearch, o.policy.dryRun, o.policy.schedulesEnabled], [true, false, true]);
yes("connections say what's not set up, in words", o.connectors.find((c) => c.name === "Embeddings").detail.includes("keyword"));

console.log("\nget to know me: what's missing\n");
let coveredReply = { covered: [] };
const asked = [];
__setAsker(async (system, user) => {
  asked.push(user);
  return coveredReply;
});
let out = await profileGaps.run({}, {});
yes("with nothing known, asks every question (no model needed)", out.includes(`(${FIELDS.length} of ${FIELDS.length})`));
check("and skips the model when there is nothing to check", asked.length, 0);
const { remember } = await import("../src/memory/rag.ts");
await remember("Andy works from Cleveland, on Eastern time.", "reflection");
coveredReply = { covered: ["where", "made-up-field"] };
out = await profileGaps.run({}, {});
check("a covered field isn't asked again", out.includes("Where are you based"), false);
yes("the rest still are, one at a time", out.includes("ONE AT A TIME") && out.includes("What should I call you?"));
yes("the model was shown the remembered facts", asked.at(-1).includes("Cleveland"));
yes("it points standing facts at profile.md, which it can't write", out.includes("profile.md by hand"));
coveredReply = { covered: FIELDS.map((f) => f.id) };
yes("nothing missing says so", (await profileGaps.run({}, {})).startsWith("Nothing obvious is missing"));
__setAsker(async () => {
  throw new Error("model down");
});
yes("no verdict from the model means asking, not guessing", (await profileGaps.run({}, {})).includes("Not known yet"));

console.log("\nget to know me: saving answers\n");
const facts = { facts: ["Andy works 8am to 4pm Eastern, Monday to Friday.", "Andy prefers short answers with the reasoning available on request."] };
check("saving is irreversible: it goes through approval", profileSave.classify(facts).reversibility, "irreversible");
yes("the card shows every fact verbatim", profileSave.classify(facts).summary.includes("- Andy works 8am to 4pm Eastern"));
check("allowed from a live chat", profileSave.checkPolicy({}, facts, { conversational: true, goal: "" }).allowed, true);
check("refused from a scheduled run", profileSave.checkPolicy({}, facts, { conversational: false, goal: "", preApproved: true }).allowed, false);
check("allowed at approval time (no run)", profileSave.checkPolicy({}, facts).allowed, true);
check("a fragment is refused", profileSave.checkPolicy({}, { facts: ["8 to 4"] }, { conversational: true, goal: "" }).allowed, false);
check("a secret is refused", profileSave.checkPolicy({}, { facts: ["Andy's VPN password: hunter2abc"] }, { conversational: true, goal: "" }).allowed, false);
check("too many at once is refused", profileSave.checkPolicy({}, { facts: Array(9).fill("Andy likes tea in the afternoon.") }, { conversational: true, goal: "" }).allowed, false);
yes("saves as profile memories", (await profileSave.run(facts, {})).startsWith("Saved 2 facts"));
const kinds = store.rawDb.prepare("SELECT kind, COUNT(*) AS n FROM memories WHERE kind = 'profile'").get();
check("stored under kind 'profile'", Number(kinds.n), 2);
yes("saving the same again is deduped", (await profileSave.run(facts, {})).includes("2 already known"));

fs.rmSync(root, { force: true, recursive: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
