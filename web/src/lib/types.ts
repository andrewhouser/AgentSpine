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

/**
 * An image sent with a turn. Metadata only — the bytes come from /api/attachments/:id, so a
 * thread full of photographs is still one small JSON response and each image is cached once
 * by the browser.
 */
export interface Attachment {
  bytes: number;
  /**
   * Whether the vision pass actually read this image. Absent on an attachment echoed
   * straight out of the composer, where the looking has not happened yet.
   */
  described?: boolean;
  id: number;
  mime: string;
  name: null | string;
}

/** Mirrors the /api/vision route: whether images can be read at all, and by what. */
export interface VisionStatus {
  configured: boolean;
  maxBytes: number;
  maxImages: number;
  model: null | string;
}

export interface Confirmation {
  args: string;
  id: number;
  result: null | string;
  run_id: null | number;
  /** `expired`: the watchdog closed it unanswered past its window. Nothing ran. */
  state: "done" | "error" | "expired" | "pending" | "rejected";
  summary: string;
  tool: string;
  ts: string;
}

/**
 * An auto-approval proposal (docs/LEARNING.md Phase 2): one `(tool, target)` shape the ledger
 * says has been approved repeatedly and never once rejected, offered as the narrowest policy
 * rule that would stop it queueing.
 *
 * Nothing stores a proposal — the server recomputes them from the confirmation ledger on
 * every request. So a shape you reject once stops being proposed, and a shape already in
 * `policy.autoApprove` stops appearing at all.
 */
export interface PromotionProposal {
  /** How many times this exact shape was approved. Rejections are not a count: one is fatal. */
  approvals: number;
  /** The exact change this would make to policy.json, rendered server-side. */
  diff: string;
  /** Days between the first and last approval — the shape's track record. */
  spanDays: number;
  /** The most recent approval's own summary, as a sample of what the rule would cover. */
  summary: string;
  target: string;
  tool: string;
  /** The confirmation ids this rule would have auto-executed, and nothing else. */
  wouldHaveAutoRun: number[];
}

export interface Conversation {
  archived: number;
  /** Decisions waiting on the user in this thread — drawn as the blue dot. */
  attention?: number;
  created: string;
  id: number;
  project_id: null | number;
  /** A pinned tier for this thread, or null to size each turn automatically. */
  tier: null | string;
  title: null | string;
  /** 1 when a reply finished after you last looked — also drawn as the blue dot. */
  unread?: number;
  updated: string;
}

/** GET /api/cloud-usage (src/cloud-cap.ts). A cap of 0 means no cap. */
export interface CloudUsage {
  caps: { day: number; month: number; run: number };
  /** False when no cloud key is set: nothing can be spent and the caps are idle. */
  enabled: boolean;
  model: null | string;
  /** Last few refusals, newest first. */
  recent: { cap: "day" | "month" | "run"; limit: number; period: string; runId: null | number; ts: string; used: number }[];
  used: { day: number; month: number };
}

/** One message in the weekly review (src/outbox-review.ts). */
export interface ReviewItem {
  body: string;
  created: string;
  /** Your answer so far. */
  feedback: "skip" | "useful" | null;
  id: number;
  kind: string;
  /** What became of it: opened and dismissed come from the phone; ntfy and Mac banners say "unknown". */
  outcome: "dismissed" | "ignored" | "opened" | "pending" | "unknown";
  source: string;
  title: string;
  /** What "Skip this kind" files the dismissal under. */
  topic: string;
}

/** GET /api/outbox/review. */
export interface OutboxReview {
  days: number;
  items: ReviewItem[];
  tally: {
    deduped: number;
    dismissed: number;
    held: number;
    ignored: number;
    opened: number;
    sent: number;
    source: string;
    wouldChange: number;
  }[];
}

export interface Memory {
  id: number;
  kind: string;
  /** The route that wrote it (reflection, tool, profile, ...), or null for a memory from before provenance. */
  origin: null | string;
  /** The run that wrote it, when there is one. */
  runId: null | number;
  /** `runId` is set but that run's trace has since been pruned. */
  runPruned: boolean;
  text: string;
  ts: string;
}

