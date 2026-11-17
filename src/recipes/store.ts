/**
 * Named recipes: procedures YOU decided to keep, under a name you can ask for.
 *
 * LEARNING Phase 3.1 already learns recipes, but implicitly: the reflection pass writes one
 * after a clean run, it is recalled by task similarity, and it is pruned with the other
 * auto-generated memories. That covers "the second time costs less". It cannot cover "the
 * way we just did that was right, call it `pi-brief`, and do exactly that when I ask",
 * which is the habit worth having after a long back-and-forth. So named recipes live
 * here, in their own table, and differ in the three ways that matter:
 *
 * - **A person approves them.** Only `recipe_save` from a live chat creates one, and it queues
 *   the full text for approval (src/tools/recipes.ts). Unattended runs cannot write one.
 *   A recipe is a standing instruction a future run will follow, the same shape of risk as a
 *   schedule's task text.
 * - **They are found by name, not by similarity.** `mentionedRecipes` reads the user's
 *   message. Code decides the match, so a recipe is in context because it was asked for.
 * - **Nothing prunes or dedupes them.** You delete one in Settings, or you don't.
 *
 * Plain rows, edited from the dashboard. No embedding: nothing here is recalled by
 * similarity.
 */
import { rawDb } from "../memory/store.ts";

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    when_text TEXT NOT NULL,
    steps TEXT NOT NULL,
    conversation_id INTEGER,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    last_used TEXT,
    uses INTEGER NOT NULL DEFAULT 0
  );
`);

export const MAX_NAME = 40;
export const MAX_WHEN = 200;
export const MAX_STEP = 300;
export const MIN_STEPS = 2;
export const MAX_STEPS = 12;
/** How many names the standing "you have these recipes" line lists before it stops. */
export const INDEX_MAX = 15;

export interface RecipeRow {
  conversation_id: null | number;
  created: string;
  id: number;
  last_used: null | string;
  name: string;
  steps: string[];
  updated: string;
  uses: number;
  when_text: string;
}

export interface RecipeFields {
  name: string;
  steps: string[];
  when: string;
}

const now = () => new Date().toISOString();

const fromDb = (r: any): RecipeRow => {
  let steps: string[] = [];
  try {
    const parsed = JSON.parse(r.steps);
    if (Array.isArray(parsed)) steps = parsed.map(String);
  } catch {
    /* a hand-edited row with bad JSON shows as empty, not as a crash */
  }
  return { ...r, steps };
};

/**
 * "PI Brief", "pi_brief" and "/pi-brief" all become `pi-brief`. A name is what you type to ask
 * for the recipe, so it is kept to characters that survive being typed or dictated.
 */
export const normaliseName = (raw: unknown): string =>
  String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME);

/**
 * Steps arrive as an array from a well-behaved model and as one newline-separated string, maybe
 * numbered, from a local one. Accept both, and strip the numbering because it is re-added on
 * render.
 */
export const normaliseSteps = (raw: unknown): string[] => {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/\r?\n/);
  return list
    .map((s) =>
      String(s ?? "")
        .trim()
        .replace(/^(\d+[.)]|[-*•])\s+/, ""),
    )
    .filter(Boolean);
};

/**
 * Narrower than reflect.ts's filter on purpose. That one rejects any fact containing the word
 * "token", which is right for facts written by a model with no one watching. Here a person
 * reads every recipe before it is stored, and "refresh the Okta token" is a legitimate step.
 * So this catches only material that IS a secret: a key block, or a value after a password,
 * secret or key label, or a long opaque string.
 */
export const looksLikeSecretValue = (s: string): boolean =>
  /BEGIN [A-Z ]*PRIVATE KEY|ssh-(rsa|ed25519) [A-Za-z0-9+/]{20,}/.test(s) ||
  /\b(password|passwd|api[_ -]?key|secret|token|bearer)\b\s*[:=]\s*\S{6,}/i.test(s) ||
  /\b[A-Za-z0-9_-]{32,}\b/.test(s);

/** Why these fields can't be a recipe, or null if they can. Worded for the model to fix. */
export const recipeProblem = (f: RecipeFields): null | string => {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(f.name))
    return `a recipe needs a short name of letters, digits and hyphens (2–${MAX_NAME} characters), e.g. "pi-brief".`;
  if (!f.when) return 'a recipe needs a "when" line: the situation it is for.';
  if (f.when.length > MAX_WHEN) return `the "when" line is over ${MAX_WHEN} characters. Shorten it.`;
  if (f.steps.length < MIN_STEPS) return `a recipe needs at least ${MIN_STEPS} steps. One step isn't a procedure.`;
  if (f.steps.length > MAX_STEPS) return `a recipe can have at most ${MAX_STEPS} steps. Merge or cut some.`;
  const long = f.steps.findIndex((s) => s.length > MAX_STEP);
  if (long >= 0) return `step ${long + 1} is over ${MAX_STEP} characters. Split or shorten it.`;
  if ([f.when, ...f.steps].some(looksLikeSecretValue))
    return "the recipe looks like it contains a secret (a key, a password value, or a long opaque string). Leave secrets out. Say where to find one instead.";
  return null;
};

