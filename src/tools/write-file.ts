/**
 * write_file — save text the user asked to keep.
 *
 * Until this existed the assistant would write a business plan, be asked to save it, and
 * truthfully answer that it had no way to. The gap was a capability, not a memory.
 *
 * ## What bounds it
 *
 *   - WHERE: only inside `policy.fs.writableDirs` (deny by default, symlinks resolved on the
 *     nearest existing ancestor so a link cannot carry a write out). A project can only
 *     narrow that list, never widen it.
 *   - WHAT: text document types only (.md .txt .csv .json .html .yaml .yml). No scripts, no
 *     plists, no shell profiles — the files that turn "write a note" into "run something
 *     later" are not on the list. Hidden path segments (`.git`, `.ssh`, `.zshrc`) are refused.
 *   - HOW MUCH: 1 MB.
 *   - UNDO: before a file is replaced or edited, the old version is copied to
 *     `<AgentSpine>/backups/`. Because the change can be taken back, it is classified
 *     REVERSIBLE and runs without a prompt — an approval nobody reads protects less than a
 *     backup that always exists.
 *
 * ## Where a bare filename lands
 *
 * A chat inside a project with a folder writes there. Otherwise it goes to
 * `<AgentSpine>/docs`. A full path (or `~/…`) goes where it says, if the gate allows it.
 * The runner sets the default per run — see `setWriteDefault`.
 *
 * ## `from_run`
 *
 * The model may name an earlier run's #id instead of retyping its output. The stored text is
 * written byte-for-byte; a 6,000-character plan is not pushed back through a small model's
 * JSON string escaping, which is where "save the plan" would otherwise lose or mangle it.
 */
import fs from "node:fs";
import path from "node:path";

import { BASE } from "../config.ts";
import { recordDeliverable } from "../deliverables.ts";
import { expand, insideWritable, realForWrite } from "../fs-scope.ts";
import { listSources } from "../projects/store.ts";
import * as store from "../memory/store.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

interface Args {
  content?: string;
  from_run?: number;
  /** "write" (default) replaces the file; "append" adds to the end. */
  mode?: string;
  path?: string;
}

export const WRITE_EXTENSIONS = [".md", ".txt", ".csv", ".json", ".html", ".yaml", ".yml"];
export const MAX_WRITE_BYTES = 1_000_000;

/** Set by `runner.ts` before each run: the project's folder, or null for the default. */
let defaultDir: null | string = null;

export const setWriteDefault = (dir: null | string): void => {
  defaultDir = dir;
};

/**
 * The folder a project's files belong in: its first directory source, or null. A source that
 * is gone, or is a single file, is not a folder to write into.
 */
export const projectWriteDir = (projectId: null | number | undefined): null | string => {
  if (projectId == null) return null;
  for (const src of listSources(projectId)) {
    if (src.kind !== "path") continue;
    try {
      const dir = expand(src.ref);
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* try the next source */
    }
  }
  return null;
};

/** Where a bare filename goes right now. */
export const writeDefaultDir = (): string => defaultDir ?? path.join(BASE, "docs");

/** The absolute path a call refers to, or "" when it names none. */
export const resolveTarget = (a: Args): string => {
  const raw = String(a?.path ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("~") || path.isAbsolute(raw)) return expand(raw);
  return path.resolve(writeDefaultDir(), raw);
};

/** Where the previous version of a file goes before it is changed. */
export const BACKUP_DIR = process.env.AGENTSPINE_BACKUP_DIR ?? path.join(BASE, "backups");

