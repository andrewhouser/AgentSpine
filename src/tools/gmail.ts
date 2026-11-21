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
const FIRST_WINDOW_MS = 14 * 3_600_000;
const MAX_WINDOW_MS = 24 * 3_600_000;

/** Gmail's `after:` takes epoch seconds. Stamps the key as it reads it, so a crash cannot make a window repeat forever. */
export const sinceClause = (key: string, now: number = Date.now()): string => {
  const k = `gmail:since:${key.replace(/[^a-z0-9_-]/gi, "").slice(0, 40)}`;
  const last = Number(kvGet(k)?.value);
  const from = Number.isFinite(last) && last > 0 ? last - OVERLAP_MS : now - FIRST_WINDOW_MS;
  kvSet(k, String(now));
  return `after:${Math.floor(Math.max(from, now - MAX_WINDOW_MS) / 1000)}`;
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
      const query = a?.sinceKey ? `${base} ${sinceClause(String(a.sinceKey))}` : base;
      const msgs = await searchMessages(query, Math.min(100, Number(a?.max ?? 10)));
      if (!msgs.length) return "No matching messages.";
      // The Id is what gmail_triage acts on. "Mailing list: yes" means a List-Unsubscribe header,
      // which is how bulk mail tells on itself; a person's mail does not have one.
      const body = msgs
        .map((m) => `${m.id ? `Id: ${m.id}\n` : ""}From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}${m.listUnsubscribe ? "\nMailing list: yes" : ""}\n${m.snippet}`)
        .join("\n\n");
      return tagUntrusted("gmail", body);
    } catch (err) {
      if (err instanceof GoogleAuthError) return `NOT CONFIGURED: ${err.message}`;
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
