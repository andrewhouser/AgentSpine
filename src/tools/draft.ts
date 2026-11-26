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
 * ## Since 2026-11-25: into Gmail, or onto the calendar (SPEC section 5, third amendment; PLAN-open-work CP2)
 *
 * With `policy.drafts.gmail`, an email draft is saved in Gmail's Drafts folder instead of a file, threaded onto the
 * message it answers when `replyTo` names it. With `policy.drafts.calendar` (one of `policy.google.write.calendars`),
 * an event with an exact start goes onto that calendar, with no attendees. Both use the separate write token, through
 * src/google/write.ts, which still has no send. You send the draft yourself, from Gmail.
 *
 * When the text could have come from work material it stays a file, whatever the switches say: the run is in a
 * project, or any run in its conversation started with private recalled memories, or ran a tool that returns private
 * material other than Gmail's and Calendar's own (meetings, knowledge, project sources, files, local MCP servers).
 * CLAUDE.md: workplace material never goes to a third-party API, and your Google account is one. When the context
 * cannot be read, it stays a file too.
 *
 * In a scheduled run a draft that could reach Google asks first (`confirmWhenUnattended`). In a live chat it is still
 * irreversible, so it shows its card, unless you list `draft` in `policy.trust.chatAutoTools`, which is how drafts go
 * straight to Gmail (and events straight onto the calendar) from a chat.
 */
import fs from "node:fs";
import path from "node:path";
import { homeDir, loadPolicy } from "../config.ts";
import { listCalendars } from "../google/client.ts";
import * as write from "../google/write.ts";
import { contextFacts, contextRunIds } from "../memory/store.ts";
import { resolveStyle } from "../styles/store.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool, ToolContext } from "../types.ts";

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
  /** The writing style it was written in (style_for). Shown on the card; code checks it against the recipient. */
  style?: string;
  /** Why this draft exists — which email prompted it, what it's responding to. */
  reason?: string;
  /** email_reply: the Gmail id of the message it answers (from gmail_search), so a Gmail draft is threaded. */
  replyTo?: string;
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
 * Which style the draft says it used, and whether that is what the rules would have picked. A wrong
 * choice should be visible on the card before you send: code, not the model, knows the rule.
 */
const styleLine = (a: Args): string => {
  const used = String(a?.style ?? "").trim();
  const rule = resolveStyle(a?.to);
  if (!used && !rule) return "";
  if (!used) return `Style:   none given (the rules would have used ${rule!.name}, ${rule!.why})`;
  if (rule && rule.name !== used) return `Style:   ${used}. NOTE: the rules for this recipient pick ${rule.name} (${rule.why}).`;
  return `Style:   ${used}${rule ? ` (${rule.why})` : ""}`;
};

/**
 * The draft as reviewable text. This lands in the confirmation summary, which is what you
 * actually read before deciding — so it has to carry the whole thing, not a description of
 * it. A summary you can't judge from is a rubber stamp with extra steps.
 */
