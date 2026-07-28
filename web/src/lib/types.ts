/** Shapes returned by the AgentSpine API, and the run events it streams. */

/** Mirrors BrokerStatus in src/types.ts — the decision the broker made about a call. */
export type BrokerStatus = "denied" | "dry-run" | "error" | "executed" | "queued";

export interface Action {
  args: string;
  decision: BrokerStatus;
  id: number;
  output: null | string;
  reversibility: null | string;
  target: null | string;
  tool: string;
  ts: string;
}

export interface Confirmation {
  args: string;
  id: number;
  result: null | string;
  run_id: null | number;
  state: "done" | "error" | "pending" | "rejected";
  summary: string;
  tool: string;
  ts: string;
}

export interface Conversation {
  archived: number;
  created: string;
  id: number;
  project_id: null | number;
  /** A pinned tier for this thread, or null to size each turn automatically. */
  tier: null | string;
  title: null | string;
  updated: string;
}

export interface Memory {
  id: number;
  kind: string;
  text: string;
  ts: string;
}

export interface Run {
  finished: null | string;
  id: number;
  kind: string;
  note: null | string;
  started: string;
  status: string;
  task: null | string;
}

export interface Schedule {
  enabled: number;
  id: number;
  last_run: null | string;
  name: string;
  next_run: null | string;
  spec: null | string;
  task: string;
}

/**
 * One exchange: what was asked, what came back, and every tool call in between. A turn is
 * a run — the server's unit of execution — presented as a unit of conversation.
 */
export type Tier = "deep" | "fast" | "standard";

export interface Agent {
  description: string;
  maxSteps: number;
  name: string;
  tier: Tier;
  tools: string[];
}

export interface Project {
  archived: number;
  chunks?: number;
  created: string;
  id: number;
  instructions: null | string;
  name: string;
  policy_overlay: null | string;
}

/** What one indexing pass actually did. */
export interface IngestResult {
  added: number;
  chunks: number;
  error?: string;
  removed: number;
  /** Formats that could not be read, and why — e.g. a PDF with no pdftotext installed. */
  skipped: string[];
  unchanged: number;
  updated: number;
}

export interface ProjectSource {
  chunk_count: number;
  file_count: number;
  id: number;
  kind: string;
  last_indexed: null | string;
  ref: string;
  status: null | string;
}

/** A unit a turn delegated to, with its own tool calls. */
export interface ChildRun {
  actions: Action[];
  agent: null | string;
  id: number;
  status: string;
  summary: null | string;
  task: null | string;
  tier: null | string;
}

export interface Turn {
  actions: Action[];
  /** Units this turn delegated to. */
  children: ChildRun[];
  /** Approvals this turn raised that are still open. */
  confirmations: Confirmation[];
  finished: null | string;
  id: number;
  started: string;
  status: string;
  summary: null | string;
  task: null | string;
  tier: null | string;
}

export interface Thread {
  conversation: Conversation;
  turns: Turn[];
}

// --- streamed run events (mirrors src/events.ts) ---

export interface RunEvent {
  agent?: string;
  args?: unknown;
  callId?: number;
  childRunId?: number;
  confirmationId?: number;
  depth?: number;
  message?: string;
  output?: string;
  reason?: string;
  reversibility?: null | string;
  seq: number;
  status?: string;
  step?: number;
  steps?: number;
  summary?: null | string;
  target?: null | string;
  tier?: string;
  tool?: string;
  ts: string;
  type:
    | "confirmation"
    | "error"
    | "final"
    | "queue_wait"
    | "run_end"
    | "run_start"
    | "step_start"
    | "subagent_end"
    | "subagent_start"
    | "tier"
    | "tool_call"
    | "tool_result";
}

/**
 * A tool call as the thread displays it: issued, then resolved. `status` is null while the
 * call is still in flight, which is the state the old dashboard could never show.
 */
export interface LiveToolCall {
  args: unknown;
  callId: number;
  output: null | string;
  status: BrokerStatus | null;
  summary: null | string;
  target: null | string;
  tool: string;
}

/** What a turn looks like while it is still running. */
export interface LiveTurn {
  confirmations: { id: number; summary: string; tool: string }[];
  /** Units delegated to during this turn, as they start and finish. */
  delegations: { agent: string; childRunId: number; status: null | string; summary: null | string; tier: string }[];
  error: null | string;
  runId: number;
  status: "failed" | "ok" | "queued" | "running";
  step: number;
  summary: null | string;
  task: string;
  tier: null | Tier;
  tierReason: string;
  toolCalls: LiveToolCall[];
  waitingBehind: number;
}
