/**
 * Named recipes (src/recipes, src/tools/recipes.ts). Run with `node test/recipes.test.mjs`.
 * No model, no network: the store, the name match, the context block, and the tool gates.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `agentspine-recipes-${process.pid}-${Date.now()}.db`);
process.env.SPINE_DB_PATH = dbPath;
const rs = await import("../src/recipes/store.ts");
const { recipeSave, recipeUse, recipeList } = await import("../src/tools/recipes.ts");
const { registry } = await import("../src/tools/index.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(62)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const piBrief = {
  name: "PI Brief",
  steps: ["1. Read _knowledge/01-architecture.md", "2. List open Okta questions from the last meeting", "3. Draft a one-page brief"],
  when: "preparing for a PI planning session",
};

console.log("\nnormalising\n");
check("names become typed slugs", rs.normaliseName(" PI Brief "), "pi-brief");
check("a leading slash and underscores are dropped", rs.normaliseName("/weekly_okta__check"), "weekly-okta-check");
check("numbered string steps become a clean list", rs.normaliseSteps("1. one\n2) two\n- three\n\n"), ["one", "two", "three"]);

console.log("\nvalidation\n");
check("a good recipe has no problem", rs.recipeProblem(rs.fieldsOf(piBrief)), null);
check("one step is not a procedure", /at least 2/.test(rs.recipeProblem(rs.fieldsOf({ ...piBrief, steps: ["only"] }))), true);
check("a missing when line is refused", /when/.test(rs.recipeProblem(rs.fieldsOf({ ...piBrief, when: "" }))), true);
check("too many steps is refused", /at most/.test(rs.recipeProblem(rs.fieldsOf({ ...piBrief, steps: Array(13).fill("x y") }))), true);
check(
  "mentioning a token is fine",
  rs.recipeProblem(rs.fieldsOf({ ...piBrief, steps: ["refresh the Okta token", "call the API"] })),
  null,
);
check(
  "a password value is refused",
  /secret/.test(rs.recipeProblem(rs.fieldsOf({ ...piBrief, steps: ["log in", "password: hunter22x"] }))),
  true,
);
check(
  "a long opaque string is refused",
  /secret/.test(rs.recipeProblem(rs.fieldsOf({ ...piBrief, steps: ["use key", "opaque0123456789abcdefghijklmnopqrstuv"] }))),
  true,
);

console.log("\nstore\n");
const saved = rs.saveRecipe(rs.fieldsOf(piBrief), 7);
check("saves under the slug", saved.name, "pi-brief");
check("keeps the steps without numbering", saved.steps[0], "Read _knowledge/01-architecture.md");
check("remembers the conversation", saved.conversation_id, 7);
rs.markUsed(saved.id);
const replaced = rs.saveRecipe(rs.fieldsOf({ ...piBrief, steps: ["a step", "another step"] }));
check("saving the same name replaces it, not duplicates", rs.listRecipes().length, 1);
check("a replace keeps the use count", replaced.uses, 1);
check("a replace keeps the original conversation", replaced.conversation_id, 7);
check("saving an invalid recipe throws", throws(() => rs.saveRecipe(rs.fieldsOf({ ...piBrief, name: "x" }))), true);
const other = rs.saveRecipe(rs.fieldsOf({ name: "okta-check", steps: ["open the admin console", "list the apps"], when: "auditing Okta apps" }));
check("updates a field in place", rs.updateRecipe(other.id, { when: "auditing Okta" }).when_text, "auditing Okta");
check("a rename onto an existing name is refused", throws(() => rs.updateRecipe(other.id, { name: "pi-brief" })), true);
check("an update is validated as a whole", throws(() => rs.updateRecipe(other.id, { steps: ["one"] })), true);
check("an unknown id is reported", throws(() => rs.updateRecipe(999, { when: "x" })), true);

console.log("\nasking by name (code decides, not the model)\n");
const plain = rs.saveRecipe(rs.fieldsOf({ name: "brief", steps: ["read mail", "summarise it"], when: "a morning summary" }));
const names = (msg) => rs.mentionedRecipes(msg).map((r) => r.name).sort();
check("a hyphenated name matches as a token", names("can you do the pi-brief for tomorrow"), ["pi-brief"]);
check("a plain word in ordinary speech does not match", names("give me a brief summary of this"), []);
check("a plain word after 'run' matches", names("run brief please"), ["brief"]);
check("a slash command matches", names("/brief"), ["brief"]);
check("'recipe <name>' matches", names("use the recipe brief"), ["brief"]);
check("part of a longer token does not match", names("see okta-checklist.md"), []);
check("matching is case-insensitive", names("Run PI-Brief"), ["pi-brief"]);

console.log("\nrun context\n");
const before = rs.getRecipe("pi-brief").uses;
const ctx = rs.recipeContext("run pi-brief for Thursday");
check("the asked-for recipe is put in full", ctx.blocks[0].includes('Recipe "pi-brief"') && ctx.blocks[0].includes("1. a step"), true);
check("the rest appear as a one-line index", ctx.blocks[1].includes("okta-check (auditing Okta)") && ctx.blocks[1].includes("brief ("), true);
check("the asked-for recipe is not repeated in the index", ctx.blocks[1].includes("pi-brief"), false);
check("using it in full counts a use", rs.getRecipe("pi-brief").uses, before + 1);
check("the context-used line names it", ctx.used, ['recipe "pi-brief" (asked for by name)']);
check("an unrelated message gets only the index", rs.recipeContext("what's the weather").blocks.length, 1);
rs.deleteRecipe(plain.id);
rs.deleteRecipe(other.id);
rs.deleteRecipe(rs.getRecipe("pi-brief").id);
check("no recipes means nothing is added to the prompt", rs.recipeContext("run pi-brief").blocks, []);

console.log("\ntools\n");
check("all three are registered", ["recipe_save", "recipe_use", "recipe_list"].every((n) => n in registry), true);
const args = { name: "pi-brief", steps: ["read the notes", "draft the brief"], when: "PI planning" };
check("recipe_save is irreversible: it goes through approval", recipeSave.classify(args).reversibility, "irreversible");
check("the approval card shows every step", /1\. read the notes\n2\. draft the brief/.test(recipeSave.classify(args).summary), true);
const chat = { conversational: true, goal: "save this as a recipe" };
const scheduled = { conversational: false, goal: "nightly job", preApproved: true };
check("allowed from a live chat", recipeSave.checkPolicy({}, args, chat).allowed, true);
check("refused from a pre-approved schedule", recipeSave.checkPolicy({}, args, scheduled).allowed, false);
check("refused from a subagent", recipeSave.checkPolicy({}, args, { conversational: false, goal: "x" }).allowed, false);
check("allowed at approval time (no run: a person clicked)", recipeSave.checkPolicy({}, args).allowed, true);
check("a bad recipe comes back to the model before queueing", recipeSave.checkPolicy({}, { ...args, steps: ["one"] }, chat).allowed, false);
check("saves when run", /Saved recipe "pi-brief"/.test(await recipeSave.run(args, { policy: {} })), true);
check("the card says REPLACES once the name exists", recipeSave.classify(args).summary.startsWith("REPLACES"), true);
check("recipe_use returns the steps", (await recipeUse.run({ name: "PI Brief" }, {})).includes("2. draft the brief"), true);
check("recipe_use counts a use", rs.getRecipe("pi-brief").uses, 1);
check("an unknown name lists the real ones", (await recipeUse.run({ name: "nope" }, {})).includes("Saved recipes: pi-brief"), true);
check("recipe_list shows use counts", (await recipeList.run({}, {})).includes("pi-brief: PI planning (2 steps, used 1×"), true);
check("recipe_use and recipe_list only read", [recipeUse, recipeList].map((t) => t.classify({ name: "x" }).reversibility), ["reversible", "reversible"]);

fs.rmSync(dbPath, { force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