export const renderDraft = (a: Args): string => {
  const k = kindOf(a);
  const lines: string[] = [`DRAFT (${k}) — nothing is sent to anyone. Approving saves it: in Gmail Drafts or on your calendar when those are switched on, otherwise as a file.`, ""];

  if (k === "email_reply" || k === "email") {
    lines.push(`To:      ${a?.to ?? "(unspecified)"}`);
    lines.push(`Subject: ${a?.subject ?? "(none)"}`);
    const s = styleLine(a);
    if (s) lines.push(s);
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

export const draftsDir = (policy: Policy): string => expand(policy.drafts?.dir || "./drafts");

// ---- Where an approved draft goes (CP2) ------------------------------------------------------

/** Tools whose private output is Google's own mail and calendar: a draft written after them may go back to Google. */
const GOOGLE_OWN = new Set(["calendar_find", "calendar_upcoming", "calendar_write", "draft", "gmail_search", "gmail_triage", "gmail_unsubscribe", "headsup_status"]);

/**
 * Why this draft must stay a file, or null when it may go to Google. Read from the store, so it is the same answer
 * when the draft runs inside its run and when its card is approved a day later.
 */
export const workReason = async (runId: null | number | undefined): Promise<null | string> => {
  if (runId == null) return "the run it came from is not known";
  const ids = contextRunIds(runId);
  if (!ids.length) return "the run it came from is not known";
  const facts = contextFacts(ids);
  if (facts.inProject) return "it was written in a project";
  if (facts.workPrivate) return "it was written with private context (a project, or recalled private memories)";
  // Imported here: the tool registry imports this file.
  const { registry } = await import("./index.ts");
  const used = facts.tools.find((t) => !GOOGLE_OWN.has(t) && Boolean(registry[t]?.privateOutput));
  return used ? `it was written after ${used} read private material` : null;
};

const START = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/;

/** "45 minutes", "1h", "1h30m", "90" -> minutes. Null when it cannot be read. */
export const durationMinutes = (s: unknown): null | number => {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t) return 60;
  if (/^\d+$/.test(t)) return Number(t);
  // Not \b after the unit: in "1h30m" a digit follows the h directly, and \b would miss the hour.
  const h = /(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs|hr|h)(?![a-z])/.exec(t);
  const m = /(\d+)\s*(?:minutes|minute|mins|min|m)(?![a-z])/.exec(t);
  if (!h && !m) return null;
  return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0));
};

/** Whether this kind could reach Google under this policy (both switches need the write token's policy on too). */
const googleTarget = (policy: Policy, kind: DraftKind): "calendar" | "gmail" | null => {
  if (!policy.google?.enabled || !policy.google.write?.enabled) return null;
  if ((kind === "email" || kind === "email_reply") && policy.drafts?.gmail === true) return "gmail";
  if (kind === "event" && policy.drafts?.calendar) return "calendar";
  return null;
};

