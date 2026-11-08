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
 *   - NEW vs. EXISTING: creating a file is reversible and runs on its own; replacing one that
 *     already exists is irreversible and waits for your approval with the path shown, the same
 *     as every other action that cannot be taken back.
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
import { expand, insideWritable, realForWrite } from "../fs-scope.ts";
import * as store from "../memory/store.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

interface Args {
  content?: string;
  from_run?: number;
  path?: string;
}

export const WRITE_EXTENSIONS = [".md", ".txt", ".csv", ".json", ".html", ".yaml", ".yml"];
export const MAX_WRITE_BYTES = 1_000_000;

/** Set by `runner.ts` before each run: the project's folder, or null for the default. */
let defaultDir: null | string = null;

export const setWriteDefault = (dir: null | string): void => {
  defaultDir = dir;
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
    "drafts and reports. Text types only (.md .txt .csv .json .html .yaml .yml). Creating a new " +
    "file just happens; replacing an existing file asks the user first.",
  argsSchema: '{ "path": string, "content"?: string, "from_run"?: number }',
  classify: (a: Args): ClassifiedAction => {
    const target = resolveTarget(a);
    const exists = !!target && fs.existsSync(target);
    return {
      reversibility: exists ? "irreversible" : "reversible",
      summary: `${exists ? "Overwrite" : "Create"} file ${target || "(no path)"}`,
      target,
    };
  },
  checkPolicy: (policy: Policy, a: Args): PolicyDecision => {
    const target = resolveTarget(a);
    if (!target) return { allowed: false, reason: 'write_file needs a "path", e.g. "BUSINESSPLAN.md".' };

    const ext = path.extname(target).toLowerCase();
    if (!WRITE_EXTENSIONS.includes(ext)) {
      return {
        allowed: false,
        reason: `write_file only writes text documents (${WRITE_EXTENSIONS.join(" ")}); "${ext || "no extension"}" is not one.`,
      };
    }
    const real = realForWrite(target);
    if (real.split(path.sep).some((seg) => seg.startsWith(".") && seg.length > 1)) {
      return { allowed: false, reason: "write_file refuses hidden files and directories." };
    }
    if (!insideWritable(policy, target)) {
      return { allowed: false, reason: `${target} is outside policy.fs.writableDirs (deny by default)` };
    }
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
  run: async (a: Args) => {
    const target = resolveTarget(a);
    const body = bodyOf(a);
    if (!target || body.text == null) return `ERROR: ${body.error ?? "no path"}`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body.text, "utf8");
      return `Saved ${body.text.length} characters to ${target}`;
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
