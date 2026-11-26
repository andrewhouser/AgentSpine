/**
 * The files that enforce AgentSpine's own gates (PLAN-open-work section 10, SC6, decided 2026-11-25).
 *
 * No tool may write `policy.json`, `profile.md`, `goals.md` or `agents/*.md` (LEARNING invariant 1). But a builder
 * that cannot write the policy could still edit the code that reads it: the broker, the local-only pin, the
 * confirmation queue, the promoter that writes auto-approvals, the test that pins all of that, and the modules that
 * hold the Google and Instagram write tokens. An edit to one of these is not refused (fixing them is real work) but
 * it is classified irreversible, so it queues in a chat and from a schedule alike, and the card shows the change.
 *
 * The list (widened 2026-11-26) is four groups, because a guard is only as good as the code around it:
 *   - the gates and what they read: the broker, the queue, the promoter, the local pin, the outgoing check, the
 *     policy loader (`config.ts`), the project narrowing, and this file;
 *   - the path a model's call takes to reach them: the loop, the runner, the run facts (`harness.ts`), the registry;
 *   - the tools that can change a checkout or start the builder: the write tools (which enforce this list), git,
 *     declared commands, `propose_change`, and the folder scoping they share;
 *   - the modules that hold the Google and Instagram write tokens, the browser, and the test that pins all of it.
 * It is still not a sandbox. The builder works in a second clone and merging stays with the person, which is the
 * real gate; this makes sure a change to one of these is seen as a card on the way.
 *
 * A write tool is not the only way to change a file: a declared command runs code, and `npm test` runs whatever test
 * file was just written. `keepingProtected` wraps those: a protected or control file a command changed is put back,
 * and the change is queued as a card, so the rule holds on that route too.
 *
 * Paths are relative to an AgentSpine checkout, and a checkout is any folder whose package.json is named
 * "agentspine", so a separate clone for the builder (SC7) is covered as well as the one the service runs from.
 * Matching ignores case, because the Mac's disk does ("src/Broker.ts" is src/broker.ts), and follows symlinks.
 * test/architecture.test.mjs pins this list, so shortening it is itself an edit to a protected file.
 */
import fs from "node:fs";
import path from "node:path";

export const PROTECTED_PATHS = [
  "src/agent.ts",
  "src/broker.ts",
  "src/config.ts",
  "src/confirmations.ts",
  "src/decision-card.ts",
  "src/fs-scope.ts",
  "src/google/write.ts",
  "src/harness.ts",
  "src/instagram/api.ts",
  "src/instagram/token.ts",
  "src/learn/promote.ts",
  "src/modes.ts",
  "src/outgoing.ts",
  "src/projects/narrow-policy.ts",
  "src/protected-paths.ts",
  "src/runner.ts",
  "src/sensitivity.ts",
  "src/tools/browser.ts",
  "src/tools/git-write.ts",
  "src/tools/index.ts",
  "src/tools/propose-change.ts",
  "src/tools/run-command.ts",
  "src/tools/write-file.ts",
  "test/architecture.test.mjs",
] as const;

/**
 * The control files no tool may write at all (LEARNING invariant 1; `isControlFile` in tools/write-file.ts holds
 * the rule for the write tools). Named here as well because a command can write them too, and `keepingProtected`
 * puts them back. `agents/*.md` is matched as a folder.
 */
const CONTROL_PATHS = ["policy.json", "profile.md", "goals.md", "modes.json", "src/area-map.md"] as const;
// The units folder, relative to a checkout. Not config.ts's AGENTS_DIR (this install's own folder, which only
// agents.ts reads): this is the same folder in whichever checkout a command ran in, and it is only ever put back.
const UNITS_FOLDER = "agents";

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

