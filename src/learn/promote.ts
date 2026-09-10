/**
 * Learn from approvals (LEARNING.md Phase 2).
 *
 * Rejections teach (Phase 1.3); approvals taught nothing, which is backwards — a shape
 * approved twenty times with zero rejections is the strongest safety signal in the system,
 * and it was evaporating. This turns that signal into a **narrowed policy proposal**: the
 * minimum rule that would let *one shape* auto-execute, never a whole tool and never a
 * domain.
 *
 * ## Where this lives, and why it matters
 *
 * This module is read-only. It computes proposals from the confirmation ledger and returns
 * them; it never writes `policy.json`. The dashboard renders a proposal with its exact diff,
 * and the server applies it on a click (`applyProposal`, called only from an authenticated
 * mutating route). **No tool in the registry can reach any of this** — that is invariant 1
 * from LEARNING.md, and this is the feature most likely to erode it if built as "a tool that
 * suggests policy," so it is built as a report the agent cannot see.
 *
 * ## The proposal is falsifiable before you accept it
 *
 * Each proposal carries the exact list of past confirmations the rule would have
 * auto-executed and asserts it would have touched nothing else. A policy change you can
 * check against history is a very different thing from one you have to reason about.
 */
import { PROMOTE_MIN_APPROVALS, PROMOTE_MIN_DAYS, loadPolicy, POLICY_PATH } from "../config.ts";
import { registry } from "../tools/index.ts";
import * as store from "./../memory/store.ts";
import type { Policy } from "../types.ts";
import fs from "node:fs";

/** The (tool, target) shape of a confirmation, from the tool's own classifier. */
const shapeOf = (tool: string, argsJson: string): null | string => {
  try {
    const t = registry[tool];
    if (!t) return null;
    return t.classify(JSON.parse(argsJson)).target ?? "";
  } catch {
    return null;
  }
};

const daysBetween = (aIso: string, bIso: string): number =>
  Math.abs(Date.parse(bIso) - Date.parse(aIso)) / 86_400_000;

export interface PromotionProposal {
  tool: string;
  target: string;
  /** How many times this exact shape was approved. */
  approvals: number;
  /** Days between the first and last approval — the shape's track record. */
  spanDays: number;
  /** The confirmation ids the rule would have auto-executed. The falsifiability claim. */
  wouldHaveAutoRun: number[];
  /** A human sentence describing the shape, taken from the most recent approval. */
  summary: string;
}

interface Agg {
  approvals: number;
  rejections: number;
  first: string;
  last: string;
  ids: number[];
  summary: string;
}

/**
 * Shapes that have earned an auto-approval proposal: approved at least `PROMOTE_MIN_APPROVALS`
 * times, rejected zero times, spanning at least `PROMOTE_MIN_DAYS`. A single rejection
 * disqualifies a shape outright — the whole point is that the user has never once said no to
 * it. Already-approved shapes (present in `policy.autoApprove`) are skipped, since proposing
 * a rule that already exists is noise.
 */
export const promotionProposals = (): PromotionProposal[] => {
  const rows = store.resolvedConfirmations();
  const byShape = new Map<string, Agg>();

  for (const r of rows) {
    const target = shapeOf(r.tool, r.args);
    if (target == null) continue;
    const key = `${r.tool}\u0000${target}`;
    let agg = byShape.get(key);
    if (!agg) {
      agg = { approvals: 0, first: r.ts, ids: [], last: r.ts, rejections: 0, summary: r.summary };
      byShape.set(key, agg);
    }
    if (r.state === "done") {
      agg.approvals++;
      agg.ids.push(r.id);
      agg.summary = r.summary; // most recent approval's summary
    } else if (r.state === "rejected") {
      agg.rejections++;
    }
    if (r.ts < agg.first) agg.first = r.ts;
    if (r.ts > agg.last) agg.last = r.ts;
  }

  const already = new Set((loadPolicy().autoApprove ?? []).map((s) => `${s.tool}\u0000${s.target}`));
  const out: PromotionProposal[] = [];

  for (const [key, agg] of byShape) {
    if (already.has(key)) continue;
    if (agg.rejections > 0) continue;
    if (agg.approvals < PROMOTE_MIN_APPROVALS) continue;
    const span = daysBetween(agg.first, agg.last);
    if (span < PROMOTE_MIN_DAYS) continue;

    const [tool, target] = key.split("\u0000");
    out.push({
      approvals: agg.approvals,
      spanDays: Math.round(span),
      summary: agg.summary,
      target,
      tool,
      wouldHaveAutoRun: agg.ids,
    });
  }

  return out.sort((a, b) => b.approvals - a.approvals);
};

/** The diff a proposal would make to policy.json — one added autoApprove entry. */
export const proposalDiff = (p: PromotionProposal): string =>
  `policy.autoApprove += { "tool": ${JSON.stringify(p.tool)}, "target": ${JSON.stringify(p.target)} }`;

export interface ApplyResult {
  ok: boolean;
  message: string;
}

/**
 * Apply one proposal: add its `(tool, target)` to `policy.autoApprove` and write
 * `policy.json`. The ONLY function in the system that writes policy from a proposal, and it
 * is called only from an authenticated mutating server route — never from a tool. Idempotent:
 * a shape already present is left as-is. Re-reads and re-writes the whole file so a
 * hand-edit made since the proposal was computed is preserved.
 */
export const applyProposal = (tool: string, target: string): ApplyResult => {
  if (!tool) return { message: "no tool given", ok: false };
  let policy: Policy;
  try {
    policy = loadPolicy();
  } catch (err) {
    return { message: `could not read policy: ${err instanceof Error ? err.message : String(err)}`, ok: false };
  }

  const list = policy.autoApprove ?? [];
  if (list.some((s) => s.tool === tool && s.target === target)) {
    return { message: `already auto-approved: ${tool} on ${target || "(no target)"}`, ok: true };
  }

  policy.autoApprove = [...list, { target, tool }];
  try {
    fs.writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2) + "\n", "utf8");
  } catch (err) {
    return { message: `could not write policy: ${err instanceof Error ? err.message : String(err)}`, ok: false };
  }
  return { message: `auto-approval added: ${tool} on ${target || "(no target)"}`, ok: true };
};
