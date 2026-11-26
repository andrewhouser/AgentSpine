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
  state: "done" | "error" | "executing" | "expired" | "pending" | "rejected";
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
  /** 1 once the thread has touched private material: every turn runs on the local model only. */
  local_only?: null | number;
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

/** One card from the weekly retrospective. Code chose it; the local model only worded it. */
export interface RetroCard {
  id: number;
  kind: "auto_approval" | "code_change" | "memory_correction" | "missing_capability" | "recipe" | "routine";
  runIds: number[];
  title: string;
  week: string;
  why: string;
}

/** A self-critique or learned recipe no run can see until you keep it. */
export interface LessonCard {
  id: number;
  /** Absent from a server older than recipe review, where every card is a lesson. */
  kind?: "lesson" | "recipe";
  runId: null | number;
  /** `critique`, `reflection`, or `before_review` for one stored before review existed. */
  source: string;
  text: string;
}

/** What code measured after a job's task changed. The server writes the words, so all three clients agree. */
export interface AfterCheck {
  detail: null | string;
  headline: string;
  status: "not_enough" | "ready" | "superseded" | "waiting";
  verdict: "better" | "mixed" | "same" | "worse" | null;
}

/** One change to a job's task. GET /api/schedules/:id/versions, newest first. */
export interface ScheduleVersion {
  after: string;
  before: string;
  canRestore: boolean;
  changed: string;
  check: AfterCheck | null;
  id: number;
  restored: boolean;
  sourceLabel: string;
}

/** A finished after-check waiting for your answer in the weekly review. */
export interface AfterCheckCard {
  changed: string;
  detail: null | string;
  headline: string;
  id: number;
  name: string;
  scheduleId: number;
  verdict: "better" | "mixed" | "same" | "worse";
}

