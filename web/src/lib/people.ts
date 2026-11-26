/**
 * The person page's shapes and its few sentences (PLAN-open-work section 15, R7). `PeopleWords` in
 * ios/AgentSpine/Core/Models.swift mirrors these, and test/people-screen.test.mjs holds them equal.
 * Everything else on the page is the server's: which way a promise runs, whether it is late.
 */
export interface PersonMoment {
  at: null | string;
  atMs: null | number;
  audio: boolean;
  meetingId: number;
  meetingTitle: string;
  quote: string;
  speaker: null | string;
}

export interface PersonOpenItem {
  claimId: number;
  direction: "they-owe" | "you-owe";
  due: null | string;
  inferred: boolean;
  late: boolean;
  moment: null | PersonMoment;
  text: string;
}

export interface PersonHeardItem {
  claimId: number;
  kind: string;
  moment: null | PersonMoment;
  reviewed: null | string;
  text: string;
}

export interface Person {
  aliases: string[];
  daysSince: null | number;
  heard: PersonHeardItem[];
  id: number;
  lastOneToOne: { at: string; meetingId: number; title: string } | null;
  name: string;
  nextOneToOne: { at: string; title: string } | null;
  onTeam: boolean;
  open: PersonOpenItem[];
}

export interface PersonRow {
  aliases: string[];
  daysSince: null | number;
  id: number;
  name: string;
  onTeam: boolean;
  theyOwe: number;
  youOwe: number;
}

const first = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** "You owe" or "Lee owes". */
export const directionLabel = (direction: PersonOpenItem["direction"], name: string): string =>
  direction === "you-owe" ? "You owe" : `${first(name)} owes`;

/** "Last 1:1 8 days ago", "Last 1:1 today", or "No 1:1 recorded". */
export const oneToOneLine = (daysSince: null | number): string =>
  daysSince === null ? "No 1:1 recorded" : daysSince === 0 ? "Last 1:1 today" : daysSince === 1 ? "Last 1:1 yesterday" : `Last 1:1 ${daysSince} days ago`;

/** The list row's counts: "You owe 2 · they owe 1", or "Nothing open". */
export const openCountLine = (youOwe: number, theyOwe: number): string =>
  youOwe + theyOwe === 0 ? "Nothing open" : `You owe ${youOwe} · they owe ${theyOwe}`;

/** "12:40 into the meeting", from milliseconds. */
export const atLine = (atMs: null | number): string => {
  if (atMs === null || atMs < 0) return "";
  const s = Math.floor(atMs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${h > 0 ? `${h}:${String(m).padStart(2, "0")}` : m}:${sec} into the meeting`;
};
