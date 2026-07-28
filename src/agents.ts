/**
 * Subagent definitions, loaded from `agents/*.md`.
 *
 * Markdown with YAML-ish frontmatter, matching this project's existing taste for
 * file-as-config (`profile.md`, `goals.md`, `policy.json`) and the Claude Code agent format
 * the Dispatch skill uses — so the same file describes a unit in both places. Re-read from
 * disk on every load, like `loadPolicy`, so editing an agent takes effect on the next run
 * with no restart.
 *
 * The frontmatter is parsed by hand rather than with a YAML dependency: it is five scalar
 * fields, and this project's rule is to justify every dependency.
 */
import fs from "node:fs";
import path from "node:path";

import { AGENTS_DIR, SUBAGENT_MAX_STEPS } from "./config.ts";
import type { Tier } from "./tiers.ts";

export interface AgentDef {
  description: string;
  /** The unit's standing instructions — everything after the frontmatter. */
  instructions: string;
  maxSteps: number;
  name: string;
  /** Which model tier this unit runs on. This is where the cost tiering actually lives. */
  tier: Tier;
  /**
   * Tools the unit is allowed to ask for. This is a CEILING, not a grant: the effective
   * set is this intersected with what the parent could reach, and every call still goes
   * through the broker against the same policy.json.
   */
  tools: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const parseTier = (value: string): Tier =>
  value === "fast" || value === "deep" || value === "standard" ? value : "standard";

const parseAgent = (file: string, raw: string): AgentDef | null => {
  const m = FRONTMATTER.exec(raw);
  if (!m) return null;

  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }

  const name = fields.name || path.basename(file, ".md");
  if (!name) return null;

  // An empty or missing `tools` means "no tools" rather than "all tools". Deny-by-default
  // is the house rule, and a delegated unit is exactly where a permissive default would
  // be least visible.
  const declared = (fields.tools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    description: fields.description ?? "",
    instructions: m[2].trim(),
    maxSteps: Math.max(1, Number(fields.maxSteps ?? SUBAGENT_MAX_STEPS)),
    name,
    tier: parseTier(fields.tier ?? fields.model ?? "standard"),
    // Deliberately NOT validated against the tool registry here. Importing it would make
    // this module part of the cycle agents → tools → subagent → agents, and the check
    // would be redundant: `visibleTools()` in agent.ts resolves names against the real
    // registry, so a typo in an agent file yields no tool rather than a phantom capability.
    tools: declared,
  };
};

/** All agent definitions on disk, keyed by name. Re-read every call. */
export const loadAgents = (): Record<string, AgentDef> => {
  const agents: Record<string, AgentDef> = {};
  let files: string[];
  try {
    files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return agents; // no agents/ directory — subagents are simply unavailable
  }
  for (const file of files) {
    try {
      const parsed = parseAgent(file, fs.readFileSync(path.join(AGENTS_DIR, file), "utf8"));
      if (parsed) agents[parsed.name] = parsed;
    } catch (err) {
      console.warn(`[agents] could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return agents;
};

export const getAgent = (name: string): AgentDef | undefined => loadAgents()[name];
