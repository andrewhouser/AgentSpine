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
 *   - WHAT: documents and web source — see WRITE_EXTENSIONS below for the list and for what
 *     stays off it. Shell and interpreter scripts, plists and shell profiles are still
 *     refused: those are the files that turn "write a note" into "run something later".
 *     Hidden path segments (`.git`, `.ssh`, `.zshrc`) are refused.
 *   - HOW MUCH: 1 MB.
 *   - THE GATES THEMSELVES: the broker, the pin, the approval code and the few files beside
 *     them (src/protected-paths.ts) always wait for the user with the diff on the card, under
 *     every skip the broker has, and are written only while that approval is carried out.
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
import { AREA_MAP_PATH } from "../area-map.ts";
import { expand, insideWritable, real, realForWrite } from "../fs-scope.ts";
import { listSources } from "../projects/store.ts";
import * as store from "../memory/store.ts";
import { asksEveryTime, protectedRel, protectedSummary, protectedWriteProblem, readCurrent, versionOf } from "../protected-paths.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

interface Args {
  content?: string;
  from_run?: number;
  /** "write" (default) replaces the file; "append" adds to the end. */
  mode?: string;
  path?: string;
}

/** Prose, data and config — what "save this for me" meant before sites were in scope. */
const DOCUMENT_EXTENSIONS = [
  ".csv",
  ".json",
  ".md",
  ".svg",
  ".toml",
  ".txt",
  ".webmanifest",
  ".xml",
  ".yaml",
  ".yml",
];

/**
 * What a working web page or web app is actually made of.
 *
 * These are source files, so this list is the point at which `write_file` stops being a
 * note-taker and starts being able to produce something that runs. The reasoning for
 * allowing it: a "one page site" the agent cannot give a stylesheet or a script to is not
 * a site, and the alternative it reaches for — cramming an entire inlined document into a
 * single JSON string argument — is the same call that blew the completion budget and timed
 * the run out. Several small files are both the better artefact and the cheaper generation.
 *
 * What is deliberately still absent, since the allowlist is the whole gate: shell and
 * interpreter scripts (.sh .bash .zsh .command .py .rb .pl .php), macOS automation
 * (.plist .scpt .applescript .app). The line is not "can this text be executed" — a .js
 * plainly can — but "does writing this file make something run LATER without the user
 * choosing to run it". A React component does not; a LaunchAgent plist or a dotfile does,
 * and hidden path segments are refused separately below for the same reason.
 */
const WEB_EXTENSIONS = [
  ".astro",
  ".cjs",
  ".css",
  ".cts",
  ".gql",
  ".graphql",
  ".htm",
  ".html",
  ".jsx",
  ".js",
  ".less",
  ".mjs",
  ".mts",
  ".sass",
  ".scss",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
];

/**
 * Program source, for the languages a build loop actually works in (docs/archive/PLAN-build-loop.md
 * Phase 4). Without these, "improve my Rust project" could not start: `run_command` could
 * build and test it, and nothing could write the change.
 *
 * ## Why .py and .rb are here now, and .sh still is not
 *
 * The rule has always been *"does writing this file make something run LATER without the user
 * choosing to run it"*, and applied honestly it never did separate `.py` from `.mjs` — both
 * need someone to invoke them, and `.mjs` has been writable since web source was allowed.
 * Refusing `.py` while allowing `.mjs` was a historical artifact, not a boundary.
 *
 * What stays refused is the set where something ELSE does the invoking:
 *
 *   - `.sh .bash .zsh .command` — the overwhelming convention for "a thing to run", and
 *     `.command` is executed by Finder on a double-click. The cost of refusing them is near
 *     zero: a declared npm script or a `.mjs` does the same job.
 *   - `.php .pl .cgi` — executed by a web server that is already running, the moment the file
 *     lands in a directory it serves. Nobody chooses to run those.
 *   - `.plist .scpt .applescript` — macOS picks these up itself (a LaunchAgent, an automation).
 *   - anything hidden, which is where `.git/hooks`, `.zshrc` and `.env` live. Checked separately
 *     below, because the extension is not what makes those dangerous.
 */
const CODE_EXTENSIONS = [
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  // Only reachable through the manifest gate below, which is the point: Android work needs
  // build.gradle writable, and a Gradle script is build logic rather than program source.
  ".gradle",
  ".h",
  ".hpp",
  ".java",
  ".kt",
  ".kts",
  ".m",
  ".mm",
  ".proto",
  ".py",
  ".rb",
  ".rs",
  ".sql",
  ".swift",
  ".zig",
];

