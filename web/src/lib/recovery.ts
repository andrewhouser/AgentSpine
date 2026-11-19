import type { BrokerStatus } from "./types.ts";

/**
 * Which failed tool calls the turn went on to get past.
 *
 * A name lookup that misses, then a search that finds it, is the loop doing its job, and a red
 * "error" node with a "1 failed" flag on that turn reads as though something broke. So an
 * `error` call is *recovered* when a LATER call in the same turn was executed.
 *
 * This is a heuristic and is labelled as one: it cannot know the later call was a substitute
 * for the failed one rather than unrelated work, so a recovered call is shown muted and
 * explained, never hidden. What it never softens:
 *
 * - `denied` is the broker doing its job, and never incidental, so it is never recovered.
 * - A turn that itself failed (`turnFailed`) keeps every error as it was, because "a later call
 *   ran" proves nothing about a turn that did not finish.
 * - A call that is still running or waiting on approval is not a recovery.
 *
 * Returns one flag per call, in the same order, so a caller can zip it with its own list.
 */
export const recoveredCalls = (calls: readonly { status: BrokerStatus | null }[], turnFailed = false): boolean[] =>
  calls.map(
    (call, i) =>
      !turnFailed &&
      call.status === "error" &&
      calls.slice(i + 1).some((later) => later.status === "executed"),
  );