/** GET /api/overview: everything installed, read-only, with the prune list (src/overview.ts). */
export interface Overview {
  connectors: { configured: boolean; detail: string; name: string }[];
  flags: { href: string; severity: "info" | "warn"; text: string }[];
  generated: string;
  memory: { cap: null | number; count: number; kind: string }[];
  policy: {
    autoApprove: { target: string; tool: string }[];
    chatAutoTools: string[];
    dryRun: boolean;
    irreversibleAlwaysConfirm: boolean;
    readableDirs: string[];
    schedulesEnabled: boolean;
    userDirected: string[];
    webSearch: boolean;
    writableDirs: string[];
  };
  projects: { badSources: string[]; chunks: number; id: number; name: string; sources: number }[];
  recipes: { created: string; last_used: null | string; name: string; uses: number }[];
  schedules: {
    created: string;
    enabled: boolean;
    id: number;
    last_run: null | string;
    name: string;
    next_run: null | string;
    recent: string[];
    spec: null | string;
  }[];
  study: { cards: number; due: number; lastActivity: null | string; name: string; projectId: null | number }[];
  tools: { errors7d: number; name: string; uses30d: number }[];
}

/**
 * A question someone put to you in a meeting, as a study candidate (src/study/meeting-questions.ts).
 * `quote` and `reply` are verbatim from the transcript. `question` and `answer` are the drafted
 * card, the answer taken from the project's documents only. `covered` false means they didn't
 * answer it.
 */
export interface MeetingQuestion {
  answer: string;
  asker: null | string;
  card_id: null | number;
  covered: boolean;
  created: string;
  id: number;
  meeting_id: number;
  project_id: number;
  question: string;
  quote: string;
  reply: null | string;
  sources: string[];
  start_ms: number;
  status: "accepted" | "dismissed" | "pending";
}

/** A study card as the Study screen sees it before a recall: the question only. */
export interface StudyDueCard {
  front: string;
  id: number;
  lapses: number;
  reps: number;
  topicId: number;
  topicName: string;
}

/** What grading a recall returns. The answer arrives only here, after you have produced yours. */
export interface StudyReview {
  back: string;
  cardId: number;
  due: string;
  feedback: string;
  /** Days to the next review; 0 means it comes back in this sitting. */
  interval: number;
  remaining: number;
  score: number;
}

export interface StudyTopic {
  cards: number;
  consumed: number;
  due: number;
  goal: null | string;
  id: number;
  level: null | number;
  map: { dependsOn: string[]; name: string; summary: string }[];
  name: string;
  produced: number;
  projectId: null | number;
}

export interface StudyOverview {
  due: number;
  topics: StudyTopic[];
}

/** A named recipe (src/recipes): a procedure the user approved, asked for by name. */
export interface Recipe {
  conversation_id: null | number;
  created: string;
  id: number;
  last_used: null | string;
  name: string;
  steps: string[];
  updated: string;
  uses: number;
  when_text: string;
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
  /** When the kept recording is deleted, ISO; null when none is kept. */
  audio_expires: null | string;
  device: string;
  ended: null | string;
  id: number;
  note: null | string;
  project_id: null | number;
  started: string;
  status: MeetingStatus;
  tags?: string[];
  title: null | string;
  transcribed_at: null | string;
  word_count: number;
}

export interface MeetingSegment {
  end_ms: number;
  id: number;
  ord: number;
  /** 0-based speaker index; null/absent on the live pass or when detection did not run. */
  speaker?: null | number;
  /** A name you gave the speaker, else "Speaker N". */
  speaker_name?: null | string;
  start_ms: number;
  text: string;
}

