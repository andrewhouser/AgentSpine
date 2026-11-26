/**
 * How long a run may go on, and when its context is trimmed (PLAN-open-work section 10, LP3,
 * with section 13 H5's order). Pure arithmetic: the loop in `agent.ts` does the work and asks
 * here what the numbers say, so every boundary is tested without a model.
 *
 * ## The budget
 *
 * The step cap treats a step that calls `task_list` and a step that writes a 4,000-token page
 * as the same thing. They are not: on this host the first costs a second or two and the second
 * over two minutes. So a run could stop at ten quick lookups with its work unfinished, while
 * ten long writes were allowed twenty minutes.
 *
 * With `LOOP_BUDGET=tokens` the cap becomes an allowance. A run still declares its size as a
 * step count (MAX_STEPS, SUBAGENT_MAX_STEPS, or a unit's own `maxSteps`), and each of those
 * steps is worth a fixed number of generated tokens and a fixed stretch of working time. The
 * run ends when either is spent, or at a hard step ceiling, whichever comes first. The ceiling
 * is what guarantees a loop of free steps still ends.
 *
 * Tokens means tokens the model GENERATED. Prompt tokens are left out on purpose: the prompt is
 * re-sent whole on every step and mostly served from the server's cache, so counting it would
 * make the budget a step cap again, scaled by how long the system prompt happens to be.
 *
 * ## Compaction
 *
 * When the context passes a share of the window, old tool results are replaced with one-line
 * stubs and the full text stays reachable through `read_more`. No model writes a summary: H5
 * keeps that out until stubbing alone is shown to fall short.
 *
 * It must be RARE. The server reuses its cache only up to the first byte that changed, so every
 * compaction pays prefill again from the first message it touched. Three rules bound that, and
 * all three are numbers below:
 *   - at most one compaction every COMPACT_MIN_GAP_STEPS steps;
 *   - not unless it frees at least COMPACT_MIN_SAVING_TOKENS;
 *   - when it happens, everything eligible goes at once, and a stub is never rewritten, so the
 *     context before the first newly stubbed message is byte-for-byte what it was.
 */
import { LOCAL_CONTEXT_TOKENS, RUN_MS_PER_STEP, RUN_TOKENS_PER_STEP } from "./config.ts";

/** The hard ceiling, as a multiple of the step cap: a 10-step run may take 30 cheap steps, never more. */
export const STEP_CEILING_FACTOR = 3;
/** Compact once the context passes this share of LOCAL_CONTEXT_TOKENS. Hermes Agent's number; a starting point. */
export const COMPACT_AT_SHARE = 0.5;
/** The newest results are never stubbed: they are what the model is working from right now. */
export const KEEP_RECENT_RESULTS = 2;
/** A result shorter than this is left alone. The stub is about 300 characters; swapping saves nothing. */
export const STUB_MIN_CHARS = 1200;
export const COMPACT_MIN_GAP_STEPS = 4;
export const COMPACT_MIN_SAVING_TOKENS = 1500;
/** How much of a set-aside result one `read_more` call hands back. */
export const STUB_WINDOW_CHARS = 6000;
/**
 * Characters per token, for a server that reports no usage. English prose and JSON on Qwen's
 * tokenizer run a little under four; rounding up to four under-counts slightly, which errs
 * toward compacting late, not toward cutting a run short.
 */
export const CHARS_PER_TOKEN = 4;

export const estimateTokens = (chars: number): number => Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);

export interface LoopBudget {
  /** Working time, in ms. Time parked so a chat turn could go first does not count (src/turn-gate.ts). */
  activeMs: number;
  stepCeiling: number;
  /** Tokens the model may generate across the run's own steps. */
  tokens: number;
}

/** The allowance for a run that would have been capped at `stepCap` steps. */
export const budgetFor = (stepCap: number): LoopBudget => {
  const steps = Math.max(1, Math.floor(stepCap));
  return { activeMs: steps * RUN_MS_PER_STEP, stepCeiling: steps * STEP_CEILING_FACTOR, tokens: steps * RUN_TOKENS_PER_STEP };
};

/**
 * Working time so far: wall clock since the loop began, less whatever it has spent parked since
 * then. `pausedAtStart` matters because parked time is kept per run id and a caller may hand
 * this loop an id that has parked before.
 */
