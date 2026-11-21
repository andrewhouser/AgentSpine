/**
 * Read-only Google client. No SDK — just fetch against the REST APIs, so every line that
 * touches your account is auditable here.
 *
 * The token this loads was minted with calendar.readonly + gmail.readonly. Those
 * credentials PHYSICALLY CANNOT send mail or change your calendar, whatever the model
 * tries. That boundary lives at Google's auth server, not in a prompt — the strongest
 * guarantee in the system, which is why the scopes must never be widened.
 *
 * Run `npm run auth` once to mint the token.
 */
import fs from "node:fs";
import { GOOGLE_TOKEN_PATH, loadGoogleCreds } from "../config.ts";

export class GoogleAuthError extends Error {}

const loadToken = (): any => {
  if (!fs.existsSync(GOOGLE_TOKEN_PATH))
    throw new GoogleAuthError("no Google token. Run `npm run auth` first.");
  return JSON.parse(fs.readFileSync(GOOGLE_TOKEN_PATH, "utf8"));
};

/** Exchange the stored refresh token for a short-lived access token. */
const accessToken = async (): Promise<string> => {
  const creds = loadGoogleCreds();
  if (!creds) throw new GoogleAuthError("Google client credentials not found.");
  const { refresh_token: refreshToken } = loadToken();
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
  if (!res.ok) throw new GoogleAuthError(`token refresh failed (HTTP ${res.status}). Re-run \`npm run auth\`.`);
  return (await res.json()).access_token;
};

const apiGet = async (url: string): Promise<any> => {
  const token = await accessToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new GoogleAuthError(`Google API HTTP ${res.status} for ${url}`);
  return res.json();
};

export interface CalEvent {
  start: string;
  title: string;
  attendees: number;
  location: string;
}

/** Upcoming calendar events within the next `hours`. Read-only. */
export const upcomingEvents = async (hours = 48, max = 20): Promise<CalEvent[]> => {
  const now = new Date();
  const later = new Date(now.getTime() + hours * 3_600_000);
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: later.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(max),
  });
  const data = await apiGet(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
  return (data.items ?? []).map((e: any) => ({
    start: e.start?.dateTime ?? e.start?.date ?? "",
    title: e.summary ?? "(no title)",
    attendees: (e.attendees ?? []).length,
    location: e.location ?? "",
  }));
};

/** A calendar the account can read, as `calendarList` reports it. */
export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
}

/**
 * One event with everything the heads-up scanner needs and `CalEvent` leaves out: a stable
 * id (for dedupe), the description (where "PAID" sometimes lives), whether it is all-day,
 * the series it belongs to, and which calendar it came from.
 */
export interface CalendarEvent {
  allDay: boolean;
  attendees: number;
  calendarId: string;
  calendarName: string;
  /** Free text from the event. UNTRUSTED: anyone who can invite you can write it. */
  description: string;
  end: string;
  /** Google's event type ("default", "birthday", "outOfOffice", ...). Empty if absent. */
  eventType: string;
  id: string;
  location: string;
  /** Set on every instance of a recurring event; identifies the series. */
  recurringEventId: string;
  start: string;
  /** "confirmed", "tentative" or "cancelled". */
  status: string;
  title: string;
}

/**
 * Raw Google event -> `CalendarEvent`. Pure, and exported so it can be tested against saved
 * payloads: the failures that matter here (a date-only start read as a timestamp, a missing
 * summary) are silent ones.
 */
export const mapCalendarEvent = (e: any, cal: CalendarInfo): CalendarEvent => ({
  allDay: !e.start?.dateTime && !!e.start?.date,
  attendees: (e.attendees ?? []).length,
  calendarId: cal.id,
  calendarName: cal.name,
  description: String(e.description ?? ""),
  end: e.end?.dateTime ?? e.end?.date ?? "",
  eventType: String(e.eventType ?? ""),
  id: String(e.id ?? ""),
  location: String(e.location ?? ""),
  recurringEventId: String(e.recurringEventId ?? ""),
  start: e.start?.dateTime ?? e.start?.date ?? "",
  status: String(e.status ?? "confirmed"),
  title: String(e.summary ?? "(no title)"),
});

