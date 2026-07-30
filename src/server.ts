/**
 * agentspine dashboard backend: a zero-dependency JSON API + the job scheduler, in one
 * long-lived Node process. Binds to 127.0.0.1 only.
 *
 *   npm run dashboard
 *
 * Responsibilities:
 *   - Serve /api/* (runs, traces, audit, confirmations, RAG memory, policy, schedules).
 *   - Run the scheduler: every 60s, run any enabled schedule that is due, serialized
 *     through the shared queue so cycles never overlap on the local model.
 *   - Optionally serve a static frontend from ./public (for the no-build UI option). A
 *     separate frontend (e.g. Next.js on :3000) can call this API cross-origin instead;
 *     CORS is allowed for localhost.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgents } from "./agents.ts";
import { loadPolicy } from "./config.ts";
import { cardsFor } from "./meetings/context.ts";
import * as meetings from "./meetings/session.ts";
import * as meetingStore from "./meetings/store.ts";
import {
  cancelDictation,
  dictationStatus,
  startDictation,
  stopDictation,
  transcribeUpload,
} from "./senses/dictate.ts";
import { listDevices } from "./senses/listen.ts";
import { converterStatus } from "./projects/extract.ts";
import { indexProject, indexSource } from "./projects/ingest.ts";
import * as projects from "./projects/store.ts";
import { runTask, startTask } from "./runner.ts";
import {
  AUDIT_RETENTION_DAYS,
  DICTATION_ENABLED,
  DICTATION_MAX_BYTES,
  MEETING_COACH_ENABLED,
  NOTE_MEMORY_MAX,
  RUN_RETENTION_DAYS,
  TRACE_RETENTION_DAYS,
  TRANSCRIPT_RETENTION_DAYS,
} from "./config.ts";
import { describeTiers } from "./tiers.ts";
import type { Tier } from "./tiers.ts";
import { hasEnded, replay, subscribe } from "./events.ts";
import type { RunEvent } from "./events.ts";
import { queueStatus } from "./queue.ts";
import { approveConfirmation, rejectConfirmation } from "./confirmations.ts";
import { pushConfigured, remoteApprovalConfigured } from "./notify.ts";
import { DASHBOARD_PUBLIC_URL } from "./config.ts";
import * as store from "./memory/store.ts";
import { rawDb } from "./memory/store.ts";
import { dedupeMemories, pruneMemories } from "./memory/rag.ts"; // also ensures the memories table exists

const PORT = Number(process.env.DASHBOARD_PORT ?? "8787");
// Default binds localhost only. Set DASHBOARD_HOST=0.0.0.0 to reach it from other machines
// on the LAN — but only with a DASHBOARD_TOKEN set (enforced below), because the API can run
// the agent, approve actions, and read your mail/calendar traces.
const HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";
const TOKEN = process.env.DASHBOARD_TOKEN ?? "";
const IS_LOCAL = HOST === "127.0.0.1" || HOST === "localhost";
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// --- memory reads (kept here to avoid re-editing store.ts) ---
const listMemories = (limit: number) =>
  rawDb.prepare("SELECT id, ts, kind, text FROM memories ORDER BY id DESC LIMIT ?").all(limit);
const searchMemories = (q: string, limit: number) =>
  rawDb.prepare("SELECT id, ts, kind, text FROM memories WHERE text LIKE ? ORDER BY id DESC LIMIT ?").all(`%${q}%`, limit);

// --- tiny http helpers ---
type Res = http.ServerResponse;

/**
 * Rate limiting — SPEC §3 requires it before the API is reachable beyond localhost.
 *
 * Fixed windows in memory, keyed by client IP. Two buckets with very different jobs:
 * the general one stops a broken client or a scan from hammering the API, while the
 * approval one is the real security control — it's what keeps a leaked-topic attacker
 * from brute-forcing a 24-byte approval token. (At 20 guesses a minute that search is
 * hopeless, which is the point.) In-memory is the right scope: this state is worthless
 * across restarts, and persisting it would just add a write per request.
 */
const RATE_LIMITS = {
  api: { max: 240, windowMs: 60_000 },
  approval: { max: 20, windowMs: 60_000 },
};
const buckets = new Map<string, { count: number; resetAt: number }>();

const rateOk = (ip: string, kind: keyof typeof RATE_LIMITS): boolean => {
  const { max, windowMs } = RATE_LIMITS[kind];
  const key = `${kind}:${ip}`;
  const nowMs = Date.now();
  const b = buckets.get(key);
  if (!b || nowMs > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    return true;
  }
  b.count++;
  return b.count <= max;
};

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const nowMs = Date.now();
  for (const [k, v] of buckets) if (nowMs > v.resetAt) buckets.delete(k);
}, 300_000).unref();

