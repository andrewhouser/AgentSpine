/**
 * The sentences on the trust dials screen (PLAN-open-work section 15, R3). Pure, so the web, the
 * iPhone and the Mac say the same thing: `DialWords` in ios/AgentSpine/Core/Models.swift mirrors
 * these, and test/dials-screen.test.mjs runs one list of cases through both.
 */
export type DialLevel = "off" | "on" | "watch";

export interface DialAgreement {
  agreed: number;
  days: number;
  of: number;
}

export interface Dial {
  agreement?: DialAgreement;
  allowed: DialLevel[];
  env: DialLevel;
  envName: string;
  /** How `.env` spells each level ("log", "push", "true"). Missing from a server older than 2026-11-27. */
  envValues?: Partial<Record<DialLevel, string>>;
  feature: string;
  guard: boolean;
  hint: string;
  label: string;
  levels: DialLevel[];
  mode: DialLevel;
}

export interface WouldHave {
  action: string;
  at: string;
  detail: string;
  feature: string;
  key: string;
  subject: string;
  thumbsDown: boolean;
}

export const levelLabel = (level: DialLevel): string => (level === "off" ? "Off" : level === "watch" ? "Watch" : "On");

const days = (n: number): string => (n === 1 ? "today" : `the last ${n} days`);

/** "You agreed with 17 of 19, the last 7 days." Arithmetic from the server; this only words it. */
export const agreementLine = (a: DialAgreement): string =>
  a.of === 0 ? `Nothing to judge from ${days(a.days)}.` : `You agreed with ${a.agreed} of ${a.of}, ${days(a.days)}.`;

/** The levels `.env` keeps this dial from taking: above a feature's ceiling, below a guard's floor. */
export const lockedLevels = (d: Pick<Dial, "allowed" | "levels">): DialLevel[] => d.levels.filter((l) => !d.allowed.includes(l));

const list = (words: string[]): string => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

/**
 * What `.env` allows, said once under the dial. A locked level names the exact line that would
 * unlock it, because "change it there" left Andrew trying the screen again (2026-11-27): the
 * ceiling is on purpose (R3), so the screen's job is to say where the switch really is.
 */
export const envLine = (d: Pick<Dial, "allowed" | "env" | "envName" | "envValues" | "guard" | "levels">): string => {
  const at = levelLabel(d.env);
  const locked = lockedLevels(d);
  const spell = d.envValues;
  if (locked.length > 0 && spell) {
    const now = spell[d.env] ? `${d.envName}=${spell[d.env]}` : d.envName;
    const which = list(locked.map(levelLabel));
    const verb = locked.length === 1 ? "is" : "are";
    const pairs = locked.map((l) => `${d.envName}=${spell[l] ?? "?"} for ${levelLabel(l)}`).join(" or ");
    const fix = `To allow ${locked.length === 1 ? "it" : "them"}, set ${pairs} in .env on the server and restart.`;
    return d.guard
      ? `${at} is the least .env allows (${now}), so ${which} ${verb} locked: a guard cannot be loosened from here. ${fix}`
      : `${at} is the most .env allows (${now}), so ${which} ${verb} locked. ${fix}`;
  }
  if (d.guard)
    return d.allowed.length === 1
      ? `${at} in .env (${d.envName}). A guard cannot be loosened from here.`
      : `.env (${d.envName}) keeps it at least ${at}. You can tighten it here.`;
  return d.allowed.length === 1
    ? `${at} in .env (${d.envName}). To turn it up, change it there and restart.`
    : `.env (${d.envName}) allows up to ${at}.`;
};

/** The tooltip and accessibility hint on a locked level's button. */
export const lockedHint = (d: Pick<Dial, "envName" | "envValues">, level: DialLevel): string => {
  const value = d.envValues?.[level];
  return value ? `Locked by .env. Set ${d.envName}=${value} on the server and restart.` : `Locked by ${d.envName} in .env.`;
};
