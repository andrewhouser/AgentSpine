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
import { converterStatus } from "./projects/extract.ts";
import { indexProject, indexSource } from "./projects/ingest.ts";
import * as projects from "./projects/store.ts";
import { runTask, startTask } from "./runner.ts";
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
import "./memory/rag.ts"; // ensure the memories table exists for the queries below

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
