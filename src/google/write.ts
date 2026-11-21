/**
 * The only module that changes anything in Google. docs/SPEC.md section 5 (decision of 2026-11-21).
 *
 * It exists because the inbox cleanup has to archive, label, trash and mark spam, and create bill
 * events. It holds its own token (`npm run auth -- write`), separate from the read-only one that
 * everything else uses, so revoking it removes every write at once and leaves reads working.
 *
 * What is deliberately NOT here, and must not be added without a new decision recorded in SPEC.md:
 *   - sending, replying or forwarding. gmail.modify technically allows a send, so the guarantee is
 *     this file: there is no function that sends, and nothing else in the repo reads this token.
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
