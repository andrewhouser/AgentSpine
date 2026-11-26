/**
 * Tool descriptions on demand (PLAN-open-work section 10, LP6).
 *
 * Every visible tool's description and argument shape sits in the prompt prefix: about 35,000
 * characters for the full registry, most of it for tools a given turn never calls. Prefill is
 * the slow part on the model host, and every server added through MCP would grow it further.
 *
 * With `TOOL_DOCS_ON_DEMAND` on, a run that can see many tools gets:
 *   - a short CORE set in full, listed below in code;
 *   - every other tool as its name and one line;
 *   - `tool_docs`, which returns the full entry for the names it is given.
 *
 * ## What this does NOT change
 *
 * Loading a description is not a permission. A call to a tool whose entry was never loaded goes
 * to the broker exactly as before, and is allowed, queued or refused on the same rules. The
 * model may guess the arguments; if the tool rejects them, the loop appends that tool's entry
 * to the error, so the guess costs one step and not two.
 *
 * ## Why `tool_docs` is answered by the loop and is not in the registry
 *
 * It describes the tools THIS run can see, which only the loop knows: a subagent's set is a
 * subset, and a chat turn's set depends on the message (`settingTools`). A registry tool would
 * have to be told that, and would also be listed in every prompt with the switch off, which
 * would move the prefix this change exists to protect. It changes nothing outside the prompt, so
 * there is nothing for the broker's gates to decide; the call is still written to the audit log
 * and announced on the event bus like any other, so a trace shows every lookup and the number
 * of them can be counted. That count is the measurement this switch is waiting on.
 */
import { publish } from "./events.ts";
import { frictionDocs } from "./learn/friction.ts";
import * as store from "./memory/store.ts";
import type { BrokerResult, ClassifiedAction, Tool, ToolCall } from "./types.ts";

export const TOOL_DOCS = "tool_docs";

/**
 * Tools whose full entry stays in the prefix. Two reasons put a name here: the stable prompt
 * tells the model to use it by name (the memory, web, recall, notify, draft and schedule rules in
 * `agent.ts`, and the `read_more` footers), or nearly every chat reaches for it. A name that is
 * not visible to a run is simply skipped.
 */
export const CORE_TOOLS: readonly string[] = [
  "memory_recall",
  "memory_save",
  "web_search",
  "web_read",
  "read_more",
  "recall_output",
  "notify",
  "draft",
  "schedule_create",
  "weather",
  "task_add",
  "task_list",
  "subagent",
];

/**
 * At or under this many visible tools, everything is listed in full. On-demand loading costs a
 * step per lookup, and a subagent with eight tools has no prefix worth saving.
 */
export const TOOL_DOCS_INLINE_MAX = 16;
/** Entries one lookup may return. The largest entries are about 1,500 characters each. */
export const TOOL_DOCS_MAX_NAMES = 6;
const ONE_LINE_MAX = 110;

/** One tool's full entry, exactly as the prompt has always listed it. */
export const fullEntry = (t: Tool): string => {
  // Recent failures with this tool, appended to its own description (LEARNING Phase 1.2).
  // Synchronous SQL, inference-free; never throws, so a lookup failure just omits the line.
  let friction = "";
  try {
    friction = frictionDocs(t.name);
  } catch {
    /* a learner must not break prompt assembly */
  }
  return `- ${t.name}: ${t.description}${friction ? `\n    ${friction}` : ""}\n    args: ${t.argsSchema}`;
};

/**
 * The first sentence of a description, for the name-only list. Some descriptions open with a
 * one-word role ("INTERVIEWER."), which says nothing by itself, so a very short first
 * sentence takes the next one with it.
 */