export interface MeetingSpeaker {
  index: number;
  name: string;
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
  chat?: ChatMessage;
  kind: "chat" | "coach" | "context" | "error" | "extraction" | "segment" | "status";
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

/** Mirrors ChatRow in src/meetings/store.ts: one line of the in-meeting chat. */
export interface ChatMessage {
  created: string;
  elapsed_ms: null | number;
  /** An answer that could not be produced; shown, but never fed back into a prompt. */
  failed: boolean;
  id: number;
  meeting_id: number;
  role: "assistant" | "user";
  text: string;
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
export type WorkItemVerdict = "already-done" | "filed" | "not-a-task" | "queued" | "unanchored" | "unverified";

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

export interface Task {
  client_id: null | number;
  completed: null | string;
  created: string;
  due: null | string;
  id: number;
  kind: "followup" | "task";
  notes: null | string;
  project_id: null | number;
  status: "done" | "dropped" | "open";
  title: string;
  waiting_on: null | string;
}

/** One research result: a product or restaurant, or a plain link when nothing could be read. */
export interface HeadsupCard {
  amount: null | number;
  fetchedAt: string;
  host: string;
  id: number;
  imageUrl: null | string;
  kind: "gift" | "link" | "restaurant";
  note: null | string;
  priceText: null | string;
  title: string;
  url: string;
}

/** Which recipients a writing style applies to. Exact addresses, and domains (which include subdomains). */
export interface StyleAppliesTo {
  addresses: string[];
  domains: string[];
}

/** A writing style in force. */
export interface WritingStyle {
  applies_to: StyleAppliesTo;
  name: string;
  note: string;
  sampled: number;
  updated: string;
}

/** A style built from your sent mail, waiting for you to read and accept it. */
export interface StyleProposal {
  applies_to: StyleAppliesTo;
  created: string;
  name: string;
  note: string;
  /** True if accepting it would overwrite a style you have now. */
  replaces: boolean;
  sampled: number;
}

export interface StylesState {
  defaultStyle: string;
  proposals: StyleProposal[];
  styles: WritingStyle[];
}

/** What became of one kind of heads-up over the last 90 days. `tier` says what the learning has done about it. */
export interface HeadsupKindLearning {
  counted: number;
  ignored: number;
  kind: string;
  later: number;
  never: number;
  offered: number;
  open: number;
  rate: number;
  tier: "none" | "off" | "quiet";
  yes: number;
}

/** Heads-up preferences, plus read-only facts about what cannot run yet. */
export interface HeadsupPrefs {
  dailyCap: number;
  /** The watch loop never polls one watch more often than this. Shown, not changeable. */
  floorMinutes: number;
  kinds: Record<string, boolean>;
  /** Days before the event at each mention, largest first. Absent from a server that predates lead-time overrides. */
  leadDays?: Record<string, number[]>;
  /** The shipped lead times. Read-only. */
  leadDaysDefault?: Record<string, number[]>;
  /** Read-only. Absent from a server that predates the learning. */
  learning?: HeadsupKindLearning[];
  quietEndHour: number;
  quietStartHour: number;
  unavailable: { drive: null | string; flights: null | string };
}

/** The standing watch behind a Yes on a flight or a drive. */
export interface HeadsupWatch {
  active: boolean;
  kind: "drive" | "flight";
  lastPolled: null | string;
  /** The latest plain-words state, or what is blocking it. */
  note: null | string;
}

/** A proactive suggestion: something coming up that the assistant noticed. */
export interface Headsup {
  amount: null | string;
  answer: null | string;
  cards: HeadsupCard[];
  dueAt: string;
  firstOfferedAt: null | string;
  id: number;
  kind: string;
  location: null | string;
  query: null | string;
  researchError: null | string;
  researchNote: null | string;
  snoozeUntil: null | string;
  state: "accepted" | "dismissed" | "done" | "expired" | "offered" | "researched" | "snoozed";
  subject: string;
  watch: HeadsupWatch | null;
  /** What Yes does: find ideas, watch a flight or a drive, or just acknowledge. */
  yesAction: "ack" | "research" | "watch";
  yesLabel: string;
}

/** A date you told it about, or one it noticed in chat and is waiting for you to confirm. */
export interface HeadsupDates {
  proposals: {
    confirmationId: number;
    day: null | number;
    month: null | number;
    occasion: string;
    summary: string;
    who: string;
  }[];
  remembered: { day: number; id: number; month: number; occasion: string; title: string; who: string }[];
}

/** What a run would offer right now. Reads the calendars, writes and sends nothing. */
export interface HeadsupPreview {
  /** Due but held back by the daily cap or quiet hours. */
  deferred: number;
  errors: string[];
  offers: { daysUntil: number; kind: string; reason: "changed" | "new" | "reminder" | "snoozed"; subject: string }[];
}

export interface HeadsupRun {
  deferred: number;
  errors: string[];
  offered: number;
  status: string;
}

export interface Client {
  email: null | string;
  id: number;
  name: string;
  next_action: null | string;
  next_action_due: null | string;
  notes: null | string;
  status: string;
  updated: string;
}

export interface TimeSummary {
  entries: { client: null | string; day: string; id: number; minutes: number; note: null | string }[];
  totals: { client: null | string; clientId: null | number; entries: number; label: string; minutes: number }[];
}

export interface BuildCommand {
  decision: string;
  name: string;
  ts: string;
  verdict: string;
}

/** One run that ran a command or touched git. Derived from the actions log — see src/builds.ts. */
export interface Build {
  branch: null | string;
  commands: BuildCommand[];
  commits: number;
  files: string[];
  finished: null | string;
  kind: null | string;
  ok: boolean | null;
  repo: null | string;
  run_id: number;
  started: string;
  status: null | string;
  summary: null | string;
  task: null | string;
}

export interface BuildDiff {
  base: null | string;
  branch: null | string;
  patch: string;
  repo: string;
  stat: string;
  uncommitted: string;
  untracked: string[];
}

export interface SavedFile {
  action: string;
  bytes: number;
  exists: boolean;
  modified: null | string;
  name: string;
  path: string;
  run_id: null | number;
  ts: string;
}

export interface SearchHit {
  conversationId: null | number;
  conversationTitle: null | string;
  finished: null | string;
  runId: number;
  snippet: string;
  task: string;
}

export interface Turn {
  actions: Action[];
  /** Images the user sent with this turn. */
  attachments: Attachment[];
  /** Units this turn delegated to. */
  children: ChildRun[];
  /** Approvals this turn raised that are still open. */
  confirmations: Confirmation[];
  /** What the assistant had in front of it for this turn (short labels). */
  contextUsed?: string[];
  finished: null | string;
  id: number;
  /** "chat" for a message the user typed; "approval" for the turn their decision resumed. */
  kind?: null | string;
  starred?: boolean;
  started: string;
  status: string;
  summary: null | string;
  task: null | string;
  tier: null | string;
}

export interface Thread {
  /** Open questions no turn here raised (the inbox's) — drawn after the last turn. */
  confirmations?: Confirmation[];
  conversation: Conversation;
  /** Whether this is the system's own thread, where questions nobody's chat raised are asked. */
  inbox?: boolean;
  turns: Turn[];
}

// --- streamed run events (mirrors src/events.ts) ---

export interface RunEvent {
  agent?: string;
  args?: unknown;
  callId?: number;
  childRunId?: number;
  confirmationId?: number;
  /** `vision`: how many images were looked at. */
  count?: number;
  depth?: number;
  /** `vision`: how long the perception pass took. */
  elapsedMs?: number;
  /** `vision`: why the images could not be read, when they could not be. */
  error?: string;
  message?: string;
  /** `vision`: which model did the looking. */
  model?: string;
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
    | "tool_result"
    | "vision";
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

/**
 * The perception pass, as the thread shows it: started, then finished or failed.
 *
 * `elapsedMs` is null while it is still looking, which is the state worth rendering — the
 * pass is several seconds on a photograph and a turn that showed nothing during it would
 * look stalled.
 */
export interface VisionPass {
  count: number;
  elapsedMs: null | number;
  error: null | string;
}

/** What a turn looks like while it is still running. */
export interface LiveTurn {
  /** Images the user attached, echoed locally so the turn renders them before it finishes. */
  attachments: Attachment[];
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
  /** Null until this turn turns out to have images on it. */
  vision: null | VisionPass;
  waitingBehind: number;
}

/** Mirrors VoiceStatus in src/senses/voice.ts. */
export interface VoiceStatus {
  defaults: { aliases: string[]; soundsAlike: boolean; timeoutSeconds: number; wakeWord: string };
  listenReady: boolean;
  /** Why listening cannot work, or empty. */
  listenReason: string;
  speakReady: boolean;
  /** Why replies cannot be spoken, or empty. */
  speakReason: string;
  voice: string;
}

/** Mirrors WakeResult in src/senses/voice.ts. */
export interface WakeResult {
  command: string;
  heard: string;
  woke: boolean;
}
