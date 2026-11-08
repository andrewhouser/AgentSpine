/**
 * Apple Mail, Calendar, Reminders, Notes and Contacts — the plumbing behind mac_control.
 *
 * Two transports, chosen per app for correctness rather than uniformity:
 *
 *   - **EventKit** (services/eventkit/ek.swift) for Calendar and Reminders. Calendar.app's
 *     AppleScript dictionary does not expand recurring events, so a scripted "what's on this
 *     week?" misses every weekly meeting. EventKit does it properly and takes real dates.
 *   - **AppleScript** for Mail, Notes and Contacts, which have no other API. Every value is
 *     passed as an `on run argv` argument, never spliced into the script text, so nothing
 *     the model writes — a subject line, a note body — can become AppleScript.
 *
 * ## Acting without asking
 *
 * `directedBy` answers one question for the broker: did the user's OWN message, in this
 * chat turn, ask for exactly this? It reads `run.goal` — the user's words, verbatim — and
 * never the model's account of them, because the model is the party being gated. Same
 * principle as `askedForPush` in notify.ts, applied to the confirmation gate instead of the
 * allowlist.
 *
 * Email gets the strictest reading, because it is the one action here that leaves the
 * machine. Asking to send is not enough; the recipient has to be someone the user NAMED, in
 * the sentence that asked. That is the property that matters against prompt injection: a
 * web page or an incoming email can talk the model into composing a message, but it cannot
 * put an address into what the user said. A recipient the model found anywhere else falls
 * back to the confirmation queue, with the full message shown.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

// --- AppleScript -------------------------------------------------------------------------

/**
 * Run a script whose inputs arrive as argv. The script text is a constant in this file;
 * `args` are data, delivered by osascript as `item n of argv`, and never parsed as code.
 */
export const osascriptArgv = async (script: string, args: string[], timeoutMs = 90_000): Promise<string> => {
  try {
    const { stdout } = await exec("osascript", ["-e", script, ...args], { timeout: timeoutMs });
    return stdout.trim();
  } catch (err) {
    throw new Error(explainAppleScriptError(err, timeoutMs));
  }
};

/**
 * The errors worth translating are the ones a person can fix, because the raw text tells them
 * nothing.
 *
 * A timeout above all. The first time AgentSpine touches an app, osascript blocks on a macOS
 * permission dialog on the Mac's screen; nobody there, and it is killed with empty stderr.
 * The old message was then the "Command failed: osascript -e <the whole script>" line, which
 * read as a bug in the script rather than a dialog waiting for a click. Ninety seconds by
 * default gives a person time to walk over and answer it.
 */
const explainAppleScriptError = (err: unknown, timeoutMs: number): string => {
  const e = err as { killed?: boolean; signal?: string; stderr?: string; message?: string };
  if (e?.killed || e?.signal === "SIGTERM") {
    return (
      `timed out after ${Math.round(timeoutMs / 1000)}s. The first time AgentSpine uses an app, macOS shows a ` +
      `permission prompt on the Mac ("node" wants to control …) and waits for someone to click OK. Approve it on ` +
      `the Mac and try again, or enable it ahead of time in System Settings > Privacy & Security > Automation.`
    );
  }
  const text = String(e?.stderr || e?.message || err);

  if (/-1743|not authori[sz]ed to send apple events/i.test(text)) {
    return (
      "macOS has not allowed AgentSpine to control this app. Open System Settings > Privacy & Security > " +
      "Automation and enable it for node. If no prompt ever appeared, the dashboard is running outside your " +
      "login session, where macOS cannot ask."
    );
  }
  if (/-600|isn.t running/i.test(text)) return "the app could not be launched from this session.";
  // Never the "Command failed: osascript -e …" line: it is the entire script, not the error.
  if (e?.stderr?.trim()) return e.stderr.trim();
  return /^Command failed:/.test(text) ? "AppleScript failed without saying why" : text.trim() || "AppleScript failed";
};

// --- EventKit helper ---------------------------------------------------------------------

const EK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "services", "eventkit");
const EK_BIN = path.join(EK_DIR, ".build", "ek");
const EK_SOURCES = [path.join(EK_DIR, "ek.swift"), path.join(EK_DIR, "Info.plist")];

