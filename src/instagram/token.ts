/**
 * The Instagram access token: the only file that knows where it lives.
 *
 * Same handling as the Google tokens. It sits outside the repo in the config directory, mode
 * 0600, and nothing but this module names the path (test/architecture.test.mjs pins that).
 * It is never written to policy.json, the database, a queue row, an error message or a log
 * line: callers get the string to put in an Authorization header and nothing else gets it.
 *
 * A long-lived token lasts 60 days and can be refreshed once it is a day old, for another 60.
 * One that is allowed to lapse cannot be refreshed and has to be generated again by hand, which
 * is why `tokenState` exists: the runner refreshes early and the digest warns before the end.
 */
import fs from "node:fs";
import path from "node:path";
import { INSTAGRAM_TOKEN_PATH } from "../config.ts";
import { TOKEN_MIN_AGE_MS, TOKEN_REFRESH_AFTER_MS } from "./rules.ts";

export interface StoredToken {
  access_token: string;
  /** When this token was issued or last refreshed, ISO. */
  obtained_at: string;
  /** ISO, or null when Meta did not say (a token pasted from the App Dashboard). */
  expires_at: null | string;
  /** The account it was verified against when it was saved. */
  user_id?: string;
  username?: string;
}

export const readToken = (): null | StoredToken => {
  try {
    const t = JSON.parse(fs.readFileSync(INSTAGRAM_TOKEN_PATH, "utf8")) as StoredToken;
    return typeof t?.access_token === "string" && t.access_token ? t : null;
  } catch {
    return null;
  }
};

export const saveToken = (t: StoredToken): void => {
  fs.mkdirSync(path.dirname(INSTAGRAM_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(INSTAGRAM_TOKEN_PATH, JSON.stringify(t, null, 2), { mode: 0o600 });
  // writeFileSync only applies the mode when it creates the file; a refresh rewrites one that exists.
  fs.chmodSync(INSTAGRAM_TOKEN_PATH, 0o600);
};

export interface TokenState {
  daysLeft: null | number;
  expired: boolean;
  present: boolean;
  /** Old enough to refresh and due for it. */
  refreshDue: boolean;
  username: null | string;
}

/** What can be said about the token without showing it. */
export const tokenState = (now: Date = new Date()): TokenState => {
  const t = readToken();
  if (!t) return { daysLeft: null, expired: false, present: false, refreshDue: false, username: null };
  const expires = t.expires_at ? Date.parse(t.expires_at) : NaN;
  const obtained = Date.parse(t.obtained_at);
  const age = Number.isNaN(obtained) ? Infinity : now.getTime() - obtained;
  const daysLeft = Number.isNaN(expires) ? null : Math.floor((expires - now.getTime()) / 86_400_000);
  const expired = !Number.isNaN(expires) && expires <= now.getTime();
  return {
    daysLeft,
    expired,
    present: true,
    refreshDue: !expired && age >= TOKEN_MIN_AGE_MS && age >= TOKEN_REFRESH_AFTER_MS,
    username: t.username ?? null,
  };
};

/** The bearer string for a request, or null when there is none or it has run out. */
export const bearer = (now: Date = new Date()): null | string => {
  const t = readToken();
  if (!t) return null;
  if (t.expires_at && Date.parse(t.expires_at) <= now.getTime()) return null;
  return t.access_token;
};
