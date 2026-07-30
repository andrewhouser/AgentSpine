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
  AudioDevices,
  Confirmation,
  Conversation,
  DictationStatus,
  IngestResult,
  LiveStatus,
  Meeting,
  MeetingExtraction,
  MeetingSegment,
  MeetingWorkItem,
  Memory,
  Project,
  ProjectSource,
  Run,
  Schedule,
  Thread,
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

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { body: body === undefined ? undefined : JSON.stringify(body), method: "POST" });

/** The URL an EventSource opens to follow a run. See the note about `?token=` above. */
export const runStreamUrl = (runId: number, after: number): string => {
  const params = new URLSearchParams({ after: String(after) });
  const token = getToken();
  if (token) params.set("token", token);
  return `/api/runs/${runId}/stream?${params}`;
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

export const api = {
  addProjectSource: (projectId: number, path: string) =>
    post<{ result: IngestResult; source: ProjectSource }>(
      `/api/projects/${projectId}/sources`,
      { path },
    ),

  approveConfirmation: (id: number) => post<{ message: string; ok: boolean }>(`/api/confirmations/${id}/approve`),

  archiveConversation: (id: number) =>
    request<Conversation>(`/api/conversations/${id}`, {
      body: JSON.stringify({ archived: true }),
      method: "PATCH",
    }),

  /**
   * Ask for notes on what was just said. Returns as soon as generation starts — the answer
   * lands on the meeting stream about five seconds later.
   */
  coachMeeting: (id: number) => post<{ started: boolean }>(`/api/meetings/${id}/coach`),

  createConversation: (projectId?: number) => post<Conversation>("/api/conversations", { projectId }),

  createProject: (name: string, instructions = "") =>
    post<Project>("/api/projects", { instructions, name }),

  createSchedule: (name: string, schedule: string, task: string) =>
    post<Schedule>("/api/schedules", { name, schedule, task }),

  deleteConversation: (id: number) => request<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),

  deleteProject: (id: number) => request<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),

  deleteSchedule: (id: number) => request<{ ok: boolean }>(`/api/schedules/${id}`, { method: "DELETE" }),

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

  /** Re-run extraction. Returns as soon as it has started; the event stream reports the end. */
  extractMeeting: (id: number) => post<{ meetingId: number; started: boolean }>(`/api/meetings/${id}/extract`),

  formats: () => request<{ pdf: boolean; rich: boolean }>("/api/formats"),

  listAgents: () => request<Agent[]>("/api/agents"),

  listConfirmations: () => request<Confirmation[]>("/api/confirmations"),

  listConversations: () => request<Conversation[]>("/api/conversations"),

  listMeetings: (limit = 50) => request<Meeting[]>(`/api/meetings?limit=${limit}`),

  listMemories: (query?: string) =>
    request<Memory[]>(`/api/memories${query ? `?query=${encodeURIComponent(query)}` : ""}`),

  listProjects: () => request<Project[]>("/api/projects"),

  listRuns: (limit = 100) => request<Run[]>(`/api/runs?limit=${limit}`),

  listSchedules: () => request<Schedule[]>("/api/schedules"),

  meeting: (id: number, pass: "final" | "live" = "final") =>
    request<{
      extraction: MeetingExtraction | null;
      meeting: Meeting;
      segments: MeetingSegment[];
      workItems: MeetingWorkItem[];
    }>(`/api/meetings/${id}?pass=${pass}`),

  meetingDevices: () => request<AudioDevices>("/api/meetings/devices"),

  meetingLive: () => request<LiveStatus>("/api/meetings/live"),

  policy: () => request<Record<string, unknown>>("/api/policy"),

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

  run: (id: number) => request<{ actions: unknown[]; run: Run; trace: unknown[] }>(`/api/runs/${id}`),

  runSchedule: (id: number) => post<unknown>(`/api/schedules/${id}/run`),

  sendMessage: (conversationId: number, task: string) =>
    post<{ conversationId: number; runId: number }>(`/api/conversations/${conversationId}/messages`, { task }),

  setConversationTier: (id: number, tier: null | string) =>
    request<Conversation>(`/api/conversations/${id}`, { body: JSON.stringify({ tier }), method: "PATCH" }),

  /** File a finished meeting under a project — this is what indexes its transcript. */
  setMeetingProject: (id: number, projectId: null | number) =>
    request<Meeting>(`/api/meetings/${id}`, { body: JSON.stringify({ projectId }), method: "PATCH" }),

  setMeetingTitle: (id: number, title: string) =>
    request<Meeting>(`/api/meetings/${id}`, { body: JSON.stringify({ title }), method: "PATCH" }),

  startDictation: () => post<{ device: string }>("/api/dictate/start"),

  startMeeting: (device: string, projectId: null | number, title?: string) =>
    post<{ meetingId: number }>("/api/meetings", { device, projectId, title }),

  status: () => request<{ queue: { depth: number; running: boolean }; schedules: number }>("/api/status"),

  stopDictation: () => post<{ text: string }>("/api/dictate/stop"),

  stopMeeting: () => post<{ meetingId: number }>("/api/meetings/stop"),

  thread: (id: number) => request<Thread>(`/api/conversations/${id}`),

  toggleSchedule: (id: number, enabled: boolean) =>
    request<Schedule>(`/api/schedules/${id}`, { body: JSON.stringify({ enabled }), method: "PATCH" }),

  updateProject: (id: number, fields: { instructions?: string; name?: string }) =>
    request<Project>(`/api/projects/${id}`, { body: JSON.stringify(fields), method: "PATCH" }),
};
