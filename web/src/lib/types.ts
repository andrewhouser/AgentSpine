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
  /** `path` for an indexed directory, `meeting` for a transcript. */
  kind: string;
  last_indexed: null | string;
  ref: string;
  status: null | string;
}

// --- meetings ---

/** Mirrors MeetingStatus in src/meetings/store.ts. */
export type MeetingStatus = "abandoned" | "done" | "failed" | "recording" | "transcribing";

export interface Meeting {
  device: string;
  ended: null | string;
  id: number;
  note: null | string;
  project_id: null | number;
  started: string;
  status: MeetingStatus;
  title: null | string;
  transcribed_at: null | string;
  word_count: number;
}

export interface MeetingSegment {
  end_ms: number;
  id: number;
  ord: number;
  start_ms: number;
  text: string;
}

/** One audio input, and whether policy.audio.devices lists it. */
export interface AudioDevice {
  allowed: boolean;
  name: string;
}

export interface AudioDevices {
  allowed: string[];
  devices: AudioDevice[];
  enabled: boolean;
}

export interface LiveStatus {
  device: null | string;
  elapsedMs: number;
  meetingId: null | number;
  /** Chunks captured but not yet transcribed. Non-zero means transcription is behind. */
  pendingChunks: number;
  recording: boolean;
}

/** Mirrors MeetingEvent in src/meetings/session.ts. */
export interface MeetingEvent {
  answer?: CoachAnswer;
  cards?: ContextCards;
  kind: "coach" | "context" | "error" | "extraction" | "segment" | "status";
  meetingId: number;
  note?: string;
  segment?: { endMs: number; startMs: number; text: string };
  seq: number;
  status?: MeetingStatus;
  thinking?: boolean;
}

/** Mirrors DictationStatus in src/senses/dictate.ts. */
export interface DictationStatus {
  device: null | string;
  listening: boolean;
  maxSeconds: number;
  model: string;
  /** False when the Whisper model file is missing — both microphones fail the same way. */
  modelReady: boolean;
  /** Whether the server's own microphone can be used right now. */
  serverMic: boolean;
  serverMicReason: string;
}

/** Mirrors CoachAnswer in src/meetings/coach.ts. */
export interface CoachAnswer {
  cards: ContextCards;
  elapsedMs: number;
  /** The model's notes. Empty when it had nothing to offer. */
  notes: string;
  /** The recent transcript the answer was responding to. */
  question: string;
}

// --- live context cards (mirrors src/meetings/context.ts) ---

export interface ContextCard {
  score: number;
  /** Where this came from — a file path, an earlier meeting's title, or "memory". */
  source: string;
  text: string;
}

export interface ContextCards {
  documents: ContextCard[];
  meetings: ContextCard[];
  memories: ContextCard[];
  /** The rolling transcript window these were retrieved for. */
  query: string;
}

// --- what was made of the transcript (mirrors src/meetings/store.ts) ---

export type ExtractionStatus = "done" | "failed" | "running";

export interface MeetingDecision {
  /** Null once the retention window has taken the transcript this was quoted from. */
  quote: null | string;
  start_ms: number;
  text: string;
}

export interface MeetingExtraction {
  created: string;
  decisions: MeetingDecision[];
  elapsed_ms: number;
  meeting_id: number;
  model: null | string;
  note: null | string;
  status: ExtractionStatus;
  summary: null | string;
  topics: string[];
  windows: number;
}

/**
 * What became of one candidate work item. Only `queued` reached the confirmation queue;
 * the rest are kept so the extraction's false-positive rate stays visible rather than
 * being quietly edited out of the record.
 */
export type WorkItemVerdict = "already-done" | "not-a-task" | "queued" | "unanchored" | "unverified";

export interface MeetingWorkItem {
  confirmation_id: null | number;
  id: number;
  meeting_id: number;
  owner: null | string;
  quote: null | string;
  start_ms: null | number;
  task: string;
  verdict: WorkItemVerdict;
  verdict_note: null | string;
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
