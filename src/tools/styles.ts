/**
 * Writing styles from the model's side: learn one from your sent mail, and ask which one applies.
 *
 * `style_learn` only PROPOSES. It reads your sent mail (read-only token, in:sent only), builds a note
 * with the local model, and parks it in Settings → Styles. It writes nothing that is in force, and it
 * never returns the note: the chat model, which may be the cloud tier, hears only that a proposal is
 * waiting. You read the note in full and accept it in Settings, a button no tool can press. Like
 * `recipe_save`, it works only from a live chat, because a style is a standing instruction.
 *
 * `style_for` is the read side. Code picks the style (an address rule, a domain rule, then the default)
 * and the model writes in it; the model is never asked which style fits. It runs anywhere.
 */
import { learnStyle } from "../styles/learn.ts";
import * as styles from "../styles/store.ts";
import type { ClassifiedAction, PolicyDecision, Tool } from "../types.ts";

export const styleLearn: Tool = {
  name: "style_learn",
  description:
    "Learn a writing style from the user's own sent mail, so drafts sound like them. Use it when the user asks you to " +
    "learn, build or update a style (for example \"learn my casual style\" or \"learn how I write to clients\"). " +
    "`name` is free text such as casual, formal or a client's name. `query` is a Gmail search that picks the sample " +
    "for that style, such as `to:@example.com`, added to in:sent; leave it out for casual and formal and the local " +
    "model sorts the sample itself. `addresses` and `domains` say which recipients the style applies to. The result is " +
    "NOT saved: it waits in Settings → Styles for the user to read and accept, and you cannot see the note. " +
    "Tell the user that it is waiting there.",
  argsSchema:
    '{ "name": string, "query"?: string (Gmail search, added to in:sent), "addresses"?: string[], "domains"?: string[] }',
  classify: (a): ClassifiedAction => ({
    // Reversible: it writes only a proposal, which does nothing until a person accepts it in Settings.
    reversibility: "reversible",
    target: "styles",
    summary: `Learn style "${styles.normaliseName(a?.name)}" from sent mail${a?.query ? ` matching "${String(a.query).slice(0, 80)}"` : ""}`,
  }),
  checkPolicy: (policy, a, run): PolicyDecision => {
    if (run && !run.conversational)
      return { allowed: false, reason: "styles are learned only from a live chat. An unattended run can't start one." };
    if (!policy.google?.enabled) return { allowed: false, reason: "google reads are disabled in policy.json, so there is no sent mail to learn from" };
    const name = styles.normaliseName(a?.name);
    return styles.styleProblem(name, "x") ? { allowed: false, reason: styles.styleProblem(name, "x")! } : { allowed: true, reason: "reads your sent mail, saves nothing until you accept" };
  },
  run: async (a) => {
    const name = styles.normaliseName(a?.name);
    const r = await learnStyle(name, String(a?.query ?? "").trim());
    if (!r.ok || !r.note) return `NOT LEARNED: ${r.reason}`;
    const saved = styles.propose(name, r.note, styles.normaliseAppliesTo({ addresses: a?.addresses, domains: a?.domains }), r.sampled);
    if ("error" in saved) return `NOT LEARNED: ${saved.error}`;
    const replaces = styles.getStyle(name) ? ` It would REPLACE the style "${name}" you have now.` : "";
    return `Built a proposed style "${name}" from ${r.sampled} sent messages. It is waiting in Settings → Styles for the user to read and accept. You cannot see it.${replaces}`;
  },
};

export const styleFor: Tool = {
  name: "style_for",
  description:
    "Before writing a draft email in the user's voice, ask which writing style applies and read it. Pass `to` (the recipient " +
    "address or addresses). Code chooses the style from rules the user set, then their default; you do not choose. " +
    "Write the draft in that style and pass its name as `style` to draft. If there is no style, write plainly.",
  argsSchema: '{ "to"?: string, "style"?: string (only if the user named one) }',
  classify: (): ClassifiedAction => ({ reversibility: "reversible", target: "styles", summary: "Read the writing style for a draft" }),
  checkPolicy: (): PolicyDecision => ({ allowed: true, reason: "reads a saved style" }),
  run: async (a) => {
    const r = styles.resolveStyle(a?.to, a?.style);
    if (!r) return "No writing style is saved yet. Write plainly, and do not invent a voice.";
    return `Style: ${r.name} (${r.why}).\n${r.note}\nWrite in this style, and pass style: "${r.name}" to draft.`;
  },
};
