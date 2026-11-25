/**
 * How a tool is described to the model (PLAN-open-work section 10, LP6, built 2026-11-25).
 *
 * Every visible tool's description used to sit in the system prompt: about 9,900 of a chat run's 11,500 prompt
 * tokens (85 tools, measured 2026-11-25). The model host keeps the prefix cached between steps, so the cost lands on
 * each run's first request and whenever the prefix changes, and prefill is the expensive part on this hardware.
 *
 * With TOOL_DOCS_MODE=core, a small core set keeps its full description and the rest are one line each, name and
 * first sentence; the model reads a tool's full instructions with `tool_help`, whose answer is appended to the
 * history so the cached prefix is untouched. A run that sees few tools (a unit) gets them all in full. Off by
 * default: whether a local model reliably asks before guessing is what has to be measured on the host first.
 */
import { frictionDocs } from "./learn/friction.ts";
import type { Tool } from "./types.ts";

/** "all" (every description in full, as before) or "core". Read live, so a test can switch it. */
export const toolDocsMode = (): "all" | "core" => (process.env.TOOL_DOCS_MODE === "core" ? "core" : "all");

/** The tools that keep their full description in core mode: the everyday ones, and the way to read the rest. */
export const CORE_TOOLS = new Set([
  "calendar_upcoming",
  "gmail_search",
  "knowledge_claims",
  "knowledge_search",
  "list_dir",
  "memory_recall",
  "memory_save",
  "read_file",
  "read_more",
  "search_files",
  "task_add",
  "task_list",
  "tool_help",
  "weather",
  "web_read",
  "web_search",
]);

/** A run that sees this many tools or fewer gets every one in full: the index would save little and cost a step. */
export const SHOW_ALL_UNDER = 20;

/** One tool's full description, with its recent failures (LEARNING Phase 1.2), as the prompt has always shown it. */
export const fullDoc = (t: Tool): string => {
  let friction = "";
  try {
    friction = frictionDocs(t.name);
  } catch {
    /* a learner must not break prompt assembly */
  }
  return `- ${t.name}: ${t.description}${friction ? `\n    ${friction}` : ""}\n    args: ${t.argsSchema}`;
};

/** The first sentence of a description, at most 100 characters: enough to know when to ask for the rest. */
export const briefDoc = (t: Tool): string => {
  const first = t.description.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return `- ${t.name}: ${first.length > 100 ? `${first.slice(0, 99)}…` : first}`;
};

/** Which tools are shown in full for this set, in this mode. */
export const fullyShown = (tools: Record<string, Tool>, mode = toolDocsMode()): Set<string> => {
  const names = Object.keys(tools);
  return mode !== "core" || names.length <= SHOW_ALL_UNDER ? new Set(names) : new Set(names.filter((n) => CORE_TOOLS.has(n)));
};

/** The "Available tools" block of the system prompt. Registry order throughout, so the prefix is the same each time. */
export const toolDocs = (tools: Record<string, Tool>, mode = toolDocsMode()): string => {
  const full = fullyShown(tools, mode);
  const shown = Object.values(tools).filter((t) => full.has(t.name)).map(fullDoc);
  const rest = Object.values(tools).filter((t) => !full.has(t.name));
  if (!rest.length) return shown.join("\n");
  return (
    `${shown.join("\n")}\n\nMore tools you can use, one line each. Before calling one for the first time, read how with ` +
    `{"action":"tool","tool":"tool_help","args":{"names":["<name>"]}}:\n${rest.map(briefDoc).join("\n")}`
  );
};