const clientIp = (req: http.IncomingMessage): string => req.socket.remoteAddress ?? "unknown";

const cors = (req: http.IncomingMessage, res: Res) => {
  const origin = req.headers.origin ?? "";
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Dashboard-Token, X-Approval-Token");
  }
};

const sendJson = (res: Res, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<any> =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });

/**
 * Read a request body as bytes, refusing anything over `limit`.
 *
 * `readBody` above accumulates into a string with no ceiling, which is survivable for JSON
 * typed by a human and not for an audio upload. This destroys the request as soon as the cap
 * is passed rather than buffering the whole thing and complaining afterwards.
 */
export class TooLargeError extends Error {}

const readBinary = (req: http.IncomingMessage, limit: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let drained = 0;
    let over = false;

    req.on("data", (c: Buffer) => {
      if (over) {
        // Keep reading, discard, and only give up if the sender is clearly not stopping.
        //
        // Two wrong versions of this came first. Destroying the socket on the first
        // oversized byte means the client sees a dropped connection instead of the sentence
        // explaining what happened — a response cannot travel down a socket already torn
        // down. Rejecting immediately but *not* draining is no better: Node will not flush
        // the response while the request body is still arriving, so the client gets a reset.
        // Reading the rest to nowhere costs bandwidth on a LAN and buys a legible 413.
        drained += c.length;
        if (drained > limit) req.destroy();
        return;
      }
      size += c.length;
      if (size > limit) {
        over = true;
        chunks = [];
        return;
      }
      chunks.push(c);
    });

    req.on("end", () => {
      if (over) reject(new TooLargeError(`upload exceeds ${Math.round(limit / 1024 / 1024)} MB`));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });

const MIME: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".js": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/**
 * Serve the built frontend. Hashed asset filenames get a long cache; index.html never
 * does, or a deploy would leave browsers pinned to the old asset manifest.
 */
const sendFile = (res: Res, file: string, immutable: boolean): boolean => {
  const ext = path.extname(file);
  res.writeHead(200, {
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "Content-Type": MIME[ext] ?? "text/plain",
  });
  res.end(fs.readFileSync(file));
  return true;
};

/**
 * Static files, with an SPA fallback.
 *
 * The client routes on the path (/c/12, /activity, /settings), so a reload or a pasted
 * link asks this server for a path that has no file behind it. Anything without a file
 * extension falls back to index.html and lets the client router sort it out; a request
 * for a missing *asset* still 404s, because silently answering `main.js` with HTML turns
 * a bad build into a baffling syntax error in the console.
 */
const serveStatic = (res: Res, urlPath: string): boolean => {
  if (!fs.existsSync(PUBLIC_DIR)) return false;
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file === PUBLIC_DIR || file.startsWith(PUBLIC_DIR + path.sep)) {
    if (fs.existsSync(file) && !fs.statSync(file).isDirectory())
      return sendFile(res, file, rel.startsWith("assets/"));
  }

  const index = path.join(PUBLIC_DIR, "index.html");
  if (!path.extname(rel) && fs.existsSync(index)) return sendFile(res, index, false);
  return false;
};

/**
 * Server-sent events for one run: the tool calls, the broker's decision on each, anything
 * that landed in the confirm queue, and the final summary — as they happen.
 *
 * Two details that are easy to get wrong and both produce a thread with a hole in it:
 *
 *   - **Subscribe before replaying.** An event published between reading the buffer and
 *     attaching the listener would otherwise vanish. So the listener goes on first and its
 *     events are held; the backlog is written; then the held ones are flushed, with `seq`
 *     dropping anything the backlog already covered.
 *   - **`?after=` resumes.** A browser that reloads mid-run reconnects with the last `seq`
 *     it saw and gets only what it missed.
 *
 * A run that has already ended is served entirely from the replay buffer and the stream is
 * closed immediately, so a client that connects late still renders the full turn.
 */
const SSE_KEEPALIVE_MS = 20_000;

