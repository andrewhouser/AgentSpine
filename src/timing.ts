/**
 * How long the model took, recorded as it happens.
 *
 * ## Why this is a module and not three lines in llm.ts
 *
 * Timing is a side channel, and it has to behave like one: a failed write must never fail
 * the work it was measuring. That is the same rule `events.ts` and `notify.ts` already
 * follow, and the way to keep it is to have exactly one place that can swallow the error,
 * rather than a try/catch at each call site that will eventually be copied without its
 * catch. `record` below never throws, and it is the only writer.
 *
 * It also keeps the DB out of `llm.ts`'s import surface. That file is the bottom of the
 * stack — a thin wrapper over the OpenAI SDK that the whole system funnels through — and it
 * stays easier to reason about if it depends on a recorder rather than on the ledger.
 *
 * ## What is measured, and what deliberately is not
 *
 * A row is one HTTP request, not one agent step. A transient retry, a tier fallback and a
 * re-ask after malformed JSON are each real seconds the user sat waiting; folding them into
 * the step that provoked them would hide the costs most worth finding. `purpose` says which
 * call site spent the time, so "the answer was slow" can be separated from "the dispatch
 * classifier and the closing-answer call were slow".
 *
 * Durations and token counts only. The prompt and the reply are already in the `messages`
 * trace under its own retention, and a second copy on a different clock is how a thread you
 * deleted turns up somewhere nobody thought to prune.
 *
 * ## The one thing this cannot see
 *
 * Time to first token. Every completion is non-streaming (`llm.ts` constructs them as
 * `ChatCompletionCreateParamsNonStreaming`), so there is no first token to time — the
 * `ms` here is the whole request, which is also exactly how long the user stares at
 * nothing. Splitting prefill from decode needs a streamed request; `bench/ttft.mjs` does
 * that against a live endpoint. What this gives you instead, and the benchmark cannot, is
 * the real distribution over real turns: how many calls a turn actually makes, which call
 * sites they come from, and how much of the total is spent somewhere other than composing
 * the answer the user is waiting for.
 */
import { LLM_TIMING } from "./config.ts";
import * as store from "./memory/store.ts";
import type { LlmCallInput } from "./memory/store.ts";

export type { LlmCallInput };

/**
 * Record one completed (or failed) model call. Never throws, never rejects, and does
 * nothing at all when LLM_TIMING is off.
 */
export const record = (call: LlmCallInput): void => {
  if (!LLM_TIMING) return;
  try {
    store.logLlmCall(call);
  } catch (err) {
    // A measurement that can break the thing it measures is worse than no measurement.
    console.warn(`[timing] not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export interface TimingSummary {
  calls: number;
  failed: number;
  /** Median ms across calls. */
  p50: number;
  p90: number;
  /** Total seconds of model time in the window. */
  totalSec: number;
  /** Median prompt tokens — how much context is re-sent on a typical call. */
  medPromptTokens: number;
  medCompletionTokens: number;
}

const median = (xs: number[]): number => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const quantile = (xs: number[], q: number): number =>
  xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] : 0;

export const summarize = (rows: store.LlmCallRow[]): TimingSummary => {
  const ms = rows.map((r) => r.ms);
  const prompts = rows.map((r) => r.prompt_tokens).filter((n): n is number => typeof n === "number");
  const completions = rows.map((r) => r.completion_tokens).filter((n): n is number => typeof n === "number");
  return {
    calls: rows.length,
    failed: rows.filter((r) => !r.ok).length,
    medCompletionTokens: median(completions),
    medPromptTokens: median(prompts),
    p50: median(ms),
    p90: quantile(ms, 0.9),
    totalSec: ms.reduce((a, b) => a + b, 0) / 1000,
  };
};

/** Group rows by a field, for the per-purpose and per-tier breakdowns. */
export const groupBy = <K extends keyof store.LlmCallRow>(
  rows: store.LlmCallRow[],
  key: K,
): Map<string, store.LlmCallRow[]> => {
  const out = new Map<string, store.LlmCallRow[]>();
  for (const row of rows) {
    const k = String(row[key] ?? "—");
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
};

/**
 * Calls per run, which is the number that decides whether streaming the final answer is
 * worth building. Streaming hides the decode of the LAST call of a turn; it does nothing
 * for the ones before it. A turn that reliably takes one call is a turn streaming fixes.
 */
export const callsPerRun = (rows: store.LlmCallRow[]): Map<number, number> => {
  const perRun = new Map<number, number>();
  for (const r of rows) {
    if (r.run_id === null) continue;
    perRun.set(r.run_id, (perRun.get(r.run_id) ?? 0) + 1);
  }
  const histogram = new Map<number, number>();
  for (const n of perRun.values()) histogram.set(n, (histogram.get(n) ?? 0) + 1);
  return new Map([...histogram.entries()].sort((a, b) => a[0] - b[0]));
};
