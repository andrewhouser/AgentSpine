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
import { describeDate, saveApprovedDate } from "../headsup/dates.ts";
import { normalizeWho } from "../headsup/detect.ts";
import type { Occasion } from "../headsup/detect.ts";
import type { ClassifiedAction, PolicyDecision, Tool } from "../types.ts";

const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

interface Parsed {
  day: number;
  month: number;
  occasion: Occasion;
  who: string;
  year?: number;
}

const parse = (a: any): { error: string } | Parsed => {
  const occasion = a?.occasion === "anniversary" ? "anniversary" : a?.occasion === "birthday" ? "birthday" : null;
  if (!occasion) return { error: 'occasion must be "birthday" or "anniversary".' };
  const month = Number(a?.month);
  const day = Number(a?.day);
  if (!Number.isInteger(month) || month < 1 || month > 12) return { error: "month must be 1 to 12." };
  if (!Number.isInteger(day) || day < 1 || day > DAYS[month - 1]) return { error: `day ${day} is not a day of month ${month}.` };
  const raw = String(a?.who ?? "").trim().slice(0, 60);
  // "you two" is how the detector spells the anniversary of the two of you; anything else is
  // run through the same person check, so the tool cannot be used to store arbitrary text.
  const who = raw.toLowerCase() === "you two" ? "you two" : /^your /i.test(raw) ? normalizeWho(`my ${raw.slice(5)}`) : normalizeWho(raw);
  if (!who) return { error: "who must be a person's name or a relation like 'my wife'." };
  const year = Number(a?.year);
  return { day, month, occasion, who, ...(Number.isInteger(year) && year > 1900 && year < 2200 ? { year } : {}) };
};

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
  run: async (a) => {
    const p = parse(a);
    return "error" in p ? `ERROR: ${p.error}` : saveApprovedDate(p);
  },
};
