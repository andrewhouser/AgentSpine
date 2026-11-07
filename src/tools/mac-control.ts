/**
 * Gated macOS control. The model can NOT send arbitrary AppleScript — it may only invoke a
 * fixed set of templated actions, each against an app bundle id that must be on
 * policy.apps.allow. Enforcement is in this file, not in a prompt. The transports live in
 * apple.ts.
 *
 * Reversibility drives the broker's confirm gate:
 *   - activate, notify, list_events, list_reminders  -> reversible (look, or bring forward)
 *   - create_note, create_event, create_reminder     -> irreversible (writes your data)
 *   - send_mail, send_message                         -> irreversible (leaves the machine)
 *
 * Irreversible actions queue for confirmation, except where the user's own message asked
 * for exactly that action and policy.userDirected lists it — see `directed` below and the
 * broker's Gate 2. That is how "email Jeff that I'm running late" just happens, while the
 * same email proposed by a scheduled job, or addressed to someone the user never named,
 * still waits for a yes.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { tagUntrusted } from "../audit.ts";
import type { ClassifiedAction, Policy, PolicyDecision, RunContext, Tool } from "../types.ts";
import {
  asPhone,
  createNote,
  directedBy,
  eventkit,
  isEmail,
  lookupContact,
  parseWhen,
  pickAddress,
  messageChats,
  sayWhen,
  sendMail,
  sendMessage,
  serviceOrder,
} from "./apple.ts";

const exec = promisify(execFile);

type Action =
  | "activate"
  | "create_event"
  | "create_note"
  | "create_reminder"
  | "list_events"
  | "list_reminders"
  | "notify"
  | "send_mail"
  | "send_message";

interface Args {
  action: Action;
  allDay?: boolean;
  app?: string; // bundle id, for activate
  body?: string;
  calendar?: string;
  days?: number;
  due?: string;
  durationMinutes?: number;
  end?: string;
  list?: string;
  location?: string;
  notes?: string;
  start?: string;
  subject?: string;
  text?: string;
  title?: string;
  to?: string;
  /** For send_message: force a service when the user names one ("by SMS", "as an iMessage"). */
  via?: string;
}

export const MAIL = "com.apple.mail";
export const CALENDAR = "com.apple.iCal";
export const REMINDERS = "com.apple.reminders";
export const NOTES = "com.apple.Notes";
export const CONTACTS = "com.apple.AddressBook";
export const MESSAGES = "com.apple.MobileSMS";

/** Which app each action touches — what the allowlist keys on. */
const TARGET: Partial<Record<Action, string>> = {
  create_event: CALENDAR,
  create_note: NOTES,
  create_reminder: REMINDERS,
  list_events: CALENDAR,
  list_reminders: REMINDERS,
  send_mail: MAIL,
  send_message: MESSAGES,
};

