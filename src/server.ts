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
import { buildDiff, listBuilds } from "./builds.ts";
import { capsProblem, cloudUsage } from "./cloud-cap.ts";
import { loadPolicy } from "./config.ts";
import { syncMcpTools } from "./mcp/register.ts";
import { probeModelHost } from "./model-probe.ts";
import { deleteAudio, pruneAudio } from "./meetings/audio.ts";
import { fileQueuedItems } from "./meetings/extract.ts";
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
import { listenForTurn, listenForWake, planSpeech, speak, voiceStatus } from "./senses/voice.ts";
import { converterStatus } from "./projects/extract.ts";
import { indexProject, indexSource } from "./projects/ingest.ts";
import * as projects from "./projects/store.ts";
import { checkWorkspaceFile } from "./projects/workspace.ts";
import { deleteItem as deleteInboxItem, fileItem as fileInboxItem, ingestFile, ingestPaste, pasteVia, reprocess as reprocessInboxItem, scanWatchDir } from "./inbox/intake.ts";
import * as inboxStore from "./inbox/store.ts";
import * as briefs from "./knowledge/briefs.ts";
import { closeMeeting, closeoutState, parsePlan, previewCloseout } from "./knowledge/closeout.ts";
import * as knowledge from "./knowledge/store.ts";
import { retentionRules } from "./knowledge/retention.ts";
import { EVIDENCE_FILTERS, searchFiltered } from "./knowledge/retrieval.ts";
import type { EvidenceFilter } from "./knowledge/retrieval.ts";
import { extractClaims, inboxItemText, normalizeMeeting } from "./knowledge/extract.ts";
import { ocrAvailable } from "./inbox/ocr.ts";
import {
  readAttachment,
  removeAttachment,
  storeImage,
  sweepOrphanedAttachments,
  sweepUnsentAttachments,
  UnsupportedImageError,
} from "./attachments.ts";
import { runTask, startTask } from "./runner.ts";
import { requestStop } from "./stop.ts";
import {
  AUDIT_RETENTION_DAYS,
  CONFIRM_EXPIRE_AFTER_MIN,
  CONFIRM_SWEEP_MS,
  DICTATION_ENABLED,
  DICTATION_MAX_BYTES,
  MEETING_IMPORT_MAX_BYTES,
  IMAGES_DIR,
  MEETING_COACH_ENABLED,
  NOTE_MEMORY_MAX,
  RUN_RETENTION_DAYS,
  TRACE_RETENTION_DAYS,
  TRANSCRIPT_RETENTION_DAYS,
} from "./config.ts";
import { describeTiers, tierConfig, visionConfigured } from "./tiers.ts";
import type { Tier } from "./tiers.ts";
import { hasEnded, replay, subscribe } from "./events.ts";
import type { RunEvent } from "./events.ts";
import { queueStatus } from "./queue.ts";
import { approveConfirmation, rejectConfirmation, sweepConfirmations } from "./confirmations.ts";
import { applyProposal, promotionProposals, proposalDiff } from "./learn/promote.ts";
import { notify, pushConfigured, remoteApprovalConfigured } from "./notify.ts";
import { bannersAfter, latestOutboxId, markOutcome, pruneOutbox, releaseHeld } from "./outbox.ts";
import { proposeSchedulesOff } from "./outbox-learn.ts";
import { answerMessage, buildReview, recordWish, sendWeeklyReview } from "./outbox-review.ts";
import { answerLesson, openLessons } from "./learn/lessons.ts";
import { answerRetro, openRetroProposals, runRetro } from "./learn/retro.ts";
import { answerAfterCheck, openAfterChecks, queueRestore, scheduleHistory } from "./learn/versions.ts";
import { tick as instagramTick } from "./instagram/index.ts";
import { INTERVAL_HOURS as CHECKIN_INTERVAL_HOURS } from "./checkin/rules.ts";
import { previewCheckin, runCheckin, sweepCheckin } from "./checkin/run.ts";
import * as checkinStore from "./checkin/store.ts";
import { pruneHeadsup } from "./headsup/prune.ts";
import { defaultApnsEnv, sendPush } from "./push/apns.ts";
import { APNS_ENABLED, DASHBOARD_PUBLIC_URL, MAC_BANNER, NTFY_ENABLED } from "./config.ts";
import { CHECKIN_MODE, CHECKIN_PUSH_DETAIL } from "./config.ts";
import { INBOX_MAX_BYTES, INBOX_WATCH_DIR } from "./config.ts";
import { BASE, CLOUD_BASE_URL, LOCAL_BASE_URL, VISION_MAX_BYTES, VISION_MAX_IMAGES, VISION_MODEL } from "./config.ts";
import * as store from "./memory/store.ts";
import { planFromActions } from "./plan.ts";
import { isDeliverable, listDeliverables } from "./deliverables.ts";
import { projectWriteDir, writeFile, WRITE_EXTENSIONS } from "./tools/write-file.ts";
import { addTask, deleteTask, getTask, listTasks, updateTask } from "./tasks/store.ts";
import { sweepDueTasks } from "./tasks/sweep.ts";
import * as headsupDates from "./headsup/dates.ts";
import * as headsupLedger from "./headsup/ledger.ts";
import { planMorning } from "./headsup/index.ts";
import { readImage } from "./headsup/research/cards.ts";
import { RESEARCH_KINDS, researchHeadsup, startResearch } from "./headsup/research/run.ts";
import { runMorningHeadsup, sweepHeadsup } from "./headsup/morning.ts";
import { sweepWatches } from "./headsup/watch/loop.ts";
import { updatePrefs } from "./headsup/prefs.ts";
import { prefsForClient } from "./headsup/prefs-view.ts";
import { enableWatch } from "./headsup/watch/enable.ts";
import { sweepDueCards } from "./study/sweep.ts";
import { deleteClient, fmtMinutes, listClients, listTime, timeReport, upsertClient } from "./clients/store.ts";
import { ensureMorningBrief } from "./briefing.ts";
import { pruneSources } from "./research/sources.ts";
import { parseWhen } from "./tasks/when.ts";
import { rawDb } from "./memory/store.ts";
import { dedupeMemories, deleteMemory, listMemories, pruneMemories } from "./memory/rag.ts"; // also ensures the memories table exists
import { summarizeConversation, summarizeIdleConversations } from "./memory/summarize.ts";
import { deleteRecipe, listRecipes, updateRecipe } from "./recipes/store.ts";
import * as styleStore from "./styles/store.ts";
import { overview } from "./overview.ts";
import { acceptQuestion, dismissQuestion, findMeetingQuestions, listQuestions } from "./study/meeting-questions.ts";
import { dueForScreen, reviewWithRecall, studyOverview } from "./study/review.ts";

const PORT = Number(process.env.DASHBOARD_PORT ?? "8787");
// Default binds localhost only. Set DASHBOARD_HOST=0.0.0.0 to reach it from other machines
// on the LAN — but only with a DASHBOARD_TOKEN set (enforced below), because the API can run
// the agent, approve actions, and read your mail/calendar traces.
const HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";
const TOKEN = process.env.DASHBOARD_TOKEN ?? "";
const IS_LOCAL = HOST === "127.0.0.1" || HOST === "localhost";
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

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

/**
 * Whether the Cloud tier exists, and where it points, for the thread inspector. When it is not
 * configured a thread pinned to Cloud quietly runs on the local model (see `resolveTier`), so
 * the app needs this to say so. Model and host are not secrets; the key never leaves config.
 */
