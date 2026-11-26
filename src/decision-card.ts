/**
 * The decision card: one queued action and the four facts about it (PLAN-open-work section 15, R2).
 *
 * Every fact comes from code, never from the model, because the model is the party the card is
 * checking on:
 *   - **What leaves**: the tool's own `outgoingText` declaration, the same parts the outgoing check
 *     scans (src/outgoing.ts). An empty list means the tool sends nothing out of the machine.
 *   - **Where it ran**: the run's pin (`runs.private`, a project, a local-only thread) and whether the
 *     cloud tier served any step of it (`runs.served`).
 *   - **Whether it can be undone**: the reversibility tier the tool's classifier gave this call. A
 *     queued call is irreversible by construction (that is why it queued), so the card says what that
 *     means rather than repeating a word.
 *   - **Why it is asking**: who started the run (you typed it, a schedule you set up, a screen's
 *     button, or a helper another run started), and separately whether that run, its tree or its
 *     thread had read outside content before this call (`runs.read_outside`, set by the loop).
 *
 * "Always allow this" is the existing auto-approval proposal (src/learn/promote.ts), never a new
 * write to policy.json, and it is offered only when that module already proposes this exact shape,
 * the call is not one that must always show its card, and the run had read nothing from outside:
 * a rule learned from a call a web page may have steered is the rule an attacker would want.
 *
 * Read-only. Approving and rejecting stay on the existing routes, which re-check policy.
 */
import { CONFIRM_EXPIRE_AFTER_MIN } from "./config.ts";
import { promotionProposals } from "./learn/promote.ts";
import * as store from "./memory/store.ts";
import { registry } from "./tools/index.ts";

export type Origin = "button" | "helper" | "schedule" | "unknown" | "you-typed";

export interface DecisionFacts {
  /** The text that would leave the machine, part by part, clipped. Null when the tool's declaration failed. */
  leaves: null | string[];
  /** What leaves, in a sentence. */
  leavesLine: string;
  origin: Origin;
  /** True when the run, its tree or its thread had read outside content before this call. */
  readOutside: boolean;
  /** "irreversible" for every queued call today; kept as a field so a future tier reads correctly. */
  undo: "irreversible" | "reversible";
  undoLine: string;
  where: "cloud" | "local" | "none";
  whereLine: string;
  whyLine: string;
}

export interface DecisionCard {
  /** Offered only under the rule above; the client posts it to /api/proposals, which a person's click calls. */
  alwaysAllow: null | { approvals: number; target: string; tool: string };
  args: string;
  conversationId: null | number;
  expiresAt: null | string;
  facts: DecisionFacts;
  id: number;
  /** The next pending card, oldest first, so the screen moves on one at a time. */
  nextId: null | number;
  /** True when this call must always show its card (an edit to a gate file): no rule may skip it. */
  pinned: boolean;
  position: { index: number; of: number };
  state: string;
  summary: string;
  tool: string;
  ts: string;
}

const LEAVE_CLIP = 400;
const clip = (s: string): string => (s.length > LEAVE_CLIP ? `${s.slice(0, LEAVE_CLIP - 1)}…` : s);

/** Who started the run that asked. Pure, so the rules are tested on rows. */
export const originOf = (
  run: null | { kind: null | string; parent_run_id: null | number; task_by_code: null | number } | undefined,
  root: null | { kind: null | string; task_by_code: null | number } | undefined,
): Origin => {
  if (!run) return "button";
  const top = root ?? run;
  if (run.parent_run_id != null && top.kind !== "schedule" && top.kind !== "heartbeat") {
    // A helper inside your chat is still your chat; one inside a job is that job.
    return top.kind === "chat" && top.task_by_code !== 1 ? "you-typed" : top.task_by_code === 1 ? "button" : "helper";
  }
  if (top.kind === "schedule" || top.kind === "heartbeat") return "schedule";
  if (top.task_by_code === 1) return "button";
  if (top.kind === "chat") return "you-typed";
  if (top.kind === "approval") return "you-typed";
  return "unknown";
};

const WHY: Record<Origin, string> = {
  button: "A button on a screen asked for this; the words were written by code, not by you.",
  helper: "A helper started by another run asked for this.",
  schedule: "A scheduled job you set up asked for this, with no one watching.",
  unknown: "The run that asked does not record who started it.",
  "you-typed": "You asked for this in a conversation.",
};

