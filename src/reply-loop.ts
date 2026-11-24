/**
 * Spot a reply that has stopped saying anything new: the same block of lines, over and over.
 *
 * Observed 2026-11-24 on the standard local tier: asked for gift ideas, the model wrote its
 * tool calls as bare text instead of the JSON protocol, then repeated one of them
 * (`web_search` / `query=…` / `recency=month`) until the 4,096-token cap. That took 3m56s,
 * ran no tool, and the 13,286 characters of repeats were shown as the answer. Nothing bounded
 * it but the cap, and the cap is sized for a long research answer.
 *
 * Pure and cheap, so the stream reader can ask after every line and hang up early. It only
 * sees whole lines: a loop with no newline in it still runs to the cap.
 */

/**
 * Consecutive identical blocks before it counts. Six, because "write this line five times" and
 * a table of identical rows are honest replies, and the wait for the extra repeats is small:
 * the observed three-line block is about 25 tokens, so six of them is roughly five seconds.
 */
export const LOOP_REPEATS = 6;
/** The longest repeating block looked for, in lines. The observed one was three. */
export const LOOP_MAX_BLOCK_LINES = 8;
/** Shorter blocks repeat honestly: closing braces, table rules, "ha ha ha". */
export const LOOP_MIN_BLOCK_CHARS = 24;

export const loopingReply = (text: string): boolean => {
  // The last line may still be arriving, so it is left out until its newline lands.
  const whole = text.endsWith("\n") ? text : text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  const lines = whole.split("\n").map((l) => l.trim()).filter(Boolean);
  const n = lines.length;
  for (let size = 1; size <= LOOP_MAX_BLOCK_LINES && size * LOOP_REPEATS <= n; size++) {
    let chars = 0;
    for (let i = n - size; i < n; i++) chars += lines[i].length;
    if (chars < LOOP_MIN_BLOCK_CHARS) continue;
    let same = true;
    for (let i = n - size * LOOP_REPEATS; same && i < n - size; i++) same = lines[i] === lines[i + size];
    if (same) return true;
  }
  return false;
};