/** Read loosely-shaped args (model or HTTP body) into fields. Validate with `recipeProblem`. */
export const fieldsOf = (a: any): RecipeFields => ({
  name: normaliseName(a?.name),
  steps: normaliseSteps(a?.steps),
  when: String(a?.when ?? a?.when_text ?? "")
    .replace(/\s+/g, " ")
    .trim(),
});

export const getRecipe = (name: string): null | RecipeRow => {
  const r = rawDb.prepare("SELECT * FROM recipes WHERE name = ?").get(normaliseName(name));
  return r ? fromDb(r) : null;
};

export const getRecipeById = (id: number): null | RecipeRow => {
  const r = rawDb.prepare("SELECT * FROM recipes WHERE id = ?").get(id);
  return r ? fromDb(r) : null;
};

/** Most recently used first, then newest: the order you are likely to want them in. */
export const listRecipes = (): RecipeRow[] =>
  (rawDb.prepare("SELECT * FROM recipes ORDER BY COALESCE(last_used, created) DESC, id DESC").all() as any[]).map(fromDb);

/**
 * Create, or replace the recipe of the same name. Replacing is deliberate: the approval card
 * says REPLACES when a name already exists, so the person approving knows. `uses` and
 * `created` survive a replace.
 */
export const saveRecipe = (f: RecipeFields, conversationId: null | number = null): RecipeRow => {
  const problem = recipeProblem(f);
  if (problem) throw new Error(problem);
  const t = now();
  rawDb
    .prepare(
      `INSERT INTO recipes (name, when_text, steps, conversation_id, created, updated)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET when_text = excluded.when_text, steps = excluded.steps,
         conversation_id = COALESCE(excluded.conversation_id, recipes.conversation_id), updated = excluded.updated`,
    )
    .run(f.name, f.when, JSON.stringify(f.steps), conversationId, t, t);
  return getRecipe(f.name)!;
};

/** Edit from the dashboard. Each field is optional and the result is validated as a whole. */
export const updateRecipe = (id: number, patch: Partial<RecipeFields>): RecipeRow => {
  const cur = getRecipeById(id);
  if (!cur) throw new Error(`no recipe #${id}`);
  const next: RecipeFields = {
    name: patch.name !== undefined ? normaliseName(patch.name) : cur.name,
    steps: patch.steps !== undefined ? normaliseSteps(patch.steps) : cur.steps,
    when: patch.when !== undefined ? String(patch.when).replace(/\s+/g, " ").trim() : cur.when_text,
  };
  const problem = recipeProblem(next);
  if (problem) throw new Error(problem);
  const clash = getRecipe(next.name);
  if (clash && clash.id !== id) throw new Error(`there is already a recipe called "${next.name}".`);
  rawDb
    .prepare("UPDATE recipes SET name = ?, when_text = ?, steps = ?, updated = ? WHERE id = ?")
    .run(next.name, next.when, JSON.stringify(next.steps), now(), id);
  return getRecipeById(id)!;
};

