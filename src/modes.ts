/**
 * Trust dials: Off, Watch or On for each feature, from a screen (PLAN-open-work section 15, R3).
 *
 * Before this, a feature's mode was a line in `.env` and a restart. The dials keep `.env` and put a
 * second, smaller setting on top of it, kept in `modes.json` at the root. The rules, decided
 * 2026-11-26 before any of this was built:
 *
 *   - **A feature's `.env` value is its ceiling.** A dial turns a feature down (On to Watch to Off)
 *     and back up as far as `.env` allows, never past it. Going higher is still an edit to `.env`
 *     and a restart, so a screen can never switch on something nobody switched on on purpose
 *     (the inbox sort, for one, should not pass Off until its injection eval has run: config.ts).
 *   - **A guard's `.env` value is its floor.** The outgoing-text check and the notification limits
 *     only stop things, so a dial may turn them on and never below what `.env` says.
 *   - **No tool and no run writes a mode.** `modes.json` is a control file beside `policy.json`:
 *     `write_file` refuses it and `keepingProtected` puts it back after a command. The only writer is
 *     `setMode`, called by the dashboard route, which is a person's click.
 *
 * A missing, unreadable or malformed file means "no dial has been moved", which is exactly the
 * behaviour before this file existed. Read on every call: the file is a few bytes, and a change
 * from the screen must reach the broker's next call without a restart.
 */
import fs from "node:fs";
import path from "node:path";

import { CHECKIN_MODE, HEADSUP_ENABLED, INBOX_SORT_MODE, MODES_PATH, OUTBOX_ENFORCE, OUTGOING_ENFORCE } from "./config.ts";

export type Level = "off" | "on" | "watch";
export type Feature = "checkin" | "headsup" | "inbox-sort" | "outbox" | "outgoing";

const RANK: Record<Level, number> = { off: 0, on: 2, watch: 1 };

interface Spec {
  /** What `.env` says, as a level. */
  env: () => Level;
  envName: string;
  feature: Feature;
  /** A guard only tightens from a screen; a feature only loosens as far as `.env`. */
  guard: boolean;
  hint: string;
  label: string;
  /** The levels this feature has at all, lowest first. */
  levels: Level[];
}

const fromMode = (m: string): Level => (m === "log" ? "watch" : m === "off" ? "off" : "on");

export const SPECS: readonly Spec[] = [
  { env: () => fromMode(CHECKIN_MODE), envName: "CHECKIN_MODE", feature: "checkin", guard: false, hint: "New mail from people, every few hours", label: "Check-in", levels: ["off", "watch", "on"] },
  { env: () => fromMode(INBOX_SORT_MODE), envName: "INBOX_SORT_MODE", feature: "inbox-sort", guard: false, hint: "Sorts mail into urgent, reply today and FYI", label: "Inbox sort", levels: ["off", "watch", "on"] },
  // Heads-up has no log-only mode of its own, so its dial is Off or On.
  { env: () => (HEADSUP_ENABLED ? "on" : "off"), envName: "HEADSUP_ENABLED", feature: "headsup", guard: false, hint: "Birthdays, bills and trips", label: "Heads-up", levels: ["off", "on"] },
  // Guards have no Off: with enforcement off they still record, which is Watch.
  { env: () => (OUTBOX_ENFORCE ? "on" : "watch"), envName: "OUTBOX_ENFORCE", feature: "outbox", guard: true, hint: "Quiet hours, repeats and the daily cap on notifications", label: "Notification limits", levels: ["watch", "on"] },
  { env: () => (OUTGOING_ENFORCE ? "on" : "watch"), envName: "OUTGOING_ENFORCE", feature: "outgoing", guard: true, hint: "Stops card numbers and secrets in text a tool sends out", label: "Outgoing text check", levels: ["watch", "on"] },
];

const specOf = (feature: string): Spec | undefined => SPECS.find((s) => s.feature === feature);