const mtime = (p: string): number => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Build the helper if it is missing or older than its source. update.sh does this too; doing
 * it here as well means a fresh checkout works on first use instead of failing until the
 * next update. The Info.plist is linked INTO the binary because macOS denies calendar access
 * to a process that carries no usage description.
 */
const ensureHelper = async (): Promise<void> => {
  const built = mtime(EK_BIN);
  if (built && EK_SOURCES.every((s) => mtime(s) <= built)) return;
  fs.mkdirSync(path.dirname(EK_BIN), { recursive: true });
  await exec(
    "swiftc",
    ["-O", EK_SOURCES[0], "-o", EK_BIN, "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", EK_SOURCES[1]],
    { timeout: 180_000 },
  );
};

/** One request to the helper: JSON in on stdin, JSON out on stdout. Throws on `error`. */
export const eventkit = async (request: Record<string, unknown>): Promise<any> => {
  await ensureHelper();
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(EK_BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    // Long, because the first call may sit on a macOS permission dialog until someone answers.
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`EventKit helper exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.end(JSON.stringify(request));
  });
  const reply = JSON.parse(out);
  if (reply?.error) throw new Error(reply.error);
  return reply;
};

// --- Dates -------------------------------------------------------------------------------

export interface When {
  /** Epoch milliseconds. */
  ms: number;
  /** "2026-11-10" with no time: an all-day date, at local midnight. */
  dateOnly: boolean;
}

/**
 * Parse the date forms the model is asked to use. Strict on purpose: a calendar entry on the
 * wrong day is worse than an error the model can correct, so "next Tuesday" is refused here
 * and resolved by the model against the clock in its prompt.
 *
 * A time with no offset is LOCAL time, which is what a person means by "3pm". JavaScript
 * already reads "2026-11-10T15:00" that way, but reads a bare "2026-11-10" as UTC midnight —
 * the evening before, west of Greenwich — so that form is built by hand.
 */
export const parseWhen = (value: unknown): null | When => {
  const s = String(value ?? "").trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isNaN(d.getTime()) ? null : { dateOnly: true, ms: d.getTime() };
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return null;
  const ms = Date.parse(s.replace(" ", "T"));
  return Number.isNaN(ms) ? null : { dateOnly: false, ms };
};

/** "Tue, Nov 10, 3:00 PM" — how a date is said back to the user and the model. */
export const sayWhen = (ms: number, allDay = false): string =>
  new Date(ms).toLocaleString("en-US", {
    day: "numeric",
    month: "short",
    weekday: "short",
    ...(allDay ? {} : { hour: "numeric", minute: "2-digit" }),
  });

// --- Contacts ----------------------------------------------------------------------------

export const isEmail = (s: string): boolean => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s.trim());

/** A phone number as dialled: digits, with a leading + kept. Null if it isn't one. */
export const asPhone = (s: string): null | string => {
  const t = String(s ?? "").trim();
  if (!/^\+?[\d\s().-]{7,}$/.test(t)) return null;
  const digits = t.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? `${t.startsWith("+") ? "+" : ""}${digits}` : null;
};

export interface ContactAddress {
  /** An email address, or a phone number as Contacts stores it. */
  address: string;
  name: string;
}

/** Emails or phones of every person whose name contains the query, one "name<TAB>value" per line. */
const CONTACTS_LOOKUP = `on run argv
  set q to item 1 of argv
  set lookupKind to item 2 of argv
  set out to ""
  tell application id "com.apple.AddressBook"
    repeat with p in (every person whose name contains q)
      if lookupKind is "phone" then
        set vals to phones of p
      else
        set vals to emails of p
      end if
      repeat with v in vals
        set out to out & (name of p) & tab & (value of v) & linefeed
      end repeat
    end repeat
  end tell
  return out
end run`;

export const lookupContact = async (query: string, kind: "email" | "phone" = "email"): Promise<ContactAddress[]> => {
  const out = await osascriptArgv(CONTACTS_LOOKUP, [query, kind]);
  return out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length === 2 && (kind === "phone" ? asPhone(parts[1]) !== null : isEmail(parts[1])))
    .map(([name, value]) => ({ address: kind === "phone" ? (asPhone(value) as string) : value.trim(), name: name.trim() }));
};

/**
 * One address for a name, or the reason there isn't one.
 *
 * Several people can match "Jeff" and one person can have several addresses. Guessing
 * between them is how an email goes to the wrong person, so anything but a single candidate
 * is handed back as a choice. An exact name match narrows first: "Jeff Houser" should not be
 * ambiguous merely because "Jeff Houserman" also exists.
 */
export const pickAddress = (query: string, matches: ContactAddress[]): { address: string; name: string } | { error: string } => {
  if (!matches.length) return { error: `no contact named "${query}" with an email address was found in Contacts.` };
  const exact = matches.filter((m) => m.name.toLowerCase() === query.trim().toLowerCase());
  const pool = exact.length ? exact : matches;
  // Keyed on the address with formatting removed, so "(603) 555-0100" and "+1 603-555-0100"
  // — the same phone, entered twice — are not mistaken for a choice. The last 10 digits
  // carry the number; a country code in one entry and not the other is still one phone.
  const key = (a: string): string => (isEmail(a) ? a.toLowerCase() : a.replace(/\D/g, "").slice(-10));
  const unique = [...new Map(pool.map((m) => [key(m.address), m])).values()];
  if (unique.length === 1) return unique[0];
  return {
    error:
      `"${query}" matches more than one address: ${unique.map((m) => `${m.name} <${m.address}>`).join(", ")}. ` +
      `Ask the user which one, or call again with "to" set to the exact address.`,
  };
};

// --- Mail and Notes ----------------------------------------------------------------------

const SEND_MAIL = `on run argv
  set {addr, subj, bod} to {item 1 of argv, item 2 of argv, item 3 of argv}
  tell application id "com.apple.mail"
    set m to make new outgoing message with properties {subject:subj, content:bod, visible:false}
    tell m to make new to recipient at end of to recipients with properties {address:addr}
    send m
  end tell
  return "sent"
end run`;

export const sendMail = (to: string, subject: string, body: string): Promise<string> =>
  osascriptArgv(SEND_MAIL, [to, subject, body], 60_000);

const CREATE_NOTE = `on run argv
  tell application id "com.apple.Notes" to make new note with properties {name:(item 1 of argv), body:(item 2 of argv)}
  return "created"
end run`;

export const createNote = (title: string, body: string): Promise<string> => osascriptArgv(CREATE_NOTE, [title, body]);

export type MessageService = "iMessage" | "RCS" | "SMS";

/**
 * Which service to send over, in the order to try them.
 *
 * Messages will "send" an iMessage to a number that no longer has iMessage — it reports
 * success and the message is never delivered. Observed: a contact who had moved off
 * iMessage got nothing, while the user's own text to him from the iPhone went out as RCS
 * and arrived. Delivery status cannot be read back (that needs Full Disk Access to
 * chat.db, which this deliberately does not ask for), so the choice has to be right up front.
 *
 * The signal that is available: the conversations Messages already has. A text-message
 * (RCS or SMS) conversation with this number means the phone has already learned that a
 * green bubble is how to reach it, so that wins over iMessage. Getting it wrong in that
 * direction costs a green bubble to someone who does have iMessage — still delivered — where
 * getting it wrong the other way costs the message. With no history, iMessage first, as
 * Messages itself does. An explicit `via` from the user overrides all of it.
 */
export const serviceOrder = (
  chats: { handle: string; service: string }[],
  handle: string,
  via?: null | string,
): MessageService[] => {
  const all: MessageService[] = ["iMessage", "RCS", "SMS"];
  const wanted = String(via ?? "").trim().toLowerCase();
  if (wanted === "imessage") return ["iMessage"];
  if (wanted === "rcs") return ["RCS", "SMS"];
  if (wanted === "sms" || wanted === "text" || wanted === "text message") return ["SMS", "RCS"];
  const key = (h: string): string => (isEmail(h) ? h.trim().toLowerCase() : h.replace(/\D/g, "").slice(-10));
  const seen = new Set(chats.filter((c) => key(c.handle) === key(handle)).map((c) => c.service.toLowerCase()));
  if (seen.has("rcs")) return ["RCS", "SMS", "iMessage"];
  if (seen.has("sms")) return ["SMS", "RCS", "iMessage"];
  return all;
};

/** Every one-to-one conversation's service and handle, as "service<TAB>handle" lines. */
const MESSAGE_CHATS = `on run argv
  set out to ""
  tell application id "com.apple.MobileSMS"
    repeat with c in chats
      try
        set svcName to (service type of account of c) as text
        repeat with pp in participants of c
          set out to out & svcName & tab & (handle of pp) & linefeed
        end repeat
      end try
    end repeat
  end tell
  return out
end run`;

export const messageChats = async (): Promise<{ handle: string; service: string }[]> =>
  (await osascriptArgv(MESSAGE_CHATS, []))
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length === 2 && parts[1].trim())
    .map(([service, handle]) => ({ handle: handle.trim(), service: service.trim() }));

/**
 * Send over the first service in `order` that the Mac has an account for and that accepts
 * the message. RCS and SMS go out through a paired iPhone (Text Message Forwarding); a Mac
 * without one simply has no such account and moves on down the list.
 */
const SEND_MESSAGE = `on run argv
  -- Variable names are deliberately unlike any dictionary term: "handle" is a property of a
  -- Messages participant, and a variable called "kind" already broke the Contacts lookup.
  set {targetHandle, msgText, orderText} to {item 1 of argv, item 2 of argv, item 3 of argv}
  set AppleScript's text item delimiters to ","
  set wantedServices to text items of orderText
  set AppleScript's text item delimiters to ""
  set failures to ""
  tell application id "com.apple.MobileSMS"
    repeat with svcName in wantedServices
      set svcName to svcName as text
      try
        if svcName is "iMessage" then
          set svc to 1st account whose service type = iMessage
        else if svcName is "RCS" then
          set svc to 1st account whose service type = RCS
        else
          set svc to 1st account whose service type = SMS
        end if
        send msgText to participant targetHandle of svc
        return svcName
      on error errText
        set failures to failures & svcName & ": " & errText & "; "
      end try
    end repeat
  end tell
  error "could not send (" & failures & ")"
end run`;

export const sendMessage = (handle: string, text: string, order: MessageService[]): Promise<string> =>
  osascriptArgv(SEND_MESSAGE, [handle, text, order.join(",")], 60_000);

// --- Did the user ask for this? ----------------------------------------------------------

export type DirectedAction = "create_event" | "create_note" | "create_reminder" | "send_mail" | "send_message";

/**
 * A verb preceded, within a few words, by one of these is being asked ABOUT, not asked FOR:
 * "did Jeff send me an email", "if Sarah emails", "when is the meeting I scheduled". Missing
 * a real request costs one approval tap; mistaking a question for a request sends an email
 * nobody asked for, so the reading errs toward the question.
 */
const QUESTION_LEAD = /\b(did|does|do|has|have|had|was|were|is|are|if|whether|when|why|who|what|which)\b(\s+\S+){0,3}\s*$/i;

/** The goal in sentences, so a verb in one sentence can't borrow a noun from another. */
const sentences = (goal: string): string[] =>
  String(goal ?? "")
    .split(/(?<=[.!?;\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Positions of imperative uses of `verb` in a sentence — those not led by a question word. */
const imperatives = (sentence: string, verb: RegExp): number[] => {
  const out: number[] = [];
  for (const m of sentence.matchAll(new RegExp(verb.source, "gi"))) {
    const at = m.index ?? 0;
    if (!QUESTION_LEAD.test(sentence.slice(0, at))) out.push(at + m[0].length);
  }
  return out;
};

/**
 * Lower-cased words, with the punctuation that ENDS a word stripped. The character class has
 * to admit "." and "@" so an address survives as one token, which also let a sentence's own
 * full stop ride along: "…to Jeffrey Houser." became the word "houser." and no longer
 * matched the recipient "Houser" — so every request that ended on the name queued.
 */
const words = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9'@._+-]+/g) ?? []).map((w) => w.replace(/^[.'_+-]+|[.'_+-]+$/g, "")).filter(Boolean);

/**
 * Whether a recipient is named in `text`. An address must appear verbatim; a name must
 * appear whole — every part of "Jeff Houser" — so a model that expands the user's "Jeff"
 * into a full name it found elsewhere is not treated as having been told to.
 */
export const namesRecipient = (text: string, to: string): boolean => {
  const target = String(to ?? "").trim().toLowerCase();
  if (!target) return false;
  if (isEmail(target)) return text.toLowerCase().includes(target);
  // A phone number must appear as the same digits, however either side punctuated it.
  // Compared on the last ten digits, the same key pickAddress uses, so a country code on one
  // side and not the other ("(603) 555-0100" said, "+16035550100" passed) is still one number.
  const phone = asPhone(target);
  if (phone) return text.replace(/\D/g, "").includes(phone.replace(/\D/g, "").slice(-10));
  const have = new Set(words(text));
  const want = words(target).filter((w) => w.length > 1);
  return want.length > 0 && want.every((w) => have.has(w));
};

/**
 * The stretch after a send verb in which the recipient must appear: up to 120 characters,
 * and no further than the first condition or sequel. "Text me when Jeff replies" names Jeff
 * — but as the trigger, not the recipient; the person being texted is "me". Without the cut,
 * that sentence read as an instruction to text Jeff.
 */
const recipientWindow = (sentence: string, end: number): string =>
  sentence.slice(end, end + 120).split(/\b(when|whenever|if|after|before|once|until|while|because|unless|then)\b/i)[0];

const MAIL_VERB = /\b(send|write|compose|shoot|drop|e-?mail|mail)\b/;
const MAIL_NOUN = /\b(e-?mails?|mail)\b/i;
const MESSAGE_VERB = /\b(send|text|message|imessage)\b/;
const MESSAGE_NOUN = /\b(texts?|messages?|imessages?|sms)\b/i;
const EVENT_VERB = /\b(add|put|create|schedule|book|set up|make|block)\b/;
const EVENT_NOUN = /\b(calendar|event|meeting|appointment|call|lunch|dinner|breakfast|coffee)\b/i;
const REMINDER_VERB = /\b(remind me|add|set|create|make|put)\b/;
const NOTE_VERB = /\b(make|take|create|add|write|jot|save|put|start)\b/;

/**
 * Why the user's message counts as asking for this exact action, or null if it doesn't.
 * The reason is recorded in the audit log next to an action that ran without confirmation.
 */
export const directedBy = (action: string, args: any, goal: string): null | string => {
  for (const sentence of sentences(goal)) {
    switch (action) {
      case "send_mail": {
        if (!MAIL_NOUN.test(sentence)) break;
        // The recipient has to follow the verb, in the same sentence: "Send Jeff Houser an
        // email", "email jeff@example.com that…". 120 characters reaches past "an email to".
        for (const end of imperatives(sentence, MAIL_VERB)) {
          if (namesRecipient(recipientWindow(sentence, end), args?.to)) {
            return `the user asked to email ${String(args.to).trim()}`;
          }
        }
        break;
      }
      case "send_message": {
        // Same rule as email, for the same reason — it leaves the machine, to a person. And
        // the same shape: "text Jeff that…", "send Jeff a message saying…".
        if (!MESSAGE_NOUN.test(sentence)) break;
        for (const end of imperatives(sentence, MESSAGE_VERB)) {
          if (namesRecipient(recipientWindow(sentence, end), args?.to)) {
            return `the user asked to message ${String(args.to).trim()}`;
          }
        }
        break;
      }
      case "create_event":
        if (EVENT_NOUN.test(sentence) && imperatives(sentence, EVENT_VERB).length) return "the user asked to add this to their calendar";
        break;
      case "create_reminder":
        if (/\bremind me\b|\breminders?\b/i.test(sentence) && imperatives(sentence, REMINDER_VERB).length) {
          return "the user asked for this reminder";
        }
        break;
      case "create_note":
        if ((/\bnotes?\b/i.test(sentence) && imperatives(sentence, NOTE_VERB).length) || /\b(jot|note) (this |that |it )?down\b/i.test(sentence)) {
          return "the user asked for this note";
        }
        break;
    }
  }
  return null;
};
