/**
 * A minimal MCP client over Streamable HTTP (spec revision 2025-06-18).
 *
 * Hand-written instead of pulling in the MCP SDK because `src/` keeps exactly two runtime
 * dependencies (CLAUDE.md). What AgentSpine needs is three JSON-RPC calls (`initialize`,
 * `tools/list`, `tools/call`) over POST, which is a few dozen lines. Not implemented on
 * purpose: stdio, the server-to-client GET stream, resources, prompts, and sampling. A server
 * that asks for sampling or roots gets "method not found" because we never advertise them.
 *
 * A POST reply is either one JSON body or an SSE stream. Both are handled by reading the whole
 * reply and picking the message whose id matches the request, so an interleaved progress
 * notification is skipped rather than mistaken for the answer.
 */

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 60_000;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, any>; required?: string[]; [k: string]: any };
  annotations?: { readOnlyHint?: boolean; title?: string; [k: string]: any };
}

/** Pull the JSON-RPC message with this id out of a JSON or SSE reply body. */
export const pickResponse = (body: string, contentType: string, id: number): any => {
  if (!contentType.includes("text/event-stream")) return JSON.parse(body);
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg?.id === id) return msg;
    } catch {
      /* a keep-alive or a partial event; the next one may be the answer */
    }
  }
  throw new Error("MCP server's event stream ended without answering the request");
};

export class McpClient {
  readonly name: string;
  private url: string;
  private token: string | undefined;
  private sessionId: string | null = null;
  private nextId = 1;
  private ready = false;

  constructor(name: string, url: string, token?: string) {
    this.name = name;
    this.url = url;
    this.token = token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    if (this.ready) h["mcp-protocol-version"] = PROTOCOL_VERSION;
    return h;
  }

  private async post(payload: object): Promise<Response> {
    return fetch(this.url, {
      body: JSON.stringify(payload),
      headers: this.headers(),
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private async handshake(): Promise<void> {
    this.sessionId = null;
    this.ready = false;
    const id = this.nextId++;
    const res = await this.post({
      id,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "agentspine", version: "0.2.0" },
        protocolVersion: PROTOCOL_VERSION,
      },
    });
    if (!res.ok) throw new Error(`MCP ${this.name}: initialize failed with HTTP ${res.status}`);
    this.sessionId = res.headers.get("mcp-session-id");
    const msg = pickResponse(await res.text(), res.headers.get("content-type") ?? "", id);
    if (msg.error) throw new Error(`MCP ${this.name}: initialize: ${msg.error.message ?? "error"}`);
    this.ready = true;
    // Notifications have no id and no reply (the server answers 202).
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).then((r) => r.text());
  }

  /** One request, initialising first and once more if the server dropped our session. */
  private async request(method: string, params: object): Promise<any> {
    if (!this.ready) await this.handshake();
    for (let attempt = 0; ; attempt++) {
      const id = this.nextId++;
      const res = await this.post({ id, jsonrpc: "2.0", method, params });
      if (res.status === 404 && this.sessionId && attempt === 0) {
        await res.text();
        await this.handshake();
        continue;
      }
      if (!res.ok) throw new Error(`MCP ${this.name}: ${method} failed with HTTP ${res.status}`);
      const msg = pickResponse(await res.text(), res.headers.get("content-type") ?? "", id);
      if (msg.error) throw new Error(`MCP ${this.name}: ${method}: ${msg.error.message ?? "error"}`);
      return msg.result;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    // Bounded: a server that never stops returning a cursor must not hang startup.
    for (let page = 0; page < 20; page++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      out.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /** Call a tool and flatten its content blocks to text. A tool-level error throws. */
  async callTool(name: string, args: object): Promise<string> {
    const r = await this.request("tools/call", { arguments: args ?? {}, name });
    const text = (r?.content ?? [])
      .map((c: any) =>
        c?.type === "text"
          ? String(c.text ?? "")
          : c?.type === "resource" && c.resource?.text
            ? String(c.resource.text)
            : `[${c?.type ?? "unknown"} content omitted]`,
      )
      .join("\n");
    if (r?.isError) throw new Error(text || "the MCP tool reported an error");
    return text || "(the MCP tool returned no content)";
  }
}
