/**
 * The files that enforce AgentSpine's own gates (PLAN-open-work section 10, SC6, decided 2026-11-25).
 *
 * No tool may write `policy.json`, `profile.md`, `goals.md` or `agents/*.md` (LEARNING invariant 1). But a builder
 * that cannot write the policy could still edit the code that reads it: the broker, the local-only pin, the
 * confirmation queue, the promoter that writes auto-approvals, the test that pins all of that, and the modules that
 * hold the Google and Instagram write tokens. An edit to one of these is not refused (fixing them is real work) but
 * it is classified irreversible, so it queues in a chat and from a schedule alike, and the card shows the change.
 *
 * Paths are relative to an AgentSpine checkout, and a checkout is any folder whose package.json is named
 * "agentspine", so a separate clone for the builder (SC7) is covered as well as the one the service runs from.
 * Matching ignores case, because the Mac's disk does ("src/Broker.ts" is src/broker.ts), and follows symlinks.
 * test/architecture.test.mjs pins this list, so shortening it is itself an edit to a protected file.
 */
import fs from "node:fs";
import path from "node:path";

export const PROTECTED_PATHS = [
  "src/broker.ts",
  "src/confirmations.ts",
  "src/google/write.ts",
  "src/instagram/api.ts",
  "src/instagram/token.ts",
  "src/learn/promote.ts",
  "src/outgoing.ts",
  "src/protected-paths.ts",
  "src/sensitivity.ts",
  "src/tools/browser.ts",
  "test/architecture.test.mjs",
] as const;

const LOWER = new Set(PROTECTED_PATHS.map((p) => p.toLowerCase()));

/** The real path, or for a file not yet written, its real folder plus its name. */
const realish = (target: string): string => {
  try {
    return fs.realpathSync(target);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
    } catch {
      return path.resolve(target);
    }
  }
};

const isCheckout = (dir: string): boolean => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))?.name === "agentspine";
  } catch {
    return false;
  }
};

/** The repo-relative protected path this target is, or null. Checks every AgentSpine checkout above it. */
export const protectedPathOf = (target: string): null | string => {
  if (!target) return null;
  const real = realish(target);
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    if (isCheckout(dir)) {
      const rel = path.relative(dir, real).split(path.sep).join("/").toLowerCase();
      if (LOWER.has(rel)) return PROTECTED_PATHS.find((p) => p.toLowerCase() === rel) ?? rel;
    }
    if (path.dirname(dir) === dir) return null;
  }
};

const MAX_DIFF_LINES = 40;

/**
 * What would change, for the approval card: the lines between the unchanged start and end, old with "- " and new
 * with "+ ", capped. Not a full diff algorithm, and it does not need to be: a reviewer needs to see the change, and a
 * change too big for 40 lines is one to read in the editor, which the card then says.
 */
export const diffPreview = (before: string, after: string): string => {
  if (before === after) return "(no change)";
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const lines = [`@@ line ${start + 1}`, ...a.slice(start, endA).map((l) => `- ${l}`), ...b.slice(start, endB).map((l) => `+ ${l}`)];
  if (lines.length <= MAX_DIFF_LINES) return lines.join("\n");
  return `${lines.slice(0, MAX_DIFF_LINES).join("\n")}\n... ${lines.length - MAX_DIFF_LINES} more changed lines: read the whole change before approving`;
};
