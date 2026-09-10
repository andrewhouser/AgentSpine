/**
 * The "what I did" digest:  npm run digest [hours] [--push]
 *
 * The single best trust-builder in the system, and the reason it's built the way it is:
 * **the numbers are computed, not narrated.** Every figure here comes from a SQL count over
 * the `actions` audit log and the `confirmations` queue. A digest written by the model
 * would be a summary of a summary — exactly the artifact you can't check, reporting on the
 * one subject where being wrong destroys the point. So the counting is code, and the model
 * is left out of it entirely.
 *
 * Also usable as a tool (`digest`), so a scheduled brief can include it and add its own
 * commentary around a set of figures it cannot fudge.
 */
import * as store from "./memory/store.ts";
import { deniedProposals } from "./learn/denials.ts";
import { promotionProposals, proposalDiff } from "./learn/promote.ts";
import { notify } from "./notify.ts";

const sinceIso = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;

/** A percentage, one decimal, guarding the empty denominator so 0/0 reads as "—" not "NaN%". */
const pct = (num: number, denom: number): string => (denom ? `${((100 * num) / denom).toFixed(1)}%` : "—");

/** Median of a numeric list, or null when empty. */
const median = (xs: number[]): null | number => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Collapse a task string to a clustering key: lowercased, whitespace-flattened, trimmed of
 * trailing punctuation. Deliberately crude — two runs of the same recurring job differ only
 * in casing or a period, and anything cleverer here would be a similarity model masquerading
 * as a group-by. A cluster is "a repeat task" only when it holds two or more runs.
 */
const taskKey = (task: null | string): string =>
  String(task ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?…\s]+$/, "")
    .trim();

/** Duration in seconds between two ISO timestamps, or null if either is missing/unparseable. */
const secondsBetween = (fromIso: null | string, toIso: null | string): null | number => {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / 1000;
};

/** A duration in seconds as a compact human string. */
const humanSeconds = (s: number): string => {
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};

