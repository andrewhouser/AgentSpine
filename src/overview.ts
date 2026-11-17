/**
 * The overview: everything installed in one read-only page, so you can see what to prune.
 *
 * Connectors, tools, memory, recipes, schedules, projects, study and the policy are spread
 * across five pages. This gathers them, and its real job is the **flags**: the schedule that
 * keeps failing, the tool that keeps erroring, the recipe nobody runs, the source that didn't
 * index, the memory kind at its cap. Each flag points to the page where you'd fix or delete
 * the thing.
 *
 * Deliberately not a cockpit: no live agent view, no animation, nothing that refreshes on its
 * own. And read-only: nothing here changes state, so the page carries no new power.
 *
 * The flags are computed by `flagsFrom`, a pure function of the gathered data and the clock,
 * so the rules are testable without a database. Every threshold is a named constant below.
 */
import fs from "node:fs";

import {
  APNS_ENABLED,
  CLOUD_ENABLED,
  EMBEDDINGS_URL,
  FAST_BASE_URL,
  GOOGLE_TOKEN_PATH,
  IMAGE_BASE_URL,
  LESSON_MEMORY_MAX,
  loadPolicy,
  LOCAL_BASE_URL,
  NTFY_ENABLED,
  RECIPE_MEMORY_MAX,
  REFLECT_MEMORY_MAX,
  TAVILY_API_KEY,
  TTS_BASE_URL,
  VISION_ENABLED,
} from "./config.ts";
import { rawDb } from "./memory/store.ts";
import * as store from "./memory/store.ts";
import { listProjects, listSources } from "./projects/store.ts";
import { listRecipes } from "./recipes/store.ts";
import { countDue, listTopics } from "./study/store.ts";
import { tools as registry } from "./tools/index.ts";

/** A schedule whose last this-many runs all failed is flagged. */
export const FAILING_RUNS = 3;
/** A tool with at least this many errors in the last week is flagged. */
export const TOOL_ERRORS_WEEK = 3;
/** A named recipe never used this many days after saving is flagged. */
export const RECIPE_UNUSED_DAYS = 14;
/** A named recipe not used for this many days is flagged. */
export const RECIPE_IDLE_DAYS = 60;
/** A paused schedule untouched for this many days is flagged. */
export const PAUSED_DAYS = 30;
/** Study cards waiting this long since the topic's last activity are flagged. */
export const STUDY_IDLE_DAYS = 14;
/** A memory kind at this share of its cap is flagged (oldest are about to be pruned). */
export const CAP_SHARE = 0.9;

const DAY = 86_400_000;

export interface Connector {
  configured: boolean;
  detail: string;
  name: string;
}

export interface ToolUse {
  errors7d: number;
  name: string;
  uses30d: number;
}

export interface ScheduleSummary {
  created: string;
  enabled: boolean;
  id: number;
  last_run: null | string;
  name: string;
  next_run: null | string;
  /** Statuses of the most recent runs, newest first. */
  recent: string[];
  spec: null | string;
}

export interface Flag {
  /** The dashboard path where you'd act on it. */
  href: string;
  severity: "info" | "warn";
  text: string;
}

export interface Overview {
  connectors: Connector[];
  flags: Flag[];
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
  schedules: ScheduleSummary[];
  study: { cards: number; due: number; lastActivity: null | string; name: string; projectId: null | number }[];
  tools: ToolUse[];
}

const CAPS: Record<string, number> = { lesson: LESSON_MEMORY_MAX, recipe: RECIPE_MEMORY_MAX, reflection: REFLECT_MEMORY_MAX };

