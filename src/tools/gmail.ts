/**
 * gmail_search — read-only Gmail headers + snippets for a query (default: unread inbox).
 * Gated by policy.google.enabled. Needs a read-only token (npm run auth). Reversible.
 *
 * Output is tagged UNTRUSTED: email is written by other people and is hostile by default.
 * Only headers + Gmail's snippet are read, NEVER full bodies — a full body is the richest
 * prompt-injection surface, and a snippet is enough to triage.
 */
import { searchMessages, GoogleAuthError } from "../google/client.ts";
import { tagUntrusted } from "../audit.ts";
import { kvGet, kvSet } from "../memory/store.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

interface Args {
  query?: string;
  max?: number;
  /**
   * Only mail since the last time a search with this same key ran (at most the last 24 hours, and never
   * seen-twice at the edge: a 20 minute overlap). For a job that runs on a schedule, so the code, not
   * the model, decides what "new since last time" means.
   */
  sinceKey?: string;
}

const OVERLAP_MS = 20 * 60_000;
// The first run, and any run after a long gap (the Mini asleep, the schedule off for a weekend), looks back this far.
// It used to be 14 hours and 24 hours, which meant a backlog older than a day was never reviewed and a missed day
// was lost for good. A week bounds the work, and the watcher's own cap on changes per run bounds the effect.
const FIRST_WINDOW_MS = 7 * 86_400_000;
const MAX_WINDOW_MS = 7 * 86_400_000;

const sinceKeyOf = (key: string): string => `gmail:since:${key.replace(/[^a-z0-9_-]/gi, "").slice(0, 40)}`;

/** Gmail's `after:` takes epoch seconds. Reads the last-run stamp but does NOT move it: see `markSince`. */
export const sinceClause = (key: string, now: number = Date.now()): string => {
  const last = Number(kvGet(sinceKeyOf(key))?.value);
  const from = Number.isFinite(last) && last > 0 ? last - OVERLAP_MS : now - FIRST_WINDOW_MS;
  return `after:${Math.floor(Math.max(from, now - MAX_WINDOW_MS) / 1000)}`;
};

/**
 * Record that a search covering up to `now` succeeded. Only called after the search returned: stamping before it
 * meant a search that failed (a token problem, a timeout) still consumed the window, and every later run then saw
 * only mail newer than the failure, so a whole stretch of the inbox was silently never reviewed. A run that crashes
 * after the search repeats its window next time, which is harmless because what is done to a message is idempotent.
 */
export const markSince = (key: string, now: number = Date.now()): void => {
  kvSet(sinceKeyOf(key), String(now));
};

export const gmailSearch: Tool = {
  name: "gmail_search",
  // Mail, calendar, files and project sources stay local: once this has run, the rest of the run is pinned (src/sensitivity.ts).
  privateOutput: true,
  description: "Read Gmail message headers + snippets for a query, e.g. 'is:unread in:inbox' (read-only).",
  argsSchema: '{ "query"?: string, "max"?: number, "sinceKey"?: string }',
  classify: (a: Args): ClassifiedAction => ({
    reversibility: "reversible",
    target: "gmail",
    summary: `Read email: "${a?.query ?? "is:unread in:inbox"}"`,
  }),
  checkPolicy: (policy: Policy): PolicyDecision =>
    policy.google?.enabled
      ? { allowed: true, reason: "google reads enabled" }
      : { allowed: false, reason: "google reads are disabled in policy.json" },
  run: async (a: Args) => {
    try {
      const base = String(a?.query ?? "is:unread in:inbox");
      const searchedAt = Date.now();
      const clause = a?.sinceKey ? sinceClause(String(a.sinceKey), searchedAt) : "";
      const query = clause ? `${base} ${clause}` : base;
      const msgs = await searchMessages(query, Math.min(100, Number(a?.max ?? 10)));
      if (a?.sinceKey) markSince(String(a.sinceKey), searchedAt);
      // Say what was searched. "No matching messages" for a window read as "the inbox is clean", which it is not:
      // it only means nothing arrived in that window.
      const scope = clause ? `Searched mail received after ${new Date(Number(clause.slice(6)) * 1000).toLocaleString()} only; older mail in the inbox was not looked at. ` : "";
      if (!msgs.length) return `${scope}No matching messages${clause ? " in that window. This does not mean the inbox is empty or clean." : "."}`;
      // The Id is what gmail_triage acts on. "Mailing list: yes" means a List-Unsubscribe header,
      // which is how bulk mail tells on itself; a person's mail does not have one.
      const body = msgs
        .map((m) => `${m.id ? `Id: ${m.id}\n` : ""}From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}${m.listUnsubscribe ? "\nMailing list: yes" : ""}\n${m.snippet}`)
        .join("\n\n");
      return tagUntrusted("gmail", scope ? `${scope}\n\n${body}` : body);
    } catch (err) {
      if (err instanceof GoogleAuthError) return `NOT CONFIGURED: ${err.message}`;
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
