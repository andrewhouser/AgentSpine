/**
 * Reversible truncation for over-long tool results.
 *
 * ## The problem this replaces
 *
 * Every tool that returns bulk external text used to end in a hard `.slice(0, N)`. A
 * 9,000-character file came back as 8,000 characters with no indication that a ninth
 * thousand had ever existed — so a model that had been handed the wrong 8,000 could not
 * know it, and neither could you reading the trace afterwards. Silent truncation is the
 * worst shape a limit can take: the caller is confidently told a partial answer.
 *
 * The cap itself is not the problem and is not going away. The `standard` tier is a local
 * 30B whose context is the binding constraint here — not cost, which is zero — so pasting
 * a whole log file into the loop is not an option. What changes is that the remainder is
 * kept rather than dropped, and the model is told, in the result itself, exactly how much
 * was withheld and exactly what to call to get it.
 *
 * ## Why the tagging lives here too
 *
 * `clip` wraps the visible slice in `tagUntrusted` itself instead of leaving that to each
 * caller, and `read_more` re-tags the same way. Those two halves are the same bytes from
 * the same hostile source, and the only way they can end up tagged differently is if one
 * call site forgets. Doing both in one function means that cannot happen.
 *
 * ## Why the footer sits outside the untrusted block
 *
 * The footer names a ref the model is invited to act on, so it must not read as content a
 * page could have written. It is appended after `tagUntrusted` has closed out its own
 * text, in the same position as the injection-scan warning.
 *
 * That is presentation, not the defence. A page is perfectly free to write a convincing
 * fake footer into its own body and it buys nothing: refs are random and are looked up
 * with the current run id bound into the query (see `stashGet`), so a forged ref either
 * misses entirely or names a row belonging to a run that is not this one, which is the
 * same miss. There is no ref a hostile page can name that reaches anything it could not
 * already see.
 */
import { randomBytes } from "node:crypto";

import { tagUntrusted } from "./audit.ts";
import { STASH_MAX_CHARS } from "./config.ts";
import * as store from "./memory/store.ts";

/** 1234567 -> "1,234,567". Fixed grouping rather than toLocaleString, which follows the host. */
const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const newRef = (): string => randomBytes(6).toString("hex");

export interface ClipCtx {
  /** The visible slice, in characters. The withheld tail starts here. */
  max: number;
  /** Which run may read the remainder back. Null disables the stash — see below. */
  runId: number | null;
  /** Human label for the source, e.g. `file ~/notes.md` or `page https://…`. */
  source: string;
  /** The calling tool's registry name, for the ledger. */
  tool: string;
  /** False only for content this machine authored. Defaults to true. */
  untrusted?: boolean;
}

/**
 * Clip `text` to `ctx.max`, keep the rest where `read_more` can reach it, and say so.
 *
 * Returns the exact string the tool should hand back. When nothing was cut this is just
 * the tagged text, byte for byte what the old `.slice()` produced — the common case pays
 * nothing, writes no row, and reads no differently.
 */
export const clip = (ctx: ClipCtx, text: string): string => {
  const untrusted = ctx.untrusted !== false;
  const body = String(text ?? "");
  const tag = (s: string): string => (untrusted ? tagUntrusted(ctx.source, s) : s);

  if (body.length <= ctx.max) return tag(body);

  const head = body.slice(0, ctx.max);

  /**
   * Without a run there is nobody who could ask for the rest — `read_more` is scoped to
   * the run that stashed — so say what was cut and skip the row. Being told the answer is
   * partial is most of the value even when the remainder is unreachable.
   */
  if (ctx.runId == null) {
    return (
      tag(head) +
      `\n\n[agentspine] Truncated: showed ${group(ctx.max)} of ${group(body.length)} characters. ` +
      `The rest is not retrievable from this context.`
    );
  }

  /**
   * A ceiling on what is retained, because `read_file` on a 200MB log should not put 200MB
   * into spine.db. Past this the tail is genuinely gone, and the footer says so rather
   * than offering an offset that would return nothing.
   */
  const kept = body.slice(0, STASH_MAX_CHARS);
  const ref = newRef();
  store.stashPut(ctx.runId, {
    content: kept,
    ref,
    shown: ctx.max,
    source: ctx.source,
    tool: ctx.tool,
    untrusted,
  });

  const retrievable = kept.length - ctx.max;
  const dropped = body.length - kept.length;

  return (
    tag(head) +
    `\n\n[agentspine] Showed ${group(ctx.max)} of ${group(body.length)} characters. ` +
    `${group(retrievable)} more are held locally under ref ${ref}` +
    (dropped > 0 ? `, and ${group(dropped)} beyond that were dropped` : "") +
    `.\nTo read on: {"action":"tool","tool":"read_more","args":{"ref":"${ref}","offset":${ctx.max}}}`
  );
};

export interface ReadMoreResult {
  ok: boolean;
  text: string;
}

/**
 * The other half: hand back one window of a stashed remainder.
 *
 * Deliberately stateless — the window is `(offset, offset + shown)` and nothing advances a
 * cursor. A model that repeats a call gets the same answer, which is what the loop's
 * repeat guard in `agent.ts` is written to detect; a cursor that moved on retry would turn
 * that guard into a way to skip content silently.
 */
export const readMore = (runId: number | null, ref: string, offset: number): ReadMoreResult => {
  if (runId == null) return { ok: false, text: "ERROR: read_more is not available outside a run." };
  if (!/^[0-9a-f]{12}$/.test(ref)) return { ok: false, text: `ERROR: ${JSON.stringify(ref)} is not a ref.` };

  const row = store.stashGet(runId, ref);
  if (!row) {
    return {
      ok: false,
      text:
        `ERROR: no held content under ref ${ref}. A ref is readable only by the run that ` +
        `produced it, and only until that run ends. Work with what you already have.`,
    };
  }

  const total = row.content.length;
  const start = Math.min(Math.max(0, Math.floor(offset)), total);
  if (start >= total) {
    return { ok: true, text: `[agentspine] ref ${ref} — ${row.source}: nothing further, all ${group(total)} characters have been shown.` };
  }

  const window = Math.max(1, row.shown);
  const end = Math.min(start + window, total);
  const chunk = row.content.slice(start, end);
  const remaining = total - end;

  const header = `[agentspine] ref ${ref} — ${row.source}, characters ${group(start)}–${group(end)} of ${group(total)}.`;
  const footer =
    remaining > 0
      ? `\n\n[agentspine] ${group(remaining)} characters remain. ` +
        `Next: {"action":"tool","tool":"read_more","args":{"ref":"${ref}","offset":${end}}}`
      : `\n\n[agentspine] That was the end of ${row.source}.`;

  const body = row.untrusted ? tagUntrusted(row.source, chunk) : chunk;
  return { ok: true, text: `${header}\n${body}${footer}` };
};
