/**
 * look_at_image — ask a new question of a picture already in this conversation.
 *
 * The automatic perception pass in `vision.ts` runs once, when an image arrives, and
 * describes it against the question that came with it. The turn after that is the problem
 * this tool exists for: "are the edges serrated?" carries no attachment, and the cached
 * description covers what was asked the first time, not what is being asked now. Without a
 * way back to the pixels the assistant would be reasoning about its own earlier summary
 * forever, getting more confident and no better informed.
 *
 * So this is a second look, with a new question. It is a model call, not a cache read.
 *
 * ## What bounds it
 *
 * Like `read_more`, this tool has no target for an allowlist to decide on: every byte it can
 * reach is a file the user themselves attached to the very thread the run belongs to. The
 * gate is therefore structural rather than configured, and it is enforced in `run` below:
 *
 *   - the id must name an attachment whose `conversation_id` is the conversation of the
 *     CURRENT run, read from the ledger rather than taken from the arguments — so an id
 *     invented by the model, or lifted from an untrusted page, reaches nothing;
 *   - a run with no conversation (a schedule, a watcher, the `do` CLI) has no images by
 *     construction and is refused outright, which keeps unattended jobs away from this
 *     entirely;
 *   - the endpoint is the local vision server, pinned private, so nothing here can send a
 *     photograph off the machine.
 *
 * Budgets still apply — the broker counts every tool by name — which is the rail that
 * matters for a model that decides to re-examine the same photograph eleven times.
 */
import type { ClassifiedAction, PolicyDecision, Tool, ToolContext } from "../types.ts";

import * as store from "../memory/store.ts";
import { look, NoVisionError, visionConfigured } from "../vision.ts";

interface Args {
  id?: number | string;
  question?: string;
}

const classify = (args: Args): ClassifiedAction => ({
  reversibility: "reversible",
  summary: `Look again at image #${args?.id ?? "?"}`,
  target: `image#${args?.id ?? ""}`,
});

const checkPolicy = (): PolicyDecision => ({
  allowed: true,
  reason: "re-reads an image the user attached to this conversation, on the local vision server",
});

const run = async (args: Args, ctx: ToolContext): Promise<string> => {
  if (!visionConfigured()) return "No vision endpoint is configured, so images cannot be read.";

  const id = Number(args?.id);
  if (!Number.isInteger(id) || id <= 0) return "look_at_image needs the numeric id of an image in this conversation.";

  const runId = ctx.runId ?? null;
  if (runId == null) return "This run has no conversation, so it has no images to look at.";

  const conversationId = store.getRun(runId)?.conversation_id ?? null;
  if (conversationId == null) return "This run has no conversation, so it has no images to look at.";

  const row = store.getAttachment(id);
  // One message for "no such image" and "not your image" on purpose: a model that can tell
  // the two apart can enumerate what other threads hold.
  if (!row || row.conversation_id !== conversationId) {
    return `There is no image #${id} in this conversation.`;
  }

  const question = String(args?.question ?? "").trim();
  if (!question) return "look_at_image needs a question — say what you want to know about the image.";

  try {
    const result = await look([row], question);
    return result.knowledge;
  } catch (err) {
    if (err instanceof NoVisionError) return err.message;
    return `Could not look at image #${id}: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const lookAtImage: Tool = {
  argsSchema: '{ "id": number, "question": string }',
  checkPolicy,
  classify,
  description:
    "Look again at an image already shared in this conversation, asking a specific question " +
    "about it. Use this when you need a visual detail the earlier description does not cover " +
    "— not to re-read something it already told you. Takes the image's numeric id.",
  name: "look_at_image",
  run,
};
