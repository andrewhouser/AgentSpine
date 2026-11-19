/**
 * Turns the tools of the MCP servers named in policy.json into ordinary broker tools.
 *
 * Gating (docs/MCP.md). A server must be listed under `policy.mcp.servers` and `mcp.enabled`
 * must be true; an optional per-server `tools` list narrows what is exposed. Reversibility
 * follows the server's own `readOnlyHint` annotation: `true` is reversible, and anything else,
 * including a tool with no annotations at all, is irreversible and queues for approval. The
 * server is vouching for itself here, which is the trade the owner chose over declaring each
 * tool by hand, so the failure direction is the safe one: a missing hint costs a click and
 * never a silent write. Such tools also set `confirmWhenUnattended`, so a scheduled run that
 * read a hostile page cannot drive a remote write without asking.
 *
 * What the server sends is untrusted. A tool description goes straight into the prompt, so it
 * is flattened and clipped rather than passed through, and results come back tagged UNTRUSTED.
 */
import { McpClient } from "./client.ts";
import type { McpToolInfo } from "./client.ts";
import { clip } from "../stash.ts";
import { registry, tools } from "../tools/index.ts";
import type { ClassifiedAction, McpServerPolicy, Policy, PolicyDecision, Tool } from "../types.ts";

const DESCRIPTION_MAX = 300;
const OUTPUT_MAX = 6000;
const PREFIX = "mcp__";

/** Registry names are `mcp__<server>__<tool>`, restricted to characters the model can echo back exactly. */
export const mcpToolName = (server: string, tool: string): string =>
  `${PREFIX}${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");

const oneLine = (s: unknown, max: number): string => {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** `{"query":"string (required) — what to find"}`, the shape the other tools describe themselves in. */
export const schemaDocs = (schema: McpToolInfo["inputSchema"]): string => {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const entries = Object.entries(props).map(([key, def]) => {
    const type = Array.isArray(def?.type) ? def.type.join("|") : (def?.type ?? "any");
    const note = def?.description ? ` — ${oneLine(def.description, 80)}` : "";
    return `${JSON.stringify(key)}: ${JSON.stringify(`${type}${required.has(key) ? " (required)" : ""}${note}`)}`;
  });
  return `{${entries.join(", ")}}`;
};

const serverPolicy = (policy: Policy, server: string): McpServerPolicy | null => {
  if (!policy.mcp?.enabled) return null;
  const s = policy.mcp.servers?.[server];
  return s && s.enabled !== false ? s : null;
};

/** Build the broker Tool for one tool on one server. Exported for the tests. */
export const makeTool = (server: string, client: McpClient, info: McpToolInfo): Tool => {
  const name = mcpToolName(server, info.name);
  const readOnly = info.annotations?.readOnlyHint === true;
  const brief = (args: any): string => oneLine(JSON.stringify(args ?? {}), 160);

  return {
    argsSchema: schemaDocs(info.inputSchema),
    checkPolicy(policy: Policy): PolicyDecision {
      const s = serverPolicy(policy, server);
      if (!s) return { allowed: false, reason: `MCP server "${server}" is not enabled in policy.json` };
      if (s.tools && !s.tools.includes(info.name))
        return { allowed: false, reason: `${info.name} is not on mcp.servers.${server}.tools` };
      return { allowed: true, reason: "MCP tool permitted" };
    },
    classify(args: any): ClassifiedAction {
      return {
        reversibility: readOnly ? "reversible" : "irreversible",
        summary: `MCP ${server}: ${info.name} ${brief(args)}`,
        target: `${server}/${info.name}`,
      };
    },
    confirmWhenUnattended: !readOnly,
    description:
      `[MCP server "${server}"${readOnly ? ", read-only" : ", asks for approval"}] ` +
      (oneLine(info.description, DESCRIPTION_MAX) || oneLine(info.annotations?.title, 80) || info.name),
    name,
    async run(args: any, ctx): Promise<string> {
      const text = await client.callTool(info.name, args ?? {});
      return clip({ max: OUTPUT_MAX, runId: ctx?.runId ?? null, source: `MCP ${server}/${info.name}`, tool: name }, text);
    },
  };
};

/** Drop every MCP tool from the live registry, so a removed server or tool disappears on refresh. */
const unregisterAll = (): void => {
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].name.startsWith(PREFIX)) {
      delete registry[tools[i].name];
      tools.splice(i, 1);
    }
  }
};

/**
 * Connect to each enabled server, list its tools and (re)register them. A server that is
 * down is reported and skipped; it must not stop AgentSpine starting or take the other
 * servers' tools with it. Returns one human-readable line per server for the startup log.
 */
export const syncMcpTools = async (policy: Policy): Promise<string[]> => {
  const lines: string[] = [];
  const fresh: Tool[] = [];
  const servers = policy.mcp?.enabled ? Object.entries(policy.mcp.servers ?? {}) : [];

  for (const [server, s] of servers) {
    if (s.enabled === false) {
      lines.push(`${server}: disabled`);
      continue;
    }
    try {
      const token = s.tokenEnv ? process.env[s.tokenEnv] : undefined;
      if (s.tokenEnv && !token) throw new Error(`${s.tokenEnv} is not set`);
      const client = new McpClient(server, s.url, token);
      const listed = (await client.listTools()).filter((t) => !s.tools || s.tools.includes(t.name));
      for (const info of listed) fresh.push(makeTool(server, client, info));
      lines.push(`${server}: ${listed.length} tool(s)`);
    } catch (err) {
      lines.push(`${server}: unavailable (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  unregisterAll();
  for (const t of fresh) {
    // A built-in can never be shadowed by a server's tool; the prefix makes this unreachable
    // in practice, and the check keeps it that way if the naming ever changes.
    if (registry[t.name]) continue;
    tools.push(t);
    registry[t.name] = t;
  }
  return lines;
};
