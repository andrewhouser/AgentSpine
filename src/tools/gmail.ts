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
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

interface Args {
  query?: string;
  max?: number;
}

export const gmailSearch: Tool = {
  name: "gmail_search",
  description: "Read Gmail message headers + snippets for a query, e.g. 'is:unread in:inbox' (read-only).",
  argsSchema: '{ "query"?: string, "max"?: number }',
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
      const msgs = await searchMessages(String(a?.query ?? "is:unread in:inbox"), Number(a?.max ?? 10));
      if (!msgs.length) return "No matching messages.";
      const body = msgs.map((m) => `From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n${m.snippet}`).join("\n\n");
      return tagUntrusted("gmail", body);
    } catch (err) {
      if (err instanceof GoogleAuthError) return `NOT CONFIGURED: ${err.message}`;
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
