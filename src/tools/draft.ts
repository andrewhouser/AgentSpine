/**
 * The write frontier, taken the safe way: the agent WRITES, you SEND.
 *
 * This is SPEC §5's "preferred path", and the whole point is what it does NOT do. It adds
 * no OAuth scope. The Google token stays `gmail.readonly` + `calendar.readonly`, which
 * means the credential *physically cannot* send mail or change a calendar no matter what
 * the model decides, what a crafted email talks it into, or what a bug in this file does.
 * That guarantee lives at Google's auth server, not in a prompt or in this code — and it is
 * the single strongest thing in the system. A `gmail.send` scope would trade it for
 * convenience, and a hostile email would become an exploit with real reach.
 *
 * So a draft is just proposed text. It is classified **irreversible**, which routes it into
 * the confirmation queue — used here for review rather than for danger, because the queue is
 * already exactly the right shape: a proposal, parked, waiting on a human. Approving writes
 * the draft to a file you can open and send yourself. Rejecting with a reason feeds §6's
 * preference memory, so a draft you didn't want is a draft it learns not to write.
 *
 * Nothing in this file talks to Google, and nothing in it can.
 */
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../config.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

export type DraftKind = "email_reply" | "email" | "event" | "text";

interface Args {
  kind?: DraftKind;
  /** Recipient(s) for email kinds. Informational only — nothing is addressed or sent. */
  to?: string;
  subject?: string;
  body?: string;
  /** Event kinds: when it starts, plainly stated ("Tuesday 2pm", "2026-08-04 14:00"). */
  start?: string;
  /** Event kinds: how long ("45 minutes", "1h"). */
  duration?: string;
  location?: string;
  /** Why this draft exists — which email prompted it, what it's responding to. */
  reason?: string;
}

const KINDS: DraftKind[] = ["email_reply", "email", "event", "text"];

const expand = (p: string): string => path.resolve(String(p ?? "").replace(/^~(?=$|\/)/, homeDir));

const kindOf = (a: Args): DraftKind => (KINDS.includes(a?.kind as DraftKind) ? (a.kind as DraftKind) : "text");

const label = (a: Args): string => {
  const k = kindOf(a);
  const subj = String(a?.subject ?? "").slice(0, 60);
  if (k === "email_reply") return `Reply to ${a?.to ?? "(unspecified)"}${subj ? ` — "${subj}"` : ""}`;
  if (k === "email") return `Email to ${a?.to ?? "(unspecified)"}${subj ? ` — "${subj}"` : ""}`;
  if (k === "event") return `Event "${subj || "(untitled)"}"${a?.start ? ` at ${a.start}` : ""}`;
  return `Note${subj ? ` — "${subj}"` : ""}`;
};

/**
 * The draft as reviewable text. This lands in the confirmation summary, which is what you
 * actually read before deciding — so it has to carry the whole thing, not a description of
 * it. A summary you can't judge from is a rubber stamp with extra steps.
 */
export const renderDraft = (a: Args): string => {
  const k = kindOf(a);
  const lines: string[] = [`DRAFT (${k}) — nothing has been sent, created, or scheduled.`, ""];

  if (k === "email_reply" || k === "email") {
    lines.push(`To:      ${a?.to ?? "(unspecified)"}`);
    lines.push(`Subject: ${a?.subject ?? "(none)"}`);
  } else if (k === "event") {
    lines.push(`Title:    ${a?.subject ?? "(untitled)"}`);
    if (a?.start) lines.push(`Start:    ${a.start}`);
    if (a?.duration) lines.push(`Duration: ${a.duration}`);
    if (a?.location) lines.push(`Location: ${a.location}`);
  } else if (a?.subject) {
    lines.push(`Subject: ${a.subject}`);
  }

  lines.push("", String(a?.body ?? "").trim() || "(empty body)");
  if (a?.reason) lines.push("", `— why: ${a.reason}`);
  return lines.join("\n");
};

const slug = (s: string): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "draft";

const draftsDir = (policy: Policy): string => expand(policy.drafts?.dir || "./drafts");

export const draft: Tool = {
  name: "draft",
  description:
    "Write a proposed email reply, new email, calendar event, or note for the user to review. " +
    "NOTHING IS SENT OR CREATED — you are composing text, and the user decides whether to use " +
    "it. Use this whenever you conclude something should be sent or scheduled: you cannot do " +
    "either, and drafting is how you act on that conclusion. Write the full finished text, in " +
    "the user's voice, ready to send as-is — a draft they have to rewrite is worse than none. " +
    "Set `reason` to say what prompted it.",
  argsSchema:
    '{ "kind": "email_reply"|"email"|"event"|"text", "to"?: string, "subject"?: string, ' +
    '"body": string, "start"?: string, "duration"?: string, "location"?: string, "reason"?: string }',

  classify: (a: Args): ClassifiedAction => ({
    // Irreversible so the broker queues it. Not because writing text is dangerous — it
    // isn't — but because a draft's entire purpose is to reach a human before anything
    // happens, and the confirmation queue is exactly that mechanism.
    reversibility: "irreversible",
    target: "drafts",
    // The full draft, because this is the text shown in the queue for review.
    summary: `${label(a)}\n\n${renderDraft(a)}`,
  }),

  checkPolicy: (policy: Policy): PolicyDecision =>
    policy.drafts?.enabled
      ? { allowed: true, reason: "policy.drafts.enabled is true" }
      : {
          allowed: false,
          reason:
            "policy.drafts.enabled is not set (deny by default). Enable with " +
            '"drafts": { "enabled": true, "dir": "./drafts" } in policy.json.',
        },

  /**
   * Runs only on approval. Writes the draft where you can open it. Still no Google call —
   * approving a draft means "put this somewhere I can send it from", never "send it".
   */
  run: async (a: Args, ctx) => {
    const body = String(a?.body ?? "").trim();
    if (!body) return "ERROR: a draft needs a body. There is nothing to review.";

    const dir = draftsDir(ctx.policy);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(dir, `${stamp}-${kindOf(a)}-${slug(a?.subject ?? a?.to ?? "")}.md`);

    // The filename is built from model-supplied text, so confirm it stayed inside the dir.
    if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) {
      return "ERROR: refusing to write a draft outside the drafts directory.";
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, renderDraft(a) + "\n", "utf8");
      return `Draft saved to ${file}. Nothing was sent — open it, and send it yourself if you want it.`;
    } catch (err) {
      return `ERROR: could not save draft: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