/** GET /api/outbox/review. */
export interface OutboxReview {
  /** Absent from a server older than SL8. */
  afterChecks?: AfterCheckCard[];
  days: number;
  items: ReviewItem[];
  /** The newest few lessons and how many wait in all. Absent from a server older than lesson review. */
  lessons?: { cards: LessonCard[]; total: number };
  /** Kinds you mostly skip over 90 days. `off` ones may have a proposal to switch the schedule off waiting in Approvals. */
  quiet: { counted: number; kind: string; rate: number; sent: number; skipped: number; source: string; tier: "off" | "quiet"; topic: string }[];
  /** Absent from a server older than SL2. */
  retro?: RetroCard[];
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
  /** The last run skipped for being too late (section 13, H6): when, which slot, and why. */
  last_skip_at?: null | string;
  last_skip_reason?: null | string;
  last_skip_slot?: null | string;
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

/** What is kept and for how long, per kind of thing (GET /api/retention). */
export interface RetentionRule {
  artifact: string;
  rule: string;
  setting: null | string;
}

export interface Project {
  archived: number;
  chunks?: number;
  created: string;
  id: number;
  instructions: null | string;
  /** The one workspace file (AGENTSPINE.md) the owner vouches for as trusted instructions. */
  instructions_file?: null | string;
  name: string;
  policy_overlay: null | string;
  /** This project's own raw-transcript window in days; null follows the global setting, 0 keeps them until the meeting is deleted. */
  transcript_retention_days?: null | number;
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
  /** 1 the full transcript stays searchable in its project, 0 summary only, null never chosen (acts as 1). */
  keep_transcript?: null | number;
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

/** One step of a booking's reminder sequence: when it is due and what became of it. */
export interface HeadsupReminder {
  dueAt: string;
  /** "Two days before", "That morning", "An hour before". */
  label: string;
  /** Why it was skipped, held or withdrawn, in the server's words. */
  reason: null | string;
  state: "pending" | "sent" | "skipped" | "withdrawn";
  step: string;
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
  /** The reminders a Yes on a booking set up. Empty for every other kind. */
  reminders?: HeadsupReminder[];
  researchError: null | string;
  researchNote: null | string;
  snoozeUntil: null | string;
  state: "accepted" | "dismissed" | "done" | "expired" | "offered" | "researched" | "snoozed";
  subject: string;
  watch: HeadsupWatch | null;
  /** What Yes does: find ideas, watch a flight or a drive, set up a booking's reminders, or just acknowledge. */
  yesAction: "ack" | "remind" | "research" | "watch";
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
  remembered: HeadsupDate[];
}

/** One remembered date. `year` is null when you never said it. */
export interface HeadsupDate {
  day: number;
  id: number;
  month: number;
  occasion: string;
  title: string;
  who: string;
  year?: null | number;
}

/** What you send to change one. Read on the server exactly as the `date_remember` tool reads it. */
export interface HeadsupDateEdit {
  day: number;
  month: number;
  occasion: string;
  who: string;
  year: null | number;
}

/** What a run would offer right now. Reads the calendars, writes and sends nothing. */
export interface HeadsupPreview {
  /** Due but held back by the daily cap or quiet hours. */
  deferred: number;
  errors: string[];
  offers: { daysUntil: number; kind: string; reason: "changed" | "new" | "reminder" | "snoozed"; subject: string }[];
}

/** One thing the check-in found. Only mail `triggers`: the rest rides along. */
export interface CheckinItem {
  detail: string;
  /** Not seen at an earlier check. */
  fresh: boolean;
  key: string;
  kind: "approval" | "calendar" | "headsup" | "mail" | "task";
  title: string;
  triggers: boolean;
}

/** What a check right now would find and say. Reads only: nothing is recorded or sent. */
export interface CheckinPreview {
  body: string;
  /**
   * Inbox buckets (section 14, U7): a label per mail item, by the item's key. Empty unless the
   * server's INBOX_SORT_MODE is "on", and absent from a server that predates them.
   */
  buckets?: Record<string, CheckinBucket>;
  errors: string[];
  /** Why a check now would stay silent even with something to say. */
  heldBy: "cap" | "off" | "quiet" | null;
  items: CheckinItem[];
  mode: "log" | "off" | "push";
  /** Sources switched off in Settings, which were not read. Absent from a server that predates the setting. */
  off?: CheckinItem["kind"][];
  title: string;
  wouldSend: boolean;
}

/** One mail's label. Both are null when the model's answer was not a label: the mail is unsorted. */
export interface CheckinBucket {
  bucket: "fyi" | "reply-today" | "urgent" | null;
  reason: null | string;
}

/** What "Draft a reply" did. A draft waits for approval like any other; nothing is sent. */
export interface CheckinReply {
  confirmationId?: number;
  message: string;
  ok: boolean;
}

/** Which sources the check-in reads. Only mail can start a notification. */
export type CheckinSources = Record<CheckinItem["kind"], boolean>;

export interface CheckinRun {
  at: string;
  body: string;
  errors: string[];
  /** New mail from a person at that check. */
  fresh: number;
  id: number;
  mode: string;
  status: string;
  title: string;
  total: number;
}

export interface CheckinStatus {
  intervalHours: number;
  lastError: null | string;
  lastRun: null | string;
  mode: "log" | "off" | "push";
  pushDetail: "senders" | "subjects";
  runs: CheckinRun[];
  /** Whether mail is sorted into buckets. Absent from a server that predates them, which reads as off. */
  sortMode?: "log" | "off" | "on";
  /** Which sources a check-in reads. Absent from an older server, which reads them all. */
  sources?: Record<CheckinSource, boolean>;
}

export type CheckinSource = "approval" | "calendar" | "headsup" | "mail" | "task";

/** What "Check now" reports. */
export interface CheckinResult {
  body: string;
  errors: string[];
  fresh: number;
  status: string;
  title: string;
  total: number;
}

export interface HeadsupRun {
  deferred: number;
  errors: string[];
  offered: number;
  status: string;
}

/**
 * A client or a prospect. The fields marked optional are the prospect ones (PLAN-open-work
 * section 14, U4): every sentence among them is made by the server (src/clients/prospects.ts),
 * so the three clients show the same words, and a server that predates prospects sends none.
 */
export interface Client {
  /** When the site was last audited, or null. */
  audit_at?: null | string;
  email: null | string;
  /** One sentence on where the audit stands, ready to show. */
  fit_line?: string;
  /** The audit's most important findings, one sentence each. */
  fit_reasons?: string[];
  fit_score?: null | number;
  id: number;
  name: string;
  next_action: null | string;
  next_action_due: null | string;
  notes: null | string;
  /** True when the status is one of the prospect ones. */
  prospect?: boolean;
  site?: null | string;
  /** Where the name came from, in your words. */
  source?: null | string;
  status: string;
  status_label?: string;
  updated: string;
}

/** What pasting a list of prospects did: the rows it saved, and each line it could not read with the reason. */
export interface ProspectPaste {
  added: Client[];
  skipped: { line: string; reason: string }[];
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
  project_id: null | number;
  project_name: null | string;
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

/** What answered a turn (runs.served); absent for turns recorded before the server kept it. */
export interface ServedModel {
  cloud: boolean;
  model: string;
  tier: string;
  via: "cloud" | "local";
}

/** Model calls and tokens for a turn and the child runs it started. A call with no reported usage adds none. */
export interface RunUsage {
  byModel: { calls: number; completionTokens: number; model: string; ms: number; promptTokens: number; tier: null | string }[];
  calls: number;
  completionTokens: number;
  promptTokens: number;
  /** Time spent on calls that reported output tokens. Absent from a server older than this field. */
  reportedMs?: number;
  unreported: number;
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
  /** The finished step checklist, folded server-side from `actions` (src/plan.ts). */
  plan?: PlanStep[];
  served?: null | ServedModel;
  starred?: boolean;
  started: string;
  status: string;
  summary: null | string;
  task: null | string;
  tier: null | string;
  usage?: RunUsage;
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
  /** `plan`: the whole plan card, newest state (src/plan.ts). */
  items?: PlanStep[];
  /** tool_progress: what the tool is doing now, e.g. "rendering 42%". */
  label?: string;
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
  /** `answer`: the whole reply so far, or "" when it was taken back. */
  text?: string;
  tier?: string;
  tool?: string;
  ts: string;
  type:
    | "answer"
    | "budget"
    | "compacted"
    | "confirmation"
    | "error"
    | "final"
    | "paused_for_person"
    | "plan"
    | "queue_wait"
    | "run_end"
    | "run_start"
    | "step_start"
    | "subagent_end"
    | "subagent_start"
    | "tier"
    | "tool_call"
    | "tool_progress"
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
  /** What a long-running tool says it is doing right now, e.g. "rendering 42%". */
  progress?: string;
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

/** One row of the plan card. Mirrors PlanStep in src/plan.ts; the server owns the status. */
export interface PlanStep {
  count: number;
  label: string;
  status: "active" | "done" | "failed" | "pending" | "waiting";
}

/** What a turn looks like while it is still running. */
/** One post in the Instagram queue, as GET /api/instagram/queue gives it (src/instagram/queue.ts rowForClient). */
export interface InstagramQueueRow {
  approved: boolean;
  /** Approved once, but the content changed since, so the approval no longer counts. */
  approvedChanged: boolean;
  blockers: string[];
  /** The post exactly as it will go out: the approval card's text. */
  card: string;
  /** The content digest an approval must name. */
  hash: string;
  id: string;
  kind: string;
  permalink: null | string;
  publishAt: string;
  status: string;
  surface: string;
}

export interface InstagramQueue {
  enabled: boolean;
  live: boolean;
  rows: InstagramQueueRow[];
}

/** A call refused whoever approves (GET /api/refusals, D2). No arguments: they can carry the refused text. */
export interface Refusal {
  id: number;
  reason: string;
  runId: null | number;
  tool: string;
  ts: string;
}

/** What happened to a run along the way that is not a tool call (GET /api/runs/:id `notes`; LP3, LP5). */
export interface RunNote {
  detail: Record<string, unknown>;
  kind: "budget" | "compacted" | "paused_for_person";
  ts: string;
}

export interface LiveTurn {
  /** The answer as it is being written. A preview: `summary` replaces it when the run finishes. */
  answer: string;
  /** Images the user attached, echoed locally so the turn renders them before it finishes. */
  attachments: Attachment[];
  confirmations: { id: number; summary: string; tool: string }[];
  /** Units delegated to during this turn, as they start and finish. */
  delegations: { agent: string; childRunId: number; status: null | string; summary: null | string; tier: string }[];
  error: null | string;
  /** Paused, compacted or stopped at a budget, as it happens (LP3, LP5). */
  notes: { detail: Record<string, unknown>; kind: string }[];
  /** The plan card's newest snapshot; empty until the turn's first tool call. */
  plan: PlanStep[];
  runId: number;
  /** "stopped": the user pressed stop (POST /api/runs/:id/stop) and the run ended early. */
  status: "failed" | "ok" | "queued" | "running" | "stopped";
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

/** A source artifact in the Knowledge Inbox: what arrived, and what happened to its text. */
export interface InboxItem {
  author: null | string;
  chars: number;
  doc_date: null | string;
  id: number;
  ingested: string;
  kind: "file" | "image" | "note" | "paste";
  name: string;
  note: null | string;
  private: number;
  project_id: null | number;
  speakers: string[];
  /** ready, needs_ocr (not read yet), ocr_failed, empty (no text) or failed. */
  status: "empty" | "failed" | "needs_ocr" | "ocr_failed" | "ready";
  /** Known people whose names appear in the text. For review only. */
  suggested_people: string[];
  suggested_project: null | number;
  /** Tags already in use whose words appear in the text. Applied only when a person accepts them. */
  suggested_tags: string[];
  suggestedProjectName: null | string;
  tags: string[];
  via: null | string;
}

export interface InboxStatus {
  maxBytes: number;
  ocr: boolean;
  watchFolder: null | string;
}

/** One hit from searching everything that has been indexed. `via` says which paths found it. */
export interface KnowledgeHit {
  /** What the passage's source is backed by (src/knowledge/retrieval.ts). The server always sends it. */
  evidence?: { claims: number; level: "conflicting" | "inferred" | "machine-extracted" | "none" | "reviewed"; reviewed: number; unreviewed: number };
  id: number;
  kind: string;
  mtime: null | string;
  path: string;
  projectId: number;
  score: number;
  text: string;
  via: string[];
}

/** Narrowing for GET /api/knowledge/search. Every field is optional; an empty one is left off the request. */
export interface KnowledgeSearchFilters {
  /** What backs the source: `reviewed` claims, `extracted` ones nobody has reviewed, or `none` analysed. */
  evidence?: "" | "extracted" | "none" | "reviewed";
  person?: number;
  project?: number;
  since?: string;
  team?: number;
  until?: string;
}

/** One extracted item in a meeting close-out, with the earlier claims it could replace. */
export interface CloseoutClaim {
  atMs: null | number;
  canReplace: { id: number; saidOn: null | string; text: string }[];
  /** A commitment that has no task yet, so "Add as a task" can be offered. */
  canTask?: boolean;
  /** The day the commitment is due, when one was recorded. */
  due?: null | string;
  id: number;
  kind: string;
  ownerName: null | string;
  passage: string;
  text: string;
  topic: null | string;
}

/** GET /api/meetings/:id/closeout. */
export interface CloseoutState {
  claims: CloseoutClaim[];
  meeting: { id: number; keepTranscript?: null | number; projectId: null | number; status: string; title: null | string };
  speakers: MeetingSpeaker[];
}

export interface CloseoutPlan {
  claims: { answer: "accept" | "reject" | "skip"; id: number; owner?: string; replaces: number[]; task?: boolean; text?: string; topic?: string }[];
  projectId: null | number;
  speakers: { index: number; name: string }[];
}

interface CloseoutCounts {
  accepted: number;
  left: number;
  rejected: number;
  replaced: number;
  /** The tasks made from accepted commitments (in a preview, the ones that would be made). */
  tasks?: CommitmentTask[];
}

/** A task made from a reviewed commitment (PLAN-open-work section 14, U6). */
export interface CommitmentTask {
  claimId: number;
  clientName: null | string;
  due: null | string;
  id: number;
  kind: "followup" | "task";
  status: string;
  title: string;
  waitingOn: null | string;
}

/** GET /api/clients/:id/commitments: the reviewed commitments in a client's project, with the task made from each. */
export interface ClientCommitments {
  client: { id: number; name: string; projectId: null | number };
  commitments: {
    claimId: number;
    due: null | string;
    overdue: boolean;
    ownerName: null | string;
    saidOn: null | string;
    task: CommitmentTask | null;
    text: string;
  }[];
  waitingForReview: number;
}

/** POST /api/meetings/:id/runbook: the draft that was written (PLAN-open-work section 14, U5). */
export interface RunbookSaved {
  dropped: number;
  path: string;
  steps: number;
  title: string;
  truncated: boolean;
}

interface CloseoutLine {
  evidence: string;
  section: string;
  text: string;
}

/** POST /api/meetings/:id/closeout/preview. */
export interface CloseoutPreview extends CloseoutCounts {
  briefs: { added: CloseoutLine[]; removed: CloseoutLine[]; subject: string; waitingAfter: number; waitingBefore: number }[];
}

/** POST /api/meetings/:id/closeout. `filingError` means the save held but the project index was not updated. */
export interface CloseoutSaved extends CloseoutCounts {
  filingError: null | string;
  projectChanged: boolean;
  projectId: null | number;
}

/** A cited decision, commitment, risk, question or fact in the knowledge store. */
export interface KnowledgeClaim {
  at_ms: null | number;
  due: null | string;
  /** reviewed, machine-extracted, inferred, conflicting, superseded or retracted. */
  evidence: string;
  id: number;
  kind: string;
  method: string;
  ownerName?: null | string;
  passage: string;
  project_id: null | number;
  review_state: "proposed" | "rejected" | "reviewed";
  said_on: null | string;
  /** 1 when marked sensitive: left out of briefs and answers, never deleted. */
  sensitive?: 0 | 1;
  source_kind: string;
  source_ref: string;
  source_state: "available" | "expired";
  speaker: null | string;
  status: "active" | "resolved" | "retracted" | "superseded";
  text: string;
  topic: null | string;
}

export interface KnowledgeEntity {
  aliases: string[];
  created: string;
  id: number;
  kind: "person" | "team" | "topic";
  name: string;
}

/** The answer to teaching a name. `clash` means it belongs to someone else and nothing changed. */
export interface KnowledgeAliasResult {
  clash: KnowledgeEntity | null;
  entity: KnowledgeEntity;
  taught: boolean;
}

export interface KnowledgeConflict {
  claims: KnowledgeClaim[];
  kind: string;
  topic: string;
}

// --- Today (PLAN-open-work section 14, U1 and U2): the shapes GET /api/today returns ---

export interface TodayApproval {
  args: string;
  conversationId: null | number;
  expiresAt: null | string;
  expiringSoon: boolean;
  id: number;
  summary: string;
  /** The whole proposed action. Approve is live only once this is on screen. */
  text: string;
  tool: string;
  ts: string;
}

export interface TodayTask {
  due: string;
  id: number;
  overdue: boolean;
  title: string;
  waitingOn: null | string;
}

export interface TodaySince {
  at: string;
  detail: string;
  key: string;
  kind: "failed" | "ok" | "skipped" | "stalled" | "stopped";
  runId: null | number;
  scheduleId: null | number;
  title: string;
}

export interface TodayThread {
  id: number;
  title: string;
  updated: string;
}

/** Mail from people with its inbox bucket (section 14, U7). Empty until that is built. */
export interface TodayMail {
  bucket: "fyi" | "reply-today" | "urgent";
  key: string;
  sender: string;
  subject: string;
}

export interface TodayBrief {
  done: { failed: number; ok: number; skipped: number; stalled: number };
  first: { id: null | number; kind: "approval" | "headsup" | "none" | "task"; reason: "due-today" | "expiring" | "none" | "overdue" | "waiting"; title: string };
  waiting: { approvals: number; headsups: number; tasks: number; threads: number };
}

export interface Today {
  approvals: TodayApproval[];
  brief: TodayBrief;
  count: number;
  headsups: Headsup[];
  later: number;
  mail: TodayMail[];
  now: string;
  since: TodaySince[];
  sinceFrom: string;
  tasks: TodayTask[];
  threads: TodayThread[];
}
