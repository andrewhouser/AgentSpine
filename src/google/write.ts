/**
 * The only module that changes anything in Google. docs/SPEC.md section 5 (decision of 2026-11-21).
 *
 * It exists because the inbox cleanup has to archive, label, trash and mark spam, and create bill
 * events. It holds its own token (`npm run auth -- write`), separate from the read-only one that
 * everything else uses, so revoking it removes every write at once and leaves reads working.
 *
 * Since 2026-11-25 (SPEC section 5, third amendment, PLAN-open-work CP2) it can also save a Gmail DRAFT and put a
 * TIMED event, with no attendees, on a named calendar. A draft sits in Drafts until you send it yourself.
 *
 * What is deliberately NOT here, and must not be added without a new decision recorded in SPEC.md:
 *   - sending, replying or forwarding, including sending a saved draft (`drafts/send`). gmail.modify technically
 *     allows a send, so the guarantee is this file: there is no function that sends, and nothing else in the repo
 *     reads this token.
 *   - attendees on an event, and answering an invitation: both make Google email other people.
 *   - permanent deletion, and emptying the trash. Trash is recoverable for 30 days; a permanent
 *     delete is not.
 *   - deleting calendar events, or creating or renaming calendars.
 *   - changing Gmail settings or filters.
 *
 * The rules about WHICH messages may be touched (never the ones you have emailed, never something
 * not in the inbox) live in src/tools/gmail-triage.ts, in code, because the model is the party being
 * gated. This file only knows how to make the calls.
 */
import fs from "node:fs";
import { GOOGLE_WRITE_TOKEN_PATH, loadGoogleCreds } from "../config.ts";
import { GoogleAuthError } from "./client.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3/calendars";

const accessToken = async (): Promise<string> => {
  const creds = loadGoogleCreds();
  if (!creds) throw new GoogleAuthError("Google client credentials not found.");
  if (!fs.existsSync(GOOGLE_WRITE_TOKEN_PATH))
    throw new GoogleAuthError(`No write token at ${GOOGLE_WRITE_TOKEN_PATH}. Run \`npm run auth -- write\` on this machine.`);
  const { refresh_token: refreshToken } = JSON.parse(fs.readFileSync(GOOGLE_WRITE_TOKEN_PATH, "utf8"));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new GoogleAuthError(`write token refresh failed (HTTP ${res.status}). Re-run \`npm run auth -- write\`.`);
  return (await res.json()).access_token;
};

const call = async (method: "GET" | "PATCH" | "POST", url: string, body?: unknown): Promise<any> => {
  const token = await accessToken();
  const res = await fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    method,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new GoogleAuthError(`Google API HTTP ${res.status} for ${method} ${url.replace(/\?.*/, "")}`);
  return res.status === 204 ? {} : res.json();
};

const ID = /^[0-9a-f]{8,32}$/i;
const assertId = (id: string): string => {
  if (!ID.test(id)) throw new Error(`not a Gmail message id: ${JSON.stringify(String(id).slice(0, 40))}`);
  return id;
};

// ---- Gmail ----------------------------------------------------------------------------------

export interface MessageInfo {
  from: string;
  id: string;
  labelIds: string[];
  subject: string;
}

/** Labels and sender of one message, with the write token (so the check and the change share an identity). */
export const messageInfo = async (id: string): Promise<MessageInfo> => {
  const m = await call("GET", `${GMAIL}/messages/${assertId(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
  const h = Object.fromEntries((m.payload?.headers ?? []).map((x: any) => [String(x.name).toLowerCase(), String(x.value)]));
  return { from: h.from ?? "", id, labelIds: m.labelIds ?? [], subject: h.subject ?? "" };
};

const modify = async (id: string, add: string[], remove: string[]): Promise<any> =>
  call("POST", `${GMAIL}/messages/${assertId(id)}/modify`, { addLabelIds: add, removeLabelIds: remove });

/** Take it out of the inbox. It stays in All Mail. */
export const archiveMessage = (id: string): Promise<any> => modify(id, [], ["INBOX"]);

/** Move to Trash. Recoverable for 30 days. This is the only removal there is. */
export const trashMessage = async (id: string): Promise<any> => call("POST", `${GMAIL}/messages/${assertId(id)}/trash`);

/** Report as spam and take out of the inbox. */
export const spamMessage = (id: string): Promise<any> => modify(id, ["SPAM"], ["INBOX"]);

export const addLabels = (id: string, labelIds: string[]): Promise<any> => modify(id, labelIds, []);
export const removeLabels = (id: string, labelIds: string[]): Promise<any> => modify(id, [], labelIds);

/** A header value with its line breaks removed, so text that came from an email cannot add a header of its own. */
const headerValue = (v: unknown): string => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

/** A subject in plain ASCII as is, anything else as an RFC 2047 encoded word, which every client reads. */
const encodeSubject = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

export interface NewDraft {
  body: string;
  /** The Gmail id of the message this answers. The draft then joins that conversation, threaded as a reply. */
  replyTo?: string;
  subject: string;
  to: string;
}

/**
 * Save a draft in Gmail's Drafts folder. Nothing is sent: the draft waits there for you to open and send it, or
 * delete it. A reply is threaded by the original's Message-ID, read here with the same token.
 */
export const createDraft = async (d: NewDraft): Promise<{ id: string; threaded: boolean }> => {
  let threadId = "";
  const extra: string[] = [];
  if (d.replyTo) {
    const m = await call("GET", `${GMAIL}/messages/${assertId(d.replyTo)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);
    const h = Object.fromEntries((m.payload?.headers ?? []).map((x: any) => [String(x.name).toLowerCase(), String(x.value)]));
    threadId = String(m.threadId ?? "");
    const msgId = headerValue(h["message-id"]);
    if (msgId) extra.push(`In-Reply-To: ${msgId}`, `References: ${headerValue([h.references, msgId].filter(Boolean).join(" "))}`);
  }
  const raw = [
    `To: ${headerValue(d.to)}`,
    `Subject: ${encodeSubject(headerValue(d.subject))}`,
    ...extra,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    String(d.body ?? ""),
  ].join("\r\n");
  const created = await call("POST", `${GMAIL}/drafts`, {
    message: { raw: Buffer.from(raw, "utf8").toString("base64url"), ...(threadId ? { threadId } : {}) },
  });
  return { id: String(created.id), threaded: Boolean(threadId) };
};