/** Whether this folder is an AgentSpine checkout: its package.json is named "agentspine". */
export const isCheckout = (dir: string): boolean => {
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

// --- commands -------------------------------------------------------------------------------

/** The AgentSpine checkout this folder is in, or null. */
const checkoutOf = (dir: string): null | string => {
  for (let at = realish(dir); ; at = path.dirname(at)) {
    if (isCheckout(at)) return at;
    if (path.dirname(at) === at) return null;
  }
};

const readOrNull = (file: string): Buffer | null => {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
};

/**
 * Run something that executes code where it likes (a declared command), and put back any protected or control file
 * it changed, created or removed. Returns what `fn` returned and one line per file put back.
 *
 * The change is not thrown away. A change to a protected file is queued as the `write_file` call that would make it,
 * with the diff on the card, so "an edit to a gate waits for the user" holds on this route too. A control file has no
 * card, because no tool may write one even with an approval: the changed copy is kept under `data/put-back/` and the
 * report names it. That also covers the awkward case of the owner editing one of these by hand while a long command
 * happens to be running: the edit is put back with everything else, and it is not lost.
 *
 * Only inside an AgentSpine checkout. A build of some other repository is run as it is.
 */
export const keepingProtected = async <T>(
  cwd: string,
  fn: () => Promise<T>,
  queue: (call: { args: { content: string; path: string }; tool: string }, summary: string) => number,
): Promise<{ putBack: string[]; value: T }> => {
  const base = checkoutOf(cwd);
  if (!base) return { putBack: [], value: await fn() };

  const abs = (rel: string): string => path.join(base, ...rel.split("/"));
  const agentFiles = (): string[] => {
    try {
      return fs
        .readdirSync(abs(UNITS_FOLDER))
        .filter((f) => f.toLowerCase().endsWith(".md"))
        .map((f) => `${UNITS_FOLDER}/${f}`);
    } catch {
      return [];
    }
  };
  const before = new Map<string, Buffer | null>();
  for (const rel of [...PROTECTED_PATHS, ...CONTROL_PATHS, ...agentFiles()]) before.set(rel, readOrNull(abs(rel)));

  const restore = (): string[] => {
    const putBack: string[] = [];
    // A unit file the command created is as much a change as one it edited.
    for (const rel of agentFiles()) if (!before.has(rel)) before.set(rel, null);
    for (const [rel, was] of before) {
      const now = readOrNull(abs(rel));
      if (was == null && now == null) continue;
      if (was != null && now != null && was.equals(now)) continue;
      try {
        if (was == null) fs.rmSync(abs(rel), { force: true });
        else {
          fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
          fs.writeFileSync(abs(rel), was);
        }
      } catch {
        // Named all the same: the report is then the only place a person learns the file is not what it was.
        putBack.push(`${rel} (could NOT be put back)`);
        continue;
      }
      if (now == null) {
        putBack.push(`${rel} (it had been removed)`);
        continue;
      }
      const protectedRel = PROTECTED_PATHS.find((p) => p === rel);
      try {
        if (protectedRel) {
          const id = queue(
            { args: { content: now.toString("utf8"), path: abs(rel) }, tool: "write_file" },
            `A command changed PROTECTED FILE ${rel} (${abs(rel)}), which enforces AgentSpine's own safety gates. It was put back. ` +
              `Approving makes the change:\n${diffPreview(was == null ? "" : was.toString("utf8"), now.toString("utf8"))}`,
          );
          putBack.push(`${rel} (the change is waiting for the user's approval as #${id})`);
        } else {
          const kept = path.join(base, "data", "put-back", `${new Date().toISOString().replace(/[:.]/g, "-")}-${rel.replace(/[\\/]/g, "_")}`);
          fs.mkdirSync(path.dirname(kept), { recursive: true });
          fs.writeFileSync(kept, now);
          putBack.push(`${rel} (no tool or command may change it; the changed copy is kept at ${kept})`);
        }
      } catch {
        putBack.push(rel);
      }
    }
    return putBack;
  };

  try {
    const value = await fn();
    return { putBack: restore(), value };
  } catch (err) {
    restore();
    throw err;
  }
};

/** What to add to a tool's report when `keepingProtected` put something back. Empty when it did not. */
export const putBackNote = (putBack: string[]): string =>
  putBack.length
    ? `\nPROTECTED FILES PUT BACK: ${putBack.join("; ")}. That command changed them, and a change to one of AgentSpine's own ` +
      `gates takes effect only when the user approves it. Do not make the change again another way.`
    : "";
