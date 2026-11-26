/**
 * A person, as your meetings describe them (PLAN-open-work section 15, R7).
 *
 * Built in code from claims a person reviewed, never from a model and never from anything
 * collected about anyone on its own: what is open between you (each commitment's direction is
 * `directionOf` in store.ts), what you have heard lately, and your 1:1s. Claims marked sensitive
 * are left out, as briefs leave them out. There is no "evidence" store: you decided on 2026-11-26
 * to leave it out, so nothing here keeps notes about a person beyond what the meetings already keep.
 *
 * Work material: the routes that serve this hand it to your screens only, and no tool reads it.
 * Quotes and meeting titles are other people's words and are shown, never put into a prompt.
 */
import fs from "node:fs";

import { calendarEventsBetween } from "../calendar-cache.ts";
import { rawDb } from "../memory/store.ts";
import { audioPath } from "../meetings/audio.ts";
import * as k from "./store.ts";

/** How far back "heard lately" reaches, and how many rows it shows. */
export const HEARD_DAYS = 60;
export const HEARD_MAX = 20;
/** How far ahead the stored calendar is searched for the next 1:1. */
export const NEXT_ONE_TO_ONE_DAYS = 14;

export interface Moment {
  at: null | string;
  atMs: null | number;
  /** Whether the recording is still kept, so playback can be offered; otherwise show the transcript. */
  audio: boolean;
  meetingId: number;
  meetingTitle: string;
  quote: string;
  speaker: null | string;
}

export interface OpenItem {
  claimId: number;
  direction: "they-owe" | "you-owe";
  due: null | string;
  /** True when the direction was worked out, not set by a person: the screen offers to correct it. */
  inferred: boolean;
  late: boolean;
  moment: Moment | null;
  text: string;
}

export interface HeardItem {
  claimId: number;
  kind: string;
  moment: Moment | null;
  reviewed: null | string;
  text: string;
}

export interface Person {
  aliases: string[];
  daysSince: null | number;
  heard: HeardItem[];
  id: number;
  lastOneToOne: null | { at: string; meetingId: number; title: string };
  name: string;
  nextOneToOne: null | { at: string; title: string };
  onTeam: boolean;
  open: OpenItem[];
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

const meetingId = (c: k.Claim): null | number => {
  if (c.source_kind !== "meeting") return null;
  const id = Number(c.source_ref.split(":")[1]);
  return Number.isInteger(id) ? id : null;
};

const meetingRow = (id: number): undefined | { started: string; title: null | string } => {
  try {
    return rawDb.prepare("SELECT title, started FROM meetings WHERE id = ?").get(id) as undefined | { started: string; title: null | string };
  } catch {
    return undefined;
  }
};

const momentOf = (c: k.Claim): Moment | null => {
  const id = meetingId(c);
  if (id == null) return null;
  const m = meetingRow(id);
  return {
    at: m?.started ?? null,
    atMs: c.at_ms,
    audio: fs.existsSync(audioPath(id)),
    meetingId: id,
    meetingTitle: m?.title?.trim() || `meeting #${id}`,
    quote: c.passage,
    speaker: c.speaker,
  };
};

/** Reviewed, active, not sensitive: the only claims a person page is built from. */
const usable = (): k.Claim[] => k.reviewedActiveClaims();

/** The commitments open between you and `personId`, each with its direction. Pure over the claims given. */
export const openBetween = (personId: number, claims: k.Claim[], now: Date): OpenItem[] => {
  const out: OpenItem[] = [];
  for (const c of claims) {
    if (c.kind !== "commitment") continue;
    const d = k.directionOf(c);
    const mine = k.isSelfName(c.ownerName) || c.owner_id == null;
    let direction: null | OpenItem["direction"] = null;
    if (mine && d.owedToId === personId) direction = "you-owe";
    else if (c.owner_id === personId && !mine && (d.owedToMe || d.owedToId == null)) direction = "they-owe";
    if (!direction) continue;
    const due = c.due ? Date.parse(c.due) : NaN;
    out.push({
      claimId: c.id,
      direction,
      due: c.due,
      inferred: d.inferred,
      late: Number.isFinite(due) && due < now.getTime(),
      moment: momentOf(c),
      text: c.text,
    });
  }
  // What you owe first, then the oldest first within each: the order to work through before a 1:1.
  return out.sort((a, b) => (a.direction === b.direction ? a.claimId - b.claimId : a.direction === "you-owe" ? -1 : 1));
};

/** A 1:1: a meeting whose named speakers, other than you, are exactly this person. */
const oneToOnes = (personId: number): { at: string; meetingId: number; title: string }[] => {
  let rows: { id: number; started: string; title: null | string }[] = [];
  try {
    rows = rawDb.prepare("SELECT id, title, started FROM meetings ORDER BY started DESC LIMIT 500").all() as typeof rows;
  } catch {
    return [];
  }
  return rows
    .filter((m) => {
      const others = k.othersInMeeting("meeting", `meeting:${m.id}`);
      return others.length === 1 && others[0].id === personId;
    })
    .map((m) => ({ at: m.started, meetingId: m.id, title: m.title?.trim() || `meeting #${m.id}` }));
};

const ONE_TO_ONE_WORDS = /\b(1[:\-\s]?(on[\s-])?1|one[\s-]on[\s-]one)\b/i;

/** The next calendar event that names this person and reads as a 1:1. From the stored copy, never Google. */
const nextOneToOne = (p: k.Entity, now: Date): Person["nextOneToOne"] => {
  const names = [p.name, ...p.aliases, p.name.split(" ")[0]].map((n) => n.toLowerCase()).filter((n) => n.length > 1);
  const events = calendarEventsBetween(now, new Date(now.getTime() + NEXT_ONE_TO_ONE_DAYS * 86_400_000));
  const hit = events.find((e) => ONE_TO_ONE_WORDS.test(e.title) && names.some((n) => e.title.toLowerCase().includes(n)));
  return hit ? { at: hit.start, title: hit.title } : null;
};

const daysBetween = (fromIso: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / 86_400_000));

