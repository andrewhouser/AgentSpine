/**
 * Where the agent is allowed to read, in one place.
 *
 * Extracted from `tools/read-file.ts` when project indexing became a second reader of the
 * filesystem. Two independent implementations of a containment check is exactly the
 * situation where one of them quietly stops resolving symlinks and nobody notices — so
 * both the `read_file` tool and the project indexer call these.
 *
 * The rule: expand `~`, resolve the real path (following symlinks), and only then check it
 * is inside an allowlisted directory. Resolving first is what stops a symlink placed inside
 * an allowed directory from pointing anywhere else on the disk.
 */
import fs from "node:fs";
import path from "node:path";

import { homeDir } from "./config.ts";
import type { Policy } from "./types.ts";

export const expand = (p: string): string => path.resolve(String(p ?? "").replace(/^~(?=$|\/)/, homeDir));

/** Resolve symlinks where the path exists; fall back to the lexical resolve otherwise. */
export const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** Is `target` inside one of `dirs`, after expansion and symlink resolution? */
export const insideAny = (dirs: string[] | undefined, target: string): boolean => {
  const t = real(expand(target));
  return (dirs ?? []).some((d) => {
    const dir = real(expand(d));
    return t === dir || t.startsWith(dir + path.sep);
  });
};

export const insideReadable = (policy: Policy, target: string): boolean =>
  insideAny(policy.fs?.readableDirs, target);

export const readableGate = (policy: Policy, p: string) =>
  insideReadable(policy, p)
    ? { allowed: true, reason: "inside policy.fs.readableDirs" }
    : { allowed: false, reason: `${expand(p)} is outside policy.fs.readableDirs (deny by default)` };

/**
 * Like `real`, for a path that may not exist yet: resolve the nearest EXISTING ancestor
 * through symlinks and re-attach the rest. A file about to be created inside a symlinked
 * directory is judged by where that directory really is.
 */
export const realForWrite = (p: string): string => {
  let head = expand(p);
  const tail: string[] = [];
  while (!fs.existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  return path.join(real(head), ...tail);
};

/** Is `target` inside one of `policy.fs.writableDirs`? Absent or empty means no. */
export const insideWritable = (policy: Policy, target: string): boolean => {
  const t = realForWrite(target);
  return (policy.fs?.writableDirs ?? []).some((d) => {
    const dir = real(expand(d));
    return t === dir || t.startsWith(dir + path.sep);
  });
};
