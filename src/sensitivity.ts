/**
 * Private output pins the run that read it to the local model.
 *
 * `sensitivity: "private"` already means "never the cloud tier" (resolveTier refuses it), but
 * until now only calls that were private on their own, like meeting extraction, passed it. The
 * agent loop did not. A run that called `meeting_list` with a transcript put that transcript
 * in the message history, and the loop's next request carried it to whichever tier the task
 * was sized to, the cloud included if the size was `deep` and a key was set.
 *
 * So a tool declares `privateOutput` (src/types.ts), and once one has run, every later model
 * call in that run is private. The pin is keyed by the ROOT run, so a subagent that read a
 * transcript pins its parent, and a subagent started after the parent read one starts pinned.
 * The summary a child hands back is a report about what it read, which is the same material.
 *
 * The pin is also recorded on the root run's row (`runs.private`), because what a pinned run asked,
 * answered and read stays private after it ends: the search over past runs withholds it from any
 * run that is not itself pinned (PLAN-open-work section 13, H4).
 */
import { markRunPrivate } from "./memory/store.ts";
import { registry } from "./tools/index.ts";

const pinned = new Set<number>();
/** Called once when a root run becomes pinned. The runner uses it to mark the conversation local-only. */
const watchers = new Map<number, () => void>();

/** Run `fn` when `rootRunId` is (or already was) pinned. Dropped by releaseRun. */
export const watchPin = (rootRunId: null | number, fn: () => void): void => {
  if (rootRunId == null) return;
  watchers.set(rootRunId, fn);
  if (pinned.has(rootRunId)) fn();
};

/** Whether a call to `tool` returns material that must stay local. Unknown tools are not private. */
export const outputIsPrivate = (tool: string, args: unknown, projectId: null | number): boolean => {
  const decl = registry[tool]?.privateOutput;
  if (typeof decl === "function") {
    try {
      return decl(args, { projectId });
    } catch {
      return true; // cannot tell, so keep it local
    }
  }
  return decl === true;
};

/**
 * Tools that can return private material, for the learners that only see the audit log and
 * cannot tell which calls were. A per-call tool counts whole: when in doubt, local.
 */
export const privateOutputTools = (): string[] =>
  Object.values(registry)
    .filter((t) => t.privateOutput)
    .map((t) => t.name);

export const pinRun = (rootRunId: null | number): void => {
  if (rootRunId == null || pinned.has(rootRunId)) return;
  pinned.add(rootRunId);
  // Written down as well as held in memory: the set above is emptied when the run ends, and the
  // search over past runs (store.searchPastRuns) must still know, months later, that this run's
  // text is private. Its own try, so a failed write neither undoes the pin nor skips the watcher.
  try {
    markRunPrivate(rootRunId);
  } catch (err) {
    console.warn(`[sensitivity] could not record the pin on run ${rootRunId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    watchers.get(rootRunId)?.();
  } catch (err) {
    // Bookkeeping must never undo the pin: the run is already local.
    console.warn(`[sensitivity] pin watcher failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
export const isPinned = (rootRunId: null | number): boolean => rootRunId != null && pinned.has(rootRunId);
/** Called when the root run ends, so the set does not grow for the life of the server. */
export const releaseRun = (rootRunId: null | number): void => {
  if (rootRunId == null) return;
  pinned.delete(rootRunId);
  watchers.delete(rootRunId);
};
