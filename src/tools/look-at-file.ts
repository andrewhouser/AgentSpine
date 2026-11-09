/**
 * look_at_file — look at an image FILE on disk, including one a command just produced.
 *
 * This is the half of seeing that the build loop needs. `run_command` can run
 * `xcrun simctl io booted screenshot shot.png`, or a build that renders a page, or a script
 * that plots a chart — and until this existed nothing could then tell whether the result
 * looked right. "The button is off the bottom of the screen" appears in no compiler output.
 *
 * ## Why this is a second tool and not a `path` argument on look_at_image
 *
 * They have genuinely different gates, and `look_at_image`'s header is explicit that it has
 * no target for an allowlist to decide on: every byte it can reach is a file the user
 * themselves attached to the very thread the run belongs to. That is a structural guarantee,
 * and adding a filesystem path to it would quietly replace it with a configured one.
 *
 * So this tool carries its own gate, and it is the ordinary one: `policy.fs.readableDirs`,
 * the same check `read_file` and the project indexer use, through the same `fs-scope.ts`
 * helpers — expand, resolve symlinks, then test containment, so a link inside an allowed
 * directory cannot carry the read out of it.
 *
 * ## The image becomes part of the thread, deliberately
 *
 * It is copied into `ATTACHMENTS_DIR` by `storeImage` and recorded as an attachment, rather
 * than being read in place. Three things fall out of that, and all three are wanted:
 *
 *   - **The user sees it.** A screenshot the agent looked at shows up in the conversation
 *     like any other image, which is the difference between "it says the layout is fine" and
 *     being able to check.
 *   - **`look_at_image` can follow up on it** by id, so the turn after can ask a second
 *     question without re-reading the file.
 *   - **Nothing is written next to the original.** `modelImageFile` caches a downscaled copy
 *     beside the file it is given; pointed at a repo that would drop a stray sibling into the
 *     user's working tree and into their `git status`.
 *
 * `storeImage` also sniffs the actual file signature rather than trusting the extension, and
 * enforces `VISION_MAX_BYTES` — so "look at config.png" on a file that is not an image is a
 * clean refusal rather than a pile of bytes posted to a model.
 *
 * ## What comes back is UNTRUSTED, and here that matters more than usual
 *
 * `vision.ts` explains why an image is an input channel for instructions: a vision model
 * reads text in pictures. A screenshot of an app under development is a picture **full of
 * text the agent itself just wrote**, and one of a web page is full of text somebody else
 * wrote. `look()` tags its result, and that tagging is the half that does not depend on the
 * model cooperating.
 *
 * Pinned local by construction, like every other vision call: `sensitivity: "private"` means
 * `resolveTier` can never send it to the cloud tier.
 */
import fs from "node:fs";
import path from "node:path";

import { storeImage, UnsupportedImageError } from "../attachments.ts";
import { expand, readableGate } from "../fs-scope.ts";
import * as store from "../memory/store.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool, ToolContext } from "../types.ts";
import { look, NoVisionError, visionConfigured } from "../vision.ts";

interface Args {
  path?: string;
  question?: string;
}

export const lookAtFile: Tool = {
  name: "look_at_file",
  description:
    "Look at an image file on disk and answer a question about it — a screenshot you just " +
    "took, a chart a script rendered, a photo in a folder. Use it to check whether something " +
    "you built LOOKS right, which no build output can tell you. The image is added to the " +
    "conversation so the user can see it too, and its id works with look_at_image for a " +
    "follow-up question.",
  argsSchema: '{ "path": string, "question": string }',
  classify: (a: Args): ClassifiedAction => ({
    // Reads a file and runs a local model. Nothing is changed that cannot be re-done, and the
    // copy it makes lands in a directory this application owns.
    reversibility: "reversible",
    summary: `Look at image ${a?.path ?? "(no path)"}`,
    target: expand(a?.path ?? ""),
  }),
  checkPolicy: (policy: Policy, a: Args): PolicyDecision => {
    const p = String(a?.path ?? "");
    if (!p) return { allowed: false, reason: 'look_at_file needs a "path" to an image file.' };
    if (!String(a?.question ?? "").trim())
      return { allowed: false, reason: 'look_at_file needs a "question" — say what you want to know about the image.' };
    return readableGate(policy, p);
  },
  run: async (a: Args, ctx: ToolContext) => {
    if (!visionConfigured())
      return (
        "No vision endpoint is configured, so images cannot be read. Set VISION_LLM_URL in .env " +
        "to an mlx_vlm.server address (see MODELS.md)."
      );

    const target = expand(String(a?.path ?? ""));
    const question = String(a?.question ?? "").trim();

    if (!fs.existsSync(target)) return `NOT FOUND: ${target}`;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (stat.isDirectory()) return `${target} is a directory, not an image.`;

    // Null for an unattended run (a schedule, a watcher, the `do` CLI). The image is still
    // looked at — the gate here is the directory allowlist, which holds either way — it just
    // has no thread to appear in.
    const conversationId = ctx.runId != null ? (store.getRun(ctx.runId)?.conversation_id ?? null) : null;

    let stored;
    try {
      stored = await storeImage(fs.readFileSync(target), { conversationId, name: path.basename(target) });
    } catch (err) {
      if (err instanceof UnsupportedImageError) return `Cannot look at ${target}: ${err.message}`;
      return `ERROR: could not read ${target} as an image — ${err instanceof Error ? err.message : String(err)}`;
    }

    const row = store.getAttachment(stored.id);
    if (!row) return `ERROR: ${target} was stored but could not be read back.`;

    try {
      const result = await look([row], question);
      return (
        `${result.knowledge}\n\n[agentspine] ${path.basename(target)} is now image #${stored.id} in this ` +
        `conversation. To ask something else about it: ` +
        `{"action":"tool","tool":"look_at_image","args":{"id":${stored.id},"question":"…"}}`
      );
    } catch (err) {
      if (err instanceof NoVisionError) return err.message;
      return `Could not look at ${target}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
