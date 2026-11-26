/**
 * A project's page (PLAN-open-work section 15, R8): the shapes the server sends and the sentences the
 * clients say. `ProjectWords` in Models.swift mirrors these; test/project-screen.test.mjs holds them equal.
 * Who *agreed* to a decision is not recorded, so no sentence here ever says anyone agreed.
 */
import type { PersonMoment } from "./people.ts";

export interface ProjectDecided {
  claimId: number;
  moment: null | PersonMoment;
  present: string[];
  saidBy: null | string;
  text: string;
}

export interface ProjectOpen {
  claimId: number;
  last: null | PersonMoment;
  raisedIn: number;
  text: string;
  topic: null | string;
}

export interface ProjectRisk {
  claimId: number;
  namedBy: string[];
  text: string;
  times: number;
}

export interface ProjectWaiting {
  claimId: number;
  direction: "they-owe" | "unknown" | "you-owe";
  due: null | string;
  late: boolean;
  text: string;
  who: null | string;
}

export interface ProjectPage {
  decided: ProjectDecided[];
  meetings: number;
  open: ProjectOpen[];
  projectId: number;
  risks: ProjectRisk[];
  waiting: ProjectWaiting[];
}

const list = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const times = (n: number): string => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** "Said by Sam Whitfield, with Dana Ortiz and Lee Okafor there." */
export const saidLine = (saidBy: null | string, present: string[]): string => {
  const who = saidBy ? `Said by ${saidBy}` : "Speaker not recorded";
  return present.length ? `${who}, with ${list(present)} there.` : `${who}.`;
};

/** "Raised in 3 meetings, not settled." */
export const raisedLine = (n: number): string => (n === 1 ? "Raised once, not settled." : `Raised in ${n} meetings, not settled.`);

/** "Named 3 times, by Lee Okafor and Sam Whitfield." */
export const riskLine = (n: number, namedBy: string[]): string => `Named ${times(n)}${namedBy.length ? `, by ${list(namedBy)}` : ""}.`;

/** "You owe Lee Okafor", "You owe", "Sam owes you", "Sam owes someone". */
export const waitingLine = (direction: ProjectWaiting["direction"], who: null | string): string =>
  direction === "you-owe" ? (who ? `You owe ${who}` : "You owe") : direction === "they-owe" ? `${who ?? "Someone"} owes you` : `${who ?? "Someone"} owes someone`;
