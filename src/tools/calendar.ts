/**
 * calendar_upcoming — read-only Google Calendar. Gated by policy.google.enabled. Needs a
 * read-only token (npm run auth). Reversible.
 */
import { upcomingEvents, GoogleAuthError } from "../google/client.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

interface Args {
  hours?: number;
  max?: number;
}

export const calendarUpcoming: Tool = {
  name: "calendar_upcoming",
  description: "List upcoming Google Calendar events (read-only).",
  argsSchema: '{ "hours"?: number, "max"?: number }',
  classify: (a: Args): ClassifiedAction => ({
    reversibility: "reversible",
    target: "calendar",
    summary: `Read calendar (next ${a?.hours ?? 48}h)`,
  }),
  checkPolicy: (policy: Policy): PolicyDecision =>
    policy.google?.enabled
      ? { allowed: true, reason: "google reads enabled" }
      : { allowed: false, reason: "google reads are disabled in policy.json" },
  run: async (a: Args) => {
    try {
      const events = await upcomingEvents(Number(a?.hours ?? 48), Number(a?.max ?? 20));
      if (!events.length) return "No upcoming events.";
      return events
        .map((e) => `- ${e.start}  ${e.title}${e.location ? ` @ ${e.location}` : ""}${e.attendees ? ` (${e.attendees} attendees)` : ""}`)
        .join("\n");
    } catch (err) {
      if (err instanceof GoogleAuthError) return `NOT CONFIGURED: ${err.message}`;
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
