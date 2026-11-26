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

/** What `.env` allows, said once under the dial. */
export const envLine = (d: Pick<Dial, "allowed" | "env" | "envName" | "guard">): string => {
  const at = levelLabel(d.env);
  if (d.guard)
    return d.allowed.length === 1
      ? `${at} in .env (${d.envName}). A guard cannot be loosened from here.`
      : `.env (${d.envName}) keeps it at least ${at}. You can tighten it here.`;
  return d.allowed.length === 1
    ? `${at} in .env (${d.envName}). To turn it up, change it there and restart.`
    : `.env (${d.envName}) allows up to ${at}.`;
};
