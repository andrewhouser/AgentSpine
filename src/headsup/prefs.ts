/**
 * Heads-up preferences: which kinds you want, how many per morning, and when it must stay quiet.
 *
 * Stored in the database (not .env) because they are meant to be changed from the app, and read by
 * the planner, the morning job and the watch loop. The numbers' DEFAULTS live in rules.ts; this
 * only holds what you changed, and every read is clamped, so a bad value in storage can never make
 * the loop misbehave.
 *
 * What is deliberately NOT here: the 30 minute floor on watches. It exists to stop a mistake from
 * becoming a polling storm against a free-tier API, and a setting you can lower defeats that.
 */
import { kvGet, kvSet } from "../memory/store.ts";
import { DAILY_CAP, FAST_LOOP_FLOOR_MINUTES, inQuietHours, LEAD_DAYS, LOOKAHEAD_DAYS, QUIET_END_HOUR, QUIET_START_HOUR } from "./rules.ts";
import type { HeadsupKind } from "./rules.ts";

export const ALL_KINDS: HeadsupKind[] = ["anniversary", "appointment", "bill", "birthday", "flight", "recurring"];

export const MAX_DAILY_CAP = 10;
export const MAX_LEAD_STAGES = 3;
/** The kinds whose lead times can be changed. */
export const LEAD_KINDS: HeadsupKind[] = ALL_KINDS.filter((k) => k !== "recurring");

/** A lead-time list, or the sentence saying why not. Exact: nothing is sorted or trimmed for you. */
export const validLeadDays = (v: unknown): { error: string } | { ok: number[] } => {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_LEAD_STAGES)
    return { error: `give 1 to ${MAX_LEAD_STAGES} day counts` };
  const out: number[] = [];
  for (const d of v) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > LOOKAHEAD_DAYS)
      return { error: `each day count must be a whole number from 0 to ${LOOKAHEAD_DAYS}` };
    if (out.length && d >= out[out.length - 1]) return { error: "list the day counts from largest to smallest, with no repeats" };
    out.push(d);
  }
  return { ok: out };
};


export interface Prefs {
  dailyCap: number;
  /** A kind set to false is never offered. Existing watches keep running. */
  kinds: Record<string, boolean>;
  /**
   * Days before the event at which each kind is mentioned, largest first: the default list unless you
   * changed it. "recurring" has no list (it is one mention per series), so it is not here.
   */
  leadDays: Record<string, number[]>;
  /** Quiet from this hour (inclusive) to the end hour (exclusive), local. Equal hours mean no quiet hours. */
  quietEndHour: number;
  quietStartHour: number;
}

export const defaultPrefs = (): Prefs => ({
  dailyCap: DAILY_CAP,
  kinds: Object.fromEntries(ALL_KINDS.map((k) => [k, true])),
  leadDays: Object.fromEntries(LEAD_KINDS.map((k) => [k, [...LEAD_DAYS[k]]])),
  quietEndHour: QUIET_END_HOUR,
  quietStartHour: QUIET_START_HOUR,
});

const KEY = "headsup:prefs";

const int = (v: unknown, lo: number, hi: number): null | number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/** What is stored, merged over the defaults and clamped. Never throws, never returns something invalid. */
export const getPrefs = (): Prefs => {
  const out = defaultPrefs();
  try {
    const raw = JSON.parse(kvGet(KEY)?.value ?? "{}");
    const cap = int(raw?.dailyCap, 1, MAX_DAILY_CAP);
    const qs = int(raw?.quietStartHour, 0, 23);
    const qe = int(raw?.quietEndHour, 0, 23);
    if (cap !== null) out.dailyCap = cap;
    if (qs !== null) out.quietStartHour = qs;
    if (qe !== null) out.quietEndHour = qe;
    for (const k of ALL_KINDS) if (raw?.kinds?.[k] === false) out.kinds[k] = false;
    // A stored list that no longer validates is ignored, so the default stands.
    for (const k of LEAD_KINDS) {
      const v = raw?.leadDays?.[k] === undefined ? null : validLeadDays(raw.leadDays[k]);
      if (v && "ok" in v) out.leadDays[k] = v.ok;
    }
  } catch {
    /* corrupt storage means defaults */
  }
  return out;
};

/**
 * Apply a partial change. Anything invalid is refused with a sentence saying what is wrong, and
 * NOTHING is changed: half-applying a bad patch is how a setting ends up in a state nobody chose.
 */
export const updatePrefs = (patch: unknown): { error: string; ok: false } | { ok: true; prefs: Prefs } => {
  if (!patch || typeof patch !== "object") return { error: "send an object of settings to change", ok: false };
  const p = patch as Record<string, any>;
  const next = getPrefs();

  if (p.dailyCap !== undefined) {
    const n = int(p.dailyCap, 1, MAX_DAILY_CAP);
    if (n === null) return { error: `dailyCap must be a whole number from 1 to ${MAX_DAILY_CAP}`, ok: false };
    next.dailyCap = n;
  }
  for (const f of ["quietStartHour", "quietEndHour"] as const) {
    if (p[f] === undefined) continue;
    const n = int(p[f], 0, 23);
    if (n === null) return { error: `${f} must be a whole hour from 0 to 23`, ok: false };
    next[f] = n;
  }
  if (p.kinds !== undefined) {
    if (!p.kinds || typeof p.kinds !== "object") return { error: "kinds must be an object like { birthday: false }", ok: false };
    for (const [k, v] of Object.entries(p.kinds)) {
      if (!ALL_KINDS.includes(k as HeadsupKind)) return { error: `unknown kind "${k}"`, ok: false };
      if (typeof v !== "boolean") return { error: `kinds.${k} must be true or false`, ok: false };
      next.kinds[k] = v;
    }
  }
  if (p.leadDays !== undefined) {
    if (!p.leadDays || typeof p.leadDays !== "object" || Array.isArray(p.leadDays))
      return { error: "leadDays must be an object like { bill: [5, 1, 0] }", ok: false };
    for (const [k, v] of Object.entries(p.leadDays)) {
      if (!LEAD_KINDS.includes(k as HeadsupKind)) return { error: `"${k}" has no lead times to change`, ok: false };
      // null puts the default back.
      if (v === null) {
        next.leadDays[k] = [...LEAD_DAYS[k as HeadsupKind]];
        continue;
      }
      const r = validLeadDays(v);
      if ("error" in r) return { error: `leadDays.${k}: ${r.error}`, ok: false };
      next.leadDays[k] = r.ok;
    }
  }
  // Store only what differs from the default, so a later change to a shipped default still reaches you.
  const stored: Record<string, number[]> = {};
  for (const k of LEAD_KINDS) if (next.leadDays[k].join() !== LEAD_DAYS[k].join()) stored[k] = next.leadDays[k];
  kvSet(KEY, JSON.stringify({ ...next, leadDays: stored }));
  return { ok: true, prefs: next };
};

/** The lead times in force for a kind: yours, or the default. */
export const leadDaysFor = (kind: string): number[] => getPrefs().leadDays[kind] ?? (LEAD_DAYS as Record<string, number[]>)[kind] ?? [];

/** Whether this kind may be offered. */
export const kindEnabled = (kind: string): boolean => getPrefs().kinds[kind] !== false;

/** Quiet hours right now, by the stored preference. */
export const isQuietNow = (now: Date): boolean => {
  const p = getPrefs();
  return inQuietHours(now, p.quietStartHour, p.quietEndHour);
};

/** Read-only facts shown next to the settings. */
export const FLOOR_MINUTES = FAST_LOOP_FLOOR_MINUTES;