export const activeMsOf = (t: { now: number; pausedAtStart: number; pausedNow: number; startedAt: number }): number =>
  Math.max(0, t.now - t.startedAt - Math.max(0, t.pausedNow - t.pausedAtStart));

export interface Spent {
  activeMs: number;
  steps: number;
  tokens: number;
}

export type Exhausted = "steps" | "time" | "tokens";

/**
 * Which limit, if any, says the run may not start another step.
 *
 * Asked BEFORE a step, so a budget is a line a run may not start past, not one it cannot cross:
 * the step that begins just under it can overshoot by one reply (AGENT_STEP_MAX_TOKENS at most).
 * Cutting a reply off mid-sentence to land exactly on the number would waste the whole reply.
 */
export const exhausted = (budget: LoopBudget, spent: Spent): Exhausted | null => {
  if (spent.steps >= budget.stepCeiling) return "steps";
  if (spent.tokens >= budget.tokens) return "tokens";
  if (spent.activeMs >= budget.activeMs) return "time";
  return null;
};

/** What a run that ran out says, when it gathered nothing better to say. */
export const exhaustedNote = (why: Exhausted): string =>
  why === "tokens"
    ? "Used its token budget without concluding."
    : why === "time"
      ? "Ran out of working time without concluding."
      : "Reached the step cap without concluding.";

/**
 * The size of the context the next request will carry, in tokens.
 *
 * The server's own count from the last call is exact for what that call read, so it is used when
 * there is one, and only what was appended (or removed) since is estimated from characters.
 */
export const contextTokens = (m: { charsAtMeasure: number; measuredTokens: null | number; totalChars: number }): number =>
  m.measuredTokens == null
    ? estimateTokens(m.totalChars)
    : Math.max(0, m.measuredTokens + Math.sign(m.totalChars - m.charsAtMeasure) * estimateTokens(Math.abs(m.totalChars - m.charsAtMeasure)));

/** One tool result sitting in the message history. */
export interface ResultNote {
  /** Length of the tool's output as it was shown. */
  chars: number;
  /** Where the message is in `messages`. */
  index: number;
  status: string;
  stubbed: boolean;
  tool: string;
}

/**
 * Which results may be set aside. Oldest first, and never:
 *   - one of the newest KEEP_RECENT_RESULTS, whatever its status;
 *   - anything that did not execute. A QUEUED line is how the run knows an approval is pending
 *     and under which id, and a denial or an error is what stops it trying the same call again.
 *     They are short, and they are instructions to the run about its own state;
 *   - a result too short to be worth the rewrite;
 *   - one already stubbed.
 */
export const stubbable = (notes: ResultNote[]): ResultNote[] =>
  notes
    .slice(0, Math.max(0, notes.length - KEEP_RECENT_RESULTS))
    .filter((n) => !n.stubbed && n.status === "executed" && n.chars >= STUB_MIN_CHARS);

/** Whether to compact now. See the three rules in the header. */
export const shouldCompact = (s: { contextTokens: number; freeableChars: number; lastCompactStep: null | number; step: number }): boolean =>
  s.contextTokens > LOCAL_CONTEXT_TOKENS * COMPACT_AT_SHARE &&
  (s.lastCompactStep == null || s.step - s.lastCompactStep >= COMPACT_MIN_GAP_STEPS) &&
  estimateTokens(s.freeableChars) >= COMPACT_MIN_SAVING_TOKENS;

/** 1234567 -> "1,234,567", the same fixed grouping `stash.ts` uses in its footers. */
const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * What stands in for a result that was set aside. It names the tool and the size, says plainly
 * that the call DID run (a stub that read as "no result" would invite the same call again), and
 * gives the exact call that brings the text back.
 */
export const stubText = (s: { chars: number; ref: string; tool: string }): string =>
  `[agentspine] Set aside to save room: the ${s.tool} result you already read here (${group(s.chars)} characters). ` +
  `The call ran and its outcome stands. Do not repeat it. ` +
  `To read the text again: {"action":"tool","tool":"read_more","args":{"ref":"${s.ref}","offset":0}}`;