const streamRun = (req: http.IncomingMessage, res: Res, runId: number, after: number): void => {
  res.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    // Tells a reverse proxy (should one ever sit in front of this) not to buffer.
    "X-Accel-Buffering": "no",
  });

  const write = (event: RunEvent): void => {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  let held: RunEvent[] | null = [];
  const onEvent = (event: RunEvent): void => {
    if (held) held.push(event);
    else write(event);
  };
  const unsubscribe = subscribe(runId, onEvent);

  const backlog = replay(runId, after);
  for (const e of backlog) write(e);

  const highest = backlog.length ? backlog[backlog.length - 1].seq : after;
  for (const e of held) if (e.seq > highest) write(e);
  held = null;

  const finish = (): void => {
    unsubscribe();
    clearInterval(keepalive);
    res.end();
  };

  // A comment line keeps the connection warm without being delivered as an event.
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), SSE_KEEPALIVE_MS);
  req.on("close", finish);

  // Close rather than hang for a run that is already over. The buffer answers for a run
  // that finished moments ago; the run row answers for one whose buffer has been swept, or
  // that belongs to a previous process — otherwise a client asking about an old run would
  // hold an open connection waiting for events that can never arrive.
  const row = store.getRun(runId);
  if (hasEnded(runId) || !row || (row.status !== "running" && row.status !== "queued")) finish();
};

/**
 * The live meeting stream. Same shape as `streamRun` above but keyed on nothing — there is
 * one microphone, so there is one stream, and a client that connects mid-meeting gets the
 * recent buffer rather than starting from silence.
 *
 * Unlike a run, this never closes itself: the browser holds it open across the gap between
 * one meeting ending and the next beginning, so the Record button stays live without polling.
 */
const streamMeetings = (req: http.IncomingMessage, res: Res, after: number): void => {
  res.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no",
  });

  const write = (event: meetings.MeetingEvent): void => {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  for (const e of meetings.replay(after)) write(e);

  const onEvent = (event: meetings.MeetingEvent): void => write(event);
  meetings.bus.on("event", onEvent);

  const keepalive = setInterval(() => res.write(": keepalive\n\n"), SSE_KEEPALIVE_MS);
  req.on("close", () => {
    meetings.bus.off("event", onEvent);
    clearInterval(keepalive);
    res.end();
  });
};

