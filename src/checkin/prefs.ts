/**
 * Which sources the check-in reads, as the owner set them (PLAN-open-work section 12, D1).
 *
 * A source switched off is not read at all: mail off means no Gmail request, not a request
 * whose answer is thrown away. The switches live in the `kv` table under a key no tool can
 * reach (`state_set` stores everything under `watch:`), and only the owner's own screens write
 * them, through `POST /api/checkin/sources`. Absent means on, so an install that never opens
 * the setting behaves exactly as it did before the setting existed.
 *
 * Mail is the only source that can start a notification (sources.ts). Switching it off
 * therefore silences the check-in, and every screen says so instead of leaving a timer that
 * quietly never speaks.
 */
import { kvGet, kvSet } from "../memory/store.ts";
import type { ItemKind } from "./sources.ts";

/** In the order the screens list them: what can start a push first. */
export const SOURCE_KINDS: readonly ItemKind[] = ["mail", "approval", "calendar", "task", "headsup"];

export type SourceSwitches = Record<ItemKind, boolean>;

const KEY = "checkin:sources";

export const ALL_ON: SourceSwitches = { approval: true, calendar: true, headsup: true, mail: true, task: true };

/** The stored switches. Anything unreadable or missing reads as on. */
export const sourceSwitches = (): SourceSwitches => {
  const out = { ...ALL_ON };
  try {
    const stored = JSON.parse(kvGet(KEY)?.value || "{}") as Record<string, unknown>;
    for (const k of SOURCE_KINDS) if (stored?.[k] === false) out[k] = false;
  } catch {
    /* a damaged row must not switch a source off by accident */
  }
  return out;
};

/** The kinds that are off, in screen order. */
export const offKinds = (s: SourceSwitches): ItemKind[] => SOURCE_KINDS.filter((k) => !s[k]);

/**
 * Change some switches. Only known sources and only real booleans: a body of `{"mail": "no"}`
 * is refused whole, because a setting that half-applied is worse than one that did not.
 */
export const setSourceSwitches = (patch: unknown): { error: string; ok: false } | { ok: true; sources: SourceSwitches } => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "send an object of source: true or false.", ok: false };
  const entries = Object.entries(patch as Record<string, unknown>);
  if (!entries.length) return { error: "name at least one source.", ok: false };
  const next = sourceSwitches();
  for (const [k, v] of entries) {
    if (!(SOURCE_KINDS as readonly string[]).includes(k)) return { error: `"${k}" is not a check-in source. The sources are ${SOURCE_KINDS.join(", ")}.`, ok: false };
    if (typeof v !== "boolean") return { error: `"${k}" must be true or false.`, ok: false };
    next[k as ItemKind] = v;
  }
  kvSet(KEY, JSON.stringify(next));
  return { ok: true, sources: next };
};

/** Tests only. */
export const resetSourcesForTests = (): void => kvSet(KEY, "");
