/**
 * Sampled self-critique (LEARNING.md Phase 3.2).
 *
 * `judge()` already exists, already prefers cloud, already treats its context as untrusted,
 * and already returns a bare yes/no plus a reason — exactly the small surface this wants. On
 * roughly one CHAT run in ten it asks: did this run accomplish what was asked without wasted
 * effort? A "no" with its reason becomes a `lesson` memory, recalled before later runs.
 *
 * Two things this must get right:
 *
 * 1. **Sampling is the cost control.** A `LESSON_SAMPLE_RATE` of 0.1 makes the critique a
 *    rounding error against the runs themselves. It is applied per run, in code, so it is
 *    not something a prompt can talk the system out of.
 * 2. **Private stays private.** If the trace touched mail, files, calendar, or a browser
 *    page, the critique is pinned to the local model — the same rule `reflect.ts` follows.
 *    The decision is read from the run's own audit rows, not guessed. When in doubt, local.
 *
 * Never throws: it runs after the result is persisted, and a critique that failed is worth
 * strictly less than the run it was critiquing.
 */
import { LESSON_MEMORY_MAX, LESSON_SAMPLE_RATE } from "../config.ts";
import { judge } from "../judge.ts";
import { countMemories, pruneMemories, remember } from "./../memory/rag.ts";
import * as store from "./../memory/store.ts";
import type { Msg } from "../llm.ts";

export const LESSON_KIND = "lesson";

/**
 * Tools whose output makes a trace sensitive enough to pin the critique local. A run that
 * read mail or a file may carry that content in its trace, and a critique is a second pass
 * over the same text — so it inherits the same local-only constraint reflection has.
 */
const SENSITIVE_TOOLS = new Set(["gmail_search", "calendar_upcoming", "read_file", "list_dir", "browser", "web_read", "draft"]);

/** True if any call this run made was to a sensitive tool. Read from the audit log. */
const touchedSensitive = (runId: number): boolean =>
  store.listActions(runId).some((a: { tool?: string }) => a.tool && SENSITIVE_TOOLS.has(a.tool));

/** Flatten a trace to a compact transcript for the judge. The tail holds the outcome. */
const renderTrace = (trace: Msg[]): string => {
  const parts: string[] = [];
  let used = 0;
  for (let i = trace.length - 1; i >= 0 && used < 4000; i--) {
    const m = trace[i];
    if (m.role === "system") continue;
    const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const line = `[${m.role}] ${body.slice(0, 800)}`;
    used += line.length;
    parts.unshift(line);
  }
  return parts.join("\n\n");
};

/**
 * Critique one run with probability `LESSON_SAMPLE_RATE`. Returns the lesson stored, or null
 * when the run was not sampled, judged fine, or produced nothing usable. `sampleOverride`
 * forces the sampling decision, for tests — production always rolls the dice.
 */
export const critiqueRun = async (
  runId: number,
  task: string,
  trace: Msg[],
  summary: string,
  sampleOverride?: boolean,
): Promise<null | string> => {
  try {
    if (LESSON_SAMPLE_RATE <= 0) return null;
    const sampled = sampleOverride ?? Math.random() < LESSON_SAMPLE_RATE;
    if (!sampled) return null;

    const context =
      `The user asked: ${task}\n\n` +
      `What the assistant concluded: ${summary}\n\n` +
      `--- transcript ---\n${renderTrace(trace)}`;

    // "yes = the run was fine" — so a NO is the thing worth recording. Fallback true, so an
    // unreachable model produces no false lesson.
    const verdict = await judge(
      "Did this run accomplish what the user asked without wasted effort or wrong turns?",
      context,
      { fallback: true, sensitivity: touchedSensitive(runId) ? "private" : "normal" },
    );

    if (verdict.yes) return null; // nothing to learn from a run that went fine
    const reason = verdict.reason.trim();
    if (!reason) return null;

    const lesson = `On a task like "${task.slice(0, 120)}", a past run fell short: ${reason}`;
    if (!(await remember(lesson, LESSON_KIND))) return null; // duplicate of a known lesson

    if (countMemories(LESSON_KIND) > LESSON_MEMORY_MAX) pruneMemories(LESSON_KIND, LESSON_MEMORY_MAX);
    console.log(`[critique] lesson: ${reason}`);
    return lesson;
  } catch (err) {
    console.warn(`[critique] skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
};
