/**
 * date_remember: keep a birthday or anniversary so Heads-up can mention it ahead of time.
 *
 * Irreversible-tier on purpose. It writes something future unattended runs act on (the morning
 * heads-up reads it), which is the same category as scheduling, so it always goes through the
 * confirmation queue, from a chat or from a scheduled run alike (`confirmWhenUnattended`). The
 * chat detector in src/headsup/dates.ts queues the same call itself; this tool exists so the
 * assistant can do it too when you say "remember Garrett's birthday is March 4" in words the
 * detector does not catch, and so approving the queued call has something to run.
 */
import { describeDate, parseDateArgs, saveApprovedDate } from "../headsup/dates.ts";
import type { ClassifiedAction, PolicyDecision, Tool } from "../types.ts";

// One reading of the fields, shared with the edit route (src/headsup/dates.ts).
const parse = parseDateArgs;

export const dateRemember: Tool = {
  name: "date_remember",
  confirmWhenUnattended: true,
  description:
    "Remember a recurring birthday or anniversary so Heads-up can mention it ahead of time each year. Use when the " +
    "user tells you someone's birthday or their anniversary. It is QUEUED for their approval, so say it is proposed, " +
    "not saved. Dates already on their calendar are handled automatically and do not need this.",
  argsSchema: '{ "who": string, "occasion": "birthday" | "anniversary", "month": 1-12, "day": 1-31, "year"?: number }',
  classify: (a): ClassifiedAction => {
    const p = parse(a);
    return {
      reversibility: "irreversible",
      summary:
        "error" in p
          ? `REMEMBER A DATE (invalid: ${p.error})`
          : `REMEMBER A DATE: ${describeDate(p)}.\nHeads-up will mention it ahead of time each year until you remove it on the Heads-up page.`,
      target: "headsup-date",
    };
  },
  checkPolicy: (): PolicyDecision => ({ allowed: true, reason: "local only, and always queued for approval" }),
  run: async (a, ctx) => {
    const p = parse(a);
    return "error" in p ? `ERROR: ${p.error}` : saveApprovedDate(p, ctx?.runId);
  },
};
