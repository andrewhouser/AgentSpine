/**
 * What of a half-written reply may be put on screen (LP1).
 *
 * A step's reply is either the answer or a tool call, and which one is not always known from
 * its first token. So this errs toward holding text back: a late answer costs a moment, while
 * a tool call flashed at the user as if it were their reply is a visible bug. Nothing here is
 * authoritative. The `final` event and the stored turn are the answer; this is a preview of
 * it, and `retract` takes the preview back whenever the step turns out to be something else.
 */
import { stripControlTokens } from "./llm.ts";

/** A reply that only announces work. Accepted as an answer, it would end the turn with the work undone. */
export const PROMISE_ONLY = /^(?:okay[,.]?\s+|sure[,.!]?\s+)?(?:i'll|i will|i'm going to|i am going to|let me)\b/i;
export const PROMISE_MAX_CHARS = 200;

/** Long enough to tell every PROMISE_ONLY opening, and a JSON code fence, from ordinary prose. */
const MIN_VISIBLE_CHARS = 24;

/**
 * Snapshot pacing. Each event carries the whole text so a reconnect can never duplicate or
 * lose a piece, so a long answer sends larger events and gets them less often. At 28 tok/s,
 * 120ms is about every third token. 4,096 tokens is roughly 16KB, so the slower pace holds
 * the worst case near 40KB/s for a phone on a weak connection.
 */
const FAST_INTERVAL_MS = 120;
const SLOW_INTERVAL_MS = 400;
const SLOW_AFTER_CHARS = 2000;

const TOOL_CALL = /\{\s*"(?:action|tool)"\s*:/;
const PARTIAL_CONTROL_TOKEN = /<(?:\|[a-z0-9_]*\|?|\/s?)?$/i;
const PARTIAL_JSON_OPENING = /\{\s*(?:"[a-z]*"?\s*)?$/i;

/** The part of a partial reply that is safe to show, or null while it could still be a tool call. */
export const visibleAnswer = (raw: string): null | string => {
  const body = stripControlTokens(raw.replace(PARTIAL_CONTROL_TOKEN, ""));
  if (body.length < MIN_VISIBLE_CHARS || body.startsWith("{") || TOOL_CALL.test(body)) return null;
  if (body.length <= PROMISE_MAX_CHARS && PROMISE_ONLY.test(body)) return null;
  return body.replace(PARTIAL_JSON_OPENING, "").trimEnd() || null;
};

export interface AnswerPublisher {
  retract: () => void;
  /** The reply so far. An empty string means a new attempt has started. */
  update: (raw: string) => void;
}

export const answerPublisher = (emit: (text: string) => void, now: () => number = Date.now): AnswerPublisher => {
  let blocked = false;
  let lastAt = 0;
  let shown = false;

  const retract = (): void => {
    if (shown) emit("");
    shown = false;
    lastAt = 0;
  };

  const update = (raw: string): void => {
    if (!raw) {
      blocked = false;
      retract();
      return;
    }
    if (blocked) return;
    const text = visibleAnswer(raw);
    if (text === null) {
      // Text that was showable and no longer is has turned into a tool call.
      if (shown) {
        blocked = true;
        retract();
      }
      return;
    }
    const interval = text.length > SLOW_AFTER_CHARS ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS;
    const at = now();
    if (shown && at - lastAt < interval) return;
    shown = true;
    lastAt = at;
    emit(text);
  };

  return { retract, update };
};
