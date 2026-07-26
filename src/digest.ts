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
import { notify } from "./notify.ts";

const sinceIso = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;

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