export const oneLine = (description: string): string => {
  const sentences = String(description ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  let line = sentences[0] ?? "";
  if (line.length < 25 && sentences[1]) line = `${line} ${sentences[1]}`;
  return line.length > ONE_LINE_MAX ? `${line.slice(0, ONE_LINE_MAX - 1).trimEnd()}…` : line;
};

const names = (args: any): string[] => {
  const raw = args?.names ?? args?.name ?? args?.tools ?? args?.tool;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  return [...new Set(list.map((n) => String(n).trim()).filter(Boolean))];
};

const classify = (args: any): ClassifiedAction => ({
  reversibility: "reversible",
  summary: `Look up how to use ${names(args).join(", ") || "a tool"}`,
  target: "agentspine",
});

/** The entry the model sees for the lookup itself. Never run through the broker: see the header. */
export const toolDocsTool: Tool = {
  argsSchema: '{ "names": string[] }',
  checkPolicy: () => ({ allowed: true, reason: "reading a tool's own description" }),
  classify,
  description:
    `Load the full description and argument shape of tools that are listed by name only under "More tools". ` +
    `Do this before the first call to one of them, up to ${TOOL_DOCS_MAX_NAMES} names at a time. It changes nothing.`,
  name: TOOL_DOCS,
  run: async () => {
    throw new Error("tool_docs is answered by the agent loop");
  },
};

/**
 * Which tools start with their full entry loaded, or null when on-demand loading does not apply
 * to this run (few enough tools that everything is listed in full).
 */
export const loadedAtStart = (tools: Record<string, Tool>): null | Set<string> => {
  const visible = Object.keys(tools).filter((n) => n !== TOOL_DOCS);
  if (visible.length <= TOOL_DOCS_INLINE_MAX) return null;
  return new Set([TOOL_DOCS, ...CORE_TOOLS.filter((n) => n in tools)]);
};

/** The tool list for a run that loads on demand: core entries in full, the rest by name. */
export const renderOnDemand = (tools: Record<string, Tool>, loaded: ReadonlySet<string>): string => {
  const all = Object.values(tools);
  const full = all.filter((t) => loaded.has(t.name)).map(fullEntry);
  const rest = all.filter((t) => !loaded.has(t.name)).map((t) => `- ${t.name}: ${oneLine(t.description)}`);
  return (
    `${full.join("\n")}\n\n` +
    `More tools. These are listed by name with one line each. Their full description and argument shape are\n` +
    `not loaded yet. Before the first call to one of them, load it:\n` +
    `{"action":"tool","tool":"${TOOL_DOCS}","args":{"names":["<name>"]}}\n` +
    rest.join("\n")
  );
};

/**
 * Event ids for lookups. The broker numbers its calls from 1 in a counter this module cannot
 * see, and a client pairs a call with its result by id, so these start far above anything the
 * broker will reach in one process.
 */
let lookupSeq = 1_000_000_000;

/**
 * Answer a `tool_docs` call from the run's own tool set, mark what it returned as loaded, and
 * leave the same record a broker call leaves: an audit row, then the two events.
 */
export const lookUp = (runId: null | number, call: ToolCall, tools: Record<string, Tool>, loaded: Set<string>): BrokerResult => {
  const callId = ++lookupSeq;
  const asked = names(call.args);
  const classified = classify(call.args);
  publish(runId, { args: call.args ?? null, callId, tool: call.tool, type: "tool_call" });

  let status: BrokerResult["status"] = "executed";
  let output: string;
  if (!asked.length) {
    status = "error";
    output = `ERROR: ${TOOL_DOCS} needs "names", for example {"names":["gmail_search"]}.`;
  } else {
    const taken = asked.slice(0, TOOL_DOCS_MAX_NAMES);
    const entries = taken.map((name) => {
      const tool = name === TOOL_DOCS ? undefined : tools[name];
      if (!tool) return `- ${name}: not a tool available to you.`;
      loaded.add(name);
      return fullEntry(tool);
    });
    const left = asked.length - taken.length;
    output = entries.join("\n") + (left > 0 ? `\n\n${left} more name(s) were not loaded: ask for at most ${TOOL_DOCS_MAX_NAMES} at a time.` : "");
  }

  // The log is the record and the event is a view of it, in that order, as in the broker.
  try {
    store.logAction(runId, call, classified, status, output);
  } catch (err) {
    console.warn(`[tool-docs] could not log a lookup: ${err instanceof Error ? err.message : String(err)}`);
  }
  publish(runId, {
    callId,
    output: output.slice(0, 4000),
    reversibility: classified.reversibility,
    status,
    summary: classified.summary,
    target: classified.target,
    tool: call.tool,
    type: "tool_result",
  });
  return { output, status };
};

/**
 * Appended to an error from a tool whose entry the model never loaded: it guessed the arguments
 * and the tool refused them, so the next thing it needs is the entry. Marks the tool loaded so
 * this is said once.
 */
export const entryAfterError = (name: string, tools: Record<string, Tool>, loaded: Set<string>): string => {
  const tool = tools[name];
  if (!tool || loaded.has(name)) return "";
  loaded.add(name);
  return `\n\nYou called ${name} without loading its description. Here it is:\n${fullEntry(tool)}`;
};