/** Escape for the two legacy one-line scripts (activate, notify), whose inputs are tiny. */
const esc = (s: string): string => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const osascript = async (script: string): Promise<string> => {
  const { stdout } = await exec("osascript", ["-e", script], { timeout: 20_000 });
  return stdout.trim() || "ok";
};

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** When an event ends: an explicit end, else start + duration (default an hour). */
const eventEnd = (args: Args, startMs: number, allDay: boolean): number | null => {
  if (args.end) return parseWhen(args.end)?.ms ?? null;
  if (allDay) return startMs + 86_400_000;
  const minutes = Number(args.durationMinutes ?? 60);
  return startMs + (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
};

const classify = (args: Args): ClassifiedAction => {
  switch (args?.action) {
    case "activate":
      return { reversibility: "reversible", target: args.app ?? "", summary: `Bring ${args.app} to the foreground` };
    case "notify":
      return { reversibility: "reversible", target: "notifications", summary: `Show you a notification: "${args.title ?? ""}"` };
    case "list_events":
      return { reversibility: "reversible", target: CALENDAR, summary: `Read your calendar for the next ${args.days ?? 7} day(s)` };
    case "list_reminders":
      return { reversibility: "reversible", target: REMINDERS, summary: "Read your open reminders" };
    case "create_note":
      return { reversibility: "irreversible", target: NOTES, summary: `Create a note in Notes titled "${args.title ?? "(untitled)"}"` };
    case "create_reminder": {
      const due = parseWhen(args.due);
      return {
        reversibility: "irreversible",
        target: REMINDERS,
        summary: `Add a reminder: "${clip(args.title, 120)}"${due ? `, due ${sayWhen(due.ms, due.dateOnly)}` : ""}${args.list ? ` (list: ${args.list})` : ""}`,
      };
    }
    case "create_event": {
      const start = parseWhen(args.start);
      return {
        reversibility: "irreversible",
        target: CALENDAR,
        summary:
          `Add to your calendar: "${clip(args.title, 120)}"` +
          (start ? `, ${sayWhen(start.ms, args.allDay || start.dateOnly)}` : "") +
          (args.location ? ` at ${clip(args.location, 80)}` : "") +
          (args.calendar ? ` (calendar: ${args.calendar})` : ""),
      };
    }
    case "send_mail":
      // The whole message, because this summary IS the review when it queues: approving an
      // email you were shown only the subject of is not reviewing it.
      return {
        reversibility: "irreversible",
        target: MAIL,
        summary: `Send an email to ${args.to ?? "(no recipient)"}\nSubject: ${clip(args.subject, 200)}\n\n${clip(args.body, 2000)}`,
      };
    case "send_message":
      return {
        reversibility: "irreversible",
        target: MESSAGES,
        summary: `Send a message to ${args.to ?? "(no recipient)"}:\n\n${clip(args.text ?? args.body, 2000)}`,
      };
    default:
      return { reversibility: "irreversible", target: "unknown", summary: `Unknown mac action: ${args?.action}` };
  }
};

const notAllowed = (target: string): PolicyDecision => ({
  allowed: false,
  reason: `${target} is not on policy.apps.allow (deny by default). Add it to grant control.`,
});

const checkPolicy = (policy: Policy, args: Args): PolicyDecision => {
  if (args?.action === "notify") return { allowed: true, reason: "notifications are always permitted" };
  const target = (args?.action && TARGET[args.action]) || args?.app;
  if (!target) return { allowed: false, reason: "no target app bundle id supplied" };
  if (!policy.apps.allow.includes(target)) return notAllowed(target);
  // A recipient given by name has to be looked up, which reads Contacts — a separate grant.
  const byName =
    (args.action === "send_mail" && args.to && !isEmail(args.to)) ||
    (args.action === "send_message" && args.to && !isEmail(args.to) && !asPhone(args.to));
  if (byName && !policy.apps.allow.includes(CONTACTS)) {
    return {
      allowed: false,
      reason: `sending to a name needs Contacts (${CONTACTS}) on policy.apps.allow to look up the address. Use an email address or phone number, or allowlist Contacts.`,
    };
  }
  return { allowed: true, reason: "app is allowlisted" };
};

/** See the header, and `directedBy` in apple.ts for what counts. */
const directed = (args: Args, run: RunContext): null | { action: string; reason: string } => {
  const action = args?.action;
  if (
    action !== "send_mail" &&
    action !== "send_message" &&
    action !== "create_event" &&
    action !== "create_reminder" &&
    action !== "create_note"
  ) {
    return null;
  }
  const reason = directedBy(action, args, run.goal);
  return reason ? { action, reason } : null;
};

const runTool = async (args: Args): Promise<string> => {
  switch (args.action) {
    case "activate":
      return osascript(`tell application id "${esc(args.app!)}" to activate`);

    case "notify":
      return osascript(`display notification "${esc(args.text ?? "")}" with title "${esc(args.title ?? "agentspine")}"`);

    case "create_note": {
      const title = String(args.title ?? "").trim() || "Untitled";
      await createNote(title, String(args.text ?? args.body ?? ""));
      return `Created a note in Notes titled "${title}".`;
    }

    case "send_mail": {
      const to = String(args.to ?? "").trim();
      const subject = String(args.subject ?? "").trim();
      const body = String(args.body ?? args.text ?? "");
      if (!to) return "ERROR: send_mail needs \"to\" — a name from Contacts or an email address.";
      if (!subject && !body.trim()) return "ERROR: send_mail needs a subject or a body; an empty email says nothing.";
      let address = to;
      let label = to;
      if (!isEmail(to)) {
        const picked = pickAddress(to, await lookupContact(to));
        if ("error" in picked) return `NOT SENT: ${picked.error}`;
        address = picked.address;
        label = `${picked.name} <${picked.address}>`;
      }
      await sendMail(address, subject, body);
      return `Sent the email to ${label} with the subject "${subject}".`;
    }

    case "send_message": {
      const to = String(args.to ?? "").trim();
      const text = String(args.text ?? args.body ?? "");
      if (!to) return "ERROR: send_message needs \"to\" — a name from Contacts, a phone number, or an iMessage email.";
      if (!text.trim()) return "ERROR: send_message needs text; an empty message says nothing.";
      let handle = asPhone(to) ?? to;
      let label = to;
      if (!isEmail(to) && !asPhone(to)) {
        // A phone first, since that is what a text goes to; an iMessage email if that is all
        // the contact has.
        let found = await lookupContact(to, "phone");
        if (!found.length) found = await lookupContact(to, "email");
        const picked = pickAddress(to, found);
        if ("error" in picked) return `NOT SENT: ${picked.error.replace("with an email address", "with a phone number or email")}`;
        handle = picked.address;
        label = `${picked.name} (${picked.address})`;
      }
      // Best-effort: if the conversation list can't be read, fall back to the default order
      // rather than failing a send the user asked for.
      const chats = await messageChats().catch(() => []);
      const sentVia = await sendMessage(handle, text, serviceOrder(chats, handle, args.via));
      // "Messages accepted it", not "delivered": Messages reports success for an iMessage it
      // will never deliver, and delivery status is not readable from here.
      return (
        `Messages accepted the message to ${label} (sent as ${sentVia === "iMessage" ? "an iMessage" : `a text, ${sentVia}`}). ` +
        `Delivery can't be confirmed from here; if they say it didn't arrive, try again with via "sms".`
      );
    }

    case "list_events": {
      const days = Math.min(31, Math.max(1, Math.round(Number(args.days ?? 7)) || 7));
      const from = parseWhen(args.start)?.ms ?? new Date().setHours(0, 0, 0, 0);
      const to = from + days * 86_400_000;
      const { events } = await eventkit({ cmd: "events", from: from / 1000, to: to / 1000 });
      if (!events.length) return `No events in the ${days} day(s) from ${sayWhen(from, true)}.`;
      const lines = events.map(
        (e: any) =>
          `- ${sayWhen(e.start * 1000, e.allDay)}${e.allDay ? " (all day)" : `–${new Date(e.end * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}: ` +
          `${e.title}${e.location ? ` @ ${e.location}` : ""} [${e.calendar}]`,
      );
      // Untrusted: event titles and locations come from whoever sent the invitation.
      return tagUntrusted("Calendar", `${events.length} event(s), ${sayWhen(from, true)} to ${sayWhen(to - 1, true)}:\n${lines.join("\n")}`);
    }

    case "list_reminders": {
      const { reminders } = await eventkit({ cmd: "reminders" });
      if (!reminders.length) return "No open reminders.";
      const lines = reminders.map((r: any) => `- ${r.title}${r.due ? ` (due ${sayWhen(r.due * 1000)})` : ""} [${r.list}]`);
      return tagUntrusted("Reminders", `${reminders.length} open reminder(s):\n${lines.join("\n")}`);
    }

    case "create_reminder": {
      const title = String(args.title ?? "").trim();
      if (!title) return "ERROR: create_reminder needs a title.";
      let due: number | undefined;
      if (args.due) {
        const when = parseWhen(args.due);
        if (!when) return `ERROR: could not read due ${JSON.stringify(args.due)}. Use "YYYY-MM-DDTHH:MM" (local time) or "YYYY-MM-DD".`;
        due = when.ms;
      }
      const res = await eventkit({ cmd: "add_reminder", due: due === undefined ? undefined : due / 1000, list: args.list, notes: args.notes, title });
      return `Added the reminder "${title}"${due === undefined ? "" : `, due ${sayWhen(due)}`}, to the ${res.list} list.`;
    }

    case "create_event": {
      const title = String(args.title ?? "").trim();
      if (!title) return "ERROR: create_event needs a title.";
      const start = parseWhen(args.start);
      if (!start) return `ERROR: could not read start ${JSON.stringify(args.start)}. Use "YYYY-MM-DDTHH:MM" (local time), or "YYYY-MM-DD" for all day.`;
      const allDay = Boolean(args.allDay) || start.dateOnly;
      const end = eventEnd(args, start.ms, allDay);
      if (end === null) return `ERROR: could not read end ${JSON.stringify(args.end)}. Use "YYYY-MM-DDTHH:MM".`;
      if (end <= start.ms) return "ERROR: the event ends before it starts.";
      const res = await eventkit({
        allDay,
        calendar: args.calendar,
        cmd: "add_event",
        end: end / 1000,
        location: args.location,
        notes: args.notes,
        start: start.ms / 1000,
        title,
      });
      return `Added "${title}" to the ${res.calendar} calendar, ${sayWhen(start.ms, allDay)}${allDay ? " (all day)" : ""}.`;
    }

    default:
      return `ERROR: unknown action ${JSON.stringify(args.action)}`;
  }
};

export const macControl: Tool = {
  name: "mac_control",
  description:
    "Act in the user's own Mac apps: Apple Mail, Messages, Calendar, Reminders and Notes. " +
    "send_mail sends a real email from their Mail account — when the user tells you to email someone, use this, " +
    "not draft, and pass \"to\" exactly as they said it (a name from their Contacts, or an address). " +
    "send_message sends an iMessage (or SMS) from Messages with \"text\" — use it when they say text or message someone; " +
    "pass \"to\" exactly as they said it (a name, a phone number, or an iMessage email). It picks iMessage or a text " +
    "(RCS/SMS) automatically; set \"via\" to \"sms\" or \"imessage\" only if the user says which. Messages cannot be read, only sent. " +
    "list_events / list_reminders read what is there; create_event / create_reminder / create_note add to it. " +
    "Dates are local time as \"YYYY-MM-DDTHH:MM\" (or \"YYYY-MM-DD\" for all day) — work them out from the current time. " +
    "Also: activate brings an app forward; notify shows a Mac banner.",
  argsSchema:
    '{ "action": "send_mail"|"send_message"|"list_events"|"create_event"|"list_reminders"|"create_reminder"|"create_note"|"activate"|"notify", ' +
    '"to"?: string, "subject"?: string, "body"?: string, ' +
    '"title"?: string, "start"?: string, "end"?: string, "durationMinutes"?: number, "allDay"?: boolean, "location"?: string, "calendar"?: string, "days"?: number, ' +
    '"via"?: "sms"|"imessage", "due"?: string, "list"?: string, "notes"?: string, "text"?: string, "app"?: "<bundle id, for activate>" }',
  classify,
  checkPolicy,
  directed,
  run: (args: Args) => runTool(args),
};
