/**
 * Named recipes from the inside: save the method you just worked out, and use one by name.
 *
 * `recipe_save` is classified **irreversible**, for the same reason `schedule_create` is (see
 * the note at the top of tools/schedule.ts). A row is easy to delete. What matters is that a
 * recipe is text a future run is told to follow, so it must not be a sentence picked up from
 * an UNTRUSTED page. Two locks:
 *
 * 1. **Only from a live chat.** `checkPolicy` refuses any run that isn't `conversational`. Scheduled and
 *    watcher runs are pre-approved since 698f112, so their irreversible calls skip the queue,
 *    and a scheduled run that could save recipes would be writing standing instructions with
 *    nobody reading. This refusal holds whatever the broker would otherwise allow.
 * 2. **The queue shows the whole recipe.** The approval card carries every step verbatim,
 *    and says REPLACES if the name already exists.
 *
 * `recipe_use` and `recipe_list` only read, so they are reversible and run anywhere,
 * including from a schedule whose task says "run pi-brief". That is a recipe doing its job.
 */
import * as recipes from "../recipes/store.ts";
import type { ClassifiedAction, PolicyDecision, Tool } from "../types.ts";

const proposal = (f: recipes.RecipeFields): string => {
  const existing = f.name ? recipes.getRecipe(f.name) : null;
  return [
    existing
      ? `REPLACES THE SAVED RECIPE "${f.name}". The old steps are overwritten if you approve.`
      : `NEW RECIPE "${f.name || "(unnamed)"}". Nothing is saved until you approve.`,
    "",
    `When: ${f.when || "(missing)"}`,
    "",
    ...(f.steps.length ? f.steps.map((s, i) => `${i + 1}. ${s}`) : ["(no steps)"]),
    "",
    `Afterwards, saying "run ${f.name || "<name>"}" puts these steps in front of the assistant.`,
  ].join("\n");
};

export const recipeSave: Tool = {
  name: "recipe_save",
  description:
    "Save the method from THIS conversation as a named recipe the user can ask for later " +
    "(\"run pi-brief\"). Use it when the user says to save, keep or remember how something " +
    "was done, or to turn the conversation into a recipe, skill or playbook. Write the steps as " +
    "complete standing instructions a future run with no memory of this chat can follow: " +
    "name the tools, files, people and checks, and leave out what was only true today. " +
    "Never include secrets. Queued for the user's approval, so say it is proposed, not saved. " +
    "Saving again with an existing name replaces that recipe.",
  argsSchema:
    '{ "name": string (short, hyphenated, e.g. "pi-brief"), "when": string (the situation it is for), ' +
    `"steps": string[] (${recipes.MIN_STEPS}–${recipes.MAX_STEPS} imperative steps) }`,
  classify: (a): ClassifiedAction => ({
    reversibility: "irreversible",
    target: "recipes",
    summary: proposal(recipes.fieldsOf(a)),
  }),
  /**
   * Validation sits here, not in `run`, for the reason schedule.ts gives: this is the last hook
   * before the call is queued. A bad recipe goes straight back to the model with what to fix,
   * instead of sitting in the queue as a card that fails when approved.
   */
  checkPolicy: (_p, a, run): PolicyDecision => {
    // `run` absent is the approval-time re-check in confirmations.ts: a person just clicked
    // Approve, so it passes. A present run that is not a chat is the case to stop: a
    // pre-approved schedule or watcher would otherwise run this without queueing.
    if (run && !run.conversational)
      return {
        allowed: false,
        reason:
          "recipes are saved only from a live chat, where the user reads them before approving. " +
          "An unattended run can't write one.",
      };
    const problem = recipes.recipeProblem(recipes.fieldsOf(a));
    return problem ? { allowed: false, reason: problem } : { allowed: true, reason: "saving a recipe the user can read first" };
  },
  run: async (a, ctx) => {
    const r = recipes.saveRecipe(recipes.fieldsOf(a), recipes.conversationOfRun(ctx.runId));
    return `Saved recipe "${r.name}" (${r.steps.length} steps). The user can say "run ${r.name}" to use it, and edit or delete it in Settings → Recipes.`;
  },
};

export const recipeUse: Tool = {
  name: "recipe_use",
  description:
    "Read a saved recipe by name to follow its steps. Use when the user's request fits a recipe " +
    "in the saved-recipes list, or names one that isn't already shown in full.",
  argsSchema: '{ "name": string }',
  classify: (a): ClassifiedAction => ({
    reversibility: "reversible",
    target: "recipes",
    summary: `Read recipe "${recipes.normaliseName(a?.name)}"`,
  }),
  checkPolicy: () => ({ allowed: true, reason: "reading a saved recipe" }),
  run: async (a) => {
    const r = recipes.getRecipe(String(a?.name ?? ""));
    if (!r) {
      const names = recipes.listRecipes().map((x) => x.name);
      return `ERROR: no recipe called "${recipes.normaliseName(a?.name)}". ${
        names.length ? `Saved recipes: ${names.join(", ")}.` : "There are no saved recipes yet."
      }`;
    }
    recipes.markUsed(r.id);
    return `${recipes.renderRecipe(r)}\n\nFollow these steps in order, adapting only where this request clearly differs.`;
  },
};

export const recipeList: Tool = {
  name: "recipe_list",
  description: "List the saved recipes: name, what each is for, and how often it has been used.",
  argsSchema: "{}",
  classify: (): ClassifiedAction => ({ reversibility: "reversible", target: "recipes", summary: "List saved recipes" }),
  checkPolicy: () => ({ allowed: true, reason: "reading saved recipes" }),
  run: async () => {
    const all = recipes.listRecipes();
    if (!all.length) return 'No saved recipes yet. After working something out, the user can say "save this as a recipe".';
    return all
      .map((r) => `- ${r.name}: ${r.when_text} (${r.steps.length} steps, used ${r.uses}×${r.last_used ? `, last ${r.last_used.slice(0, 10)}` : ""})`)
      .join("\n");
  },
};

export const recipeTools: Tool[] = [recipeSave, recipeUse, recipeList];
