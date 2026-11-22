/**
 * search_files: find text across the files in an allowlisted folder (docs/PLAN-open-work.md, SC2).
 *
 * Before this the builder could only walk with list_dir and open files one at a time, so "how does
 * the outbox decide quiet hours?" had no good answer. Same gate and `privateOutput` as read_file.
 *
 * The query is a literal, on purpose. A regular expression written by the model runs on the server's
 * one event loop, and a catastrophic pattern over a large file would stall the dashboard and the
 * scheduler with it. Files are read asynchronously for the same reason.
 *
 * A search sweeps files nobody named, so it is stricter than read_file: it does not follow symlinks,
 * and it skips dot-folders and credential-shaped files. Naming such a file to read_file still works,
 * because that is a deliberate read of one path.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expand, readableGate, real } from "../fs-scope.ts";
import { clip } from "../stash.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

/** The limits live here rather than in the description: code owns the numbers. */
export const SEARCH_LIMITS = {
  filesScanned: 5000,
  matches: 100,
  matchesPerFile: 5,
  maxFileBytes: 1_000_000,
  maxLineChars: 200,
  minQueryChars: 2,
  timeMs: 5000,
} as const;

// Only names that are nearly always generated. "public" and "vendor" can hold real work in someone's folder.
const SKIP_DIRS = new Set(["build", "coverage", "DerivedData", "dist", "node_modules", "Pods"]);
const SECRET_FILE = /^\.env(\..*)?$|\.(pem|p12|pfx|key|keystore)$|^(credentials|secrets?)(\.[a-z]+)?$|^id_(rsa|dsa|ecdsa|ed25519)$/i;

const available = (policy: Policy): PolicyDecision =>
  (policy.fs?.readableDirs?.length ?? 0) > 0
    ? { allowed: true, reason: "policy.fs.readableDirs is not empty" }
    : { allowed: false, reason: "policy.fs.readableDirs is empty (deny by default)" };

const normalizeExt = (raw: unknown): string | null => {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return null;
  return text.startsWith(".") ? text : `.${text}`;
};

const excerpt = (line: string, at: number): string => {
  const max = SEARCH_LIMITS.maxLineChars;
  const trimmed = line.trim();
  if (trimmed.length <= max) return trimmed;
  const offset = Math.max(0, at - (line.length - line.trimStart().length) - Math.floor(max / 3));
  const slice = trimmed.slice(offset, offset + max);
  return `${offset > 0 ? "…" : ""}${slice}${offset + max < trimmed.length ? "…" : ""}`;
};

interface Sweep {
  ext: string | null;
  files: number;
  lines: string[];
  needle: string;
  root: string;
  stopped: string | null;
  deadline: number;
}

const searchFile = async (file: string, sweep: Sweep): Promise<void> => {
  let text: string;
  try {
    const info = await fs.stat(file);
    if (info.size > SEARCH_LIMITS.maxFileBytes) return;
    const bytes = await fs.readFile(file);
    if (bytes.subarray(0, 8000).includes(0)) return; // binary
    text = bytes.toString("utf8");
  } catch {
    return; // unreadable files are not worth failing a whole search over
  }
  if (!text.toLowerCase().includes(sweep.needle)) return;
  let inFile = 0;
  const rel = path.relative(sweep.root, file) || path.basename(file);
  for (const [index, line] of text.split("\n").entries()) {
    const at = line.toLowerCase().indexOf(sweep.needle);
    if (at < 0) continue;
    sweep.lines.push(`${rel}:${index + 1}: ${excerpt(line, at)}`);
    inFile += 1;
    if (sweep.lines.length >= SEARCH_LIMITS.matches) {
      sweep.stopped = `stopped at ${SEARCH_LIMITS.matches} matches`;
      return;
    }
    if (inFile >= SEARCH_LIMITS.matchesPerFile) return;
  }
};

const walk = async (dir: string, sweep: Sweep): Promise<void> => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (sweep.stopped) return;
    if (Date.now() > sweep.deadline) {
      sweep.stopped = `stopped after ${SEARCH_LIMITS.timeMs / 1000} seconds`;
      return;
    }
    // Dirent reports a symlink as a symlink, so neither branch below ever walks out of the folder.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      await walk(full, sweep);
    } else if (entry.isFile()) {
      if (SECRET_FILE.test(entry.name)) continue;
      if (sweep.ext && path.extname(entry.name).toLowerCase() !== sweep.ext) continue;
      if (sweep.files >= SEARCH_LIMITS.filesScanned) {
        sweep.stopped = `stopped after ${SEARCH_LIMITS.filesScanned} files`;
        return;
      }
      sweep.files += 1;
      await searchFile(full, sweep);
    }
  }
};

export const searchFiles: Tool = {
  name: "search_files",
  // Mail, calendar, files and project sources stay local: once this has run, the rest of the run is pinned (src/sensitivity.ts).
  privateOutput: true,
  description:
    "Find literal text (not a regex, case-insensitive) in the files under a folder inside an allowlisted directory. " +
    "Returns path:line: text for each match. Optional ext limits it to one file type, such as \"ts\". " +
    "Skips dot-folders, dependencies, build output, binaries and credential files.",
  argsSchema: '{ "query": string, "path": string, "ext"?: string }',
  classify: (a): ClassifiedAction => ({
    reversibility: "reversible",
    summary: `Search files in ${a?.path ?? ""}`,
    target: expand(a?.path ?? ""),
  }),
  available,
  checkPolicy: (policy, a) => readableGate(policy, a?.path ?? ""),
  run: async (a, ctx) => {
    const query = String(a?.query ?? "").trim();
    if (query.length < SEARCH_LIMITS.minQueryChars) {
      return `ERROR: search_files needs a "query" of at least ${SEARCH_LIMITS.minQueryChars} characters.`;
    }
    const target = expand(a?.path ?? "");
    try {
      // The gate approved the resolved path, so the walk starts from that same resolved path.
      const root = real(target);
      const info = await fs.stat(root);
      const sweep: Sweep = {
        deadline: Date.now() + SEARCH_LIMITS.timeMs,
        ext: normalizeExt(a?.ext),
        files: 0,
        lines: [],
        needle: query.toLowerCase(),
        root: info.isDirectory() ? root : path.dirname(root),
        stopped: null,
      };
      if (info.isDirectory()) await walk(root, sweep);
      else {
        sweep.files = 1;
        await searchFile(root, sweep);
      }
      const scope = `${sweep.files} file${sweep.files === 1 ? "" : "s"} searched`;
      // An incomplete search must say so, or "no matches" reads as "it is not there".
      const note = sweep.stopped ? `; INCOMPLETE, ${sweep.stopped}` : "";
      const body = sweep.lines.length
        ? `${sweep.lines.join("\n")}\n(${sweep.lines.length} matches, ${scope}${note})`
        : `No matches for "${query}" (${scope}${note}).`;
      return clip({ max: 8000, runId: ctx?.runId ?? null, source: `search of ${root}`, tool: "search_files" }, body);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return `NOT FOUND: ${target}`;
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