const LABEL_NAME = /^[A-Za-z0-9][A-Za-z0-9 _/-]{0,39}$/;

/** The id of a user label, creating it if it does not exist. System labels cannot be created or renamed here. */
export const ensureLabel = async (name: string): Promise<string> => {
  if (!LABEL_NAME.test(name)) throw new Error("label names are letters, digits, spaces, _ - / and at most 40 characters");
  const list = await call("GET", `${GMAIL}/labels`);
  const found = (list.labels ?? []).find((l: any) => String(l.name).toLowerCase() === name.toLowerCase());
  if (found) {
    if (found.type === "system") throw new Error(`"${name}" is a Gmail system label`);
    return found.id;
  }
  const created = await call("POST", `${GMAIL}/labels`, { labelListVisibility: "labelShow", messageListVisibility: "show", name });
  return created.id;
};

// ---- Calendar -------------------------------------------------------------------------------

export interface NewAllDayEvent {
  date: string; // YYYY-MM-DD
  description: string;
  /** Days before the date for the email reminder. */
  remindDaysBefore: number;
  title: string;
}

const nextDay = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Create an all-day event with one email reminder. The calendar must already exist; this never creates one. */
export const createAllDayEvent = async (calendarId: string, e: NewAllDayEvent): Promise<{ id: string }> => {
  const created = await call("POST", `${CAL}/${encodeURIComponent(calendarId)}/events`, {
    description: e.description,
    end: { date: nextDay(e.date) },
    reminders: { overrides: [{ method: "email", minutes: Math.round(e.remindDaysBefore * 1440) }], useDefault: false },
    start: { date: e.date },
    summary: e.title,
  });
  return { id: String(created.id) };
};

export interface NewTimedEvent {
  description?: string;
  location?: string;
  minutes: number;
  /** Local wall time, YYYY-MM-DDTHH:MM, read in `timeZone`. */
  start: string;
  timeZone: string;
  title: string;
}

const TIMED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** A wall-clock time plus minutes, still as wall-clock time: both ends are read in the same time zone. */
const addMinutes = (start: string, minutes: number): string => {
  const d = new Date(`${start}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 16);
};

/**
 * Put a timed event on a calendar. There is no attendees field and Google is told to send no updates, because an
 * attendee gets an invitation email, which is a send. The calendar must already exist; this never creates one.
 */
export const createTimedEvent = async (calendarId: string, e: NewTimedEvent): Promise<{ id: string }> => {
  if (!TIMED.test(e.start)) throw new Error("an event needs a start like 2026-12-02T15:00");
  const minutes = Math.max(5, Math.min(12 * 60, Math.round(e.minutes)));
  const created = await call("POST", `${CAL}/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, {
    ...(e.description ? { description: e.description } : {}),
    end: { dateTime: `${addMinutes(e.start, minutes)}:00`, timeZone: e.timeZone },
    ...(e.location ? { location: e.location } : {}),
    start: { dateTime: `${e.start}:00`, timeZone: e.timeZone },
    summary: e.title,
  });
  return { id: String(created.id) };
};

/** Change an existing event's title, date or description. Anything left out is left alone. */
export const updateEvent = async (
  calendarId: string,
  eventId: string,
  patch: { date?: string; description?: string; title?: string },
): Promise<void> => {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.summary = patch.title;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.date !== undefined) {
    body.start = { date: patch.date };
    body.end = { date: nextDay(patch.date) };
  }
  await call("PATCH", `${CAL}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, body);
};
