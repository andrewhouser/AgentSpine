/**
 * npm run timing [days]
 *
 * Where the model time went, from real turns rather than a benchmark.
 *
 *   npm run timing        the last 7 days
 *   npm run timing 30     the last 30
 *
 * Reads only. The rows come from `llm_calls`, written by src/timing.ts on every completion
 * and aged on the audit retention window.
 *
 * The three questions this is built to answer, in the order they decide anything:
 *
 *   1. How many model calls does a turn actually make? Streaming the final answer hides the
 *      decode of the LAST call only. At one call per turn that is the whole wait; at four it
 *      is a quarter of it, and the work worth doing is removing calls instead.
 *   2. How much of the time is spent somewhere other than answering? `dispatch`, `judge`,
 *      `reflect` and `step-reask` are all time the user waits without an answer being
 *      written. A re-ask in particular is a whole round-trip lost to a model fumbling the
 *      JSON protocol, and nobody knew how often it happened.
 *   3. How big is the prompt on a typical call? It is re-sent every step, so prefill is
 *      paid per call, not per turn.
 */
import { AUDIT_RETENTION_DAYS } from "./config.ts";
import * as store from "./memory/store.ts";
import { callsPerRun, groupBy, summarize } from "./timing.ts";

const days = Number(process.argv[2] ?? "7");
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const rows = store.llmCallsSince(since);

const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
const pad = (s: string | number, n: number): string => String(s).padStart(n);

console.log(`\nModel time over the last ${days} day(s)`);
console.log(`(timing rows are kept for AUDIT_RETENTION_DAYS=${AUDIT_RETENTION_DAYS}, so a longer window shows nothing older)\n`);

if (!rows.length) {
  console.log("No calls recorded in that window.");
  console.log("If this is unexpected: LLM_TIMING must be unset or true, and only calls made");
  console.log("since the instrumentation landed are counted.\n");
  process.exit(0);
}

const all = summarize(rows);
console.log(`${all.calls} calls, ${all.totalSec.toFixed(1)}s of model time, ${all.failed} failed`);
console.log(`  per call      p50 ${ms(all.p50)}   p90 ${ms(all.p90)}`);
console.log(`  tokens        prompt ${all.medPromptTokens} (median), completion ${all.medCompletionTokens}`);

console.log("\nBY PURPOSE — what the time was spent on");
const byPurpose = [...groupBy(rows, "purpose").entries()].sort(
  (a, b) => summarize(b[1]).totalSec - summarize(a[1]).totalSec,
);
for (const [purpose, group] of byPurpose) {
  const s = summarize(group);
  const share = (100 * s.totalSec) / Math.max(0.001, all.totalSec);
  console.log(
    `  ${purpose.padEnd(14)} ${pad(s.calls, 5)} calls  ${pad(s.totalSec.toFixed(1), 7)}s  ` +
      `${pad(share.toFixed(0), 3)}%  p50 ${ms(s.p50)}`,
  );
}

console.log("\nBY TIER");
for (const [tier, group] of groupBy(rows, "tier")) {
  const s = summarize(group);
  console.log(`  ${tier.padEnd(14)} ${pad(s.calls, 5)} calls  p50 ${ms(s.p50)}  p90 ${ms(s.p90)}  median prompt ${s.medPromptTokens} tok`);
}

console.log("\nCALLS PER RUN — the ceiling streaming does NOT move");
const hist = callsPerRun(rows);
const runs = [...hist.values()].reduce((a, b) => a + b, 0);
for (const [calls, n] of hist) {
  console.log(`  ${pad(calls, 2)} call(s)  ${"#".repeat(Math.min(50, n))} ${n}`);
}
if (runs) {
  const weighted = [...hist.entries()].reduce((t, [calls, n]) => t + calls * n, 0) / runs;
  console.log(`  ${runs} runs, mean ${weighted.toFixed(2)} calls each`);
}

// The headline. The last call of a run is the one whose decode a user would watch arrive;
// everything before it is time they stare at tool cards or at nothing.
const lastCallPerRun = new Map<number, store.LlmCallRow>();
for (const r of rows) if (r.run_id !== null) lastCallPerRun.set(r.run_id, r);
const finalMs = [...lastCallPerRun.values()].reduce((t, r) => t + r.ms, 0);
if (finalMs && all.totalSec) {
  const share = (100 * (finalMs / 1000)) / all.totalSec;
  console.log(`\nSTREAMING CEILING`);
  console.log(`  ${(finalMs / 1000).toFixed(1)}s of ${all.totalSec.toFixed(1)}s (${share.toFixed(0)}%) was the last call of a run.`);
  console.log(`  That is the most streaming the final answer could ever hide. The other`);
  console.log(`  ${(100 - share).toFixed(0)}% needs fewer calls or a smaller prompt, not faster paint.`);
}
console.log();