/**
 * Files whose job is to declare WHAT CODE GETS FETCHED AND RUN — and the one place the
 * extension allowlist genuinely stops holding.
 *
 * Be precise about why these are special, because it is easy to state too strongly. Once
 * `.ts` and `.rs` are writable at all, "code that runs during a build" cannot be gated by
 * filename: the build compiles and runs the repository's own source, which is the entire
 * point of letting the agent edit it. The diff is the review step for that, and git is where
 * it happens.
 *
 * What these files do that source does not is pull in **new code from outside the repo**, or
 * run on a lifecycle hook — `scripts` in a package.json, a `build-dependencies` line in a
 * Cargo.toml, a changed version in a lockfile, a `build.rs`. Reviewing a one-line manifest
 * change is something a person can actually do, which is why this is the cut.
 *
 * So: writes here are classified IRREVERSIBLE and land in the confirmation queue with the
 * path shown. Not refused — an agent that cannot add a dependency cannot do the work — and
 * not configurable, for the same reason `schedule_*` writes are not: a knob here is a knob
 * that gets left on. The backup still happens, so this is not about undo. It is about a
 * person seeing the one change that converts "it wrote a file" into "it ran new code".
 */
const MANIFEST_BASENAMES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "build.rs",
  "cargo.toml",
  "cmakelists.txt",
  "conanfile.py",
  "package-lock.json",
  "package.json",
  "package.swift",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "requirements.txt",
  "settings.gradle",
  "settings.gradle.kts",
  "setup.py",
  // Refused by the extension gate as well (.lock is not writable) — kept here so the
  // classification is right if that ever changes. A lockfile is generated, not hand-written.
  "yarn.lock",
]);

/** Does this path declare what gets fetched and run? */
export const isManifest = (target: string): boolean => {
  if (!target) return false;
  const base = path.basename(target).toLowerCase();
  return MANIFEST_BASENAMES.has(base) || base.endsWith(".gradle") || base.endsWith(".gradle.kts");
};

/**
 * AgentSpine's OWN control files, which this tool may not write at all.
 *
 * These were reachable until Phase 4, and that was a hole rather than a decision:
 * `policy.json` is a `.json` file inside `~/Developer`, so the extension allowlist and
 * `writableDirs` both said yes, and the write classified reversible and auto-executed. It
 * contradicted the invariant stated in docs/LEARNING.md and repeated in tools/schedule.ts —
 * *"a run that could widen its own permissions would make deny-by-default a suggestion"*.
 *
 * Refused, not queued. docs/LEARNING.md invariant 1 says the write happens "in the server, from a
 * human click, and never from a tool call", and a confirmation card holding a 200-line JSON
 * diff is precisely the thing that gets waved through. Each of these is editable in the
 * dashboard, which is where a change to them belongs:
 *
 *   - `policy.json`  — the permissions themselves.
 *   - `profile.md`   — injected as a SYSTEM message on every run. Trusted context by design,
 *                      so a line written here outranks everything the model is told elsewhere.
 *   - `goals.md`     — the standing instruction every heartbeat reads, unattended.
 *   - `agents/*.md`  — a unit's instructions AND its `tools:` ceiling.
 *   - `src/area-map.md` — the map of this codebase that a run working here is given as
 *                      trusted context (PLAN-open-work section 10, SC3). Same reason as
 *                      profile.md: a line a tool could write there would arrive as ours.
 *
 * `.env` needs no entry: it is hidden, and hidden paths are refused below.
 *
 * Source under `src/` is deliberately NOT here. Changing this project's code is work the
 * builder is for, and a code change is reviewable as a diff; these four files change what
 * runs or what is trusted with no diff anyone would see.
 */
const controlFiles = (): string[] => [
  path.join(real(BASE), "policy.json"),
  path.join(real(BASE), "profile.md"),
  path.join(real(BASE), "goals.md"),
  real(AREA_MAP_PATH),
];

export const isControlFile = (target: string): boolean => {
  if (!target) return false;
  const t = realForWrite(target);
  if (controlFiles().includes(t)) return true;
  const agents = path.join(real(BASE), "agents");
  return t === agents || t.startsWith(agents + path.sep);
};

