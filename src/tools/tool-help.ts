/**
 * tool_help: the full instructions for tools the prompt lists in one line (PLAN-open-work section 10, LP6).
 *
 * Read-only and local. It answers only for tools this run can actually use (its harness's list), so it cannot be
 * used to learn about tools a unit or a setting was not given. Its output is appended to the history like any tool
 * result, which is the point: the cached prompt prefix stays as it was.
 */
import { getHarness } from "../harness.ts";
import { fullDoc } from "../tool-docs.ts";
import type { ClassifiedAction, PolicyDecision, Tool } from "../types.ts";

const MAX_NAMES = 6;

export const toolHelp: Tool = {
  name: "tool_help",
  description:
    "Read the full instructions and argument shape for tools listed in one line under \"More tools\". Give their " +
    `names (at most ${MAX_NAMES}). Call it before using such a tool for the first time.`,
  argsSchema: '{ "names": string[] }',
  classify: (): ClassifiedAction => ({ reversibility: "reversible", summary: "Read tool instructions", target: "tools" }),
  checkPolicy: (): PolicyDecision => ({ allowed: true, reason: "reads tool descriptions" }),
  run: async (a: any, ctx) => {
    const asked = (Array.isArray(a?.names) ? a.names : a?.names ? [a.names] : []).map((n: unknown) => String(n ?? "").trim()).filter(Boolean);
    if (!asked.length) return 'ERROR: tool_help needs "names": the tools you want instructions for.';
    // Imported here: the registry imports this file.
    const { registry } = await import("./index.ts");
    const visible = new Set(getHarness(ctx?.runId ?? null)?.tools ?? Object.keys(registry));
    const out = (asked as string[]).slice(0, MAX_NAMES).map((name) =>
      visible.has(name) && registry[name] ? fullDoc(registry[name]) : `- ${name}: not a tool you can use here.`,
    );
    if (asked.length > MAX_NAMES) out.push(`(Only the first ${MAX_NAMES} were answered; ask again for the rest.)`);
    return out.join("\n");
  },
};
