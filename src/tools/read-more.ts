/**
 * read_more — the second half of a clipped tool result.
 *
 * When a result is too long for the local model's context, `src/stash.ts` shows the first
 * N characters and keeps the rest. This is how the model asks for the rest. It reads no
 * file, opens no page and touches no network: every byte it can return was already
 * fetched, under a gate the broker applied, during this same run.
 *
 * ## Why this is allowed unconditionally
 *
 * Every other tool answers "may the agent reach this target" against `policy.json`. This
 * one has no target of its own to check. Re-deriving the original — re-gating the path
 * behind `file ~/notes.md` — would look more rigorous and would in fact be weaker: it
 * means a second, differently-written copy of each gate, and a gate written twice is a
 * gate that will eventually disagree with itself.
 *
 * What bounds this tool instead is the shape of the stash, enforced in SQL in
 * `store.stashGet`:
 *
 *   - a row exists only because a gated call already succeeded and its output was already
 *     handed to this model;
 *   - the lookup binds the current run id, so a ref cannot be read from another run — a
 *     subagent has its own run row and so cannot reach its caller's stash;
 *   - rows are dropped when the run ends, so a ref is dead before anything else could ask.
 *
 * The set of bytes reachable here is therefore exactly the set already granted, minus what
 * was shown. There is nothing left for an allowlist to decide.
 *
 * Budgets still apply, because the broker counts every tool by name — `perRun.default`
 * covers this one like any other, which is the rail that matters for a model that decides
 * to page through a 200,000-character log one window at a time.
 */
import { readMore } from "../stash.ts";
import type { ClassifiedAction, PolicyDecision, Tool, ToolContext } from "../types.ts";

interface Args {
  offset?: number;
  ref: string;
}

const classify = (args: Args): ClassifiedAction => ({
  reversibility: "reversible",
  target: String(args?.ref ?? ""),
  summary: `Read more of held content ${args?.ref ?? "(no ref)"}`,
});

const checkPolicy = (): PolicyDecision => ({
  allowed: true,
  reason: "returns content this run already fetched under its own gate",
});

const run = async (args: Args, ctx: ToolContext): Promise<string> =>
  readMore(ctx.runId ?? null, String(args?.ref ?? ""), Number(args?.offset ?? 0)).text;

export const readMoreTool: Tool = {
  name: "read_more",
  description:
    "Continue reading a result that was clipped. Use the ref and offset printed at the end " +
    "of the clipped result. Only for content clipped in this run — it cannot open anything new.",
  argsSchema: '{ "ref": string, "offset": number }',
  classify,
  checkPolicy,
  run,
};