export const WRITE_EXTENSIONS = [...DOCUMENT_EXTENSIONS, ...WEB_EXTENSIONS, ...CODE_EXTENSIONS];
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
  // Before the extension check, so the refusal names the real reason rather than talking
  // about file types — see controlFiles() for why these are refused and not queued.
  if (isControlFile(target)) {
    return {
      allowed: false,
      reason:
        `${target} is one of AgentSpine's own control files (policy.json, profile.md, goals.md, agents/*.md, src/area-map.md). ` +
        `No tool may write them — permissions and trusted context are changed in the dashboard, by a person. ` +
        `Say what you would change and why, and let the user make the edit.`,
    };
  }
  if (ext) {
    const e = path.extname(target).toLowerCase();
    if (!WRITE_EXTENSIONS.includes(e)) {
      return {
        allowed: false,
        reason:
          `"${e || "no extension"}" cannot be written. Allowed: documents ` +
          `(${DOCUMENT_EXTENSIONS.join(" ")}) and web source (${WEB_EXTENSIONS.join(" ")}).`,
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

/** What `mode: "append"` leaves in the file. One function, so the diff on a card is the text that gets written. */
const appended = (cur: string, text: string): string => `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${text}`;

/** What edit_file would leave in the file, or why it would change nothing. */
const edited = (cur: string, a: EditArgs): { count: number; next?: string; problem?: string } => {
  const find = String(a?.find ?? "");
  const count = find ? cur.split(find).length - 1 : 0;
  if (count === 0) return { count, problem: "the text to replace was not found" };
  if (count > 1 && !a?.all) return { count, problem: `that text appears ${count} times` };
  return { count, next: a?.all ? cur.split(find).join(String(a.replace)) : cur.replace(find, () => String(a.replace)) };
};

/**
 * The second check on a protected file, made by the tool itself at the moment of writing: it
 * goes ahead only while an approval is being carried out, and only against the text the card's
 * diff was made from. Thrown, not returned, so the approval ends as an error and not as "done".
 */
const notApproved = (...targets: string[]): void => {
  for (const t of targets) {
    const problem = protectedWriteProblem(t);
    if (problem) throw new Error(`NOT WRITTEN: ${problem}`);
  }
};

export const writeFile: Tool = {
  name: "write_file",
  // Registry pass, 2026-11-26 (PLAN-open-work section 12, D2). The only irreversible write is a
  // build manifest, "the one write a person should see before it happens", and a schedule's
  // pre-approval skipped the queue for it: a job steered by a page it read could add a
  // dependency with an install script, which the next `npm install` runs. So it asks even
  // when nobody is watching. Ordinary files are reversible and never reach this flag.
  confirmWhenUnattended: true,
  description:
    "Save text to a file. Give a bare filename like \"BUSINESSPLAN.md\" to save in the default " +
    "folder (this project's folder if it has one, otherwise AgentSpine's docs folder), or a full " +
    "path to put it elsewhere. Provide the text as \"content\", or pass \"from_run\" with the #id of " +
    "an earlier output to save that output exactly as it was written — prefer this for plans, " +
    "drafts and reports. mode \"append\" adds to the end of an existing file instead of replacing it. " +
    "Writes documents (.md .txt .csv .json .yaml .toml .xml .svg) and web source (.html .css .js .jsx " +
    ".ts .tsx .mjs .vue .svelte .astro and the rest), so a site can be built as real separate files — " +
    "one call per file is better than cramming a whole page into one. Also writes program source " +
    "(.rs .swift .go .py .rb .java .kt .c .cpp .sql and more), so it can work in a real codebase. " +
    "Shell scripts (.sh .command), server-executed source (.php .pl), macOS automation (.plist .scpt) " +
    "and hidden files are refused. Build manifests (package.json, Cargo.toml, build.rs, Package.swift, " +
    "lockfiles) can be written but WAIT for the user's approval, because they decide what code the " +
    "build fetches and runs. So do AgentSpine's own gate files (its broker, approval and privacy code), " +
    "which always wait with the diff shown. AgentSpine's own policy.json, profile.md, goals.md, agents/*.md " +
    "and src/area-map.md cannot be written at all. The previous version of a replaced file is backed up automatically, " +
    "so an ordinary file write never needs to ask first.",
  argsSchema: '{ "path": string, "content"?: string, "from_run"?: number, "mode"?: "write" | "append" }',
  classify: (a: Args): ClassifiedAction => {
    const target = resolveTarget(a);
    const exists = !!target && fs.existsSync(target);
    const verb = a?.mode === "append" ? "Append to" : exists ? "Replace (old version backed up)" : "Create";
    // One of the gates themselves. Asks under every skip, with the diff — see protected-paths.ts.
    const gate = protectedRel(target);
    if (gate) {
      const before = readCurrent(target);
      const body = bodyOf(a).text ?? null;
      const after = body == null ? null : a?.mode === "append" && before != null ? appended(before, body) : body;
      return asksEveryTime({
        reversibility: "irreversible",
        summary: protectedSummary(gate, a?.mode === "append" ? "APPEND TO" : exists ? "REPLACE" : "CREATE", before, after),
        target,
      });
    }
    // A manifest is the one write that can make the build fetch and run new code, so it is
    // the one write a person should see before it happens. See MANIFEST_BASENAMES.
    if (isManifest(target)) {
      return {
        reversibility: "irreversible",
        summary: `${verb} BUILD MANIFEST ${target} — approving this lets the build fetch and run code it did not before`,
        target,
      };
    }
    return { reversibility: "reversible", summary: `${verb} file ${target || "(no path)"}`, target };
  },
  available: (policy: Policy): PolicyDecision =>
    (policy.fs?.writableDirs?.length ?? 0) > 0
      ? { allowed: true, reason: "policy.fs.writableDirs is not empty" }
      : { allowed: false, reason: "policy.fs.writableDirs is empty (deny by default)" },
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
    notApproved(target);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const backup = backupFile(target);
      if (a?.mode === "append" && fs.existsSync(target)) {
        const cur = fs.readFileSync(target, "utf8");
        fs.writeFileSync(target, appended(cur, body.text), "utf8");
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
  // As write_file: its one irreversible call is a build manifest, and that asks unattended too.
  confirmWhenUnattended: true,
  description:
    "Change part of an existing text document: replace the exact text in \"find\" with \"replace\". " +
    "\"find\" must match exactly once (pass \"all\": true to replace every occurrence), so quote enough " +
    "surrounding text to be unambiguous. Use write_file with mode \"append\" to add to the end instead.",
  argsSchema: '{ "path": string, "find": string, "replace": string, "all"?: boolean }',
  classify: (a: EditArgs): ClassifiedAction => {
    const target = resolveArg(a?.path);
    const gate = protectedRel(target);
    if (gate) {
      const before = readCurrent(target);
      return asksEveryTime({
        reversibility: "irreversible",
        summary: protectedSummary(gate, "EDIT", before, before == null ? null : (edited(before, a).next ?? null)),
        target,
      });
    }
    if (isManifest(target)) {
      return {
        reversibility: "irreversible",
        summary: `Edit BUILD MANIFEST ${target} — approving this lets the build fetch and run code it did not before`,
        target,
      };
    }
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
    notApproved(target);
    try {
      const cur = fs.readFileSync(target, "utf8");
      const { count, next } = edited(cur, a);
      if (count === 0) return `NOT CHANGED: the text to replace was not found in ${target}. Read the file and quote it exactly.`;
      if (next == null) {
        return `NOT CHANGED: that text appears ${count} times in ${target}. Quote more surrounding text, or pass "all": true.`;
      }
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
  // As write_file: moving a file onto or off a build manifest's name asks unattended too.
  confirmWhenUnattended: true,
  description:
    "Move or rename a text document (both ends must be in a writable folder). The destination must not already exist.",
  argsSchema: '{ "from": string, "to": string }',
  // Either end being a manifest is enough: moving a file ONTO package.json replaces it, and
  // moving package.json away is how you would get a build to fall back to a different one.
  classify: (a: MoveArgs): ClassifiedAction => {
    const from = resolveArg(a?.from);
    const to = resolveArg(a?.to);
    const manifest = isManifest(from) || isManifest(to);
    // Moving a gate away removes it, and moving a file into its place supplies a new one.
    const gate = protectedRel(from) ?? protectedRel(to);
    if (gate) {
      return asksEveryTime({
        reversibility: "irreversible",
        summary:
          `MOVE that changes PROTECTED FILE ${gate}: ${from || "?"} to ${to || "?"}. This file is one of AgentSpine's own gates, ` +
          `so the move waits for you whatever else is trusted.\n\n` +
          `(file version when proposed: ${versionOf(readCurrent(protectedRel(from) ? from : to))})`,
        target: to,
      });
    }
    return {
      reversibility: manifest ? "irreversible" : "reversible",
      summary: `Move ${from || "?"} to ${to || "?"}${manifest ? " — this changes a BUILD MANIFEST" : ""}`,
      target: to,
    };
  },
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
    notApproved(from, to);
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
