/**
 * Tool-friction memory (LEARNING.md Phase 1.2).
 *
 * Small models fail the same way repeatedly. When a call comes back `decision='error'`, we
 * store what went wrong and put the correction back where it will be read: not in a memory
 * the model has to think to recall, but appended to the failing tool's OWN description, at
 * prompt-assembly time. A note next to the tool it concerns is worth more than a note in a
 * store the model has to remember to search.
 *
 * ## The error class is derived in code, never by a model
 *
 * `classifyError` is a regex table, not inference — because the error string can contain
 * fetched page content, and running a model over hostile text to summarize it is exactly the
 * injection surface Phase 1 is designed not to have. A pattern that matches nothing falls
 * back to a truncated, single-lined copy of the message, which is still safe: it becomes tool
 * documentation, never an instruction, and it is length-capped.
 *
 * ## Where the two halves connect
 *
 *   - `recordFriction(tool, errorText)` — called from the broker's error path in `broker.ts`.
 *   - `frictionDocs(tool)` — called from `toolDocs` in `agent.ts` while the prompt is built.
 *
 * Both are inference-free and neither throws: a learner that fails a run is worse than one
 * that learns nothing.
 */
import { FRICTION_MEMORY_MAX } from "../config.ts";
import { rememberFriction } from "./../memory/rag.ts";
import { frictionForTool } from "./../memory/store.ts";

/**
 * Map an error string to a short, stable class. Order matters — the first match wins — so
 * the more specific patterns come first. Everything here is a fixed regex; none of it reads
 * the error as anything but text to bucket.
 */
const ERROR_CLASSES: [RegExp, string][] = [
  [/timed?\s*out|timeout|etimedout|deadline/i, "timeout"],
  [/econnrefused|connection refused|refused to connect/i, "connection refused"],
  [/enotfound|getaddrinfo|dns|could not resolve/i, "host not found"],
  [/\b(429|rate.?limit|too many requests)\b/i, "rate limited"],
  [/\b(401|403|unauthor|forbidden|permission denied)\b/i, "unauthorized"],
  [/\b(404|not found|no such file|enoent)\b/i, "not found"],
  [/\b(5\d\d|server error|bad gateway|unavailable)\b/i, "server error"],
  [/robots|blocked by|captcha|automation/i, "blocked"],
  [/parse|json|unexpected token|malformed|invalid.*(json|xml|html)/i, "unparseable response"],
  [/\bpdf\b/i, "pdf"],
  [/too large|exceeds|payload|entity too large/i, "response too large"],
];

/** The stored error text is `ERROR: <message>`; strip the prefix and flatten to one line. */
const cleanError = (raw: string): string =>
  String(raw ?? "")
    .replace(/^ERROR:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

export const classifyError = (raw: string): string => {
  const msg = cleanError(raw);
  for (const [pattern, label] of ERROR_CLASSES) if (pattern.test(msg)) return label;
  // No pattern matched: keep a trimmed copy of the message itself. Safe — it lands as tool
  // documentation, never as an instruction — and length-capped so a page cannot pad it out.
  return msg.slice(0, 80) || "unknown error";
};

/**
 * Record one tool failure. `errorText` is the broker's `output` for an errored call. Returns
 * whether a new friction row was written (false on a duplicate or empty input).
 */
export const recordFriction = (tool: string, errorText: string): boolean => {
  const cls = classifyError(errorText);
  return rememberFriction(tool, cls, FRICTION_MEMORY_MAX);
};

/**
 * The friction line appended to a tool's description in the system prompt, or empty string
 * when this tool has none. Deduped classes are counted so "3× timeout" reads as a pattern
 * rather than three separate notes.
 */
export const frictionDocs = (tool: string): string => {
  if (FRICTION_MEMORY_MAX <= 0) return "";
  const rows = frictionForTool(tool, FRICTION_MEMORY_MAX);
  if (!rows.length) return "";

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r, (counts.get(r) ?? 0) + 1);
  const phrases = [...counts.entries()].map(([cls, n]) => (n > 1 ? `${n}× ${cls}` : cls));
  return `Recent failures with this tool: ${phrases.join("; ")}.`;
};