const cloudStatus = (): { configured: boolean; host: null | string; model: null | string } => {
  const deep = tierConfig("deep");
  if (!deep.configured) return { configured: false, host: null, model: null };
  let host: null | string = null;
  try {
    host = new URL(CLOUD_BASE_URL).hostname;
  } catch {
    /* an unparseable URL just has no host to show */
  }
  return { configured: true, host, model: deep.model };
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
  ".png": "image/png",
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
 * Serve a generated image from IMAGES_DIR under /images/.
 *
 * These are written by the generate_image tool, NOT part of the built frontend, so they
 * live outside PUBLIC_DIR (which is replaced wholesale on every rebuild) and get their own
 * route. The filename in the URL originates from a tool whose arguments come from the model,
 * so the same path-traversal guard serveStatic uses is a real boundary here, not a
 * formality: resolve the path, then confirm it is still inside IMAGES_DIR before reading it.
 * A `/images/../server.ts` or an absolute path must not escape. No SPA fallback — a missing
 * image is a 404, never index.html.
 */
const serveImage = (res: Res, urlPath: string): boolean => {
  if (!fs.existsSync(IMAGES_DIR)) return false;
  const rel = urlPath.replace(/^\/images\/+/, "");
  if (!rel) return false;
  const file = path.resolve(IMAGES_DIR, rel);
  if (!file.startsWith(IMAGES_DIR + path.sep)) return false; // escaped the directory
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  // Generated PNGs are immutable — the filename carries a uuid, so it never changes content.
  return sendFile(res, file, true);
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

  // Generated images, served from IMAGES_DIR (outside PUBLIC_DIR). No token: same posture
  // as the static shell, and the guard inside serveImage is what keeps this to real files
  // under that one directory. Checked before serveStatic so an /images path is never handed
  // the SPA index fallback.
  if (seg[0] === "images") {
    if (serveImage(res, p)) return;
    return sendJson(res, 404, { error: "image not found" });
  }

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

  // The same idea for a heads-up: a push can carry a token that answers THAT ONE item, once.
  const isHeadsupAnswer = m === "POST" && seg[1] === "headsups" && seg.length === 4 && seg[3] === "answer";
  if (isHeadsupAnswer && approvalToken) {
    if (!rateOk(ip, "approval")) return sendJson(res, 429, { error: "rate limited" });
    authedByApproval = headsupLedger.checkAnswerToken(Number(seg[2]), approvalToken);
    if (!authedByApproval) return sendJson(res, 401, { error: "invalid, already-used, or expired answer token" });
  }

  if (TOKEN && !authedByApproval) {
    const provided = (req.headers["x-dashboard-token"] as string | undefined) ?? url.searchParams.get("token");
    if (provided !== TOKEN) return sendJson(res, 401, { error: "unauthorized: missing or invalid dashboard token" });
  }

  try {
    // /api/status
    if (m === "GET" && seg[1] === "status" && seg.length === 2) {
      return sendJson(res, 200, {
        // The thread where questions nobody's chat raised are asked, once one has been.
        inbox: store.inboxId(),
        // Whether the local model host answers, and how fast (cached ten seconds).
        model: await probeModelHost(LOCAL_BASE_URL),
        queue: queueStatus(),
        // Whether the Cloud tier exists at all, so a thread pinned to it can say why it ran
        // local. The model name is not a secret; the key never leaves config.
        cloud: cloudStatus(),
        schedules: store.listSchedules().length,
        // Open tasks, for the Mac sidebar's badge. Same cap as GET /api/tasks, so a count of 300
        // means "at least 300"; nobody needs that precision on a badge.
        tasks: listTasks({ limit: 300, status: "open" }).length,
        time: new Date().toISOString(),
      });
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

    // /api/builds , /api/builds/:runId/diff — a view over the actions log, not a table of
    // its own. See src/builds.ts for why, and for the second authorisation on the diff.
    if (m === "GET" && seg[1] === "builds") {
      if (seg.length === 2) return sendJson(res, 200, listBuilds(Number(url.searchParams.get("limit") ?? 40)));
      if (seg.length === 4 && seg[3] === "diff") {
        const out = await buildDiff(Number(seg[2]));
        return sendJson(res, "error" in out ? 404 : 200, out);
      }
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
        // Every open question in this thread, each placed under the turn that raised it (a
        // subagent's under the turn that delegated to it). Whatever no turn claims — the
        // inbox's questions, a CLI run's — is returned on its own and drawn at the end.
        const runs = store.runsForConversation(id);
        const open = store.pendingConfirmationsForConversation(id);
        const claimed = new Set<number>();
        const openFor = (turnId: number, childIds: number[]): store.ConfirmationRow[] => {
          const mine = open.filter((c) => c.run_id === turnId || (c.run_id != null && childIds.includes(c.run_id)));
          for (const c of mine) claimed.add(c.id);
          return mine;
        };
        const turns = runs.map((r: any) => {
          const actions = store.listActions(r.id);
          return {
          actions,
          // The step checklist the chat draws under each turn (src/plan.ts), folded from the
          // same rows the Trace tab lists call by call.
          plan: planFromActions(actions, r.status),
          // Images the user sent with this turn. Metadata only — the bytes come from
          // /api/attachments/:id, so a thread of twenty photographs is still one small JSON
          // response and the browser caches each image once.
          attachments: store.attachmentsForRun(r.id).map((a) => ({
            bytes: a.bytes,
            // Whether the perception pass actually read this one. A reloaded thread has no
            // event stream to replay, so without this it could only guess — and guessing
            // "read" from the mere presence of an image would quietly claim the assistant
            // looked at a picture that the vision endpoint was down for.
            described: a.description !== null,
            id: a.id,
            mime: a.mime,
            name: a.name,
          })),
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
          // What actually answered (null for turns before this was recorded); see noteServed.
          served: (() => {
            try {
              return r.served ? JSON.parse(r.served) : null;
            } catch {
              return null;
            }
          })(),
          // What the assistant had in front of it, and whether this reply is starred.
          contextUsed: (() => {
            try {
              return r.context_used ? JSON.parse(r.context_used) : [];
            } catch {
              return [];
            }
          })(),
          starred: !!r.starred,
          // Model calls and tokens for this turn and the child runs it started (the thread inspector).
          usage: store.usageForRuns([r.id, ...store.childRuns(r.id).map((c: any) => c.id)]),
          // Still-open approvals belong with the turn that raised them, so they survive a
          // reload and don't strand the user in a separate queue to answer them.
          confirmations: openFor(
            r.id,
            store.childRuns(r.id).map((c: any) => c.id),
          ),
          finished: r.finished,
          id: r.id,
          // "chat" for the user's own message; "approval" for the turn that picked the
          // thread back up after they answered its buttons — drawn as a decision, not a
          // message they typed.
          kind: r.kind,
          started: r.started,
          status: r.status,
          summary: r.note,
          task: r.task,
          };
        });
        return sendJson(res, 200, {
          confirmations: open.filter((c) => !claimed.has(c.id)),
          conversation: store.getConversation(id),
          inbox: store.isInbox(id),
          turns,
        });
      }

      // The user is looking at this thread: its finished replies are read (the unread dot).
      if (m === "POST" && seg.length === 4 && seg[3] === "read") {
        store.markConversationRead(id);
        return sendJson(res, 200, { ok: true });
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
        // Archiving is an explicit "I'm done with this" — the moment to fold the thread into
        // cross-conversation memory, even if short (force). Fire-and-forget so the PATCH still
        // answers immediately; the summariser is private-pinned and never throws. No-op unless
        // CONVERSATION_SUMMARY_ENABLED. Done after the update so the archived flag is set, but
        // it reads the thread's runs, which the flag doesn't touch.
        if (patch.archived === true) void summarizeConversation(id, { force: true });
        return sendJson(res, 200, store.getConversation(id));
      }

      if (m === "DELETE" && seg.length === 3) {
        // The files too, not just the rows. An image is the most personal thing this system
        // stores, and "I deleted that conversation" has to mean the photograph is gone from
        // the disk as well — otherwise the attachments directory becomes a private archive
        // of every thread the user thought they had removed.
        for (const a of store.attachmentsForConversation(id, 1000)) removeAttachment(a);
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
        const attachmentIds = Array.isArray(b.attachmentIds)
          ? b.attachmentIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
          : [];
        // A message may be an image with no words — "what is this?" is often the picture
        // itself — so text is required only when nothing was attached.
        if (!task && !attachmentIds.length) return sendJson(res, 400, { error: "task required" });
        // A thread pinned to a tier overrides the dispatcher for every turn in it — the
        // escape hatch for "I know this one is hard, use the good model".
        const pinned = store.getConversation(id)?.tier;
        const { done, runId } = startTask(task || "What is this?", {
          attachmentIds,
          conversationId: id,
          kind: "chat",
          // The phone sets this and then locks itself. The dashboard never does — it is
          // holding the event stream open. See RunOpts.notifyOnFinish.
          notifyOnFinish: !!b.notify,
          tier: (pinned as Tier | undefined) ?? undefined,
        });
        // The failure is already recorded on the run row and published to the stream; this
        // handler exists so an unattended rejection doesn't crash the process.
        done.catch((e) => console.error(`[chat] run ${runId} failed: ${e instanceof Error ? e.message : e}`));
        return sendJson(res, 202, { conversationId: id, runId });
      }
    }

    /**
     * /api/attachments — images sent with a message.
     *
     * Upload is its own route rather than part of the message body, for the same reason
     * dictation's is: the bytes are binary and potentially megabytes, and JSON would mean
     * base64 in a string with no ceiling. The browser uploads while the user is still
     * typing, gets an id back, and sends that id with the message — so a photograph that
     * takes a moment to travel does not hold up the composer.
     *
     * The upload is bound to a conversation at this point but to no run: the run does not
     * exist until send is pressed, and an upload nobody sends is swept by `prune` below.
     */
    if (seg[1] === "attachments") {
      // POST /api/attachments?conversationId=&name= — raw image bytes as the body.
      if (m === "POST" && seg.length === 2) {
        try {
          const bytes = await readBinary(req, VISION_MAX_BYTES);
          const raw = url.searchParams.get("conversationId");
          const conversationId = raw ? Number(raw) : null;
          // An upload naming a conversation that does not exist is refused rather than
          // stored loose: every legitimate upload comes from an open thread, and a row with
          // a dangling conversation id would never be swept by thread deletion.
          if (conversationId != null && (!Number.isInteger(conversationId) || !store.getConversation(conversationId))) {
            return sendJson(res, 404, { error: "no such conversation" });
          }
          const stored = await storeImage(bytes, { conversationId, name: url.searchParams.get("name") });
          return sendJson(res, 200, stored);
        } catch (err) {
          if (err instanceof TooLargeError) return sendJson(res, 413, { error: (err as Error).message });
          if (err instanceof UnsupportedImageError) return sendJson(res, 415, { error: err.message });
          return sendJson(res, 400, { error: (err as Error).message });
        }
      }

      /**
       * GET /api/attachments/:id — the image itself, for the thread to render.
       *
       * Served with `nosniff` and a `default-src 'none'` policy. The sniffer in
       * attachments.ts already refuses anything that is not one of four raster formats — SVG
       * in particular never reaches disk, because an SVG is a document that can carry script
       * — so these headers are the second lock rather than the first. The long cache is safe
       * because the file is immutable: an id names one set of bytes forever.
       */
      if (m === "GET" && seg.length === 3) {
        const row = store.getAttachment(Number(seg[2]));
        if (!row) return sendJson(res, 404, { error: "no such attachment" });
        const bytes = readAttachment(row);
        if (!bytes) return sendJson(res, 410, { error: "the file for this attachment is gone" });
        res.writeHead(200, {
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Length": String(bytes.length),
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Type": row.mime,
          "X-Content-Type-Options": "nosniff",
        });
        res.end(bytes);
        return;
      }
    }

    /**
     * /api/vision — whether images can be read at all, and by what.
     *
     * The composer asks this once on load so it can say "no vision endpoint configured"
     * before someone attaches a photograph and waits for an answer, rather than after.
     */
    if (m === "GET" && seg[1] === "vision" && seg.length === 2) {
      return sendJson(res, 200, {
        configured: visionConfigured(),
        maxBytes: VISION_MAX_BYTES,
        maxImages: VISION_MAX_IMAGES,
        model: visionConfigured() ? VISION_MODEL : null,
      });
    }

    // /api/confirmations , approve, reject
    if (seg[1] === "confirmations") {
      if (m === "GET" && seg.length === 2)
        return sendJson(res, 200, store.listConfirmations(url.searchParams.get("state") ?? undefined));
      // Answering resumes the conversation that asked (see resumeConversation). A lock-screen
      // button (approval token) or a client that says { notify: true } is not going to watch
      // that turn happen, so it finishes with a push.
      if (m === "POST" && seg.length === 4 && seg[3] === "approve") {
        const b = await readBody(req);
        return sendJson(
          res,
          200,
          await approveConfirmation(Number(seg[2]), { notifyOnFinish: authedByApproval || !!b?.notify }),
        );
      }
      if (m === "POST" && seg.length === 4 && seg[3] === "reject") {
        // Optional { reason } — stored as a preference so it stops proposing this.
        // The phone's Reject button sends none, which is fine.
        const b = await readBody(req);
        return sendJson(
          res,
          200,
          await rejectConfirmation(Number(seg[2]), String(b.reason ?? ""), {
            notifyOnFinish: authedByApproval || !!b.notify,
          }),
        );
      }
    }

    /**
     * /api/devices — the phones that get pushed to.
     *
     * Registration is an upsert the app repeats on every launch, because an APNs device
     * token is not stable (reinstall, restore from backup, or iOS simply deciding). A client
     * that tried to remember whether it had already registered would eventually be wrong in
     * the one direction that matters, so it does not try.
     *
     * Behind the dashboard token like every other mutating route. The agent has no tool that
     * reaches this: nothing the model does can add a destination for your notifications,
     * which is the same posture as /api/proposals and for the same reason.
     */
    if (seg[1] === "devices") {
      if (m === "GET" && seg.length === 2) {
        // The token is a credential for pushing to your phone, so it is shown the way a card
        // number is: enough to tell two devices apart, not enough to be useful if this
        // response is read by someone else.
        return sendJson(
          res,
          200,
          store.listDevices().map((d) => ({
            created: d.created,
            detail: d.detail,
            disabled: d.disabled,
            environment: d.environment,
            failures: d.failures,
            id: d.id,
            name: d.name,
            seen: d.seen,
            token: `…${d.token.slice(-8)}`,
          })),
        );
      }

      if (m === "POST" && seg.length === 2) {
        const b = await readBody(req);
        // Hex, 64 characters today, but Apple has lengthened it before and may again — so
        // this checks the alphabet and a sane range rather than an exact length, which would
        // turn a future iOS release into a silent registration failure.
        const token = String(b.token ?? "").trim().toLowerCase();
        if (!/^[0-9a-f]{32,200}$/.test(token))
          return sendJson(res, 400, { error: "token must be a hex APNs device token" });
        const environment = b.environment === "production" ? "production" : defaultApnsEnv();
        const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : null;
        const row = store.upsertDevice(token, environment, name);
        console.log(`[devices] registered ${row.name ?? "device"} ${row.id} (${environment})`);
        return sendJson(res, 200, { environment: row.environment, id: row.id, name: row.name });
      }

      if (m === "DELETE" && seg.length === 3) {
        const removed = store.deleteDevice(Number(seg[2]));
        return sendJson(res, removed ? 200 : 404, { id: Number(seg[2]), removed });
      }
    }

    /**
     * GET /api/outbox/banners?after=N: what the server left for the Mac app to show (MAC_BANNER=app).
     * Without `after` it returns no banners, just `latest`, so an app that has just opened starts
     * from now. `mode` says whether the app should show anything: with MAC_BANNER=osascript the
     * server already showed them, and the app must not repeat them.
     */
    if (m === "GET" && seg[1] === "outbox" && seg[2] === "banners" && seg.length === 3) {
      const raw = url.searchParams.get("after");
      const after = raw === null ? null : Number(raw);
      if (after !== null && (!Number.isInteger(after) || after < 0)) return sendJson(res, 400, { error: "after must be a non-negative integer" });
      return sendJson(res, 200, {
        banners: after === null || MAC_BANNER !== "app" ? [] : bannersAfter(after),
        latest: latestOutboxId(),
        mode: MAC_BANNER,
      });
    }

    /**
     * POST /api/outbox/:id/opened and /dismissed: the phone reporting what happened to a push
     * (docs/archive/PLAN-outbox.md, Phase 2). Only an APNs delivery can say this; the id rides in
     * the push payload. Idempotent, first report wins. Behind the dashboard token, and it records
     * a timestamp and nothing else, so a wrong call can at worst skew a count.
     */
    if (m === "POST" && seg[1] === "outbox" && seg.length === 4 && (seg[3] === "opened" || seg[3] === "dismissed")) {
      const id = Number(seg[2]);
      if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: "id must be a positive integer" });
      const recorded = markOutcome(id, seg[3]);
      return sendJson(res, recorded ? 200 : 404, { id, recorded });
    }

    /**
     * The weekly review (docs/archive/PLAN-outbox.md, Phase 3), for web, Mac and iPhone alike.
     *   GET  /api/outbox/review          the last 7 days of messages you can vote on, plus the counts.
     *                                    Opening it stamps `seen_at` on what it lists; that is its one side effect.
     *   POST /api/outbox/:id/feedback    {answer: "useful" | "skip"}. "skip" files a dismissal memory under
     *                                    the message's topic. Memory only: nothing here edits profile.md,
     *                                    goals.md, policy.json, agents/*.md or a schedule.
     *   POST /api/outbox/wish            {text}: something you wish you had been told, stored as a preference memory.
     */
    if (m === "GET" && seg[1] === "outbox" && seg[2] === "review" && seg.length === 3) {
      // Composed here so outbox-review.ts stays free of anything that imports the model router.
      return sendJson(res, 200, { ...buildReview(), afterChecks: openAfterChecks(), lessons: openLessons(), retro: openRetroProposals() });
    }
    // POST /api/outbox/after-checks/:id {answer: "keep" | "revert"}: a finished check on a job's change (SL8).
    // Reverting only queues the earlier text for approval.
    if (m === "POST" && seg[1] === "outbox" && seg[2] === "after-checks" && seg.length === 4) {
      const id = Number(seg[3]);
      if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: "id must be a positive integer" });
      const b = await readBody(req);
      if (b?.answer !== "keep" && b?.answer !== "revert") return sendJson(res, 400, { error: 'answer must be "keep" or "revert"' });
      const result = answerAfterCheck(id, b.answer);
      return result ? sendJson(res, 200, result) : sendJson(res, 404, { error: "not an open after-check" });
    }
    // POST /api/outbox/lessons/:id {answer: "accept" | "reject"}: keeping a lesson is the only way one reaches a later
    // run, because the critique that wrote it may have read untrusted content (learn/lessons.ts).
    if (m === "POST" && seg[1] === "outbox" && seg[2] === "lessons" && seg.length === 4) {
      const id = Number(seg[3]);
      if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: "id must be a positive integer" });
      const b = await readBody(req);
      if (b?.answer !== "accept" && b?.answer !== "reject") return sendJson(res, 400, { error: 'answer must be "accept" or "reject"' });
      const result = await answerLesson(id, b.answer);
      return result ? sendJson(res, 200, result) : sendJson(res, 404, { error: "not an open lesson" });
    }
    // POST /api/outbox/retro/:id {answer: "accept" | "reject"}: one retrospective card (SL2). Accepting a
    // routine queues a disabled job for approval. No other answer changes anything but the card's record.
    if (m === "POST" && seg[1] === "outbox" && seg[2] === "retro" && seg.length === 4) {
      const id = Number(seg[3]);
      if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: "id must be a positive integer" });
      const b = await readBody(req);
      if (b?.answer !== "accept" && b?.answer !== "reject") return sendJson(res, 400, { error: 'answer must be "accept" or "reject"' });
      const result = answerRetro(id, b.answer);
      return result ? sendJson(res, 200, result) : sendJson(res, 404, { error: "not an open card" });
    }
    if (m === "POST" && seg[1] === "outbox" && seg[2] === "wish" && seg.length === 3) {
      const b = await readBody(req);
      if (!String(b?.text ?? "").trim()) return sendJson(res, 400, { error: "text is required" });
      return sendJson(res, 200, { remembered: await recordWish(b.text) });
    }
    if (m === "POST" && seg[1] === "outbox" && seg.length === 4 && seg[3] === "feedback") {
      const id = Number(seg[2]);
      if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: "id must be a positive integer" });
      const b = await readBody(req);
      if (b?.answer !== "useful" && b?.answer !== "skip") return sendJson(res, 400, { error: 'answer must be "useful" or "skip"' });
      const result = await answerMessage(id, b.answer);
      return result ? sendJson(res, 200, result) : sendJson(res, 404, { error: "not a message the review lists" });
    }

    /**
     * POST /api/push/test — send a notification to every registered phone, right now.
     *
     * This earns its place because the APNs failure modes are all silent from the phone's
     * side: a wrong key id, the wrong environment, a Time Sensitive permission you never
     * granted, and a working setup are indistinguishable from the sofa. The response is the
     * verbatim APNs verdict per device, which turns "it didn't buzz" into a reason.
     */
    if (m === "POST" && seg[1] === "push" && seg[2] === "test" && seg.length === 3) {
      const b = await readBody(req);
      const r = await sendPush(
        String(b.title ?? "AgentSpine"),
        String(b.body ?? "Test push. If you can read this, the APNs path works."),
        { category: "RUN", priority: Number(b.priority ?? 3) },
      );
      return sendJson(res, r.ok ? 200 : 502, r);
    }

    // /api/memories?query=
    if (m === "GET" && seg[1] === "memories" && seg.length === 2) {
      const q = url.searchParams.get("query");
      return sendJson(res, 200, listMemories(100, q || undefined));
    }

    // /api/memories/:id  — retract a single learned memory. The human-facing correction for
    // a wrong or stale fact, behind the dashboard token like every other mutating route; the
    // agent has no tool that reaches it. 404 when the id is unknown so a stale UI double-click
    // reads honestly rather than pretending it deleted something.
    if (m === "DELETE" && seg[1] === "memories" && seg.length === 3) {
      const removed = deleteMemory(Number(seg[2]));
      return sendJson(res, removed ? 200 : 404, { id: Number(seg[2]), removed });
    }

    /**
     * /api/inbox: the Knowledge Inbox (src/inbox/). Files, screenshots, scans, pasted threads and notes become
     * source artifacts before they have a project. Local only; nothing here calls out.
     */
    if (seg[1] === "inbox") {
      // The server's file paths stay on the server: a client sees the item, never where its original sits.
      const withProject = (it: inboxStore.ItemRow | undefined) =>
        it
          ? { ...it, stored_path: undefined, suggestedProjectName: it.suggested_project != null ? (projects.getProject(it.suggested_project)?.name ?? null) : null }
          : undefined;
      try {
        // GET /api/inbox/status: what this machine can do with an item.
        if (m === "GET" && seg[2] === "status" && seg.length === 3) {
          return sendJson(res, 200, { maxBytes: INBOX_MAX_BYTES, ocr: await ocrAvailable(), watchFolder: INBOX_WATCH_DIR || null });
        }
        // GET /api/inbox?status=&unfiled=1
        if (m === "GET" && seg.length === 2) {
          const status = url.searchParams.get("status") as inboxStore.ItemStatus | null;
          return sendJson(res, 200, inboxStore.listItems({ status: status ?? undefined, unfiled: url.searchParams.get("unfiled") === "1" }).map(withProject));
        }
        // POST /api/inbox/files?name=&project= (raw bytes). The same bytes again return the existing item.
        if (m === "POST" && seg[2] === "files" && seg.length === 3) {
          const bytes = await readBinary(req, INBOX_MAX_BYTES);
          const project = url.searchParams.get("project");
          const r = await ingestFile(bytes, { name: url.searchParams.get("name") ?? undefined, projectId: project ? Number(project) : undefined, via: "upload" });
          return sendJson(res, r.duplicate ? 200 : 201, { duplicate: r.duplicate, item: withProject(r.item) });
        }
        // POST /api/inbox/paste { text, name?, kind?: "note"|"paste", via?: "dictation", project?, thread? }
        if (m === "POST" && seg[2] === "paste" && seg.length === 3) {
          const b = await readBody(req);
          const r = await ingestPaste(String(b?.text ?? ""), {
            kind: b?.kind === "note" ? "note" : "paste",
            name: typeof b?.name === "string" ? b.name : undefined,
            projectId: b?.project != null ? Number(b.project) : undefined,
            thread: b?.thread === false ? false : undefined,
            via: pasteVia(b),
          });
          return sendJson(res, r.duplicate ? 200 : 201, { duplicate: r.duplicate, item: withProject(r.item) });
        }
        const itemId = Number(seg[2]);
        if (Number.isInteger(itemId) && seg.length >= 3) {
          const item = inboxStore.getItem(itemId);
          if (!item) return sendJson(res, 404, { error: "no such inbox item" });
          if (m === "GET" && seg.length === 3) return sendJson(res, 200, withProject(item));
          // POST /api/inbox/:id/extract: ask the local model for cited claims. They arrive `proposed`.
          if (m === "POST" && seg[3] === "extract") {
            const text = inboxItemText(itemId);
            if (!text) return sendJson(res, 409, { error: "this item has no readable text to extract from" });
            const r = await extractClaims({ projectId: item.project_id, saidOn: item.doc_date, sourceKind: "inbox", sourceRef: `inbox:${itemId}`, text });
            return sendJson(res, 200, r);
          }
          if (m === "POST" && seg[3] === "reprocess") return sendJson(res, 200, withProject(await reprocessInboxItem(itemId)));
          if (m === "DELETE" && seg.length === 3) return sendJson(res, 200, { deleted: deleteInboxItem(itemId) });
          if (m === "PATCH" && seg.length === 3) {
            const b = await readBody(req);
            if ("project" in b) {
              const target = b.project == null ? null : Number(b.project);
              if (target != null && !projects.getProject(target)) return sendJson(res, 404, { error: "no such project" });
              await fileInboxItem(itemId, target);
            }
            inboxStore.updateItem(itemId, {
              docDate: typeof b.docDate === "string" ? b.docDate : undefined,
              private: typeof b.private === "boolean" ? b.private : undefined,
              tags: Array.isArray(b.tags) ? b.tags.map(String).slice(0, 20) : undefined,
            });
            return sendJson(res, 200, withProject(inboxStore.getItem(itemId)));
          }
        }
      } catch (err) {
        if (err instanceof TooLargeError) return sendJson(res, 413, { error: (err as Error).message });
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    /**
     * /api/knowledge/claims and friends: the knowledge store (src/knowledge/). Cited decisions, commitments, risks and
     * facts, `proposed` until a person reviews them. Supersession is only ever marked here, by a person.
     */
    if (seg[1] === "knowledge" && seg[2] !== "search") {
      try {
        const num = (k: string): number | undefined => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
        const str = (k: string): string | undefined => url.searchParams.get(k) ?? undefined;
        if (m === "GET" && seg[2] === "entities" && seg.length === 3) return sendJson(res, 200, knowledge.listEntities());
        // POST /api/knowledge/entities/:id/aliases {alias, merge?}: a name that is someone else's returns `clash` and
        // changes nothing unless `merge` is exactly true, because a merge cannot be undone.
        if (m === "POST" && seg[2] === "entities" && seg[4] === "aliases" && seg.length === 5) {
          const b = await readBody(req);
          return sendJson(res, 200, knowledge.teachAlias(Number(seg[3]), String(b.alias ?? ""), { merge: b.merge === true }));
        }
        // Relationships between people and teams. A person enters them; nothing infers them.
        if (seg[2] === "relations" && seg.length === 3) {
          if (m === "GET") {
            const id = num("entity");
            if (id === undefined) return sendJson(res, 400, { error: "entity is required" });
            return sendJson(res, 200, knowledge.relationsOf(id));
          }
          if (m === "POST" || m === "DELETE") {
            const b = await readBody(req);
            (m === "POST" ? knowledge.relate : knowledge.unrelate)(Number(b.from), Number(b.to), b.rel);
            return sendJson(res, 200, knowledge.relationsOf(Number(b.from)));
          }
        }
        if (m === "GET" && seg[2] === "conflicts" && seg.length === 3) return sendJson(res, 200, knowledge.findConflicts());
        if (m === "GET" && seg[2] === "summary" && seg.length === 3) return sendJson(res, 200, knowledge.counts());
        if (seg[2] === "claims") {
          const present = (c: knowledge.Claim) => ({ ...c, evidence: knowledge.evidenceLevel(c) });
          if (m === "GET" && seg.length === 3) {
            return sendJson(res, 200, knowledge.listClaims({
              asOf: str("asOf"), kind: str("kind") as knowledge.ClaimKind | undefined, limit: num("limit"), ownerId: num("owner"),
              projectId: num("project"), reviewState: str("review") as knowledge.ReviewState | undefined, since: str("since"),
              sourceKind: str("sourceKind"), sourceRef: str("sourceRef"), status: str("status") as knowledge.ClaimStatus | undefined,
              topicId: num("topic"),
            }).map(present));
          }
          // POST /api/knowledge/claims: a claim entered by hand. A person entering it is the review.
          if (m === "POST" && seg.length === 3) {
            const b = await readBody(req);
            const id = knowledge.addClaim({
              due: b.due, kind: b.kind, method: "manual", owner: b.owner, passage: String(b.passage ?? ""), projectId: b.project ?? null,
              reviewState: "reviewed", saidOn: b.saidOn, sourceKind: String(b.sourceKind ?? "note"), sourceRef: String(b.sourceRef ?? "typed"),
              speaker: b.speaker, text: String(b.text ?? ""), topic: b.topic,
            });
            return sendJson(res, 201, present(knowledge.getClaim(id) as knowledge.Claim));
          }
          const claimId = Number(seg[3]);
          if (Number.isInteger(claimId) && seg.length >= 4) {
            const claim = knowledge.getClaim(claimId);
            if (!claim) return sendJson(res, 404, { error: "no such claim" });
            if (m === "GET" && seg.length === 4) return sendJson(res, 200, { ...present(claim), chain: knowledge.chain(claimId), links: knowledge.linksOf(claimId) });
            if (m === "POST" && seg[4] === "supersede") {
              const b = await readBody(req);
              knowledge.supersede(claimId, Number(b.by));
              return sendJson(res, 200, present(knowledge.getClaim(claimId) as knowledge.Claim));
            }
            if (m === "PATCH" && seg.length === 4) {
              const b = await readBody(req);
              if (typeof b.sensitive === "boolean") knowledge.setClaimSensitive(claimId, b.sensitive);
              if (b.review === "accept" || b.review === "reject") knowledge.reviewClaim(claimId, b.review, { due: b.due, owner: b.owner, text: b.text, topic: b.topic });
              if (b.status) knowledge.setClaimStatus(claimId, b.status);
              return sendJson(res, 200, present(knowledge.getClaim(claimId) as knowledge.Claim));
            }
          }
        }
        // GET /api/knowledge/briefs/{project|person|topic|op|trace}/...: assembled from reviewed claims, never free text.
        // ?format=md returns Markdown with each line's citation; ?refresh=1 rebuilds a stored brief.
        if (m === "GET" && seg[2] === "briefs" && seg.length >= 5) {
          const asOf = str("asOf");
          const fresh = url.searchParams.get("refresh") === "1";
          const maxAge = fresh ? 0 : 60;
          let brief: briefs.Brief;
          if (seg[3] === "project") {
            const pid = Number(seg[4]);
            const project = projects.getProject(pid);
            if (!project) return sendJson(res, 404, { error: "no such project" });
            brief = asOf ? briefs.projectBrief(pid, project.name, { asOf }) : briefs.materialize({ kind: "project", subject: String(pid) }, () => briefs.projectBrief(pid, project.name), maxAge);
          } else if (seg[3] === "person") {
            const eid = Number(seg[4]);
            brief = asOf ? briefs.personBrief(eid, { asOf }) : briefs.materialize({ kind: "person", subject: String(eid) }, () => briefs.personBrief(eid), maxAge);
          } else if (seg[3] === "topic") {
            const eid = Number(seg[4]);
            if (knowledge.getEntity(eid)?.kind !== "topic") return sendJson(res, 404, { error: "no such topic" });
            brief = asOf ? briefs.topicBrief(eid, { asOf }) : briefs.materialize({ kind: "topic", subject: String(eid) }, () => briefs.topicBrief(eid), maxAge);
          } else if (seg[3] === "op") {
            const name = seg[4] as briefs.Operation;
            if (!briefs.OPERATIONS.includes(name)) return sendJson(res, 404, { error: `unknown operation; one of ${briefs.OPERATIONS.join(", ")}` });
            const pid = num("project");
            brief = briefs.operation(name, { asOf, days: num("days"), ownerId: num("owner"), projectId: pid, projectName: pid ? projects.getProject(pid)?.name : undefined });
          } else if (seg[3] === "one-on-one") {
            brief = briefs.oneOnOne(Number(seg[4]), { asOf });
          } else if (seg[3] === "trace") {
            brief = briefs.decisionTrace(Number(seg[4]));
          } else return sendJson(res, 404, { error: "unknown brief" });
          if (str("format") === "md") return sendJson(res, 200, { markdown: briefs.renderBrief(brief) });
          return sendJson(res, 200, brief);
        }
        // POST /api/knowledge/briefs/plan {plan, project?}: a written plan against what the meetings recorded.
        if (m === "POST" && seg[2] === "briefs" && seg[3] === "plan" && seg.length === 4) {
          const b = await readBody(req);
          const plan = String(b.plan ?? "");
          if (!plan.trim()) return sendJson(res, 400, { error: "plan is required" });
          const pid = b.project != null ? Number(b.project) : undefined;
          const brief = briefs.comparePlan(plan, { projectId: pid, projectName: pid ? projects.getProject(pid)?.name : undefined });
          return sendJson(res, 200, str("format") === "md" ? { markdown: briefs.renderBrief(brief) } : brief);
        }
        // POST /api/knowledge/meetings/:id: carry a meeting's extraction into the store (idempotent).
        if (m === "POST" && seg[2] === "meetings" && seg.length === 4) return sendJson(res, 200, { claims: normalizeMeeting(Number(seg[3])) });
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // /api/retention: what is kept, and for how long, per kind of thing. Read-only; the numbers are config.
    if (m === "GET" && seg[1] === "retention" && seg.length === 2) return sendJson(res, 200, retentionRules());

    // /api/knowledge/search?q=&project=&kind=&since=&until=&asOf=&person=&team=&evidence=&k= — hybrid full-text and
    // vector search over every indexed document and filed meeting (src/projects/search.ts). Omit project to search the
    // whole base. asOf is until by another name (a passage is as of the day it is dated). person or team keeps passages
    // that name them; evidence (reviewed, extracted, none, comma-separated) keeps sources by what backs them. An
    // unknown person or team, or a bad evidence value, is a 400 so a screen never shows "no results" for a typo.
    if (m === "GET" && seg[1] === "knowledge" && seg[2] === "search" && seg.length === 3) {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query) return sendJson(res, 400, { error: "q is required" });
      const project = url.searchParams.get("project");
      const kinds = (url.searchParams.get("kind") ?? "").split(",").filter(Boolean);
      const evidence = (url.searchParams.get("evidence") ?? "").split(",").filter(Boolean);
      if (evidence.some((e) => !(EVIDENCE_FILTERS as readonly string[]).includes(e))) return sendJson(res, 400, { error: `evidence must be any of ${EVIDENCE_FILTERS.join(", ")}` });
      const person = url.searchParams.get("person") || undefined;
      const team = url.searchParams.get("team") || undefined;
      if (person && team) return sendJson(res, 400, { error: "give person or team, not both" });
      const found = await searchFiltered(query, {
        evidence: evidence.length ? (evidence as EvidenceFilter[]) : undefined,
        k: Math.min(50, Math.max(1, Number(url.searchParams.get("k") ?? 10) || 10)),
        kinds: kinds.length ? kinds : undefined,
        person,
        projectId: project ? Number(project) : undefined,
        since: url.searchParams.get("since") ?? undefined,
        team,
        until: url.searchParams.get("until") ?? url.searchParams.get("asOf") ?? undefined,
      });
      if ((person || team) && !found.who) return sendJson(res, 400, { error: found.note });
      // Each hit says what its source is backed by (src/knowledge/retrieval.ts); ranking is unchanged. Still a plain
      // array, which every client reads; a note about a filter goes in a header so the shape does not change.
      if (found.note) res.setHeader("X-Search-Note", found.note);
      return sendJson(res, 200, found.hits);
    }

    // /api/data-events — the deletion and retention audit trail (ids, names and counts, never content).
    if (m === "GET" && seg[1] === "data-events" && seg.length === 2) {
      return sendJson(res, 200, store.listDataEvents(Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100)), url.searchParams.get("kind") ?? undefined));
    }

    // /api/overview — everything installed, read-only, with the prune list (src/overview.ts).
    if (m === "GET" && seg[1] === "overview" && seg.length === 2) return sendJson(res, 200, overview());

    // /api/study — the Study screen (src/study/review.ts). Topics with their due counts and
    // curriculum, the due cards (question only: the answer is never sent before a recall),
    // and a review that grades the typed recall exactly as `study_cards review` does in chat.
    if (seg[1] === "study") {
      if (m === "GET" && seg.length === 2) return sendJson(res, 200, studyOverview());
      if (m === "GET" && seg.length === 3 && seg[2] === "due") {
        const topic = url.searchParams.get("topic");
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
        return sendJson(res, 200, dueForScreen(topic ? Number(topic) : undefined, limit));
      }
      // Meeting question candidates: accept (with optional edits) into a card, or dismiss.
      if (m === "POST" && seg.length === 5 && seg[2] === "questions" && (seg[4] === "accept" || seg[4] === "dismiss")) {
        const qid = Number(seg[3]);
        if (seg[4] === "dismiss") {
          const ok = dismissQuestion(qid);
          return sendJson(res, ok ? 200 : 404, { ok });
        }
        const b = await readBody(req);
        try {
          return sendJson(res, 200, acceptQuestion(qid, {
            answer: typeof b.answer === "string" ? b.answer : undefined,
            question: typeof b.question === "string" ? b.question : undefined,
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return sendJson(res, msg.startsWith("no question") ? 404 : 400, { error: msg });
        }
      }
      if (m === "POST" && seg.length === 5 && seg[2] === "cards" && seg[4] === "review") {
        const b = await readBody(req);
        try {
          return sendJson(res, 200, await reviewWithRecall(Number(seg[3]), b.answer));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // A model that gave no usable grade is transient. The card is untouched, so retrying is safe.
          return sendJson(res, msg.startsWith("no such card") ? 404 : 503, { error: msg });
        }
      }
    }

    // /api/recipes — named recipes (src/recipes). List, edit and delete, from the dashboard
    // only. There's no POST: a recipe is created by recipe_save in a chat, where its whole
    // text goes through the approval card. Editing one here is a person at the keyboard,
    // which is the same trust.
    if (seg[1] === "recipes") {
      if (m === "GET" && seg.length === 2) return sendJson(res, 200, listRecipes());
      if (m === "PATCH" && seg.length === 3) {
        const b = await readBody(req);
        try {
          return sendJson(res, 200, updateRecipe(Number(seg[2]), { name: b.name, steps: b.steps, when: b.when }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return sendJson(res, msg.startsWith("no recipe") ? 404 : 400, { error: msg });
        }
      }
      if (m === "DELETE" && seg.length === 3) {
        const removed = deleteRecipe(Number(seg[2]));
        return sendJson(res, removed ? 200 : 404, { id: Number(seg[2]), removed });
      }
    }

    // /api/styles — writing styles (src/styles). A style is written here by a person (a hand edit, or
    // Accept on a proposal the learner built from sent mail). No tool reaches any of this: style_learn
    // can only park a proposal, and never sees or returns the note.
    if (seg[1] === "styles" && seg.length === 2 && m === "GET")
      return sendJson(res, 200, {
        defaultStyle: styleStore.getDefaultStyle(),
        proposals: styleStore.listProposals().map((p) => ({ ...p, replaces: !!styleStore.getStyle(p.name) })),
        styles: styleStore.listStyles(),
      });
    if (seg[1] === "styles" && seg.length === 3) {
      if (m === "PUT") {
        const b = await readBody(req);
        const r = styleStore.saveStyle(seg[2], String(b?.note ?? ""), styleStore.normaliseAppliesTo(b?.appliesTo), Number(b?.sampled ?? 0));
        return "error" in r ? sendJson(res, 400, r) : sendJson(res, 200, r.ok);
      }
      if (m === "DELETE") {
        const removed = styleStore.deleteStyle(seg[2]);
        return sendJson(res, removed ? 200 : 404, { name: seg[2], removed });
      }
    }
    if (seg[1] === "style-default" && seg.length === 2 && m === "PUT") {
      const r = styleStore.setDefaultStyle(String((await readBody(req))?.name ?? ""));
      return "error" in r ? sendJson(res, 400, r) : sendJson(res, 200, { defaultStyle: r.ok });
    }
    if (seg[1] === "style-proposals" && seg.length >= 3) {
      if (m === "POST" && seg[3] === "accept") {
        const r = styleStore.acceptProposal(seg[2]);
        return "error" in r ? sendJson(res, 404, r) : sendJson(res, 200, r);
      }
      if (m === "DELETE" && seg.length === 3) {
        const removed = styleStore.rejectProposal(seg[2]);
        return sendJson(res, removed ? 200 : 404, { name: seg[2], removed });
      }
    }

    // /api/policy
    if (m === "GET" && seg[1] === "policy" && seg.length === 2) return sendJson(res, 200, loadPolicy());

    // GET /api/cloud-usage — cloud tokens against the caps (src/cloud-cap.ts). Read-only on
    // purpose: the caps are numbers in `.env`, so no screen can raise the limit it is showing.
    if (m === "GET" && seg[1] === "cloud-usage" && seg.length === 2) return sendJson(res, 200, cloudUsage());

    /**
     * /api/proposals — auto-approval proposals from the ledger (LEARNING Phase 2).
     *
     * A GET lists them; a POST applies one, which is the ONLY path that writes an
     * autoApprove entry to policy.json. Both sit behind the dashboard token like every
     * other /api route. The agent cannot reach this — promotionProposals reads the ledger
     * and no tool exposes it, which is invariant 1: the model never widens its own grants.
     */
    if (seg[1] === "proposals" && seg.length === 2) {
      if (m === "GET") {
        return sendJson(
          res,
          200,
          promotionProposals().map((p) => ({ ...p, diff: proposalDiff(p) })),
        );
      }
      if (m === "POST") {
        const b = await readBody(req);
        if (!b?.tool) return sendJson(res, 400, { error: "tool is required" });
        const result = applyProposal(String(b.tool), String(b.target ?? ""));
        return sendJson(res, result.ok ? 200 : 409, result);
      }
    }

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
     * /api/voice — hands-free: wake word in, spoken reply out.
     *
     * The session logic lives in the browser (see web/src/hooks/useVoiceSession.ts); these are
     * the three things it needs from here. The wake word and its aliases arrive per request,
     * from the browser's own saved settings, so changing them in Settings takes effect on the
     * next utterance with nothing to restart.
     */
    if (seg[1] === "voice") {
      if (m === "GET" && seg.length === 2) return sendJson(res, 200, await voiceStatus());

      // POST /api/voice/listen?mode=wake|turn&wake=Gianna&aliases=Jana,Joanna — raw audio body.
      if (m === "POST" && seg.length === 3 && seg[2] === "listen") {
        if (!DICTATION_ENABLED) return sendJson(res, 403, { error: "DICTATION_ENABLED is false" });
        const wake = (url.searchParams.get("wake") ?? "").trim();
        if (!wake) return sendJson(res, 400, { error: "no wake word given" });
        const aliases = (url.searchParams.get("aliases") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
        try {
          const audio = await readBinary(req, DICTATION_MAX_BYTES);
          if (!audio.length) return sendJson(res, 400, { error: "no audio received" });
          const type = String(req.headers["content-type"] ?? "");
          const sounds = url.searchParams.get("sounds") === "1";
          return sendJson(
            res,
            200,
            url.searchParams.get("mode") === "turn"
              ? await listenForTurn(audio, type, wake, aliases, sounds)
              : await listenForWake(audio, type, wake, aliases, sounds),
          );
        } catch (err) {
          return sendJson(res, err instanceof TooLargeError ? 413 : 400, { error: (err as Error).message });
        }
      }

      // POST /api/voice/plan {text} — what to say, cleaned and cut into pieces to synthesise in turn.
      if (m === "POST" && seg.length === 3 && seg[2] === "plan") {
        const body = (await readBody(req)) as { text?: string };
        return sendJson(res, 200, { chunks: planSpeech(body.text ?? "") });
      }

      // POST /api/voice/speak {text, voice?} — WAV bytes back, for one piece from /plan.
      if (m === "POST" && seg.length === 3 && seg[2] === "speak") {
        try {
          const body = (await readBody(req)) as { text?: string; voice?: string };
          if (!body.text?.trim()) return sendJson(res, 400, { error: "text required" });
          const wav = await speak(body.text, body.voice);
          res.writeHead(200, { "Cache-Control": "no-store", "Content-Length": wav.length, "Content-Type": "audio/wav" });
          return void res.end(wav);
        } catch (err) {
          const message = (err as Error).message;
          return sendJson(res, message === "nothing to read aloud" ? 422 : 502, { error: message });
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
       * POST /api/meetings/import?name=&title=&project=&started=&speakers= — a recording made
       * elsewhere (Voice Memos on the phone), as the raw request body. Any format ffmpeg reads.
       * Answers 202 once it's decoded and the meeting exists. Transcription is queued, and its
       * progress arrives on the meeting stream like a live meeting's final pass.
       */
      if (m === "POST" && seg.length === 3 && seg[2] === "import") {
        let bytes: Buffer;
        try {
          bytes = await readBinary(req, MEETING_IMPORT_MAX_BYTES);
        } catch (err) {
          return sendJson(res, err instanceof TooLargeError ? 413 : 400, { error: (err as Error).message });
        }
        if (!bytes.length) return sendJson(res, 400, { error: "send the recording as the request body" });
        const project = Number(url.searchParams.get("project"));
        const speakers = Number(url.searchParams.get("speakers"));
        try {
          const { meetingId } = await meetings.importRecording(bytes, {
            name: url.searchParams.get("name") ?? "recording",
            projectId: Number.isInteger(project) && project > 0 ? project : null,
            speakers: Number.isInteger(speakers) && speakers > 0 && speakers <= 20 ? speakers : undefined,
            started: url.searchParams.get("started") ?? undefined,
            title: url.searchParams.get("title") ?? undefined,
          });
          return sendJson(res, 202, { meetingId, started: true });
        } catch (err) {
          const msg = (err as Error).message;
          return sendJson(res, msg.startsWith("a meeting is recording") ? 409 : 400, { error: msg });
        }
      }

      /**
       * POST /api/meetings/remote {source, projectId?, title?} — start a meeting whose audio a
       * client sends itself (the Mac app's microphone). `source` must be in
       * policy.audio.remoteSources. Answers 201 {meetingId, nextSeq: 0}; send chunks next.
       */
      if (m === "POST" && seg.length === 3 && seg[2] === "remote") {
        const b = await readBody(req);
        if (!b?.source) return sendJson(res, 400, { error: "source is required" });
        try {
          const started = await meetings.startRemoteMeeting(loadPolicy(), {
            projectId: b.projectId == null ? null : Number(b.projectId),
            source: String(b.source),
            title: b.title ? String(b.title) : undefined,
          });
          return sendJson(res, 201, started);
        } catch (err) {
          const message = (err as Error).message;
          return sendJson(res, message.startsWith("denied:") ? 403 : 409, { error: message });
        }
      }

      /**
       * POST /api/meetings/:id/chunks?seq=N — the next piece of a remote meeting's audio, as the
       * raw request body: 16 kHz mono signed 16-bit little-endian PCM, a few seconds at a time.
       * Numbered from 0 and applied strictly in order; a repeat is acknowledged and ignored, a
       * gap is refused with the number wanted. Every answer carries `next`, so a client that
       * lost its place (dropped connection, lost response) resumes from there.
       */
      if (m === "POST" && seg.length === 4 && seg[3] === "chunks") {
        let pcm: Buffer;
        try {
          pcm = await readBinary(req, meetings.REMOTE_CHUNK_MAX_BYTES);
        } catch (err) {
          return sendJson(res, err instanceof TooLargeError ? 413 : 400, { error: (err as Error).message });
        }
        try {
          return sendJson(res, 200, meetings.ingestChunk(Number(seg[2]), Number(url.searchParams.get("seq")), pcm));
        } catch (err) {
          if (err instanceof meetings.ChunkSequenceError) return sendJson(res, 409, { error: err.message, next: err.next });
          const message = (err as Error).message;
          return sendJson(res, message.startsWith("that meeting is not recording") ? 409 : 400, { error: message });
        }
      }

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

      // /api/meetings/tags — every tag in use, with counts
      if (m === "GET" && seg.length === 3 && seg[2] === "tags") return sendJson(res, 200, meetingStore.allTags());

      // GET /api/meetings?tag=a,b&since=ISO — `tag` takes a comma list; a meeting must have all
      if (m === "GET" && seg.length === 2) {
        const projectId = url.searchParams.get("project");
        const tag = url.searchParams.get("tag");
        return sendJson(
          res,
          200,
          meetingStore.findMeetings({
            limit: Number(url.searchParams.get("limit") ?? 50),
            projectId: projectId === null ? undefined : Number(projectId),
            since: url.searchParams.get("since") ?? undefined,
            tags: tag ? tag.split(",") : [],
          }),
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
          chat: meetingStore.listChat(id),
          segments: meetingStore.segments(id, pass),
          speakers: meetingStore.speakers(id),
          workItems: meetingStore.workItems(id),
          // Questions you were asked, as study candidates awaiting review (src/study/meeting-questions.ts).
          questions: listQuestions(id),
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
      // GET /api/meetings/:id/coach — the pollable half of the coach, for clients that cannot
      // hold the event stream. { thinking, answer } where answer is null until one arrives.
      if (m === "GET" && seg.length === 4 && seg[3] === "coach") {
        const id = Number(seg[2]);
        if (!meetingStore.getMeeting(id)) return sendJson(res, 404, { error: "no such meeting" });
        return sendJson(res, 200, meetings.coachState(id));
      }

      // GET /api/meetings/:id/chat — the saved thread, oldest first
      if (m === "GET" && seg.length === 4 && seg[3] === "chat") {
        const id = Number(seg[2]);
        if (!meetingStore.getMeeting(id)) return sendJson(res, 404, { error: "no such meeting" });
        return sendJson(res, 200, meetingStore.listChat(id));
      }
      // POST /api/meetings/:id/chat {question} — ask the in-meeting assistant. Returns once the
      // question is stored; the answer arrives on the event stream like the coach's does.
      if (m === "POST" && seg.length === 4 && seg[3] === "chat") {
        const id = Number(seg[2]);
        if (!MEETING_COACH_ENABLED) return sendJson(res, 403, { error: "MEETING_COACH_ENABLED is false" });
        if (!meetingStore.getMeeting(id)) return sendJson(res, 404, { error: "no such meeting" });
        const b = await readBody(req);
        const question = typeof b.question === "string" ? b.question.trim() : "";
        if (!question) return sendJson(res, 400, { error: "question is required" });
        if (question.length > 500) return sendJson(res, 400, { error: "question is over 500 characters" });
        const result = meetings.askChat(id, question);
        return result.busy
          ? sendJson(res, 429, { error: "already working on the last one" })
          : sendJson(res, 202, result.message);
      }
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

      // POST /api/meetings/:id/reprocess — re-make the final transcript from kept audio.
      // Body: { speakers?: number } pins the head count. 404 when no audio is kept.
      if (m === "POST" && seg.length === 4 && seg[3] === "reprocess") {
        const b = await readBody(req);
        if (!meetingStore.getMeeting(id)) return sendJson(res, 404, { error: "no such meeting" });
        const n = Number(b?.speakers ?? 0);
        const r = await meetings.reprocessMeeting(id, { speakers: Number.isInteger(n) && n > 0 && n <= 20 ? n : 0 });
        return r.ok ? sendJson(res, 200, { started: true }) : sendJson(res, 409, { error: r.reason });
      }

      // POST /api/meetings/:id/questions — look (again) for questions put to you. Synchronous:
      // a few local calls, and the answer is the list the page shows. A gap (no project,
      // nobody named "me") comes back as 409 with the reason, which the page shows as is.
      if (m === "POST" && seg.length === 4 && seg[3] === "questions") {
        if (!meetingStore.getMeeting(id)) return sendJson(res, 404, { error: "no such meeting" });
        try {
          const r = await findMeetingQuestions(id);
          if (r.reason) return sendJson(res, 409, { error: r.reason });
          return sendJson(res, 200, { ...r, questions: listQuestions(id) });
        } catch (err) {
          return sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // DELETE /api/meetings/:id — remove a meeting and everything derived from it (409 while
      // it is still being recorded or processed).
      if (m === "DELETE" && seg.length === 3) {
        const r = meetings.deleteMeeting(id);
        if (r.ok) return sendJson(res, 200, { deleted: true, rejectedItems: r.rejectedItems });
        return sendJson(res, r.reason === "no such meeting" ? 404 : 409, { error: r.reason });
      }

      // DELETE /api/meetings/:id/audio — delete the kept recording now.
      if (m === "DELETE" && seg.length === 4 && seg[3] === "audio") {
        if (!meetingStore.getMeeting(id)) return sendJson(res, 404, { error: "no such meeting" });
        const deleted = deleteAudio(id);
        if (deleted) store.logDataEvent("meeting_audio_deleted", `meeting #${id}`, "the kept recording was deleted on request");
        return sendJson(res, 200, { deleted });
      }

      // The one-step close-out (K5). GET reads it, .../preview shows how the briefs would change and writes nothing,
      // and POST saves it all or none. Filing into the project index runs after the save, because it cannot roll back.
      if (seg[3] === "closeout") {
        try {
          if (m === "GET" && seg.length === 4) {
            const raw = url.searchParams.get("project");
            const state = closeoutState(id, raw === null ? undefined : raw === "" ? null : Number(raw));
            return state ? sendJson(res, 200, state) : sendJson(res, 404, { error: "no such meeting" });
          }
          if (m === "POST" && seg.length === 5 && seg[4] === "preview") {
            return sendJson(res, 200, previewCloseout(id, parsePlan(await readBody(req))));
          }
          if (m === "POST" && seg.length === 4) {
            const b = await readBody(req);
            const saved = closeMeeting(id, parsePlan(b));
            let filingError: null | string = null;
            if (saved.projectChanged && saved.projectId) {
              try {
                await meetings.indexIntoProject(id, saved.projectId, typeof b.keepTranscript === "boolean" ? b.keepTranscript : undefined);
                fileQueuedItems(id, saved.projectId);
              } catch (err) {
                filingError = err instanceof Error ? err.message : String(err);
              }
            }
            return sendJson(res, 200, { ...saved, filingError });
          }
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // PATCH /api/meetings/:id/speakers — name a speaker ("Speaker 2" → "Priya"). An empty
      // name puts it back. Applies to the transcript view and to any later extraction.
      if (m === "PATCH" && seg.length === 4 && seg[3] === "speakers") {
        const b = await readBody(req);
        if (!meetingStore.getMeeting(id)) return sendJson(res, 404, { error: "no such meeting" });
        const index = Number(b?.index);
        if (!Number.isInteger(index) || index < 0 || typeof b?.name !== "string")
          return sendJson(res, 400, { error: "index and name required" });
        meetingStore.setSpeakerName(id, index, b.name);
        return sendJson(res, 200, meetingStore.speakers(id));
      }

      // PATCH /api/meetings/:id — retitle, or file it under a project after the fact
      if (m === "PATCH" && seg.length === 3) {
        const b = await readBody(req);
        const meeting = meetingStore.getMeeting(id);
        if (!meeting) return sendJson(res, 404, { error: "no such meeting" });
        // Checked before anything changes: filing under a bad id would carry the index copies out of reach.
        if (b && "projectId" in b && b.projectId != null && !projects.getProject(Number(b.projectId)))
          return sendJson(res, 400, { error: "no such project" });
        if (typeof b?.title === "string") meetingStore.setTitle(id, b.title);
        if (Array.isArray(b?.tags)) meetingStore.setTags(id, b.tags.map(String));
        if (b && "projectId" in b) {
          const projectId = b.projectId == null ? null : Number(b.projectId);
          meetingStore.fileMeeting(id, projectId);
          knowledge.setSourceProject("meeting", `meeting:${id}`, projectId);
          // Assigning a project is what files the transcript into that project's index.
          // Doing it here rather than only at stop() is the whole point of assign-after —
          // you often don't know which project a meeting was about until it's over.
          if (projectId && meeting.status === "done")
            await meetings.indexIntoProject(id, projectId, typeof b.keepTranscript === "boolean" ? b.keepTranscript : undefined);
          // Items already waiting in Approvals move onto the project's task list.
          if (projectId) fileQueuedItems(id, projectId);
        } else if (typeof b?.keepTranscript === "boolean") {
          // Changing the choice for a meeting that is already filed replaces what the project holds.
          if (meeting.project_id != null && meeting.status === "done") await meetings.indexIntoProject(id, meeting.project_id, b.keepTranscript);
          else meetingStore.setKeepTranscript(id, b.keepTranscript);
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
        if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
        if (typeof b.instructions === "string") patch.instructions = b.instructions;
        // Stored as given; `narrowPolicy` is what guarantees it can only ever restrict, so
        // there is nothing to validate away here — an overlay asking for more simply
        // doesn't get it at run time.
        if ("policyOverlay" in b) patch.policyOverlay = b.policyOverlay ?? null;
        // Trusting a file is a privilege (it joins the system context of every run in the project),
        // so it is checked here and again each time it is read. Clearing it needs no check.
        if ("instructionsFile" in b) {
          if (b.instructionsFile == null || b.instructionsFile === "") patch.instructionsFile = null;
          else {
            const check = checkWorkspaceFile(id, String(b.instructionsFile), loadPolicy());
            if (!check.ok) return sendJson(res, 400, { error: check.reason });
            patch.instructionsFile = check.real;
          }
        }
        // K7: this project's own raw-transcript window. null clears it; 0 keeps transcripts until the meeting
        // is deleted. A whole number of days, capped at ten years, so a typo cannot read as "forever".
        if ("transcriptRetentionDays" in b) {
          if (b.transcriptRetentionDays == null || b.transcriptRetentionDays === "") patch.transcriptRetentionDays = null;
          else {
            const d = Number(b.transcriptRetentionDays);
            if (!Number.isInteger(d) || d < 0 || d > 3650) return sendJson(res, 400, { error: "transcriptRetentionDays must be a whole number of days from 0 to 3650, or null" });
            patch.transcriptRetentionDays = d;
          }
        }
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

    // /api/clients , /api/time — the light client list and time tracker (src/clients).
    if (seg[1] === "clients") {
      if (m === "GET" && seg.length === 2) return sendJson(res, 200, listClients(url.searchParams.get("status") ?? "all"));
      if (m === "POST" && seg.length === 2) {
        const b = await readBody(req);
        if (!String(b.name ?? "").trim()) return sendJson(res, 400, { error: "name required" });
        let due: null | string | undefined;
        if (b.nextActionDue !== undefined) {
          due = b.nextActionDue ? parseWhen(b.nextActionDue) : null;
          if (b.nextActionDue && !due) return sendJson(res, 400, { error: "could not read that due time" });
        }
        return sendJson(res, 200, upsertClient(String(b.name), { email: b.email, nextAction: b.nextAction, nextActionDue: due, note: b.note, status: b.status }));
      }
      if (m === "DELETE" && seg.length === 3) return sendJson(res, 200, { ok: deleteClient(Number(seg[2])) });
    }
    if (m === "GET" && seg[1] === "time" && seg.length === 2) {
      const days = Number(url.searchParams.get("days") ?? 30) || 30;
      return sendJson(res, 200, {
        entries: listTime(days),
        totals: timeReport(days).map((t) => ({ ...t, label: fmtMinutes(t.minutes) })),
      });
    }

    // /api/search?q= — across every conversation: titles, questions, and answers.
    if (m === "GET" && seg[1] === "search" && seg.length === 2) {
      const q = String(url.searchParams.get("q") ?? "").trim();
      if (q.length < 2) return sendJson(res, 200, []);
      const clip = (t: string, n: number) => t.replace(/\s+/g, " ").trim().slice(0, n);
      const hits = store.searchRuns(q, { limit: 40 }).map((r: any) => {
        const note = String(r.note ?? "");
        const word = (q.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])[0] ?? "";
        const at = Math.max(0, note.toLowerCase().indexOf(word) - 60);
        return {
          conversationId: r.conversationId,
          conversationTitle: r.conversationTitle,
          finished: r.finished,
          runId: r.id,
          snippet: clip(note.slice(at, at + 220), 220),
          task: clip(String(r.task ?? ""), 140),
        };
      });
      return sendJson(res, 200, hits);
    }

    /**
     * POST /api/runs/:id/stop — the user no longer wants this turn. 202, because the run ends
     * at its next safe point (src/stop.ts), not inside this request; the stream's run_end with
     * status "stopped" is what tells the client it is over. A run already finished is a 409,
     * so a late tap cannot relabel an answer that arrived first.
     */
    if (m === "POST" && seg[1] === "runs" && seg.length === 4 && seg[3] === "stop") {
      const run = store.getRun(Number(seg[2]));
      if (!run) return sendJson(res, 404, { error: "no such run" });
      if (run.finished) return sendJson(res, 409, { error: "that turn has already finished", status: run.status });
      requestStop(run.id);
      return sendJson(res, 202, { ok: true });
    }

    // /api/starred, POST /api/runs/:id/star {starred}
    if (m === "GET" && seg[1] === "starred" && seg.length === 2) return sendJson(res, 200, store.starredRuns(100));
    if (m === "POST" && seg[1] === "runs" && seg.length === 4 && seg[3] === "star") {
      const b = await readBody(req);
      const ok = store.setRunStarred(Number(seg[2]), b.starred !== false);
      return sendJson(res, ok ? 200 : 404, { ok, starred: b.starred !== false });
    }

    // /api/files — what the assistant has written for you (src/deliverables.ts).
    if (seg[1] === "files") {
      if (m === "GET" && seg.length === 2) return sendJson(res, 200, listDeliverables(500));

      // GET /api/files/content?path= — only paths in the ledger are served, whatever the policy
      // says about the folder around them.
      if (m === "GET" && seg.length === 3 && seg[2] === "content") {
        const file = String(url.searchParams.get("path") ?? "");
        if (!isDeliverable(file) || !fs.existsSync(file)) return sendJson(res, 404, { error: "no such file" });
        const raw = fs.readFileSync(file, "utf8");
        return sendJson(res, 200, { path: file, text: raw.slice(0, 200_000), truncated: raw.length > 200_000 });
      }

      // POST /api/files/save {runId, name, projectId?} — save one reply as a file, in the
      // project's folder or docs/. The "Save to file" button; same gates as write_file.
      if (m === "POST" && seg.length === 3 && seg[2] === "save") {
        const b = await readBody(req);
        const run = store.getRun(Number(b.runId));
        if (!run || !String(run.note ?? "").trim()) return sendJson(res, 404, { error: "that reply has no text to save" });
        let name = path.basename(String(b.name ?? "").trim() || `reply-${run.id}.md`);
        if (!WRITE_EXTENSIONS.includes(path.extname(name).toLowerCase())) name += ".md";
        const dir = projectWriteDir(b.projectId ?? null) ?? path.join(BASE, "docs");
        const args = { from_run: run.id, path: path.join(dir, name) };
        const policy = loadPolicy();
        const gate = writeFile.checkPolicy(policy, args);
        if (!gate.allowed) return sendJson(res, 403, { error: gate.reason });
        const out = await writeFile.run(args, { policy, runId: run.id });
        return sendJson(res, 200, { message: out, path: args.path });
      }
    }

    // /api/checkin — the check-in (src/checkin, PLAN-open-work section 12 D1). `preview` reads and
    // writes nothing, and works with the mode off. `run` is "Check now": it records and, in push
    // mode, sends, so it is a POST and is not the dry run.
    if (seg[1] === "checkin") {
      if (m === "GET" && seg.length === 2)
        return sendJson(res, 200, {
          intervalHours: CHECKIN_INTERVAL_HOURS,
          lastError: checkinStore.lastError(),
          lastRun: checkinStore.lastRun(),
          mode: CHECKIN_MODE,
          pushDetail: CHECKIN_PUSH_DETAIL,
          runs: checkinStore.listRuns(Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20))),
        });
      if (m === "GET" && seg.length === 3 && seg[2] === "preview") return sendJson(res, 200, await previewCheckin());
      if (m === "POST" && seg.length === 3 && seg[2] === "run") return sendJson(res, 200, await runCheckin(new Date(), { force: true }));
    }

    // /api/headsups — proactive suggestions (src/headsup, docs/archive/PLAN-heads-up.md).
    if (seg[1] === "headsups") {
      if (m === "GET" && seg.length === 2)
        return sendJson(
          res,
          200,
          headsupLedger.listForClient(url.searchParams.get("state") === "all" ? "all" : "open"),
        );
      // Dates you told it about, and dates it noticed in chat and is waiting for you to confirm.
      if (m === "GET" && seg.length === 3 && seg[2] === "dates") return sendJson(res, 200, headsupDates.datesForClient());
      // Preferences: which kinds, the daily cap, quiet hours. Plus read-only facts about what cannot run yet.
      if (seg.length === 3 && seg[2] === "prefs") {
        if (m === "GET") return sendJson(res, 200, prefsForClient());
        if (m === "POST") {
          const r = updatePrefs(await readBody(req));
          return r.ok ? sendJson(res, 200, prefsForClient()) : sendJson(res, 400, { error: r.error });
        }
      }
      if (m === "DELETE" && seg.length === 4 && seg[2] === "dates")
        return headsupDates.deleteDate(Number(seg[3]))
          ? sendJson(res, 200, { ok: true })
          : sendJson(res, 404, { error: "no such remembered date" });
      // What a run would offer right now. Reads the calendars, writes nothing.
      if (m === "GET" && seg.length === 3 && seg[2] === "preview") {
        const plan = await planMorning().catch((err) => ({
          deferred: 0,
          errors: [err instanceof Error ? err.message : String(err)],
          offers: [],
        }));
        return sendJson(res, 200, {
          deferred: plan.deferred,
          errors: plan.errors,
          offers: plan.offers.map((o) => ({
            daysUntil: o.candidate.daysUntil,
            kind: o.candidate.kind,
            reason: o.reason,
            subject: o.candidate.subject,
          })),
        });
      }
      // Run the morning job now, ignoring "already ran today". Still honors quiet hours.
      if (m === "POST" && seg.length === 3 && seg[2] === "run")
        return sendJson(res, 200, await runMorningHeadsup(new Date(), { force: true }));
      if (m === "POST" && seg.length === 4 && seg[3] === "answer") {
        const b = await readBody(req);
        const a = String(b?.answer ?? "");
        if (a !== "yes" && a !== "later" && a !== "never")
          return sendJson(res, 400, { error: 'answer must be "yes", "later" or "never"' });
        const row = headsupLedger.answer(Number(seg[2]), a, new Date());
        // Yes on a birthday or an anniversary is also "go and look": research runs in the background
        // and the result appears on the page. Anything else has nothing to look up.
        if (row && a === "yes") {
          const action = headsupLedger.toView(row).yesAction;
          if (action === "research") startResearch(row.id);
          // Yes on a flight, or on an appointment with a place, starts a watch. That press is the
          // consent: it is a person in the app, not a scan deciding to create standing work.
          else if (action === "watch") enableWatch(row);
        }
        return row ? sendJson(res, 200, headsupLedger.toView(row)) : sendJson(res, 404, { error: "no such heads-up" });
      }
      // Run the research again (it failed, or the prices are stale). Waits for it, so the page can show the result.
      if (m === "POST" && seg.length === 4 && seg[3] === "research") {
        const row = headsupLedger.getById(Number(seg[2]));
        if (!row) return sendJson(res, 404, { error: "no such heads-up" });
        if (!RESEARCH_KINDS.has(row.kind)) return sendJson(res, 400, { error: "nothing to research for this kind" });
        return sendJson(res, 200, await researchHeadsup(row.id));
      }
      // A cached product photo. Only ever bytes we sniffed as JPEG/PNG/GIF/WebP, served inert.
      if (m === "GET" && seg.length === 4 && seg[2] === "images") {
        const img = readImage(Number(seg[3]));
        if (!img) return sendJson(res, 404, { error: "no such image" });
        res.writeHead(200, {
          "Cache-Control": "private, max-age=86400",
          "Content-Length": img.bytes.length,
          "Content-Security-Policy": "default-src 'none'",
          "Content-Type": img.mime,
          "X-Content-Type-Options": "nosniff",
        });
        res.end(img.bytes);
        return;
      }
    }

    // /api/tasks ... — the assistant's own to-do list and follow-ups (src/tasks).
    if (seg[1] === "tasks") {
      if (m === "GET" && seg.length === 2) {
        const st = url.searchParams.get("status") ?? "open";
        const pid = Number(url.searchParams.get("projectId"));
        return sendJson(
          res,
          200,
          listTasks({
            limit: 300,
            projectId: Number.isInteger(pid) && pid > 0 ? pid : undefined,
            status: (["open", "done", "dropped", "all"].includes(st) ? st : "open") as any,
          }),
        );
      }
      if (m === "POST" && seg.length === 2) {
        const b = await readBody(req);
        if (!String(b.title ?? "").trim()) return sendJson(res, 400, { error: "title required" });
        let due: null | string = null;
        if (b.due) {
          due = parseWhen(b.due);
          if (!due) return sendJson(res, 400, { error: `could not read the due time ${JSON.stringify(b.due)}` });
        }
        const id = addTask({
          clientId: b.clientId ?? null,
          due,
          kind: b.kind === "followup" ? "followup" : "task",
          notes: b.notes ?? null,
          projectId: b.projectId ?? null,
          title: String(b.title),
          waitingOn: b.waitingOn ?? null,
        });
        return sendJson(res, 200, getTask(id));
      }
      if (m === "PATCH" && seg.length === 3) {
        const b = await readBody(req);
        const id = Number(seg[2]);
        if (!getTask(id)) return sendJson(res, 404, { error: "no such task" });
        const patch: any = {};
        for (const k of ["title", "notes", "status", "waitingOn"]) if (k in b) patch[k] = b[k];
        if ("projectId" in b) {
          const pid = b.projectId == null ? null : Number(b.projectId);
          if (pid !== null && !projects.getProject(pid)) return sendJson(res, 400, { error: "no such project" });
          patch.projectId = pid;
        }
        if ("due" in b) {
          if (!b.due) patch.due = null;
          else {
            patch.due = parseWhen(b.due);
            if (!patch.due) return sendJson(res, 400, { error: `could not read the due time ${JSON.stringify(b.due)}` });
          }
        }
        return sendJson(res, 200, updateTask(id, patch));
      }
      if (m === "DELETE" && seg.length === 3) return sendJson(res, 200, { ok: deleteTask(Number(seg[2])) });
    }

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
          store.updateSchedule(Number(seg[2]), patch, "edit");
          return sendJson(res, 200, store.getSchedule(Number(seg[2])));
        } catch (e) {
          return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (m === "DELETE" && seg.length === 3) {
        store.deleteSchedule(Number(seg[2]));
        return sendJson(res, 200, { ok: true });
      }
      // A job's task history and its after-check (SL8).
      if (m === "GET" && seg.length === 4 && seg[3] === "versions") {
        const history = scheduleHistory(Number(seg[2]));
        return history ? sendJson(res, 200, history) : sendJson(res, 404, { error: "no such schedule" });
      }
      // Queues the earlier text for approval. It never changes the job itself.
      if (m === "POST" && seg.length === 6 && seg[3] === "versions" && seg[5] === "restore") {
        const result = queueRestore(Number(seg[2]), Number(seg[4]));
        return "error" in result ? sendJson(res, 400, result) : sendJson(res, 200, result);
      }
      if (m === "POST" && seg.length === 4 && seg[3] === "run") {
        const s = store.getSchedule(Number(seg[2]));
        if (!s) return sendJson(res, 404, { error: "no such schedule" });
        const r = await runTask(s.task, { kind: "schedule", scheduleId: s.id });
        return sendJson(res, 200, r);
      }
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

const prune = async (): Promise<void> => {
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
    const hu = pruneHeadsup();
    if (hu.cardSets + hu.watches + hu.ledger + hu.orphanFiles + hu.orphanImageRows)
      console.log(`pruned: heads-up ${hu.cardSets} card sets, ${hu.watches} watches, ${hu.ledger} ledger rows, ${hu.orphanFiles + hu.orphanImageRows} orphan images`);
    const outbox = pruneOutbox();
    if (outbox) console.log(`pruned: ${outbox} outbox rows`);
    // Transcripts run on their own, shorter window — see TRANSCRIPT_RETENTION_DAYS.
    const dropped = pruneSources(60);
    if (dropped) console.log(`pruned: ${dropped} fetched sources older than 60 days`);
    const audio = pruneAudio();
    if (audio) console.log(`pruned: ${audio} kept meeting recording(s) past their time`);
    const words = meetingStore.pruneTranscripts(TRANSCRIPT_RETENTION_DAYS);
    if (words) console.log(`pruned: ${words} meeting transcript segments past the retention window`);

    // Memories are bounded by count rather than age: a fact does not stop being true. Notes
    // had no ceiling at all until 2026-07-30, which is how 20 copies of one sentence came to
    // occupy every recall slot. `remember` now refuses duplicates, so this is the backstop
    // for what predates it and for near-misses that clear the similarity threshold.
    // Uploads nobody ever sent: picked a file, changed their mind, closed the tab.
    const unsent = sweepUnsentAttachments();
    if (unsent) console.log(`pruned: ${unsent} unsent attachment(s)`);
    // And images whose run the prune above just removed. Runs first, then this, so a run
    // pruned on this pass takes its photographs with it on the same pass rather than the
    // next one.
    const orphaned = sweepOrphanedAttachments();
    if (orphaned) console.log(`pruned: ${orphaned} image(s) whose run passed the retention window`);

    const collapsed = dedupeMemories();
    if (collapsed) console.log(`pruned: ${collapsed} duplicate memories`);
    if (NOTE_MEMORY_MAX > 0) {
      const notes = pruneMemories("note", NOTE_MEMORY_MAX);
      if (notes) console.log(`pruned: ${notes} note memories past the ${NOTE_MEMORY_MAX} ceiling`);
    }
  } catch (err) {
    console.error("prune failed:", err instanceof Error ? err.message : err);
  }

  // Fold idle chat threads into cross-conversation memory (no-op unless enabled). Separate
  // try/catch: a summariser failure must not stop the ledger prune above from having run.
  try {
    const summarised = await summarizeIdleConversations();
    if (summarised.length) console.log(`summarised ${summarised.length} idle conversation(s) into memory`);
  } catch (err) {
    console.error("conversation summary failed:", err instanceof Error ? err.message : err);
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

// --- the confirmation watchdog ---
/**
 * Nudge, escalate and expire questions nobody has answered. The logic is in
 * confirmations.ts; this is only the clock. Runs on boot as well as on the interval,
 * because the case it exists for — the Mini was asleep, or the process restarted
 * overnight — is exactly the one where the first sweep should not wait five minutes.
 */
const watchdog = async (): Promise<void> => {
  // The watched inbox folder rides the same clock: new files are taken in, and a failure to read it is logged.
  try {
    const added = await scanWatchDir();
    if (added) console.log(`inbox: took in ${added} file(s) from the watched folder`);
  } catch (err) {
    console.error("inbox scan error:", err instanceof Error ? err.message : err);
  }
  try {
    const r = await sweepConfirmations();
    if (r.reminded + r.escalated + r.expired > 0) {
      console.log(
        `watchdog: ${r.reminded} reminded, ${r.escalated} escalated, ${r.expired} expired`,
      );
    }
  } catch (err) {
    console.error("watchdog error:", err instanceof Error ? err.message : err);
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
// A cloud token cap that would silently count nothing (LLM_TIMING off, retention under a month,
// a typo read as unlimited) is worse than no cap, so refuse to start. See src/cloud-cap.ts.
const capProblem = capsProblem();
if (capProblem) {
  console.error(`Refusing to start: ${capProblem}`);
  process.exit(1);
}
const interrupted = store.markInterruptedRuns();
if (interrupted) console.log(`marked ${interrupted} interrupted run(s) as failed`);
// An approval that was mid-run when the process died is ended as an error and never re-run:
// whether the irreversible tool finished is unknowable, and running it again could double it.
const stuckApprovals = store.recoverInterruptedConfirmations();
if (stuckApprovals) console.log(`marked ${stuckApprovals} interrupted approval(s) as error (not re-run)`);
// A `recording` row can outlive the process that owned it. Left alone it would block every
// future capture, because one already claims the microphone.
const orphaned = meetingStore.reapOrphans();
if (orphaned) console.log(`marked ${orphaned} interrupted meeting(s) as abandoned`);
// MCP tools are discovered over the network, so they join the registry here and again every
// hour (a server can add tools, and policy.json can change). A server that is down is logged
// and skipped; it must never stop the dashboard starting.
const refreshMcp = async (): Promise<string[]> => {
  try {
    return await syncMcpTools(loadPolicy());
  } catch (err) {
    return [`refresh failed (${err instanceof Error ? err.message : String(err)})`];
  }
};
const mcpStatus = await refreshMcp();
setInterval(() => void refreshMcp(), 3_600_000).unref();
http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`agentspine dashboard API on http://${HOST}:${PORT}`);
  if (mcpStatus.length) console.log(`  mcp: ${mcpStatus.join("; ")}`);
  console.log(`  auth: ${TOKEN ? "token required on /api" : IS_LOCAL ? "none (localhost only)" : "NONE"}`);
  console.log(fs.existsSync(PUBLIC_DIR) ? "  serving static frontend from ./public" : "  API only (no ./public) — point your frontend here");
  console.log(`  scheduler: checking due jobs every ${SCHEDULER_TICK_MS / 1000}s`);
  console.log(
    `  watchdog: unanswered approvals re-pushed, then ${
      CONFIRM_EXPIRE_AFTER_MIN > 0 ? `expired after ${CONFIRM_EXPIRE_AFTER_MIN / 60}h` : "kept forever (expiry off)"
    }`,
  );
  console.log(`  tiers: ${describeTiers()}`);
  console.log(
    `  vision: ${
      visionConfigured()
        ? `${VISION_MODEL.replace(/^mlx-community\//, "")} — images attached to a message are read automatically`
        : "off (set VISION_LLM_URL to accept images)"
    }`,
  );
  // Which transports are actually live, and whether an approval can be answered from the
  // phone. Worth printing in full: every one of these failures is silent at the phone end.
  const transports = [
    ...(APNS_ENABLED ? [`APNs (${store.activeDevices().length} device(s) registered)`] : []),
    ...(NTFY_ENABLED ? ["ntfy"] : []),
  ];
  console.log(
    `  push: ${
      transports.length
        ? `${transports.join(" + ")}${
            remoteApprovalConfigured()
              ? ", Approve/Reject from the phone"
              : " (no DASHBOARD_PUBLIC_URL — ntfy pushes arrive without buttons)"
          }`
        : "off (Mac banners only — set NTFY_TOPIC, or see ios/README.md for the iPhone app)"
    }`,
  );
});
if (ensureMorningBrief()) console.log('  seeded a "Morning brief" schedule (weekdays 7:30am) — edit or delete it on the Schedules page');
runScheduler();
setInterval(runScheduler, SCHEDULER_TICK_MS);
// Due tasks and follow-ups become notifications.
void sweepDueTasks();
setInterval(() => void sweepDueTasks(), 60_000).unref();
// Messages the outbox held (quiet hours, the daily cap) go out as one summary once it is allowed.
const sweepOutbox = (): Promise<number> => releaseHeld((t, b, o) => notify(t, b, o));
setInterval(() => void sweepOutbox(), 5 * 60_000).unref();
// Sunday evening: one push saying the week's review is ready (src/outbox-review.ts).
// The same tick queues (never applies) a proposal to switch off a schedule you almost always skip; it asks
// at most once per schedule per 90 days, so running it every few minutes costs one query.
const sweepReview = (): Promise<boolean> => {
  proposeSchedulesOff();
  // Not awaited: a slow local model must not delay the review's own push. A no-op unless RETRO_ENABLED.
  void runRetro((t, b, o) => notify(t, b, o));
  return sendWeeklyReview((t, b, o) => notify(t, b, o));
};
setInterval(() => void sweepReview(), 5 * 60_000).unref();
// The morning heads-up: code-only, once a day, so a quiet morning costs one calendar read.
void sweepHeadsup();
setInterval(() => void sweepHeadsup(), 10 * 60_000).unref();
// The check-in: code-only too, and a no-op unless CHECKIN_MODE is "log" or "push". The tick is
// short so a check lands soon after quiet hours end; the four-hour interval is its own gate.
void sweepCheckin();
setInterval(() => void sweepCheckin(), 10 * 60_000).unref();
// Watched flights and drives. The tick is short; each watch has its own 30-minute floor, and outside
// its window a watch makes no call at all, so a quiet day costs nothing.
void sweepWatches();
setInterval(() => void sweepWatches(), 5 * 60_000).unref();
// The Instagram queue (docs/INSTAGRAM.md): code-only, and a no-op unless policy.json has an enabled
// `instagram` section. Even then it is a dry run that posts nothing until `publish` is exactly true.
// One minute, because a post's slot is a minute on a calendar and "one hour out" has a short window.
const sweepInstagram = async (): Promise<void> => {
  // loadPolicy is inside the try: a policy.json caught mid-edit must cost one tick, not the process.
  try {
    await instagramTick({ notify: (t, b, o) => notify(t, b, o), policy: loadPolicy() });
  } catch (err) {
    console.error("instagram sweep error:", err instanceof Error ? err.message : err);
  }
};
setInterval(() => void sweepInstagram(), 60_000).unref();
// Flash cards that have come due earn one nudge a day.
void sweepDueCards();
setInterval(() => void sweepDueCards(), 10 * 60_000).unref();
prune();
setInterval(prune, PRUNE_INTERVAL_MS).unref();
// Kept recordings are measured in hours, so they cannot wait for the daily prune.
pruneAudio();
setInterval(pruneAudio, 5 * 60_000).unref();
watchdog();
setInterval(watchdog, CONFIRM_SWEEP_MS).unref();