/** Tally a list by a key function, returned highest-first. */
const tally = (rows: any[], key: (r: any) => string): [string, number][] => {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

export interface DigestOpts {
  /** How far back to look. Default 24h. */
  hours?: number;
}

/**
 * Build the digest text. Pure read — computes nothing it can't show you the source of.
 */
export const buildDigest = ({ hours = 24 }: DigestOpts = {}): string => {
  const since = sinceIso(hours);
  const runs = store.runsSince(since);
  const actions = store.actionsSince(since);
  const memories = store.memoriesSince(since);
  const pending = store.listConfirmations("pending");

  const out: string[] = [];
  const window = hours === 24 ? "the last 24 hours" : `the last ${plural(hours, "hour")}`;

  // --- what ran ---
  const ok = runs.filter((r) => r.status === "ok").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const running = runs.filter((r) => r.status === "running").length;

  if (!runs.length && !actions.length && !pending.length) {
    return `Nothing happened in ${window}. No runs, no actions, nothing waiting on you.`;
  }

  out.push(
    `In ${window}: ${plural(runs.length, "run")}` +
      (runs.length ? ` — ${ok} ok, ${failed} failed${running ? `, ${running} still running` : ""}.` : "."),
  );

  // --- what it actually did ---
  const executed = actions.filter((a) => a.decision === "executed");
  const denied = actions.filter((a) => a.decision === "denied");
  const errored = actions.filter((a) => a.decision === "error");
  const dryRun = actions.filter((a) => a.decision === "dry-run");

  if (executed.length) {
    const byTool = tally(executed, (a) => a.tool)
      .map(([t, n]) => `${t} ×${n}`)
      .join(", ");
    out.push(`\nActions taken (${executed.length}): ${byTool}`);
  } else if (actions.length) {
    out.push(`\nActions taken: none.`);
  }

  if (dryRun.length) out.push(`Dry run — ${plural(dryRun.length, "call")} reported but not executed.`);

  if (denied.length) {
    const byReason = tally(denied, (a) => a.tool)
      .map(([t, n]) => `${t} ×${n}`)
      .join(", ");
    out.push(
      `\nBlocked by policy (${denied.length}): ${byReason}` +
        `\n  Worth a look if you expected these to work — it usually means an allowlist or a budget.`,
    );
  }

  if (errored.length) {
    out.push(`\nErrors (${errored.length}):`);
    for (const a of errored.slice(0, 5)) out.push(`  ${a.tool}: ${String(a.output).slice(0, 120)}`);
  }

  if (failed) {
    out.push(`\nFailed runs (${failed}):`);
    for (const r of runs.filter((x) => x.status === "failed").slice(0, 5))
      out.push(`  "${String(r.task ?? "").slice(0, 60)}" — ${String(r.note ?? "").slice(0, 100)}`);
  }

  // --- what it learned ---
  if (memories.length) {
    const byKind = tally(memories, (m) => m.kind ?? "note")
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    out.push(`\nLearned (${memories.length}): ${byKind}`);
    for (const m of memories.slice(0, 3)) out.push(`  · ${String(m.text).slice(0, 110)}`);
  }

  // --- the numbers (LEARNING Phase 0) ---
  // A baseline, computed in SQL for the same reason the rest of the digest is: these are the
  // figures each learning phase promises to move, and a plausible story about improvement is
  // worth the least on exactly this subject. Every line here is a count or a ratio over tables
  // that already exist — no model is consulted.
  const metrics: string[] = [];

  // 1. Denied-call rate — how much of every run is spent re-attempting forbidden things.
  if (actions.length) {
    metrics.push(`  Denied-call rate: ${pct(denied.length, actions.length)} (${denied.length}/${actions.length} calls)`);
  }

  // 2. Tool error rate — which tool the model cannot drive, worst first.
  if (errored.length) {
    const byTool = tally(errored, (a) => a.tool)
      .map(([t, n]) => `${t} ${pct(n, actions.filter((a) => a.tool === t).length)} (${n})`)
      .join(", ");
    metrics.push(`  Tool errors: ${byTool}`);
  }

  // 3. Steps per repeat task — the one number recipes (Phase 3.1) are supposed to move.
  //    A "repeat task" is a normalized task string seen on two or more finished runs; we
  //    report the median step count across such clusters, plus how many clusters there were.
  const stepRows = store.runStepCountsSince(since);
  const byTaskKey = new Map<string, number[]>();
  for (const row of stepRows) {
    const key = taskKey(row.task);
    if (!key) continue;
    const bucket = byTaskKey.get(key) ?? [];
    bucket.push(row.steps);
    byTaskKey.set(key, bucket);
  }
  const repeatClusters = [...byTaskKey.values()].filter((v) => v.length >= 2);
  if (repeatClusters.length) {
    // Median of each cluster's median, so a single chatty cluster can't dominate the figure.
    const perCluster = repeatClusters.map((v) => median(v)!).filter((n): n is number => n != null);
    const overall = median(perCluster);
    if (overall != null) {
      metrics.push(
        `  Steps per repeat task: ${overall.toFixed(1)} median ` +
          `(${plural(repeatClusters.length, "task")} seen 2+ times)`,
      );
    }
  }

  // 4 & 5. Rejection rate and approval latency — over confirmations *resolved* in the window.
  const resolved = store.confirmationsResolvedSince(since);
  if (resolved.length) {
    const rejected = resolved.filter((c) => c.state === "rejected").length;
    metrics.push(`  Rejection rate: ${pct(rejected, resolved.length)} (${rejected}/${resolved.length} resolved)`);

    const latencies = resolved
      .map((c) => secondsBetween(c.ts, c.resolved))
      .filter((n): n is number => n != null && n >= 0);
    const med = median(latencies);
    if (med != null) metrics.push(`  Approval latency: ${humanSeconds(med)} median (${plural(latencies.length, "decision")})`);
  }

  if (metrics.length) {
    out.push(`\nThe numbers (${window}):`);
    out.push(...metrics);
  }

  // --- worth deciding (LEARNING Phase 1.1) ---
  // A shape the broker keeps refusing is a standing question with two useful answers:
  // allowlist it, or tell the agent to stop proposing it. Derived in SQL from the audit log;
  // this is a report the model cannot see or influence. Not windowed — a pattern denied
  // steadily over months is exactly the one worth surfacing.
  const proposals = deniedProposals();
  if (proposals.length) {
    out.push(`\nWorth deciding (${plural(proposals.length, "recurring denial")}):`);
    for (const p of proposals.slice(0, 5)) {
      out.push(`  ${p.shape} — denied ${p.n}×${p.reason ? ` (${p.reason})` : ""}.`);
      out.push(`    Allowlist it, or should I stop proposing it?`);
    }
  }

  // --- policy proposals (LEARNING Phase 2) ---
  // A shape approved many times with no rejections is a candidate for auto-approval. The
  // proposal is falsifiable: it names exactly the past confirmations the rule would have
  // auto-run and nothing else. Computed from the ledger; the agent cannot see or apply it.
  const promotions = promotionProposals();
  if (promotions.length) {
    out.push(`\nAuto-approval proposals (${plural(promotions.length, "shape")}):`);
    for (const p of promotions.slice(0, 5)) {
      out.push(
        `  ${p.tool} on ${p.target || "(no target)"} — approved ${p.approvals}× over ${plural(p.spanDays, "day")}, never rejected.`,
      );
      out.push(`    Would auto-run these and nothing else: #${p.wouldHaveAutoRun.join(", #")}.`);
      out.push(`    ${proposalDiff(p)}`);
    }
  }

  // --- what needs you --- (last, because it's the part that needs action)
  if (pending.length) {
    out.push(`\nWAITING ON YOU (${pending.length}):`);
    for (const c of pending.slice(0, 10)) out.push(`  #${c.id} [${c.tool}] ${c.summary}`);
    if (pending.length > 10) out.push(`  …and ${pending.length - 10} more`);
    out.push(`  Approve with: npm run confirm approve <id>`);
  } else {
    out.push(`\nNothing waiting on you.`);
  }

  return out.join("\n");
};

// --- CLI ---
// Only when run directly, so importing buildDigest (e.g. from the tool) has no side effects.
if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const push = args.includes("--push");
  const hours = Number(args.find((a) => /^\d+$/.test(a)) ?? "24");

  const text = buildDigest({ hours });
  console.log(text);

  if (push) {
    const r = await notify("AgentSpine digest", text.slice(0, 3500), {
      priority: store.listConfirmations("pending").length ? 4 : 3,
    });
    console.log(`\npush: ${r.ok ? r.detail : `FAILED — ${r.detail}`}`);
  }
  process.exit(0);
}
