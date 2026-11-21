/**
 * The API client.
 *
 * A dashboard token is only needed when the server is bound past localhost (see
 * server.ts). It is kept in localStorage and sent as a header on fetches — except on the
 * event stream, where `EventSource` cannot set headers and the server accepts `?token=`
 * instead. That is the only reason the token ever appears in a URL, and it is the same
 * localhost-to-localhost hop either way.
 */
import type {
  Agent,
  Attachment,
  AudioDevices,
  Build,
  BuildDiff,
  ChatMessage,
  Client,
  CloudUsage,
  Confirmation,
  Conversation,
  DictationStatus,
  Headsup,
  HeadsupDates,
  HeadsupPrefs,
  HeadsupPreview,
  HeadsupRun,
  IngestResult,
  LiveStatus,
  Meeting,
  MeetingExtraction,
  MeetingQuestion,
  MeetingSegment,
  MeetingSpeaker,
  MeetingWorkItem,
  Memory,
  OutboxReview,
  Overview,
  Project,
  ProjectSource,
  PromotionProposal,
  Recipe,
  Run,
  SavedFile,
  Schedule,
  SearchHit,
  StudyDueCard,
  StudyOverview,
  StudyReview,
  Task,
  Thread,
  TimeSummary,
  VisionStatus,
  VoiceStatus,
  WakeResult,
} from "./types.ts";

const TOKEN_KEY = "as_token";

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token);

export class UnauthorizedError extends Error {}

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-Dashboard-Token": token } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401) throw new UnauthorizedError("dashboard token required");
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
};

const voiceListenPath = (mode: "turn" | "wake", wake: string, aliases: string[], sounds: boolean): string =>
  `/api/voice/listen?${new URLSearchParams({ aliases: aliases.join(","), mode, sounds: sounds ? "1" : "0", wake })}`;

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { body: body === undefined ? undefined : JSON.stringify(body), method: "POST" });

/** A same-origin path that an <img> can load: it cannot send our token header, so the token rides along as a query parameter. */
export const authedPath = (path: string): string => {
  const token = getToken();
  return token ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : path;
};

/** The URL an EventSource opens to follow a run. See the note about `?token=` above. */
export const runStreamUrl = (runId: number, after: number): string => {
  const params = new URLSearchParams({ after: String(after) });
  const token = getToken();
  if (token) params.set("token", token);
  return `/api/runs/${runId}/stream?${params}`;
};

/**
 * Where an image lives, for an `<img src>`.
 *
 * Carries `?token=` for exactly the reason the two streams above do: the browser issues this
 * request itself, so nothing can attach the `X-Dashboard-Token` header to it. Without the
 * query parameter every image in a thread 401s the moment the dashboard is bound past
 * localhost — which is precisely the deployment that requires a token in the first place.
 *
 * The token does end up in the DOM. That is a smaller exposure than it first appears, since
 * it already lives in `localStorage` where any script on the page can read it, and this is
 * the same-origin hop every other API call makes. It is still worth knowing about before
 * copying an image URL out of the page and sending it to someone.
 */
export const attachmentUrl = (id: number): string => {
  const token = getToken();
  return token ? `/api/attachments/${id}?token=${encodeURIComponent(token)}` : `/api/attachments/${id}`;
};

/**
 * The live meeting stream. Takes no meeting id on purpose — there is one microphone, so
 * there is one stream, and it stays open across the gap between meetings.
 */
export const meetingStreamUrl = (after: number): string => {
  const params = new URLSearchParams({ after: String(after) });
  const token = getToken();
  if (token) params.set("token", token);
  return `/api/meetings/stream?${params}`;
};

const patch = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { body: JSON.stringify(body), method: "PATCH" });

