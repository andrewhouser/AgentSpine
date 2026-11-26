/**
 * Keep a long run's context in bounds (PLAN-open-work section 10, LP3, built 2026-11-25).
 *
 * Every step resends the whole history, and on this model host prefill, not generation, is the expensive part. A run
 * that reads three long pages carries all three into every later step. So once the loop's messages pass a threshold,
 * older tool results are replaced by a stub that says what was there and how to read it again (`read_more` on a ref),
 * oldest first, until the estimate is back under a lower mark. The newest results stay whole, because those are what
 * the next step is about.
 *
 * Rarely, on purpose. A compaction rewrites history from the first stub onward, so the next request pays prefill on
 * all of it again. Going down to well under the threshold (not just under it) is what keeps this from happening every
 * step. The prefix before the run's own goal (system prompt, envelope, context, chat history) is never touched.
 *
 * The size is an estimate (characters over four), not the model's tokenizer: it decides when to act, and a wrong guess
 * by a few percent moves the moment slightly, nothing more. The numbers are in config.ts, to be set on the model host.
 */
import type { Msg } from "./llm.ts";

/** Characters per token for the estimate. English prose on Qwen-family tokenizers runs close to four. */
export const CHARS_PER_TOKEN = 4;

/** Stubs are made only for results at least this long; a short one costs less than the prefill a rewrite would. */
const MIN_STUB_CHARS = 600;

const textOf = (m: Msg): string => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));

export const estimateTokens = (messages: Msg[]): number =>
  Math.ceil(messages.reduce((n, m) => n + textOf(m).length, 0) / CHARS_PER_TOKEN);

const RESULT = /^tool result \[[a-z-]+\]:/;
const STUB = "[agentspine] Compacted";

export interface CompactOptions {
  /** Act once the estimate reaches this. */
  atTokens: number;
  /** Messages before this index are the prefix and are never changed (the run's goal is the last of them). */
  from: number;
  /** The newest this-many tool results are always kept whole. */
  keepRecent: number;
  /** Hold the full text somewhere `read_more` can reach and return its ref, or null when it cannot be held. */
  hold: (text: string) => null | string;
  /** Stop once the estimate is at or under this fraction of `atTokens`. */
  toFraction: number;
}

export interface CompactResult {
  after: number;
  before: number;
  stubs: number;
}

/** Compact in place, if needed. Returns what it did; `stubs: 0` means nothing changed. */
export const compactMessages = (messages: Msg[], o: CompactOptions): CompactResult => {
  const before = estimateTokens(messages);
  if (before < o.atTokens) return { after: before, before, stubs: 0 };
  const results: number[] = [];
  for (let i = o.from; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string" && RESULT.test(m.content) && !m.content.includes(STUB)) results.push(i);
  }
  const eligible = results.slice(0, Math.max(0, results.length - o.keepRecent));
  const target = o.atTokens * o.toFraction;
  let now = before;
  let stubs = 0;
  for (const i of eligible) {
    if (now <= target) break;
    const full = messages[i].content as string;
    if (full.length < MIN_STUB_CHARS) continue;
    const ref = o.hold(full);
    if (!ref) continue;
    const status = RESULT.exec(full)?.[0] ?? "tool result:";
    const stub =
      `${status}\n${STUB} to save room: this ${full.length.toLocaleString("en-US")}-character result is held under ref ${ref}. ` +
      `If you still need it: {"action":"tool","tool":"read_more","args":{"ref":"${ref}","offset":0}}`;
    now -= Math.ceil((full.length - stub.length) / CHARS_PER_TOKEN);
    messages[i] = { content: stub, role: "user" };
    stubs++;
  }
  return { after: stubs ? estimateTokens(messages) : before, before, stubs };
};
