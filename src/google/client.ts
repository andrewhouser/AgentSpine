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

export interface MailHeader {
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
        `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    );
    const headers = Object.fromEntries(
      (msg.payload?.headers ?? []).map((h: any) => [h.name.toLowerCase(), h.value]),
    );
    out.push({
      from: headers.from ?? "?",
      subject: headers.subject ?? "(no subject)",
      date: headers.date ?? "",
      snippet: (msg.snippet ?? "").slice(0, 300),
    });
  }
  return out;
};