export const api = {
  /** Turn a meeting question into a study card, with your edits if you made any. */
  acceptMeetingQuestion: (id: number, edits: { answer?: string; question?: string }) =>
    post<{ cardId: null | number; topic: string }>(`/api/study/questions/${id}/accept`, edits),
  addProjectSource: (projectId: number, path: string) =>
    post<{ result: IngestResult; source: ProjectSource }>(
      `/api/projects/${projectId}/sources`,
      { path },
    ),
  // --- tasks, files, clients, search (the personal-assistant surface) ---
  addTask: (fields: { due?: string; kind?: "followup" | "task"; notes?: string; projectId?: number; title: string; waitingOn?: string }) =>
    post<Task>("/api/tasks", fields),
  answerHeadsup: (id: number, answer: "later" | "never" | "yes") =>
    post<Headsup>(`/api/headsups/${id}/answer`, { answer }),
  /** Your answer to one message in the weekly review. "skip" files a dismissal memory for its topic. */
  answerOutbox: (id: number, answer: "skip" | "useful") =>
    post<{ remembered: boolean; topic: string }>(`/api/outbox/${id}/feedback`, { answer }),
  /**
   * Accept one auto-approval proposal.
   *
   * The only call in this client that widens what the assistant may do without asking, and
   * the server side of it (`applyProposal`) is the only function anywhere that writes an
   * `autoApprove` entry. Deliberately not reachable from any tool the model can invoke —
   * see docs/LEARNING.md invariant 1 — which is why it lives here and not in the agent's API.
   * Idempotent: re-applying a rule that already exists answers `ok` and changes nothing.
   */
  applyProposal: (tool: string, target: string) =>
    post<{ message: string; ok: boolean }>("/api/proposals", { target, tool }),
  approveConfirmation: (id: number) => post<{ message: string; ok: boolean }>(`/api/confirmations/${id}/approve`),
  archiveConversation: (id: number) =>
    request<Conversation>(`/api/conversations/${id}`, {
      body: JSON.stringify({ archived: true }),
      method: "PATCH",
    }),
  askMeetingChat: (id: number, question: string) =>
    post<ChatMessage>(`/api/meetings/${id}/chat`, { question }),
  /**
   * Ask for notes on what was just said. Returns as soon as generation starts — the answer
   * lands on the meeting stream about five seconds later.
   */
  /** The diff for one build — see src/builds.ts. */
  buildDiff: (runId: number) => request<BuildDiff>(`/api/builds/${runId}/diff`),

  /** Cloud tokens against the caps (src/cloud-cap.ts). Read-only. */
  cloudUsage: () => request<CloudUsage>("/api/cloud-usage"),

  coachMeeting: (id: number) => post<{ started: boolean }>(`/api/meetings/${id}/coach`),

  createConversation: (projectId?: number) => post<Conversation>("/api/conversations", { projectId }),
  createProject: (name: string, instructions = "") =>
    post<Project>("/api/projects", { instructions, name }),
  createSchedule: (name: string, schedule: string, task: string) =>
    post<Schedule>("/api/schedules", { name, schedule, task }),
  deleteClient: (id: number) => request<{ ok: boolean }>(`/api/clients/${id}`, { method: "DELETE" }),
  deleteConversation: (id: number) => request<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),
  deleteHeadsupDate: (id: number) => request<{ ok: boolean }>(`/api/headsups/dates/${id}`, { method: "DELETE" }),
  /** Delete a meeting and everything derived from it. 409 while it is still recording or processing. */
  deleteMeeting: (id: number) => request<{ deleted: boolean; rejectedItems: number }>(`/api/meetings/${id}`, { method: "DELETE" }),
  /** Delete a meeting's kept recording now. */
  deleteMeetingAudio: (id: number) => request<{ deleted: boolean }>(`/api/meetings/${id}/audio`, { method: "DELETE" }),
  deleteMemory: (id: number) => request<{ id: number; removed: boolean }>(`/api/memories/${id}`, { method: "DELETE" }),
  deleteProject: (id: number) => request<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  deleteRecipe: (id: number) => request<{ id: number; removed: boolean }>(`/api/recipes/${id}`, { method: "DELETE" }),

  deleteSchedule: (id: number) => request<{ ok: boolean }>(`/api/schedules/${id}`, { method: "DELETE" }),
  deleteTask: (id: number) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),

  /**
   * Upload a recording made in the browser and get the words back.
   *
   * Sends the blob as the raw body with its own content type, rather than multipart — there
   * is exactly one field, and the server hands the bytes straight to ffmpeg.
   */
  dictate: (audio: Blob) =>
    request<{ text: string }>("/api/dictate", {
      body: audio,
      headers: { "Content-Type": audio.type || "application/octet-stream" },
      method: "POST",
    }),

  dictationStatus: () => request<DictationStatus>("/api/dictate"),

  dismissMeetingQuestion: (id: number) => post<{ ok: boolean }>(`/api/study/questions/${id}/dismiss`),

  /** Re-run extraction. Returns as soon as it has started; the event stream reports the end. */
  extractMeeting: (id: number) => post<{ meetingId: number; started: boolean }>(`/api/meetings/${id}/extract`),

  fileContent: (path: string) =>
    request<{ path: string; text: string; truncated: boolean }>(`/api/files/content?path=${encodeURIComponent(path)}`),

  formats: () => request<{ pdf: boolean; rich: boolean }>("/api/formats"),

  headsupPrefs: () => request<HeadsupPrefs>("/api/headsups/prefs"),

  /**
   * Upload a recording made elsewhere (Voice Memos, say) as a new meeting. The raw file is the
   * body, as with dictation. 202 means decoded and queued; the meeting stream reports the rest.
   */
  importMeeting: (file: Blob, opts: { name: string; projectId: null | number; started?: string; title?: string }) => {
    const params = new URLSearchParams({ name: opts.name });
    if (opts.projectId) params.set("project", String(opts.projectId));
    if (opts.started) params.set("started", opts.started);
    if (opts.title) params.set("title", opts.title);
    return request<{ meetingId: number; started: boolean }>(`/api/meetings/import?${params}`, {
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
      method: "POST",
    });
  },

  listAgents: () => request<Agent[]>("/api/agents"),

  /** Runs that built or tested something, newest first. */
  listBuilds: (limit = 40) => request<Build[]>(`/api/builds?limit=${limit}`),

  listClients: () => request<Client[]>("/api/clients"),

  /**
   * The approval queue. With no `state` the server answers the hundred most recent of any
   * state, which is what the Approvals view wants; `"done"` asks for every resolved
   * approval with no cap, which is what reading a proposal's evidence needs — a shape
   * proposed on a long track record can cite a confirmation older than that hundred.
   */
  listConfirmations: (state?: string) =>
    request<Confirmation[]>(`/api/confirmations${state ? `?state=${encodeURIComponent(state)}` : ""}`),

  listConversations: () => request<Conversation[]>("/api/conversations"),

  /** One utterance said to an assistant that is already listening. */
  listenForTurn: (audio: Blob, wake: string, aliases: string[], sounds: boolean) =>
    request<{ text: string }>(voiceListenPath("turn", wake, aliases, sounds), {
      body: audio,
      headers: { "Content-Type": audio.type || "audio/wav" },
      method: "POST",
    }),

  /**
   * One stretch of speech heard while idle: was it the wake word, and what followed?
   * Audio goes as the raw body, like `dictate`; the wake word and its spellings ride in the
   * query so changing them in Settings applies to the very next utterance.
   */
  listenForWake: (audio: Blob, wake: string, aliases: string[], sounds: boolean) =>
    request<WakeResult>(voiceListenPath("wake", wake, aliases, sounds), {
      body: audio,
      headers: { "Content-Type": audio.type || "audio/wav" },
      method: "POST",
    }),
  listFiles: () => request<SavedFile[]>("/api/files"),
  listHeadsupDates: () => request<HeadsupDates>("/api/headsups/dates"),
  listHeadsups: (state: "all" | "open" = "open") => request<Headsup[]>(`/api/headsups?state=${state}`),

  listMeetings: (limit = 50, tags: string[] = []) =>
    request<Meeting[]>(`/api/meetings?limit=${limit}${tags.length ? `&tag=${encodeURIComponent(tags.join(","))}` : ""}`),

  listMemories: (query?: string) =>
    request<Memory[]>(`/api/memories${query ? `?query=${encodeURIComponent(query)}` : ""}`),

  listProjects: () => request<Project[]>("/api/projects"),

  /** Shapes that have earned an auto-approval rule. Recomputed server-side on every call. */
  listProposals: () => request<PromotionProposal[]>("/api/proposals"),
  listRecipes: () => request<Recipe[]>("/api/recipes"),

  listRuns: (limit = 100) => request<Run[]>(`/api/runs?limit=${limit}`),
  listSchedules: () => request<Schedule[]>("/api/schedules"),
  listStudyDue: (topic?: number) => request<StudyDueCard[]>(`/api/study/due${topic ? `?topic=${topic}` : ""}`),

  listTasks: (status: "all" | "done" | "open" = "open", projectId?: number) =>
    request<Task[]>(`/api/tasks?status=${status}${projectId ? `&projectId=${projectId}` : ""}`),

  listTime: (days = 30) => request<TimeSummary>(`/api/time?days=${days}`),

  /** You are looking at this thread: its finished replies are read (clears the unread dot). */
  markConversationRead: (id: number) => post<{ ok: boolean }>(`/api/conversations/${id}/read`),

  meeting: (id: number, pass: "final" | "live" = "final") =>
    request<{
      chat?: ChatMessage[];
      extraction: MeetingExtraction | null;
      meeting: Meeting;
      questions?: MeetingQuestion[];
      segments: MeetingSegment[];
      speakers: MeetingSpeaker[];
      workItems: MeetingWorkItem[];
    }>(`/api/meetings/${id}?pass=${pass}`),
  /** The saved in-meeting chat, oldest first. */
  meetingChat: (id: number) => request<ChatMessage[]>(`/api/meetings/${id}/chat`),

  meetingDevices: () => request<AudioDevices>("/api/meetings/devices"),

  meetingLive: () => request<LiveStatus>("/api/meetings/live"),

  /**
   * Look (again) for questions put to you in a meeting. A 409 carries the reason it can't
   * (no project, nobody named "me"), worth showing as is.
   */
  meetingQuestions: (id: number) =>
    post<{ pairs: number; questions: MeetingQuestion[]; saved: number }>(`/api/meetings/${id}/questions`),

  /** Every meeting tag in use, with counts. */
  meetingTags: () => request<{ count: number; tag: string }[]>("/api/meetings/tags"),

  /** The last 7 days of messages you can vote on. Opening it marks what it lists as seen. */
  outboxReview: () => request<OutboxReview>("/api/outbox/review"),

  /** Everything installed, read-only, with the prune list. */
  overview: () => request<Overview>("/api/overview"),

  /**
   * What to say aloud for a reply: cleaned of markup and cut into pieces to synthesise in turn,
   * so the first sentence can start playing while the rest are still being made. Empty when
   * there is nothing a voice can read.
   */
  planSpeech: (text: string) => post<{ chunks: string[] }>("/api/voice/plan", { text }),

  policy: () => request<Record<string, unknown>>("/api/policy"),

  previewHeadsups: () => request<HeadsupPreview>("/api/headsups/preview"),
  project: (id: number) =>
    request<{ chunks: number; conversations: Conversation[]; project: Project; sources: ProjectSource[] }>(
      `/api/projects/${id}`,
    ),

  reindexProject: (id: number, force = false) =>
    post<{ result: IngestResult }>(`/api/projects/${id}/sources/reindex`, { force }),

  rejectConfirmation: (id: number, reason: string) =>
    post<{ message: string; ok: boolean }>(`/api/confirmations/${id}/reject`, { reason }),

  removeProjectSource: (projectId: number, sourceId: number) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/sources/${sourceId}`, { method: "DELETE" }),

  renameConversation: (id: number, title: string) =>
    request<Conversation>(`/api/conversations/${id}`, { body: JSON.stringify({ title }), method: "PATCH" }),

  /** Re-make the final transcript from kept audio; `speakers` pins the head count (omit to detect). */
  reprocessMeeting: (id: number, speakers?: number) =>
    post<{ started: boolean }>(`/api/meetings/${id}/reprocess`, speakers ? { speakers } : {}),

  researchHeadsup: (id: number) => post<{ cards: number; error?: string; status: string }>(`/api/headsups/${id}/research`),
  /**
   * Grade a recall and reschedule the card, exactly as `study_cards review` does in chat. An
   * empty answer counts as forgotten. A 503 means the model gave no usable grade; the card is
   * untouched and retrying is safe.
   */
  reviewStudyCard: (id: number, answer: string) => post<StudyReview>(`/api/study/cards/${id}/review`, { answer }),

  run: (id: number) => request<{ actions: unknown[]; run: Run; trace: unknown[] }>(`/api/runs/${id}`),

  runHeadsups: () => post<HeadsupRun>("/api/headsups/run"),
  runSchedule: (id: number) => post<unknown>(`/api/schedules/${id}/run`),

  saveReplyAsFile: (runId: number, name: string, projectId?: null | number) =>
    post<{ message: string; path: string }>("/api/files/save", { name, projectId, runId }),

  search: (q: string) => request<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),

  sendMessage: (conversationId: number, task: string, attachmentIds: number[] = []) =>
    post<{ conversationId: number; runId: number }>(`/api/conversations/${conversationId}/messages`, {
      attachmentIds,
      task,
    }),

  /** "Something I wish I'd been told", stored as a preference memory. */
  sendOutboxWish: (text: string) => post<{ remembered: boolean }>("/api/outbox/wish", { text }),

  setConversationTier: (id: number, tier: null | string) =>
    request<Conversation>(`/api/conversations/${id}`, { body: JSON.stringify({ tier }), method: "PATCH" }),

  setHeadsupPrefs: (patch: Record<string, unknown>) => post<HeadsupPrefs>("/api/headsups/prefs", patch),

  /** File a finished meeting under a project — this is what indexes its transcript. */
  setMeetingProject: (id: number, projectId: null | number) =>
    request<Meeting>(`/api/meetings/${id}`, { body: JSON.stringify({ projectId }), method: "PATCH" }),

  /** Replace a meeting's tags. */
  setMeetingTags: (id: number, tags: string[]) =>
    request<Meeting>(`/api/meetings/${id}`, { body: JSON.stringify({ tags }), method: "PATCH" }),

  setMeetingTitle: (id: number, title: string) =>
    request<Meeting>(`/api/meetings/${id}`, { body: JSON.stringify({ title }), method: "PATCH" }),

  /** Name a speaker in a finished meeting; an empty name goes back to "Speaker N". */
  setSpeakerName: (id: number, index: number, name: string) =>
    request<MeetingSpeaker[]>(`/api/meetings/${id}/speakers`, { body: JSON.stringify({ index, name }), method: "PATCH" }),

  /** Synthesise `text`. Resolves to WAV audio; rejects with the service's own reason. */
  speak: async (text: string): Promise<Blob> => {
    const token = getToken();
    const res = await fetch("/api/voice/speak", {
      body: JSON.stringify({ text }),
      headers: { "Content-Type": "application/json", ...(token ? { "X-Dashboard-Token": token } : {}) },
      method: "POST",
    });
    if (res.status === 401) throw new UnauthorizedError("dashboard token required");
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.blob();
  },

  starRun: (runId: number, starred: boolean) => post<{ ok: boolean }>(`/api/runs/${runId}/star`, { starred }),

  startDictation: () => post<{ device: string }>("/api/dictate/start"),
  startMeeting: (device: string, projectId: null | number, title?: string) =>
    post<{ meetingId: number }>("/api/meetings", { device, projectId, title }),

  status: () =>
    request<{ inbox?: null | number; queue: { depth: number; running: boolean }; schedules: number }>("/api/status"),

  stopDictation: () => post<{ text: string }>("/api/dictate/stop"),

  stopMeeting: () => post<{ meetingId: number }>("/api/meetings/stop"),

  /** Cards due now, question only. `topic` narrows to one topic. */
  studyOverview: () => request<StudyOverview>("/api/study"),

  thread: (id: number) => request<Thread>(`/api/conversations/${id}`),

  toggleSchedule: (id: number, enabled: boolean) =>
    request<Schedule>(`/api/schedules/${id}`, { body: JSON.stringify({ enabled }), method: "PATCH" }),

  updateProject: (id: number, fields: { instructions?: string; name?: string }) =>
    request<Project>(`/api/projects/${id}`, { body: JSON.stringify(fields), method: "PATCH" }),

  /**
   * Change any of a schedule's name, task, schedule spec or enabled flag. Editing in place
   * keeps `last_run`, which delete-and-recreate would lose.
   */
  /** Edit a named recipe. A 400 carries a message saying what to fix (too few steps, a name clash). */
  updateRecipe: (id: number, fields: { name?: string; steps?: string[]; when?: string }) =>
    patch<Recipe>(`/api/recipes/${id}`, fields),

  updateSchedule: (id: number, fields: { enabled?: boolean; name?: string; schedule?: string; task?: string }) =>
    request<Schedule>(`/api/schedules/${id}`, { body: JSON.stringify(fields), method: "PATCH" }),

  updateTask: (id: number, fields: { due?: null | string; notes?: string; projectId?: null | number; status?: "done" | "dropped" | "open"; title?: string }) =>
    patch<Task>(`/api/tasks/${id}`, fields),
  /**
   * Send one image up and get its id back.
   *
   * Raw bytes as the body rather than multipart, matching `dictate` above: there is exactly
   * one field, and the server hands the bytes straight to a sniffer. The filename rides in
   * the query string because it is a label, not data — the server sanitises it and names the
   * file on disk from a random id regardless.
   *
   * Uploading happens as soon as a file is chosen, not on send, so that attaching three
   * photos and then writing a question does not end in a wait.
   */
  uploadAttachment: (conversationId: number, file: Blob, name?: string) => {
    const params = new URLSearchParams({ conversationId: String(conversationId) });
    if (name) params.set("name", name);
    return request<Attachment>(`/api/attachments?${params}`, {
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
      method: "POST",
    });
  },

  upsertClient: (fields: {
    email?: string;
    name: string;
    nextAction?: string;
    nextActionDue?: string;
    note?: string;
    status?: string;
  }) => post<Client>("/api/clients", fields),

  visionStatus: () => request<VisionStatus>("/api/vision"),

  voiceStatus: () => request<VoiceStatus>("/api/voice"),
};