/** Try Google. A string is the result to return; null means fall back to a file (with `why` set). */
const toGoogle = async (a: Args, ctx: ToolContext, note: { why: string }): Promise<null | string> => {
  const target = googleTarget(ctx.policy, kindOf(a));
  if (!target) return null;
  const work = await workReason(ctx.runId ?? ctx.queuedByRunId);
  if (work) {
    note.why = `kept as a file because ${work}`;
    return null;
  }
  const body = String(a?.body ?? "").trim();
  try {
    if (target === "gmail") {
      const made = await write.createDraft({ body, replyTo: a?.replyTo ? String(a.replyTo) : undefined, subject: String(a?.subject ?? ""), to: String(a?.to ?? "") });
      return `Draft saved in Gmail Drafts${made.threaded ? ", in the conversation it answers" : ""} (draft ${made.id}). Nothing was sent: open Gmail to send it, or delete it.`;
    }
    const name = String(ctx.policy.drafts?.calendar ?? "");
    const allowed = (ctx.policy.google?.write?.calendars ?? ["Bills"]).map((c) => c.toLowerCase());
    if (!allowed.includes(name.toLowerCase())) {
      note.why = `kept as a file because "${name}" is not in policy.google.write.calendars`;
      return null;
    }
    const start = String(a?.start ?? "").trim();
    if (!START.test(start)) {
      note.why = `kept as a file because the start "${start}" is not an exact time like 2026-12-02T15:00`;
      return null;
    }
    const minutes = durationMinutes(a?.duration);
    if (minutes == null) {
      note.why = `kept as a file because the duration "${String(a?.duration)}" could not be read`;
      return null;
    }
    const cal = (await listCalendars()).find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!cal) {
      note.why = `kept as a file because there is no calendar called "${name}" (it is never created)`;
      return null;
    }
    const made = await write.createTimedEvent(cal.id, {
      description: body,
      location: a?.location ? String(a.location) : undefined,
      minutes,
      start: start.replace(" ", "T"),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      title: String(a?.subject ?? "").trim() || "(untitled)",
    });
    return `Event "${String(a?.subject ?? "").trim() || "(untitled)"}" put on ${cal.name} at ${start}, ${minutes} minutes (event ${made.id}). No one was invited.`;
  } catch (err) {
    note.why = `kept as a file because Google refused it: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
};

export const draft: Tool = {
  name: "draft",
  // Mail, calendar, files and project sources stay local: once this has run, the rest of the run is pinned (src/sensitivity.ts).
  privateOutput: true,
  description:
    "Write a proposed email reply, new email, calendar event, or note for the user to review. " +
    "NOTHING IS SENT to anyone: an email draft is saved in the user's Gmail Drafts or as a file, and they send it; " +
    "an event may be put on their calendar, with no one invited. For a reply, pass replyTo with the Id of the message " +
    "from gmail_search, and for an event give start as an exact local time like 2026-12-02T15:00. The user decides whether to use " +
    "it. Use this when YOU conclude something should be sent or scheduled and the user has not " +
    "told you to — drafting is how you act on your own conclusion. When the user tells you to " +
    "email someone or add an event or reminder, do it with mac_control instead; a draft of " +
    "something they asked you to do is a chore handed back. This is ONLY for text the user " +
    "might send onward as their own — never for delivering information TO the user. A brief, " +
    "digest, report, or answer is not a draft: a draft queues for approval, and information " +
    "queued for approval is a question with nothing being asked. Deliver information in your " +
    "reply or summary (or, from an unattended run, with notify). Write the full finished " +
    "text, in the user's voice, ready to send as-is — a draft they have to rewrite is worse " +
    "than none. For an email, call style_for with the recipient first, write in the style it gives, and pass that name " +
    "as `style`. Set `reason` to say what prompted it.",
  argsSchema:
    '{ "kind": "email_reply"|"email"|"event"|"text", "to"?: string, "subject"?: string, ' +
    '"body": string, "style"?: string, "replyTo"?: string, "start"?: string, "duration"?: string, "location"?: string, "reason"?: string }',

  // A draft is text meant to be sent onward as the user's own, so it is checked like a send.
  outgoingText: (a: Args) => [a?.subject, a?.body].map((x) => String(x ?? "")),
  classify: (a: Args): ClassifiedAction => ({
    // Irreversible so the broker queues it. Not because writing text is dangerous — it
    // isn't — but because a draft's entire purpose is to reach a human before anything
    // happens, and the confirmation queue is exactly that mechanism.
    reversibility: "irreversible",
    target: "drafts",
    // The full draft, because this is the text shown in the queue for review.
    summary: `${label(a)}\n\n${renderDraft(a)}`,
  }),

  available: (policy: Policy): PolicyDecision =>
    policy.drafts?.enabled
      ? { allowed: true, reason: "policy.drafts.enabled is true" }
      : {
          allowed: false,
          reason:
            "policy.drafts.enabled is not set (deny by default). Enable with " +
            '"drafts": { "enabled": true, "dir": "./drafts" } in policy.json.',
        },
  checkPolicy: (policy: Policy): PolicyDecision => draft.available!(policy),

  // CP2: a draft that could reach Gmail or the calendar asks from a scheduled run, like a send. A plain note, or any
  // draft while the Google switches are off, still saves its file unasked. A policy that cannot be read means ask.
  confirmWhenUnattended: (a: Args): boolean => {
    try {
      return googleTarget(loadPolicy(), kindOf(a)) !== null;
    } catch {
      return true;
    }
  },

  /**
   * Runs only on approval. Writes the draft where you can open it. Still no Google call —
   * approving a draft means "put this somewhere I can send it from", never "send it".
   */
  run: async (a: Args, ctx) => {
    const body = String(a?.body ?? "").trim();
    if (!body) return "ERROR: a draft needs a body. There is nothing to review.";

    const note = { why: "" };
    const google = await toGoogle(a, ctx, note);
    if (google) return google;

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
      return `Draft saved to ${file}${note.why ? ` (${note.why})` : ""}. Nothing was sent — open it, and send it yourself if you want it.`;
    } catch (err) {
      return `ERROR: could not save draft: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
