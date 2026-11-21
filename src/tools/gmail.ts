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

/**
 * What a cleanup has already looked at. `sinceKey` used to mean "only mail newer than my last run", which is wrong for
 * a job whose point is to work through the inbox as it stands: mail older than the window was never reviewed, a window
 * lost to a failed run hid mail for good, and mail the job deliberately left alone had no second chance. It now means
 * "remember which messages I have reviewed". Each call takes the matching mail it has NOT reviewed, whatever its age,
 * and records the ones it returns, so a backlog is worked through over successive calls and the same mail is not
 * re-read every run. An id is forgotten after REVIEW_TTL_MS, so mail left alone, or skipped because a run crashed
 * after the search, is looked at again within a week.
 */
const REVIEW_TTL_MS = 7 * 86_400_000;
const MAX_REMEMBERED = 3000;

const seenKeyOf = (key: string): string => `gmail:reviewed:${key.replace(/[^a-z0-9_-]/gi, "").slice(0, 40)}`;

/** The ids reviewed within the last week, for this key. */
export const reviewedIds = (key: string, now: number = Date.now()): Set<string> => {
  try {
    const m = JSON.parse(kvGet(seenKeyOf(key))?.value ?? "{}") as Record<string, number>;
    return new Set(Object.keys(m).filter((id) => now - m[id] < REVIEW_TTL_MS));
  } catch {
    return new Set();
  }
};

/**
 * Record ids as reviewed. Called only after the search returned them, so a search that failed reviews nothing and a
 * retry sees the same mail. Expired entries are dropped here, and the set is capped so it cannot grow without bound.
 */
export const markReviewed = (key: string, ids: string[], now: number = Date.now()): void => {
  let m: Record<string, number> = {};
  try {
    m = JSON.parse(kvGet(seenKeyOf(key))?.value ?? "{}");
  } catch {
    m = {};
  }
  for (const id of Object.keys(m)) if (now - m[id] >= REVIEW_TTL_MS) delete m[id];
  for (const id of ids) m[id] = now;
  const keep = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, MAX_REMEMBERED);
  kvSet(seenKeyOf(key), JSON.stringify(Object.fromEntries(keep)));
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
      const now = Date.now();
      const skip = a?.sinceKey ? reviewedIds(String(a.sinceKey), now) : new Set<string>();
      const msgs = await searchMessages(base, Math.min(100, Number(a?.max ?? 10)), skip);
      if (a?.sinceKey) markReviewed(String(a.sinceKey), msgs.map((m) => m.id).filter(Boolean) as string[], now);
      // Say what was covered, so a summary can state it rather than guess. An empty result means nothing UNREVIEWED
      // matched, which is not the same as the inbox being empty.
      const scope = a?.sinceKey
        ? `Reviewing only mail not yet reviewed in the last 7 days (${msgs.skipped ?? 0} already-reviewed message(s) skipped${msgs.more ? `, ${msgs.more} more unreviewed after these; call again for the next batch` : ""}). `
        : "";
      if (!msgs.length) return `${scope}No matching messages${a?.sinceKey ? ": every matching message has already been reviewed" : ""}.`;
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
