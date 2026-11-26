/**
 * The decision card's shape and its few client-side words (PLAN-open-work section 15, R2). The
 * facts' sentences come from the server (src/decision-card.ts) so the three clients cannot word
 * them differently; what is here is the position line and the hold time. `DecisionWords` in
 * ios/AgentSpine/Core/Models.swift mirrors it, and test/decision-screen.test.mjs holds them equal.
 */
export interface DecisionFacts {
  leaves: null | string[];
  leavesLine: string;
  origin: "button" | "helper" | "schedule" | "unknown" | "you-typed";
  readOutside: boolean;
  /** The four facts in a word or two, for the decision panel (2026-11-26 redesign). Absent from an older server. */
  short?: { leaves: string; requestedBy: string; undo: string; where: string };
  undo: "irreversible" | "reversible";
  undoLine: string;
  where: "cloud" | "local" | "none";
  whereLine: string;
  whyLine: string;
}

export interface DecisionCard {
  alwaysAllow: { approvals: number; target: string; tool: string } | null;
  args: string;
  conversationId: null | number;
  expiresAt: null | string;
  facts: DecisionFacts;
  id: number;
  nextId: null | number;
  pinned: boolean;
  position: { index: number; of: number };
  state: string;
  summary: string;
  tool: string;
  ts: string;
}

/** How long Approve must be held. Long enough not to happen by accident, short enough not to annoy. */
export const HOLD_MS = 800;

/** "1 of 3 waiting", or "" when this is the only one or it is no longer pending. */
export const positionLine = (p: { index: number; of: number }): string => (p.of > 1 && p.index > 0 ? `${p.index} of ${p.of} waiting` : "");

/** The offer, in words: how many times you said yes to this shape. */
export const alwaysAllowLine = (a: { approvals: number; target: string; tool: string }): string =>
  `You have approved this ${a.approvals} times and never said no. Always allow ${a.tool}${a.target ? ` on ${a.target}` : ""}?`;

/**
 * What the panel shows as the action's own text: a draft's subject and body when the arguments have them,
 * else the whole summary. The words are the call's, shown as text; nothing here is sent anywhere.
 */
export const actionText = (argsJson: string, summary: string): { body: string; subject: null | string; to: null | string } => {
  let a: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(argsJson);
    if (v && typeof v === "object") a = v as Record<string, unknown>;
  } catch {
    /* an unreadable row shows its summary */
  }
  const str = (k: string): null | string => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string) : null);
  const body = str("body") ?? str("text") ?? str("content") ?? summary;
  return { body, subject: str("subject") ?? str("title"), to: str("to") ?? str("recipient") };
};
