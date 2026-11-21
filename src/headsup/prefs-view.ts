/**
 * What the Settings screens are sent: the stored preferences, plus read-only facts that explain
 * them. One function for the web route, the iOS route and the iOS contract test, so the shape is
 * stated once.
 */
import { learningForClient } from "./outcomes.ts";
import type { KindLearning } from "./outcomes.ts";
import { getPrefs, FLOOR_MINUTES, LEAD_KINDS } from "./prefs.ts";
import type { Prefs } from "./prefs.ts";
import { LEAD_DAYS } from "./rules.ts";
import { blockedReason } from "./watch/loop.ts";

export interface PrefsForClient extends Prefs {
  /** The watch loop never polls one watch more often than this. Shown, not changeable. */
  floorMinutes: number;
  /** The shipped lead times, so a client can say "default" and offer to put them back. Read-only. */
  leadDaysDefault: Record<string, number[]>;
  /** Per kind over the last 90 days: how many were offered, how many you acted on, and where it stands. Read-only. */
  learning: KindLearning[];
  /** Why flight tracking or drive watching cannot run yet, in words, or null if it can. */
  unavailable: { drive: null | string; flights: null | string };
}

export const prefsForClient = (): PrefsForClient => ({
  ...getPrefs(),
  floorMinutes: FLOOR_MINUTES,
  leadDaysDefault: Object.fromEntries(LEAD_KINDS.map((k) => [k, [...LEAD_DAYS[k]]])),
  learning: learningForClient(),
  unavailable: { drive: blockedReason("drive"), flights: blockedReason("flight") },
});
