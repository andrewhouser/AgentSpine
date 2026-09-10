/**
 * The denial learner (LEARNING.md Phase 1.1) — the cheapest win in the system.
 *
 * `SELECT tool, target, COUNT(*) FROM actions WHERE decision='denied' GROUP BY tool, target`
 * is the highest-value untouched query in the database. Each row is the model attempting
 * something policy forbids, and without this it costs a wasted turn *every run, forever* —
 * the broker denies it, the model reads DENIED, and nothing anywhere remembers.
 *
 * Two outputs from that one query, both derived entirely in SQL:
 *
 *   1. `deniedContext()` — a known-denied block injected into standing context by
 *      `buildContext` in `runner.ts`, so the model does not try the forbidden thing again.
 *   2. `deniedProposals()` — lines for the weekly digest asking whether to allowlist a shape
 *      that keeps being attempted, or to stop proposing it.
 *
 * This module lives under `src/learn/`, not `src/tools/`, on purpose: it is not a capability
 * the model may invoke. It reads the ledger and shapes a prompt; it never writes policy and
 * never runs a tool. There is no inference here, which is why Phase 1 goes first — nothing in
 * it can be talked into anything.
 */
import { DENIAL_PROMPT_MAX, DENIAL_PROPOSE_MIN } from "../config.ts";
import * as store from "./../memory/store.ts";
import type { DeniedShape } from "./../memory/store.ts";

/** The stored denial reason is `DENIED: <reason>`; strip the prefix for a clean phrase. */
const cleanReason = (raw: string): string =>
  String(raw ?? "")
    .replace(/^DENIED:\s*/i, "")
    .trim()
    .slice(0, 120);

/** `tool on <target>` or just `tool` when a call has no target (target is null). */
const shapeLabel = (s: DeniedShape): string => (s.target ? `${s.tool} on ${s.target}` : s.tool);

/**
 * A system-message block naming the shapes the broker has already refused, with how many
 * times each was tried. Legitimately trusted context: it is the user's own audit log,
 * summarized by SQL, with no outside content in it. Empty string when nothing has been
 * denied, so a clean install injects nothing.
 */
export const deniedContext = (): string => {
  if (DENIAL_PROMPT_MAX <= 0) return "";
  const shapes = store.deniedShapes(1, DENIAL_PROMPT_MAX);
  if (!shapes.length) return "";

  const lines = shapes.map((s) => {
    const reason = cleanReason(s.reason);
    return `- ${shapeLabel(s)} (${s.n}×)${reason ? ` — ${reason}` : ""}`;
  });

  return (
    "Calls the broker has already refused, with how many times you have tried each. Do not " +
    "attempt these — the answer will be the same. If the goal genuinely needs one, say so in " +
    "your final summary instead of calling it:\n" +
    lines.join("\n")
  );
};

export interface DenialProposal {
  n: number;
  reason: string;
  shape: string;
}

/**
 * Shapes denied often enough to be worth raising with the user — a question for the weekly
 * digest, with two useful answers and no bad one. Rendered by `digest.ts`, not here, so this
 * module stays a pure read.
 */
export const deniedProposals = (): DenialProposal[] =>
  store
    .deniedShapes(DENIAL_PROPOSE_MIN, 10)
    .map((s) => ({ n: s.n, reason: cleanReason(s.reason), shape: shapeLabel(s) }));