export const readPerson = (id: number, now: Date = new Date()): null | Person => {
  const p = k.getEntity(id);
  if (!p || p.kind !== "person") return null;
  const claims = usable();
  const names = [p.name, ...p.aliases].map((n) => n.toLowerCase());
  const since = now.getTime() - HEARD_DAYS * 86_400_000;
  const heard = claims
    .filter((c) => c.owner_id === id || (c.speaker != null && names.includes(c.speaker.trim().toLowerCase())))
    .filter((c) => Date.parse(c.reviewed ?? c.created) >= since)
    .sort((a, b) => Date.parse(b.reviewed ?? b.created) - Date.parse(a.reviewed ?? a.created))
    .slice(0, HEARD_MAX)
    .map((c) => ({ claimId: c.id, kind: c.kind, moment: momentOf(c), reviewed: c.reviewed, text: c.text }));
  const last = oneToOnes(id)[0] ?? null;
  return {
    aliases: p.aliases,
    daysSince: last ? daysBetween(last.at, now) : null,
    heard,
    id,
    lastOneToOne: last,
    name: p.name,
    nextOneToOne: nextOneToOne(p, now),
    onTeam: k.myTeamIds().has(id),
    open: openBetween(id, claims, now),
  };
};

/** Everyone the store names, your team first, then by name, with what is open each way. */
export const listPeople = (now: Date = new Date()): PersonRow[] => {
  const claims = usable();
  const team = k.myTeamIds();
  return k
    .listEntities("person")
    .filter((p) => !k.isSelfName(p.name))
    .map((p) => {
      const open = openBetween(p.id, claims, now);
      const last = team.has(p.id) ? (oneToOnes(p.id)[0] ?? null) : null;
      return {
        aliases: p.aliases,
        daysSince: last ? daysBetween(last.at, now) : null,
        id: p.id,
        name: p.name,
        onTeam: team.has(p.id),
        theyOwe: open.filter((o) => o.direction === "they-owe").length,
        youOwe: open.filter((o) => o.direction === "you-owe").length,
      };
    })
    .sort((a, b) => Number(b.onTeam) - Number(a.onTeam) || a.name.localeCompare(b.name));
};