const isLevel = (v: unknown): v is Level => v === "off" || v === "watch" || v === "on";

/** What the screen has set, feature by feature. Anything not understood is left out. */
const readStore = (): Partial<Record<Feature, Level>> => {
  let raw: string;
  try {
    raw = fs.readFileSync(MODES_PATH, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Partial<Record<Feature, Level>> = {};
    for (const s of SPECS) {
      const v = (parsed as Record<string, unknown>)[s.feature];
      if (isLevel(v) && s.levels.includes(v)) out[s.feature] = v;
    }
    return out;
  } catch {
    return {};
  }
};

/** The levels a screen may choose: up to `.env` for a feature, from `.env` up for a guard. */
export const allowedLevels = (spec: Spec): Level[] => {
  const env = RANK[spec.env()];
  return spec.levels.filter((l) => (spec.guard ? RANK[l] >= env : RANK[l] <= env));
};

/** The level in force: the screen's choice, held inside what `.env` allows. */
export const levelOf = (feature: Feature): Level => {
  const spec = specOf(feature);
  if (!spec) throw new Error(`unknown feature ${feature}`);
  const env = spec.env();
  const chosen = readStore()[feature];
  if (!chosen) return env;
  if (spec.guard) return RANK[chosen] > RANK[env] ? chosen : env;
  return RANK[chosen] < RANK[env] ? chosen : env;
};

export interface Dial {
  allowed: Level[];
  /** What `.env` says: the ceiling for a feature, the floor for a guard. */
  env: Level;
  envName: string;
  feature: Feature;
  guard: boolean;
  hint: string;
  label: string;
  levels: Level[];
  mode: Level;
}

export const listDials = (): Dial[] =>
  SPECS.map((s) => ({
    allowed: allowedLevels(s),
    env: s.env(),
    envName: s.envName,
    feature: s.feature,
    guard: s.guard,
    hint: s.hint,
    label: s.label,
    levels: s.levels,
    mode: levelOf(s.feature),
  }));

export type SetResult = { dial: Dial; ok: true } | { error: string; ok: false };

/**
 * Move one dial. Called only by the dashboard route (a person's click). Refuses a level past what
 * `.env` allows rather than clamping it, so the screen never shows a setting that did not take.
 */
export const setMode = (feature: unknown, level: unknown): SetResult => {
  const spec = specOf(String(feature));
  if (!spec) return { error: `unknown feature: ${String(feature)}`, ok: false };
  if (!isLevel(level) || !spec.levels.includes(level)) return { error: `${spec.label} has no level ${String(level)}`, ok: false };
  if (!allowedLevels(spec).includes(level)) {
    return {
      error: spec.guard
        ? `${spec.label} can only be tightened from here: ${spec.envName} in .env sets the lowest it can go`
        : `${spec.label} cannot go higher than ${spec.envName} in .env allows; change it there and restart`,
      ok: false,
    };
  }
  const next = { ...readStore(), [spec.feature]: level };
  // Written whole and renamed into place, so a reader never sees half a file.
  const tmp = path.join(path.dirname(MODES_PATH), `.modes.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, MODES_PATH);
  const dial = listDials().find((d) => d.feature === spec.feature);
  if (!dial) return { error: "the dial vanished", ok: false };
  return { dial, ok: true };
};

// The modes the features read, in each feature's own words.
const CHECKIN_WORDS = { off: "off", on: "push", watch: "log" } as const;
const SORT_WORDS = { off: "off", on: "on", watch: "log" } as const;
export const checkinMode = (): "log" | "off" | "push" => CHECKIN_WORDS[levelOf("checkin")];
export const inboxSortMode = (): "log" | "off" | "on" => SORT_WORDS[levelOf("inbox-sort")];
export const headsupEnabled = (): boolean => levelOf("headsup") === "on";
export const outboxEnforce = (): boolean => levelOf("outbox") === "on";
export const outgoingEnforce = (): boolean => levelOf("outgoing") === "on";