// --- router ---
const handle = async (req: http.IncomingMessage, res: Res): Promise<void> => {
  cors(req, res);
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const p = url.pathname;
  const seg = p.split("/").filter(Boolean); // e.g. ["api","runs","3"]
  const m = req.method ?? "GET";

  // Non-API paths: serve the static frontend (no token needed — it's just the shell that
  // then prompts for and sends the token on its API calls).
  if (seg[0] !== "api") {
    if (serveStatic(res, p)) return;
    return sendJson(res, 404, { error: "not found (no ./public frontend built; use the Next.js app or API directly)" });
  }

  const ip = clientIp(req);
  if (!rateOk(ip, "api")) return sendJson(res, 429, { error: "rate limited" });

  /**
   * Auth, in two forms.
   *
   * The dashboard token is the general key: it opens everything, so it stays on the box
   * and only ever travels between your browser and the API.
   *
   * An approval token is the narrow one, and exists because Approve/Reject buttons in a
   * phone push have to carry their credential *through an ntfy server* — possibly the
   * public one. So the thing they carry is scoped to a single pending confirmation, one
   * use, no other route. Worst case for a leaked approval token is that someone
   * approves or rejects one action you were already being asked about; worst case for a
   * leaked dashboard token is they run the agent and read your mail. Hence two tokens.
   */
  const isConfirmAction =
    m === "POST" &&
    seg[1] === "confirmations" &&
    seg.length === 4 &&
    (seg[3] === "approve" || seg[3] === "reject");
  const approvalToken =
    (req.headers["x-approval-token"] as string | undefined) ?? url.searchParams.get("t") ?? "";

  let authedByApproval = false;
  if (isConfirmAction && approvalToken) {
    if (!rateOk(ip, "approval")) return sendJson(res, 429, { error: "rate limited" });
    authedByApproval = store.checkApprovalToken(Number(seg[2]), approvalToken);
    if (!authedByApproval)
      return sendJson(res, 401, { error: "invalid, already-used, or expired approval token" });
  }

  if (TOKEN && !authedByApproval) {
    const provided = (req.headers["x-dashboard-token"] as string | undefined) ?? url.searchParams.get("token");
    if (provided !== TOKEN) return sendJson(res, 401, { error: "unauthorized: missing or invalid dashboard token" });
  }

  try {
    // /api/status
    if (m === "GET" && seg[1] === "status" && seg.length === 2) {
      return sendJson(res, 200, { queue: queueStatus(), schedules: store.listSchedules().length, time: new Date().toISOString() });
    }

    // /api/runs , /api/runs/:id , /api/runs/:id/stream
    if (m === "GET" && seg[1] === "runs") {
      if (seg.length === 2) return sendJson(res, 200, store.listRuns(Number(url.searchParams.get("limit") ?? 50)));
      const id = Number(seg[2]);
      if (seg.length === 4 && seg[3] === "stream") return streamRun(req, res, id, Number(url.searchParams.get("after") ?? -1));
      const run = store.getRun(id);
      if (!run) return sendJson(res, 404, { error: "no such run" });
      return sendJson(res, 200, { run, trace: store.getTrace(id), actions: store.listActions(id) });
    }

    // /api/conversations ...
    if (seg[1] === "conversations") {
      if (m === "GET" && seg.length === 2)
        return sendJson(res, 200, store.listConversations(Number(url.searchParams.get("limit") ?? 100)));

      if (m === "POST" && seg.length === 2) {
        const b = await readBody(req);
        const id = store.createConversation(b.title ?? null, b.projectId ?? null);
        return sendJson(res, 200, store.getConversation(id));
      }

      const id = Number(seg[2]);
      if (seg.length >= 3 && !store.getConversation(id)) return sendJson(res, 404, { error: "no such conversation" });

      // The whole thread, ready to render: one turn per run, each with the tool calls that
      // happened during it. This is what a browser reload rebuilds the page from.
      if (m === "GET" && seg.length === 3) {
        const turns = store.runsForConversation(id).map((r: any) => ({
          actions: store.listActions(r.id),
          // Units this turn delegated to, each with its own trace — rendered nested under
          // the turn rather than as separate rows in the thread.
          children: store.childRuns(r.id).map((c: any) => ({
            actions: store.listActions(c.id),
            agent: c.agent,
            id: c.id,
            status: c.status,
            summary: c.note,
            task: c.task,
            tier: c.tier,
          })),
          tier: r.tier,
          // Still-open approvals belong with the turn that raised them, so they survive a
          // reload and don't strand the user in a separate queue to answer them.
          confirmations: store.pendingConfirmationsForRun(r.id),
          finished: r.finished,
          id: r.id,
          started: r.started,
          status: r.status,
          summary: r.note,
          task: r.task,
        }));
        return sendJson(res, 200, { conversation: store.getConversation(id), turns });
      }

      if (m === "PATCH" && seg.length === 3) {
        const b = await readBody(req);
        const patch: store.ConversationFields = {};
        if (typeof b.title === "string") patch.title = b.title;
        if ("archived" in b) patch.archived = !!b.archived;
        if ("projectId" in b) patch.projectId = b.projectId ?? null;
        // null pins nothing and hands the thread back to the dispatcher.
        if ("tier" in b) patch.tier = b.tier ?? null;
        store.updateConversation(id, patch);
        return sendJson(res, 200, store.getConversation(id));
      }

      if (m === "DELETE" && seg.length === 3) {
        store.deleteConversation(id);
        return sendJson(res, 200, { ok: true });
      }

      /**
       * Send a message. Returns the run id IMMEDIATELY rather than holding the socket for
       * the length of a cycle — the client then watches /api/runs/:id/stream. That split is
       * what makes the interface a conversation instead of a form submission: a cycle can
       * take minutes on the local model, and the tool calls are the interesting part.
       */
      if (m === "POST" && seg.length === 4 && seg[3] === "messages") {
        const b = await readBody(req);
        const task = String(b.task ?? "").trim();
        if (!task) return sendJson(res, 400, { error: "task required" });
        // A thread pinned to a tier overrides the dispatcher for every turn in it — the
        // escape hatch for "I know this one is hard, use the good model".
        const pinned = store.getConversation(id)?.tier;
        const { done, runId } = startTask(task, {
          conversationId: id,
          kind: "chat",
          tier: (pinned as Tier | undefined) ?? undefined,
        });
        // The failure is already recorded on the run row and published to the stream; this
        // handler exists so an unattended rejection doesn't crash the process.
        done.catch((e) => console.error(`[chat] run ${runId} failed: ${e instanceof Error ? e.message : e}`));
        return sendJson(res, 202, { conversationId: id, runId });
      }
    }

    // /api/confirmations , approve, reject
    if (seg[1] === "confirmations") {
      if (m === "GET" && seg.length === 2)
        return sendJson(res, 200, store.listConfirmations(url.searchParams.get("state") ?? undefined));
      if (m === "POST" && seg.length === 4 && seg[3] === "approve")
        return sendJson(res, 200, await approveConfirmation(Number(seg[2])));
      if (m === "POST" && seg.length === 4 && seg[3] === "reject") {
        // Optional { reason } — stored as a preference so it stops proposing this.
        // The phone's Reject button sends none, which is fine.
        const b = await readBody(req);
        return sendJson(res, 200, await rejectConfirmation(Number(seg[2]), String(b.reason ?? "")));
      }
    }

    // /api/memories?query=
    if (m === "GET" && seg[1] === "memories" && seg.length === 2) {
      const q = url.searchParams.get("query");
      return sendJson(res, 200, q ? searchMemories(q, 100) : listMemories(100));
    }

    // /api/policy
    if (m === "GET" && seg[1] === "policy" && seg.length === 2) return sendJson(res, 200, loadPolicy());

    /**
     * /api/dictate — voice into the composer.
     *
     * Two microphones because the dashboard is opened from more than one machine: the browser
     * records where you are sitting, the server's own mic works however you are browsing. See
     * `senses/dictate.ts` for why the browser path never consults `policy.audio` and the
     * server path always does.
     */
    if (seg[1] === "dictate") {
      if (!DICTATION_ENABLED) return sendJson(res, 403, { error: "DICTATION_ENABLED is false" });

      if (m === "GET" && seg.length === 2) return sendJson(res, 200, dictationStatus(loadPolicy()));

      // POST /api/dictate — a recording made in the browser, transcribed here.
      if (m === "POST" && seg.length === 2) {
        try {
          const audio = await readBinary(req, DICTATION_MAX_BYTES);
          if (!audio.length) return sendJson(res, 400, { error: "no audio received" });
          const text = await transcribeUpload(audio, String(req.headers["content-type"] ?? ""));
          return sendJson(res, 200, { text });
        } catch (err) {
          return sendJson(res, err instanceof TooLargeError ? 413 : 400, { error: (err as Error).message });
        }
      }

      // POST /api/dictate/start | /stop | /cancel — the server's own microphone.
      if (m === "POST" && seg.length === 3) {
        try {
          if (seg[2] === "start") return sendJson(res, 200, await startDictation(loadPolicy()));
          if (seg[2] === "stop") return sendJson(res, 200, await stopDictation());
          if (seg[2] === "cancel") {
            await cancelDictation();
            return sendJson(res, 200, { cancelled: true });
          }
        } catch (err) {
          const message = (err as Error).message;
          return sendJson(res, message.startsWith("denied:") ? 403 : 409, { error: message });
        }
      }
    }

    /**
     * /api/meetings ...
     *
     * Note what is NOT here: no confirmation queue on start. The queue exists for actions
     * the *model* initiates, where a human never saw the decision. A person clicking Record
     * in their own dashboard has already given the only consent that mechanism collects, and
     * routing it through an approval they then have to go and grant would be theatre. The
     * `meeting_start` tool is the path that gets queued, because that one has no human in it.
     */
    if (seg[1] === "meetings") {
      // /api/meetings/devices — what ffmpeg can see, and which are allowlisted
      if (m === "GET" && seg.length === 3 && seg[2] === "devices") {
        const policy = loadPolicy();
        const found = await listDevices();
        return sendJson(res, 200, {
          allowed: policy.audio?.devices ?? [],
          devices: found.map((name) => ({ allowed: (policy.audio?.devices ?? []).includes(name), name })),
          enabled: policy.audio?.enabled === true,
        });
      }

      // /api/meetings/live — is anything recording right now
      if (m === "GET" && seg.length === 3 && seg[2] === "live") return sendJson(res, 200, meetings.liveStatus());

      /**
       * GET /api/meetings/:id/context — the context cards for a meeting, computed now.
       *
       * The stream pushes these on a timer, so the dashboard rarely needs this. It exists for
       * the first render before the first tick, and because a retrieval lane you cannot ask a
       * direct question is one you cannot debug when the cards come back empty.
       */
      if (m === "GET" && seg.length === 4 && seg[3] === "context") {
        const id = Number(seg[2]);
        if (!meetingStore.getMeeting(id)) return sendJson(res, 404, { error: "no such meeting" });
        return sendJson(res, 200, await cardsFor(id));
      }

      // /api/meetings/stream — SSE of segments and status changes
      if (m === "GET" && seg.length === 3 && seg[2] === "stream")
        return streamMeetings(req, res, Number(url.searchParams.get("after") ?? -1));

      if (m === "GET" && seg.length === 2) {
        const projectId = url.searchParams.get("project");
        return sendJson(
          res,
          200,
          meetingStore.listMeetings(
            Number(url.searchParams.get("limit") ?? 50),
            projectId === null ? undefined : Number(projectId),
          ),
        );
      }

      // POST /api/meetings — start recording
      if (m === "POST" && seg.length === 2) {
        const b = await readBody(req);
        if (!b?.device) return sendJson(res, 400, { error: "device is required" });
        try {
          const started = await meetings.startMeeting(loadPolicy(), {
            device: String(b.device),
            projectId: b.projectId == null ? null : Number(b.projectId),
            title: b.title ? String(b.title) : undefined,
          });
          return sendJson(res, 201, started);
        } catch (err) {
          // A policy denial is the caller's problem to fix, not a server fault.
          const message = (err as Error).message;
          return sendJson(res, message.startsWith("denied:") ? 403 : 409, { error: message });
        }
      }

      // POST /api/meetings/stop — stop whatever is recording
      if (m === "POST" && seg.length === 3 && seg[2] === "stop") {
        try {
          return sendJson(res, 200, await meetings.stopMeeting());
        } catch (err) {
          return sendJson(res, 409, { error: (err as Error).message });
        }
      }

      const id = Number(seg[2]);
      if (m === "GET" && seg.length === 3) {
        const meeting = meetingStore.getMeeting(id);
        if (!meeting) return sendJson(res, 404, { error: "no such meeting" });
        const pass = url.searchParams.get("pass") === "live" ? "live" : "final";
        return sendJson(res, 200, {
          extraction: meetingStore.getExtraction(id) ?? null,
          meeting,
          segments: meetingStore.segments(id, pass),
          workItems: meetingStore.workItems(id),
        });
      }

      /**
       * POST /api/meetings/:id/extract — run (or re-run) extraction.
       *
       * Returns immediately. A half-hour meeting takes about a minute to extract, and the
       * event stream reports progress, so holding the response open would only teach the
       * dashboard's fetch timeout to fire on exactly the meetings worth extracting.
       */
      /**
       * POST /api/meetings/:id/coach — notes on what was just said.
       *
       * Returns as soon as generation starts; the answer arrives on the event stream about
       * five seconds later. Holding the response open would tie the hotkey's feedback to a
       * fetch that outlives the moment it was pressed in.
       */
      if (m === "POST" && seg.length === 4 && seg[3] === "coach") {
        const id = Number(seg[2]);
        if (!MEETING_COACH_ENABLED) return sendJson(res, 403, { error: "MEETING_COACH_ENABLED is false" });
        if (!meetingStore.getMeeting(id)) return sendJson(res, 404, { error: "no such meeting" });
        const { busy } = meetings.askCoach(id);
        return sendJson(res, busy ? 429 : 202, busy ? { error: "already working on the last one" } : { started: true });
      }

      if (m === "POST" && seg.length === 4 && seg[3] === "extract") {
        const meeting = meetingStore.getMeeting(id);
        if (!meeting) return sendJson(res, 404, { error: "no such meeting" });
        if (!meetingStore.segments(id).length)
          return sendJson(res, 409, { error: "no transcript to extract from" });
        void meetings.runExtraction(id);
        return sendJson(res, 202, { meetingId: id, started: true });
      }

      // PATCH /api/meetings/:id — retitle, or file it under a project after the fact
      if (m === "PATCH" && seg.length === 3) {
        const b = await readBody(req);
        const meeting = meetingStore.getMeeting(id);
        if (!meeting) return sendJson(res, 404, { error: "no such meeting" });
        if (typeof b?.title === "string") meetingStore.setTitle(id, b.title);
        if (b && "projectId" in b) {
          const projectId = b.projectId == null ? null : Number(b.projectId);
          meetingStore.setProject(id, projectId);
          // Assigning a project is what files the transcript into that project's index.
          // Doing it here rather than only at stop() is the whole point of assign-after —
          // you often don't know which project a meeting was about until it's over.
          if (projectId && meeting.status === "done") await meetings.indexIntoProject(id, projectId);
        }
        return sendJson(res, 200, meetingStore.getMeeting(id));
      }
    }

    // /api/projects ...
    if (seg[1] === "projects") {
      if (m === "GET" && seg.length === 2)
        return sendJson(
          res,
          200,
          projects.listProjects().map((p) => ({ ...p, chunks: projects.countChunks(p.id) })),
        );

      if (m === "POST" && seg.length === 2) {
        const b = await readBody(req);
        if (!b.name) return sendJson(res, 400, { error: "name required" });
        const id = projects.createProject(String(b.name), String(b.instructions ?? ""));
        return sendJson(res, 200, projects.getProject(id));
      }

      const id = Number(seg[2]);
      const project = seg.length >= 3 ? projects.getProject(id) : undefined;
      if (seg.length >= 3 && !project) return sendJson(res, 404, { error: "no such project" });

      if (m === "GET" && seg.length === 3)
        return sendJson(res, 200, {
          chunks: projects.countChunks(id),
          conversations: store.listConversations(200).filter((c) => c.project_id === id),
          project,
          sources: projects.listSources(id),
        });

      if (m === "PATCH" && seg.length === 3) {
        const b = await readBody(req);
        const patch: projects.ProjectFields = {};
        if (typeof b.name === "string") patch.name = b.name;
        if (typeof b.instructions === "string") patch.instructions = b.instructions;
        // Stored as given; `narrowPolicy` is what guarantees it can only ever restrict, so
        // there is nothing to validate away here — an overlay asking for more simply
        // doesn't get it at run time.
        if ("policyOverlay" in b) patch.policyOverlay = b.policyOverlay ?? null;
        projects.updateProject(id, patch);
        return sendJson(res, 200, projects.getProject(id));
      }

      if (m === "DELETE" && seg.length === 3) {
        projects.deleteProject(id);
        return sendJson(res, 200, { ok: true });
      }

      // Sources: add a path, re-index it, or remove it.
      if (m === "POST" && seg.length === 4 && seg[3] === "sources") {
        const b = await readBody(req);
        const ref = String(b.path ?? "").trim();
        if (!ref) return sendJson(res, 400, { error: "path required" });
        const sourceId = projects.addSource(id, ref);
        // Indexed inline: it is local file reading and embedding, and the caller wants to
        // know whether the path was even allowed.
        const result = await indexSource(sourceId, loadPolicy());
        return sendJson(res, 200, { result, source: projects.getSource(sourceId) });
      }

      if (m === "POST" && seg.length === 5 && seg[3] === "sources" && seg[4] === "reindex") {
        const b = await readBody(req);
        const result = await indexProject(id, loadPolicy(), { force: !!b.force });
        return sendJson(res, 200, { result, sources: projects.listSources(id) });
      }

      if (m === "POST" && seg.length === 5 && seg[3] === "sources") {
        const b = await readBody(req);
        const result = await indexSource(Number(seg[4]), loadPolicy(), { force: !!b.force });
        return sendJson(res, 200, { result, source: projects.getSource(Number(seg[4])) });
      }

      if (m === "DELETE" && seg.length === 5 && seg[3] === "sources") {
        projects.removeSource(Number(seg[4]));
        return sendJson(res, 200, { ok: true });
      }
    }

    // /api/formats — which document converters this machine actually has
    if (m === "GET" && seg[1] === "formats" && seg.length === 2)
      return sendJson(res, 200, await converterStatus());

    // /api/agents — the Dispatch units, read-only (they are files on disk)
    if (m === "GET" && seg[1] === "agents" && seg.length === 2)
      return sendJson(res, 200, Object.values(loadAgents()));

    // /api/schedules ...
    if (seg[1] === "schedules") {
      if (m === "GET" && seg.length === 2) return sendJson(res, 200, store.listSchedules());
      if (m === "POST" && seg.length === 2) {
        const b = await readBody(req);
        // Human-readable spec (preferred), or legacy numeric interval_minutes.
        const spec = b.schedule ?? (b.interval_minutes ? `every ${Number(b.interval_minutes)} minutes` : null);
        if (!b.name || !b.task || !spec)
          return sendJson(res, 400, { error: "name, task, and schedule required" });
        try {
          const id = store.createSchedule(b.name, b.task, String(spec), b.enabled !== false);
          return sendJson(res, 200, store.getSchedule(id));
        } catch (e) {
          return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (m === "PATCH" && seg.length === 3) {
        const b = await readBody(req);
        const patch: any = {};
        for (const k of ["name", "task", "enabled"]) if (k in b) patch[k] = b[k];
        if (b.schedule != null) patch.spec = String(b.schedule);
        try {
          store.updateSchedule(Number(seg[2]), patch);
          return sendJson(res, 200, store.getSchedule(Number(seg[2])));
        } catch (e) {
          return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (m === "DELETE" && seg.length === 3) {
        store.deleteSchedule(Number(seg[2]));
        return sendJson(res, 200, { ok: true });
      }
      if (m === "POST" && seg.length === 4 && seg[3] === "run") {
        const s = store.getSchedule(Number(seg[2]));
        if (!s) return sendJson(res, 404, { error: "no such schedule" });
        const r = await runTask(s.task, { kind: "schedule", scheduleId: s.id });
        return sendJson(res, 200, r);
      }
    }

    // /api/do  { task }
    if (m === "POST" && seg[1] === "do" && seg.length === 2) {
      const b = await readBody(req);
      if (!b.task) return sendJson(res, 400, { error: "task required" });
      const r = await runTask(String(b.task), { kind: "do" });
      return sendJson(res, 200, r);
    }

    return sendJson(res, 404, { error: `no route for ${m} ${p}` });
  } catch (err) {
    return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
};

/**
 * Trim the ledger. Run on boot and once a day thereafter, because the ledger otherwise only
 * ever grows and both the Activity list and the digest scan it. Never throws: a failed
 * prune is a tidy-up that didn't happen, not a reason to take the dashboard down with it.
 */
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

const prune = (): void => {
  try {
    const r = store.pruneLedger({
      auditDays: AUDIT_RETENTION_DAYS,
      runDays: RUN_RETENTION_DAYS,
      traceDays: TRACE_RETENTION_DAYS,
    });
    const total = r.messages + r.actions + r.runs;
    if (total) {
      console.log(
        `pruned: ${r.messages} trace messages, ${r.actions} audit rows, ${r.runs} runs` +
          (r.conversations ? `, ${r.conversations} empty conversations` : "") +
          (r.withheld ? ` (${r.withheld} kept — pending or unfinished)` : ""),
      );
    }
    // Transcripts run on their own, shorter window — see TRANSCRIPT_RETENTION_DAYS.
    const words = meetingStore.pruneTranscripts(TRANSCRIPT_RETENTION_DAYS);
    if (words) console.log(`pruned: ${words} meeting transcript segments past the retention window`);

    // Memories are bounded by count rather than age: a fact does not stop being true. Notes
    // had no ceiling at all until 2026-07-30, which is how 20 copies of one sentence came to
    // occupy every recall slot. `remember` now refuses duplicates, so this is the backstop
    // for what predates it and for near-misses that clear the similarity threshold.
    const collapsed = dedupeMemories();
    if (collapsed) console.log(`pruned: ${collapsed} duplicate memories`);
    if (NOTE_MEMORY_MAX > 0) {
      const notes = pruneMemories("note", NOTE_MEMORY_MAX);
      if (notes) console.log(`pruned: ${notes} note memories past the ${NOTE_MEMORY_MAX} ceiling`);
    }
  } catch (err) {
    console.error("prune failed:", err instanceof Error ? err.message : err);
  }
};

// --- scheduler ---
const SCHEDULER_TICK_MS = 60_000;
const runScheduler = async (): Promise<void> => {
  try {
    for (const s of store.dueSchedules()) {
      store.markScheduleRan(s.id); // re-arm first, so a slow run doesn't double-fire next tick
      runTask(s.task, { kind: "schedule", scheduleId: s.id }).catch((e) =>
        console.error(`[schedule ${s.name}] failed: ${e instanceof Error ? e.message : e}`),
      );
    }
  } catch (err) {
    console.error("scheduler error:", err instanceof Error ? err.message : err);
  }
};

// --- boot ---
// Fail-safe: never expose the (data-bearing, action-capable) API to the network unauthenticated.
if (!IS_LOCAL && !TOKEN) {
  console.error(
    `Refusing to bind to ${HOST} without DASHBOARD_TOKEN set.\n` +
      "The API can run the agent, approve actions, and read your mail/calendar traces, and has no\n" +
      "other authentication. Set DASHBOARD_TOKEN in .env, or bind to 127.0.0.1 and use an SSH tunnel.",
  );
  process.exit(1);
}
const interrupted = store.markInterruptedRuns();
if (interrupted) console.log(`marked ${interrupted} interrupted run(s) as failed`);
// A `recording` row can outlive the process that owned it. Left alone it would block every
// future capture, because one already claims the microphone.
const orphaned = meetingStore.reapOrphans();
if (orphaned) console.log(`marked ${orphaned} interrupted meeting(s) as abandoned`);
http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`agentspine dashboard API on http://${HOST}:${PORT}`);
  console.log(`  auth: ${TOKEN ? "token required on /api" : IS_LOCAL ? "none (localhost only)" : "NONE"}`);
  console.log(fs.existsSync(PUBLIC_DIR) ? "  serving static frontend from ./public" : "  API only (no ./public) — point your frontend here");
  console.log(`  scheduler: checking due jobs every ${SCHEDULER_TICK_MS / 1000}s`);
  console.log(`  tiers: ${describeTiers()}`);
  console.log(
    `  push: ${
      remoteApprovalConfigured()
        ? `ntfy + remote approval via ${DASHBOARD_PUBLIC_URL}`
        : pushConfigured()
          ? "ntfy (no DASHBOARD_PUBLIC_URL — pushes arrive without Approve/Reject buttons)"
          : "off (Mac banners only — set NTFY_TOPIC to reach your phone)"
    }`,
  );
});
runScheduler();
setInterval(runScheduler, SCHEDULER_TICK_MS);
prune();
setInterval(prune, PRUNE_INTERVAL_MS).unref();