/** The four facts for one confirmation row. Exported for the tests. */
export const factsFor = (row: store.ConfirmationRow): { facts: DecisionFacts; pinned: boolean; target: null | string } => {
  const tool = registry[row.tool];
  let args: unknown = {};
  try {
    args = JSON.parse(row.args);
  } catch {
    /* an unreadable row still gets a card; it says what it can */
  }

  let leaves: null | string[] = [];
  if (tool?.outgoingText) {
    try {
      leaves = tool.outgoingText(args as never).filter((p) => typeof p === "string" && p.trim() !== "").map(clip);
    } catch {
      leaves = null;
    }
  }

  let reversibility: "irreversible" | "reversible" = "irreversible";
  let pinned = false;
  let target: null | string = null;
  try {
    const c = tool?.classify(args as never);
    if (c) {
      reversibility = c.reversibility === "reversible" ? "reversible" : "irreversible";
      pinned = c.reversibility === "irreversible" && c.alwaysConfirm === true;
      target = c.target ?? "";
    }
  } catch {
    /* a classifier that throws leaves the cautious defaults */
  }

  const run = row.run_id != null ? store.getRun(row.run_id) : null;
  const rootId = row.run_id != null ? store.rootRunId(row.run_id) : null;
  const root = rootId != null ? store.getRun(rootId) : null;
  const origin = originOf(run, root);
  const readOutside = row.run_id != null && store.readOutsideFor(row.run_id);

  let where: DecisionFacts["where"] = "none";
  if (row.run_id != null) {
    const servedCloud = [run, root].some((r) => {
      try {
        return r?.served ? JSON.parse(r.served).cloud === true : false;
      } catch {
        return false;
      }
    });
    where = store.runIsPrivate(row.run_id) || !servedCloud ? "local" : "cloud";
  }

  const facts: DecisionFacts = {
    leaves,
    leavesLine:
      leaves === null
        ? "What this sends could not be worked out from the tool. Read the details before approving."
        : leaves.length === 0
          ? "Nothing leaves this machine."
          : `${leaves.length === 1 ? "This text leaves" : `${leaves.length} pieces of text leave`} this machine.`,
    origin,
    readOutside,
    undo: reversibility,
    undoLine:
      reversibility === "irreversible"
        ? "AgentSpine cannot undo this once it runs."
        : "This can be undone.",
    where,
    whereLine:
      where === "none"
        ? "No run: a screen asked for it directly."
        : where === "local"
          ? "Written on the local model."
          : "A cloud model took part in the run that asked.",
    whyLine: `${WHY[origin]}${readOutside ? " Before asking, that run read outside content (an email, a page or a file), which may have shaped this." : ""}`,
  };
  return { facts, pinned, target };
};

/** The card for one confirmation, or null when there is no such row. */
export const decisionCard = (id: number): DecisionCard | null => {
  const row = store.getConfirmation(id);
  if (!row) return null;
  const { facts, pinned, target } = factsFor(row);

  // Oldest first, one at a time: the position is among what is still pending.
  const pending = store
    .listConfirmations("pending")
    .map((c) => c.id)
    .sort((a, b) => a - b);
  const at = pending.indexOf(row.id);
  const nextId = pending.find((p) => p !== row.id && (at < 0 || p > row.id)) ?? pending.find((p) => p !== row.id) ?? null;

  let alwaysAllow: DecisionCard["alwaysAllow"] = null;
  if (!pinned && !facts.readOutside && target !== null && row.state === "pending") {
    const p = promotionProposals().find((x) => x.tool === row.tool && x.target === target);
    if (p) alwaysAllow = { approvals: p.approvals, target: p.target, tool: p.tool };
  }

  const expiresAt = CONFIRM_EXPIRE_AFTER_MIN > 0 ? new Date(Date.parse(row.ts) + CONFIRM_EXPIRE_AFTER_MIN * 60_000).toISOString() : null;
  return {
    alwaysAllow,
    args: row.args,
    conversationId: row.conversation_id ?? null,
    expiresAt,
    facts,
    id: row.id,
    nextId,
    pinned,
    position: { index: at < 0 ? 0 : at + 1, of: pending.length },
    state: row.state,
    summary: row.summary,
    tool: row.tool,
    ts: row.ts,
  };
};
