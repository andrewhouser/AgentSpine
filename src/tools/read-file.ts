/**
 * Local file reading, gated by policy.fs.readableDirs (deny by default). read_file returns
 * a file's text; list_dir lists a directory. Both are read-only/reversible.
 *
 * Path safety: paths are resolved and symlinks followed (realpath), then checked to be
 * inside an allowlisted directory — so a symlink inside an allowed dir can't escape it.
 * File contents are tagged UNTRUSTED: a local file may be something you downloaded, so its
 * text is information to reason about, never instructions to follow.
 */
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../config.ts";
import { tagUntrusted } from "../audit.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const expand = (p: string): string => path.resolve(String(p ?? "").replace(/^~(?=$|\/)/, homeDir));

/** Resolve symlinks where the path exists; fall back to the lexical resolve otherwise. */
const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const insideReadable = (policy: Policy, target: string): boolean => {
  const t = real(expand(target));
  return (policy.fs?.readableDirs ?? []).some((d) => {
    const dir = real(expand(d));
    return t === dir || t.startsWith(dir + path.sep);
  });
};

const gate = (policy: Policy, p: string): PolicyDecision =>
  insideReadable(policy, p)
    ? { allowed: true, reason: "inside policy.fs.readableDirs" }
    : { allowed: false, reason: `${expand(p)} is outside policy.fs.readableDirs (deny by default)` };

export const readFile: Tool = {
  name: "read_file",
  description: "Read the text of a file inside an allowlisted directory.",
  argsSchema: '{ "path": string }',
  classify: (a): ClassifiedAction => ({ reversibility: "reversible", target: expand(a?.path ?? ""), summary: `Read file ${a?.path ?? ""}` }),
  checkPolicy: (policy, a) => gate(policy, a?.path ?? ""),
  run: async (a) => {
    const p = expand(a?.path ?? "");
    try {
      if (!fs.existsSync(p)) return `NOT FOUND: ${p}`;
      if (fs.statSync(p).isDirectory()) return `${p} is a directory — use list_dir.`;
      return tagUntrusted(`file ${p}`, fs.readFileSync(p, "utf8").slice(0, 8000));
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const listDir: Tool = {
  name: "list_dir",
  description: "List the entries of a directory inside an allowlisted directory.",
  argsSchema: '{ "path": string }',
  classify: (a): ClassifiedAction => ({ reversibility: "reversible", target: expand(a?.path ?? ""), summary: `List dir ${a?.path ?? ""}` }),
  checkPolicy: (policy, a) => gate(policy, a?.path ?? ""),
  run: async (a) => {
    const p = expand(a?.path ?? "");
    try {
      if (!fs.existsSync(p)) return `NOT FOUND: ${p}`;
      if (!fs.statSync(p).isDirectory()) return `${p} is a file — use read_file.`;
      const entries = fs.readdirSync(p, { withFileTypes: true }).slice(0, 200);
      return entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`).join("\n") || "(empty)";
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
