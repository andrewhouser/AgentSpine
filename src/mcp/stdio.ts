/**
 * A minimal MCP client over stdio (PLAN-open-work section 10, CP1, built 2026-11-25).
 *
 * Most MCP servers people run with Claude Desktop are local programs that speak JSON-RPC on stdin and stdout, one
 * message per line. They are more private than a remote server: nothing has to leave the machine. Same three calls as
 * the HTTP client (`initialize`, `tools/list`, `tools/call`), hand-written for the same reason (two runtime
 * dependencies, CLAUDE.md).
 *
 * What runs, and with what:
 *   - The command is an argument list from `policy.json`, which only a person edits, and it is spawned directly,
 *     never through a shell, so nothing in it is interpreted.
 *   - The child gets a minimal environment, not this process's: PATH, HOME, the locale, and only what the entry names
 *     (`env` values, and `envFrom` variables passed through by name). This process holds the cloud key, the dashboard
 *     token and the Google paths, and a third-party program has no business inheriting them.
 *   - It starts on first use, is restarted once if it has died, and is stopped when tools are re-discovered and when
 *     AgentSpine exits.
 *
 * What it may ask of us: nothing. A request from the server (sampling, roots) is answered "method not found", since
 * we never advertise either; a ping is answered, as the spec requires. Its stderr is kept, briefly, for the error
 * message when it fails, and never shown to a model.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { McpToolInfo } from "./client.ts";

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 60_000;
/** A line longer than this is not a message we will hold in memory; the server is stopped. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const STDERR_KEEP = 2000;

/** The environment variables a child always gets: enough to find programs and read text, nothing that grants anything. */
const BASE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];

export interface StdioSpec {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  envFrom?: string[];
}

/** The child's environment: the base names, the entry's own values, and the named variables passed through. */
export const childEnv = (spec: StdioSpec, from: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of [...BASE_ENV, ...(spec.envFrom ?? [])]) if (from[k] !== undefined) out[k] = String(from[k]);
  for (const [k, v] of Object.entries(spec.env ?? {})) out[k] = String(v);
  return out;
};

interface Pending {
  reject: (err: Error) => void;
  resolve: (value: any) => void;
  timer: NodeJS.Timeout;
}

const live = new Set<StdioMcpClient>();
let exitHooked = false;

export class StdioMcpClient {
  readonly name: string;
  private spec: StdioSpec;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";

  constructor(name: string, spec: StdioSpec) {
    if (!Array.isArray(spec.command) || !spec.command.length || !spec.command.every((p) => typeof p === "string" && p)) {
      throw new Error(`MCP ${name}: "command" must be a non-empty list of strings`);
    }
    this.name = name;
    this.spec = spec;
    live.add(this);
    if (!exitHooked) {
      exitHooked = true;
      process.once("exit", () => {
        for (const c of live) c.close();
      });
    }
  }

  private fail(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.ready = null;
    this.child = null;
  }

  private write(msg: object): void {
    this.child?.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // a log line on stdout is the server's mistake; it is not a message
    }
    if (msg && typeof msg.method === "string" && msg.id !== undefined) {
      // A request from the server. Ping is answered; everything else (sampling, roots) we never offered.
      if (msg.method === "ping") this.write({ id: msg.id, jsonrpc: "2.0", result: {} });
      else this.write({ error: { code: -32601, message: "Method not found" }, id: msg.id, jsonrpc: "2.0" });
      return;
    }
    const p = typeof msg?.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return; // a notification, or an answer nobody is waiting for
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`MCP ${this.name}: ${msg.error.message ?? "error"}`));
    else p.resolve(msg.result);
  }

  private start(): void {
    const [cmd, ...args] = this.spec.command;
    const child = spawn(cmd, args, { cwd: this.spec.cwd, env: childEnv(this.spec), shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    live.add(this); // a client used again after close() starts a process that must still be stopped at exit
    this.buffer = "";
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
        this.close();
        this.fail(new Error(`MCP ${this.name}: the server sent a message over ${MAX_LINE_BYTES} bytes, so it was stopped`));
        return;
      }
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.onLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
    });
    const gone = (why: string): void => {
      if (this.child !== child) return;
      const tail = this.stderr.trim().split("\n").slice(-3).join(" | ");
      this.fail(new Error(`MCP ${this.name}: ${why}${tail ? ` (stderr: ${tail.slice(0, 300)})` : ""}`));
    };
    child.on("error", (err) => gone(`could not start ${cmd}: ${err.message}`));
    child.on("exit", (code, signal) => gone(`the server exited (${signal ?? `code ${code}`})`));
    // A write to a pipe the child has closed must surface as the exit above, not crash this process.
    child.stdin.on("error", () => {});
  }

  private send(method: string, params: object): Promise<any> {
    if (!this.child) return Promise.reject(new Error(`MCP ${this.name}: not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: ${method} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { reject, resolve, timer });
      this.write({ id, jsonrpc: "2.0", method, params });
    });
  }

  private ensure(): Promise<void> {
    if (this.ready && this.child) return this.ready;
    this.start();
    this.ready = (async () => {
      await this.send("initialize", { capabilities: {}, clientInfo: { name: "agentspine", version: "0.2.0" }, protocolVersion: PROTOCOL_VERSION });
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  /** One request, starting the server first, and once more if it had died since the last call. */
  private async request(method: string, params: object): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensure();
        return await this.send(method, params);
      } catch (err) {
        const died = !this.child;
        if (attempt === 0 && died && !/timed out/.test(String(err))) continue;
        throw err;
      }
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      out.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /** Call a tool and flatten its content blocks to text, as the HTTP client does. A tool-level error throws. */
  async callTool(name: string, args: object): Promise<string> {
    const r = await this.request("tools/call", { arguments: args ?? {}, name });
    const text = (r?.content ?? [])
      .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "resource" && c.resource?.text ? String(c.resource.text) : `[${c?.type ?? "unknown"} content omitted]`))
      .join("\n");
    if (r?.isError) throw new Error(text || "the MCP tool reported an error");
    return text || "(the MCP tool returned no content)";
  }

  /** Stop the server. Safe to call twice. */
  close(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    live.delete(this);
    if (child && child.exitCode === null) child.kill();
  }
}
