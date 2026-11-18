/**
 * What the Settings screens are sent: the stored preferences, plus read-only facts that explain
 * them. One function for the web route, the iOS route and the iOS contract test, so the shape is
 * stated once.
 */
import { getPrefs, FLOOR_MINUTES } from "./prefs.ts";
import type { Prefs } from "./prefs.ts";
import { blockedReason } from "./watch/loop.ts";

export interface PrefsForClient extends Prefs {
  /** The watch loop never polls one watch more often than this. Shown, not changeable. */
  floorMinutes: number;
  /** Why flight tracking or drive watching cannot run yet, in words, or null if it can. */
  unavailable: { drive: null | string; flights: null | string };
}

export const prefsForClient = (): PrefsForClient => ({
  ...getPrefs(),
  floorMinutes: FLOOR_MINUTES,
  unavailable: { drive: blockedReason("drive"), flights: blockedReason("flight") },
});