export const deleteRecipe = (id: number): boolean =>
  Number(rawDb.prepare("DELETE FROM recipes WHERE id = ?").run(id).changes) > 0;

/** The conversation a run belongs to, so a recipe remembers the thread it came from. */
export const conversationOfRun = (runId: null | number | undefined): null | number => {
  if (!runId) return null;
  const r = rawDb.prepare("SELECT conversation_id FROM runs WHERE id = ?").get(runId) as any;
  return r?.conversation_id ?? null;
};

/** Counted when a recipe is put in front of a run, so Settings can show which ones earn their keep. */
export const markUsed = (id: number): void => {
  rawDb.prepare("UPDATE recipes SET uses = uses + 1, last_used = ? WHERE id = ?").run(now(), id);
};

export const renderRecipe = (r: Pick<RecipeRow, "name" | "steps" | "when_text">): string =>
  `Recipe "${r.name}" (when: ${r.when_text})\n${r.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The recipes the user's message asks for. Code owns this match, never the model.
 *
 * A name with a hyphen or a digit (`pi-brief`, `q3-report`) is distinctive enough to match as a
 * whole token anywhere. A single plain word could easily be ordinary speech ("give me a brief
 * summary" isn't asking for the recipe `brief`), so it matches only when it is clearly a
 * reference: `/brief`, `recipe brief`, or `run brief` / `use brief` / `do brief` / `follow brief`.
 */
export const mentionedRecipes = (message: string): RecipeRow[] => {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) return [];
  return listRecipes().filter((r) => {
    const n = escapeRe(r.name);
    const token = `(?<![a-z0-9-])${n}(?![a-z0-9-])`;
    if (/[-0-9]/.test(r.name) && new RegExp(token).test(text)) return true;
    return new RegExp(`(?:/|\\b(?:recipe|run|use|do|follow)\\s+(?:the\\s+|my\\s+)?)${n}(?![a-z0-9-])`).test(text);
  });
};

/**
 * Standing context for a run: the recipes this message asked for, in full, plus a one-line
 * index of the rest so the model knows they exist and can call `recipe_use`. Returns [] when
 * there are no recipes, so a fresh install adds nothing to the prompt.
 *
 * `markUsed` runs only for recipes put in full, because that is the one that did any work.
 */
export const recipeContext = (message: string): { blocks: string[]; used: string[] } => {
  const all = listRecipes();
  if (!all.length) return { blocks: [], used: [] };
  const asked = mentionedRecipes(message);
  const blocks: string[] = [];
  if (asked.length) {
    for (const r of asked) markUsed(r.id);
    blocks.push(
      "The user asked for a saved recipe: a procedure they approved and named. Follow its steps " +
        "in order, adapting only where this request clearly differs, and say if a step no longer " +
        "works:\n\n" +
        asked.map(renderRecipe).join("\n\n"),
    );
  }
  const rest = all.filter((r) => !asked.some((a) => a.id === r.id));
  if (rest.length) {
    const shown = rest.slice(0, INDEX_MAX);
    blocks.push(
      "Saved recipes the user can ask for by name (call recipe_use to read one if the request " +
        "fits it): " +
        shown.map((r) => `${r.name} (${r.when_text.slice(0, 80)})`).join("; ") +
        (rest.length > shown.length ? `; and ${rest.length - shown.length} more (recipe_list)` : "") +
        ".",
    );
  }
  return { blocks, used: asked.map((r) => `recipe "${r.name}" (asked for by name)`) };
};