const connectors = (): Connector[] => {
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  return [
    { configured: !!LOCAL_BASE_URL, detail: LOCAL_BASE_URL ? `standard tier at ${host(LOCAL_BASE_URL)}` : "not set", name: "Local model" },
    { configured: !!FAST_BASE_URL, detail: FAST_BASE_URL ? `fast tier at ${host(FAST_BASE_URL)}` : "not set; the standard tier does fast work", name: "Fast model" },
    { configured: VISION_ENABLED, detail: VISION_ENABLED ? "images can be read" : "not set; images can't be read", name: "Vision" },
    { configured: CLOUD_ENABLED, detail: CLOUD_ENABLED ? "deep tier available (never for private work)" : "no cloud key; everything stays local", name: "Cloud model" },
    { configured: !!EMBEDDINGS_URL, detail: EMBEDDINGS_URL ? `at ${host(EMBEDDINGS_URL)}` : "not set; recall uses keyword matching", name: "Embeddings" },
    { configured: !!TAVILY_API_KEY, detail: TAVILY_API_KEY ? "Tavily" : "no Tavily key; falls back to the browser", name: "Web search" },
    {
      configured: fs.existsSync(GOOGLE_TOKEN_PATH),
      detail: fs.existsSync(GOOGLE_TOKEN_PATH) ? "Gmail and Calendar, read-only" : "not authorised (npm run auth)",
      name: "Google",
    },
    {
      configured: APNS_ENABLED || NTFY_ENABLED,
      detail: [APNS_ENABLED ? "iPhone app (APNs)" : "", NTFY_ENABLED ? "ntfy" : ""].filter(Boolean).join(" + ") || "no push; Mac banners only",
      name: "Push",
    },
    { configured: !!TTS_BASE_URL, detail: TTS_BASE_URL ? "spoken replies" : "not set; no voice out", name: "Speech" },
    { configured: !!IMAGE_BASE_URL, detail: IMAGE_BASE_URL ? "image generation" : "not set", name: "Images" },
  ];
};

const toolUse = (now: Date): ToolUse[] => {
  const since = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const rows = rawDb
    .prepare(
      `SELECT tool,
         SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS uses30d,
         SUM(CASE WHEN ts >= ? AND decision = 'error' THEN 1 ELSE 0 END) AS errors7d
       FROM actions WHERE ts >= ? GROUP BY tool`,
    )
    .all(since(30), since(7), since(30)) as { errors7d: number; tool: string; uses30d: number }[];
  const used = new Map(rows.map((r) => [r.tool, r]));
  return registry
    .map((t) => ({ errors7d: Number(used.get(t.name)?.errors7d ?? 0), name: t.name, uses30d: Number(used.get(t.name)?.uses30d ?? 0) }))
    .sort((a, b) => b.uses30d - a.uses30d || a.name.localeCompare(b.name));
};

const schedules = (): ScheduleSummary[] => {
  const recent = rawDb.prepare("SELECT status FROM runs WHERE schedule_id = ? AND finished IS NOT NULL ORDER BY id DESC LIMIT ?");
  return store.listSchedules().map((s) => ({
    created: s.created,
    enabled: !!s.enabled,
    id: s.id,
    last_run: s.last_run,
    name: s.name,
    next_run: s.next_run,
    recent: (recent.all(s.id, FAILING_RUNS) as { status: null | string }[]).map((r) => r.status ?? "unknown"),
    spec: s.spec,
  }));
};

const memory = (): Overview["memory"] =>
  (rawDb.prepare("SELECT COALESCE(kind, 'note') AS kind, COUNT(*) AS n FROM memories GROUP BY kind ORDER BY n DESC").all() as { kind: string; n: number }[]).map(
    (r) => ({ cap: CAPS[r.kind] ?? null, count: Number(r.n), kind: r.kind }),
  );

const projects = (): Overview["projects"] =>
  listProjects().map((p) => {
    const sources = listSources(p.id);
    return {
      // A source that was denied or not found never indexed: its documents are invisible to recall.
      badSources: sources.filter((s) => /^(error|denied)/.test(s.status ?? "")).map((s) => `${s.ref}: ${s.status}`),
      chunks: sources.reduce((n, s) => n + (s.chunk_count ?? 0), 0),
      id: p.id,
      name: p.name,
      sources: sources.length,
    };
  });

const study = (): Overview["study"] => {
  const last = rawDb.prepare("SELECT MAX(asked) AS at FROM study_attempts WHERE topic_id = ?");
  const cards = rawDb.prepare("SELECT COUNT(*) AS n FROM study_cards WHERE topic_id = ?");
  return listTopics().map((t) => ({
    cards: Number((cards.get(t.id) as any).n),
    due: countDue(t.id),
    lastActivity: ((last.get(t.id) as any)?.at as null | string) ?? null,
    name: t.name,
    projectId: t.project_id,
  }));
};