/** Copy an existing file aside; returns the backup path, or null when there was nothing to keep. */
export const backupFile = (target: string): null | string => {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const flat = target.replace(/^\//, "").replace(/[\/\\]/g, "__");
  const dest = path.join(BACKUP_DIR, `${stamp}__${flat}`);
  fs.copyFileSync(target, dest);
  return dest;
};

/**
 * The checks every text-file write shares: a real path, a document extension, nothing hidden,
 * inside writableDirs. `ext` is skipped for directories.
 */
export const textTargetGate = (policy: Policy, target: string, { ext = true } = {}): PolicyDecision => {
  if (!target) return { allowed: false, reason: 'a "path" is required, e.g. "BUSINESSPLAN.md".' };
  if (ext) {
    const e = path.extname(target).toLowerCase();
    if (!WRITE_EXTENSIONS.includes(e)) {
      return {
        allowed: false,
        reason: `only text documents can be written (${WRITE_EXTENSIONS.join(" ")}); "${e || "no extension"}" is not one.`,
      };
    }
  }
  const real = realForWrite(target);
  if (real.split(path.sep).some((seg) => seg.startsWith(".") && seg.length > 1)) {
    return { allowed: false, reason: "hidden files and directories are refused." };
  }
  if (!insideWritable(policy, target)) {
    return { allowed: false, reason: `${target} is outside policy.fs.writableDirs (deny by default)` };
  }
  return { allowed: true, reason: "inside policy.fs.writableDirs" };
};

/** An absolute path from an arbitrary argument, relative to the current default folder. */
export const resolveArg = (raw: unknown): string => resolveTarget({ path: String(raw ?? "") });

const bodyOf = (a: Args): { error?: string; text?: string } => {
  if (a?.from_run != null && String(a.from_run) !== "") {
    const run = store.getRun(Number(a.from_run));
    if (!run) return { error: `No run #${a.from_run} exists.` };
    const text = String(run.note ?? "");
    return text.trim() ? { text } : { error: `Run #${a.from_run} recorded no output to save.` };
  }
  if (typeof a?.content === "string" && a.content.length) return { text: a.content };
  return { error: 'write_file needs "content", or "from_run" with the #id of an earlier output.' };
};

export const writeFile: Tool = {
  name: "write_file",
  description:
    "Save text to a file. Give a bare filename like \"BUSINESSPLAN.md\" to save in the default " +
    "folder (this project's folder if it has one, otherwise AgentSpine's docs folder), or a full " +
    "path to put it elsewhere. Provide the text as \"content\", or pass \"from_run\" with the #id of " +
    "an earlier output to save that output exactly as it was written — prefer this for plans, " +
    "drafts and reports. mode \"append\" adds to the end of an existing file instead of replacing it. " +
    "Text types only (.md .txt .csv .json .html .yaml .yml). The previous version of a replaced file is " +
    "backed up automatically, so it never needs to ask first.",
  argsSchema: '{ "path": string, "content"?: string, "from_run"?: number, "mode"?: "write" | "append" }',
  classify: (a: Args): ClassifiedAction => {
    const target = resolveTarget(a);
    const exists = !!target && fs.existsSync(target);
    const verb = a?.mode === "append" ? "Append to" : exists ? "Replace (old version backed up)" : "Create";
    return { reversibility: "reversible", summary: `${verb} file ${target || "(no path)"}`, target };
  },
  checkPolicy: (policy: Policy, a: Args): PolicyDecision => {
    const target = resolveTarget(a);
    const gate = textTargetGate(policy, target);
    if (!gate.allowed) return gate;
    const body = bodyOf(a);
    if (body.error) return { allowed: false, reason: body.error };
    if (Buffer.byteLength(body.text ?? "", "utf8") > MAX_WRITE_BYTES) {
      return { allowed: false, reason: `Content is over ${MAX_WRITE_BYTES} bytes.` };
    }
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      return { allowed: false, reason: `${target} is a directory.` };
    }
    return { allowed: true, reason: "inside policy.fs.writableDirs, text document" };
  },
  run: async (a: Args, ctx) => {
    const target = resolveTarget(a);
    const body = bodyOf(a);
    if (!target || body.text == null) return `ERROR: ${body.error ?? "no path"}`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const backup = backupFile(target);
      if (a?.mode === "append" && fs.existsSync(target)) {
        const cur = fs.readFileSync(target, "utf8");
        fs.appendFileSync(target, `${cur && !cur.endsWith("\n") ? "\n" : ""}${body.text}`, "utf8");
        recordDeliverable(target, "append", ctx?.runId);
        return `Appended ${body.text.length} characters to ${target}${backup ? ` (previous version kept at ${backup})` : ""}`;
      }
      fs.writeFileSync(target, body.text, "utf8");
      recordDeliverable(target, backup ? "replace" : "create", ctx?.runId);
      return `Saved ${body.text.length} characters to ${target}${backup ? ` (previous version kept at ${backup})` : ""}`;
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

interface EditArgs {
  all?: boolean;
  find?: string;
  path?: string;
  replace?: string;
}

/** Replace text inside an existing document. The old version is backed up first. */
export const editFile: Tool = {
  name: "edit_file",
  description:
    "Change part of an existing text document: replace the exact text in \"find\" with \"replace\". " +
    "\"find\" must match exactly once (pass \"all\": true to replace every occurrence), so quote enough " +
    "surrounding text to be unambiguous. Use write_file with mode \"append\" to add to the end instead.",
  argsSchema: '{ "path": string, "find": string, "replace": string, "all"?: boolean }',
  classify: (a: EditArgs): ClassifiedAction => {
    const target = resolveArg(a?.path);
    return { reversibility: "reversible", summary: `Edit file ${target || "(no path)"} (old version backed up)`, target };
  },
  checkPolicy: (policy: Policy, a: EditArgs): PolicyDecision => {
    const target = resolveArg(a?.path);
    const gate = textTargetGate(policy, target);
    if (!gate.allowed) return gate;
    if (!a?.find) return { allowed: false, reason: 'edit_file needs "find" — the exact text to replace.' };
    if (typeof a.replace !== "string") return { allowed: false, reason: 'edit_file needs "replace" (use "" to delete).' };
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return { allowed: false, reason: `${target} does not exist; use write_file to create it.` };
    }
    return { allowed: true, reason: "inside policy.fs.writableDirs, text document" };
  },
  run: async (a: EditArgs, ctx) => {
    const target = resolveArg(a?.path);
    try {
      const cur = fs.readFileSync(target, "utf8");
      const find = String(a?.find ?? "");
      const count = cur.split(find).length - 1;
      if (count === 0) return `NOT CHANGED: the text to replace was not found in ${target}. Read the file and quote it exactly.`;
      if (count > 1 && !a?.all) {
        return `NOT CHANGED: that text appears ${count} times in ${target}. Quote more surrounding text, or pass "all": true.`;
      }
      const next = a?.all ? cur.split(find).join(String(a.replace)) : cur.replace(find, () => String(a.replace));
      if (Buffer.byteLength(next, "utf8") > MAX_WRITE_BYTES) return `NOT CHANGED: the result would be over ${MAX_WRITE_BYTES} bytes.`;
      const backup = backupFile(target);
      fs.writeFileSync(target, next, "utf8");
      recordDeliverable(target, "edit", ctx?.runId);
      return `Edited ${target}: replaced ${a?.all ? count : 1} occurrence(s)${backup ? ` (previous version kept at ${backup})` : ""}`;
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

interface MoveArgs {
  from?: string;
  to?: string;
}

/** Move or rename a document. Refuses to clobber: the destination must be free. */
export const moveFile: Tool = {
  name: "move_file",
  description:
    "Move or rename a text document (both ends must be in a writable folder). The destination must not already exist.",
  argsSchema: '{ "from": string, "to": string }',
  classify: (a: MoveArgs): ClassifiedAction => ({
    reversibility: "reversible",
    summary: `Move ${resolveArg(a?.from) || "?"} to ${resolveArg(a?.to) || "?"}`,
    target: resolveArg(a?.to),
  }),
  checkPolicy: (policy: Policy, a: MoveArgs): PolicyDecision => {
    const from = resolveArg(a?.from);
    const to = resolveArg(a?.to);
    const g1 = textTargetGate(policy, from);
    if (!g1.allowed) return { allowed: false, reason: `source: ${g1.reason}` };
    const g2 = textTargetGate(policy, to);
    if (!g2.allowed) return { allowed: false, reason: `destination: ${g2.reason}` };
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return { allowed: false, reason: `${from} does not exist.` };
    if (fs.existsSync(to)) return { allowed: false, reason: `${to} already exists; choose a free name.` };
    return { allowed: true, reason: "both ends inside policy.fs.writableDirs" };
  },
  run: async (a: MoveArgs, ctx) => {
    const from = resolveArg(a?.from);
    const to = resolveArg(a?.to);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      recordDeliverable(to, "move", ctx?.runId);
      return `Moved ${from} to ${to}`;
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** Create a folder (and any missing parents). */
export const makeDir: Tool = {
  name: "make_dir",
  description: "Create a folder (and missing parents) inside a writable location.",
  argsSchema: '{ "path": string }',
  classify: (a: { path?: string }): ClassifiedAction => ({
    reversibility: "reversible",
    summary: `Create folder ${resolveArg(a?.path) || "(no path)"}`,
    target: resolveArg(a?.path),
  }),
  checkPolicy: (policy: Policy, a: { path?: string }): PolicyDecision =>
    textTargetGate(policy, resolveArg(a?.path), { ext: false }),
  run: async (a: { path?: string }) => {
    const target = resolveArg(a?.path);
    try {
      fs.mkdirSync(target, { recursive: true });
      return `Folder ready: ${target}`;
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