/** Every calendar the account can read, including subscribed ones such as contact birthdays. */
export const listCalendars = async (): Promise<CalendarInfo[]> => {
  const out: CalendarInfo[] = [];
  let pageToken = "";
  // A handful of pages is far more calendars than anyone has; the cap is a runaway guard.
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({ minAccessRole: "reader", maxResults: "250" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await apiGet(`https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`);
    for (const c of data.items ?? [])
      out.push({
        id: String(c.id),
        // `summaryOverride` is the name the user gave it; `summary` is the owner's.
        name: String(c.summaryOverride ?? c.summary ?? c.id),
        primary: !!c.primary,
      });
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out;
};

/**
 * Events on one calendar between `from` and `to`, recurring series expanded to instances.
 * Read-only. Pages up to 4 x 250 events, which is well past any real calendar's month.
 */
export const eventsBetween = async (cal: CalendarInfo, from: Date, to: Date): Promise<CalendarEvent[]> => {
  const out: CalendarEvent[] = [];
  let pageToken = "";
  for (let page = 0; page < 4; page++) {
    const params = new URLSearchParams({
      maxResults: "250",
      orderBy: "startTime",
      singleEvents: "true",
      timeMax: to.toISOString(),
      timeMin: from.toISOString(),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await apiGet(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
    );
    for (const e of data.items ?? []) out.push(mapCalendarEvent(e, cal));
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out;
};

export interface MailHeader {
  /** Gmail's message id, needed to act on the message. Empty only in old fixtures. */
  id?: string;
  /** Gmail label ids ("INBOX", "UNREAD", "SENT", "STARRED", user labels). */
  labelIds?: string[];
  /** True when the message carries a List-Unsubscribe header: a mailing list, not a person. */
  listUnsubscribe?: boolean;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

/**
 * Message headers + snippets for a Gmail query (default: unread inbox). Read-only, and
 * deliberately NEVER the full body — a full body is the richest prompt-injection surface,
 * and a snippet is enough to triage what needs your attention.
 */
export const searchMessages = async (query = "is:unread in:inbox", max = 10): Promise<MailHeader[]> => {
  const params = new URLSearchParams({ q: query, maxResults: String(max) });
  const list = await apiGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`);
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);

  const out: MailHeader[] = [];
  for (const id of ids) {
    const msg = await apiGet(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata` +
        `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe`,
    );
    const headers = Object.fromEntries(
      (msg.payload?.headers ?? []).map((h: any) => [h.name.toLowerCase(), h.value]),
    );
    out.push({
      id,
      labelIds: msg.labelIds ?? [],
      listUnsubscribe: !!headers["list-unsubscribe"],
      from: headers.from ?? "?",
      subject: headers.subject ?? "(no subject)",
      date: headers.date ?? "",
      snippet: (msg.snippet ?? "").slice(0, 300),
    });
  }
  return out;
};

export interface SentMessage {
  date: string;
  id: string;
  subject: string;
  /** The text/plain body, undecoded from base64url and nothing else done to it. Quoted replies are still in it. */
  text: string;
  to: string;
}

/** The first text/plain part of a Gmail payload, depth first. Exported so a test can feed it a fixture. */
export const plainTextOf = (payload: any): string => {
  if (!payload) return "";
  if (String(payload.mimeType ?? "").toLowerCase() === "text/plain" && payload.body?.data)
    return Buffer.from(String(payload.body.data), "base64url").toString("utf8");
  for (const part of payload.parts ?? []) {
    const t = plainTextOf(part);
    if (t) return t;
  }
  return "";
};

/**
 * Full bodies of YOUR OWN sent mail, for learning a writing style (src/styles). This is the one place
 * a body is read, and it is narrower than the rule it relaxes (searchMessages: "never the full body"):
 *
 * - the search is forced to `in:sent`, and every message that comes back is checked for the SENT label
 *   too, because a query like `x OR in:inbox` could otherwise widen it;
 * - the token is the same read-only one, so nothing is sent, changed or deleted;
 * - nobody but src/styles/learn.ts calls it, and what it reads goes only to the local model.
 *
 * Sent mail is not free of hostile text (a forwarded message is someone else's), so the caller still
 * strips quoted blocks and wraps what is left with tagUntrusted.
 */
export const sentMessages = async (query = "", max = 40): Promise<SentMessage[]> => {
  const params = new URLSearchParams({ q: `in:sent ${query}`.trim(), maxResults: String(Math.min(100, Math.max(1, max))) });
  const list = await apiGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`);
  const out: SentMessage[] = [];
  for (const m of list.messages ?? []) {
    const msg = await apiGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`);
    if (!(msg.labelIds ?? []).includes("SENT")) continue;
    const headers = Object.fromEntries((msg.payload?.headers ?? []).map((h: any) => [String(h.name).toLowerCase(), h.value]));
    const text = plainTextOf(msg.payload);
    if (text.trim()) out.push({ date: headers.date ?? "", id: m.id, subject: headers.subject ?? "", text, to: headers.to ?? "" });
  }
  return out;
};