const policySummary = (): Overview["policy"] => {
  const p = loadPolicy() as any;
  return {
    autoApprove: (p.autoApprove ?? []).map((a: any) => ({ target: String(a.target), tool: String(a.tool) })),
    chatAutoTools: p.trust?.chatAutoTools ?? [],
    dryRun: !!p.autoExecute?.dryRun,
    irreversibleAlwaysConfirm: !!p.autoExecute?.irreversibleAlwaysConfirm,
    readableDirs: p.fs?.readableDirs ?? [],
    schedulesEnabled: !!p.schedules?.enabled,
    userDirected: p.userDirected?.enabled ? (p.userDirected?.actions ?? []) : [],
    webSearch: !!p.web?.searchEnabled,
    writableDirs: p.fs?.writableDirs ?? [],
  };
};

/** The prune list. Pure: the same data and clock always give the same flags. */
export const flagsFrom = (o: Omit<Overview, "flags" | "generated">, now: Date): Flag[] => {
  const flags: Flag[] = [];
  const ago = (iso: null | string) => (iso ? (now.getTime() - Date.parse(iso)) / DAY : Infinity);

  for (const s of o.schedules) {
    if (s.recent.length >= FAILING_RUNS && s.recent.every((r) => r !== "ok"))
      flags.push({ href: "/schedules", severity: "warn", text: `Schedule "${s.name}" failed its last ${FAILING_RUNS} runs.` });
    if (!s.enabled && ago(s.last_run ?? s.created) > PAUSED_DAYS)
      flags.push({ href: "/schedules", severity: "info", text: `Schedule "${s.name}" has been paused over ${PAUSED_DAYS} days. Delete it if it's done.` });
  }
  for (const t of o.tools)
    if (t.errors7d >= TOOL_ERRORS_WEEK)
      flags.push({ href: "/activity", severity: "warn", text: `${t.name} errored ${t.errors7d} times this week.` });
  for (const r of o.recipes) {
    if (r.uses === 0 && ago(r.created) > RECIPE_UNUSED_DAYS)
      flags.push({ href: "/settings", severity: "info", text: `Recipe "${r.name}" has never been used since it was saved.` });
    else if (r.uses > 0 && ago(r.last_used) > RECIPE_IDLE_DAYS)
      flags.push({ href: "/settings", severity: "info", text: `Recipe "${r.name}" hasn't been used in over ${RECIPE_IDLE_DAYS} days.` });
  }
  for (const p of o.projects)
    for (const b of p.badSources)
      flags.push({ href: `/p/${p.id}`, severity: "warn", text: `Project "${p.name}" has a source that didn't index: ${b}.` });
  for (const m of o.memory)
    if (m.cap && m.count >= m.cap * CAP_SHARE)
      flags.push({ href: "/settings", severity: "info", text: `${m.count} ${m.kind} memories, near the cap of ${m.cap}; the oldest are pruned first.` });
  for (const s of o.study)
    if (s.due > 0 && ago(s.lastActivity) > STUDY_IDLE_DAYS)
      flags.push({ href: "/study", severity: "info", text: `${s.due} card${s.due === 1 ? "" : "s"} in "${s.name}" waiting, and no study in ${STUDY_IDLE_DAYS} days.` });
  if (o.policy.dryRun)
    flags.push({ href: "/settings", severity: "warn", text: "Dry run is on: nothing the assistant does actually happens." });
  return flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1));
};

export const overview = (now: Date = new Date()): Overview => {
  const data = {
    connectors: connectors(),
    memory: memory(),
    policy: policySummary(),
    projects: projects(),
    recipes: listRecipes().map((r) => ({ created: r.created, last_used: r.last_used, name: r.name, uses: r.uses })),
    schedules: schedules(),
    study: study(),
    tools: toolUse(now),
  };
  return { ...data, flags: flagsFrom(data, now), generated: now.toISOString() };
};
