/**
 * meeting_list / meeting_tag — let the assistant find recordings by tag and date, and tag them.
 *
 * Reads return the extraction (summary, topics, decisions), not the transcript: "summarise
 * everything tagged standup over two weeks" is a question about descriptions, and dragging
 * raw transcripts into the context would blow it on the first long meeting. A transcript
 * for one meeting is still one `meeting_list` hit away via `transcript: true` on a single id.
 *
 * Both are local-only and reversible (tags can be edited back), so always allowed.
 */
import {
  allTags,
  findMeetings,
  getExtraction,
  getMeeting,
  normalizeTag,
  setTags,
  transcriptText,
} from "../meetings/store.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const classify = (summary: string) => (): ClassifiedAction => ({ reversibility: "reversible", summary, target: "meetings" });
const allow = (_p: Policy): PolicyDecision => ({ allowed: true, reason: "local meeting store" });

const listOf = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(",") : [];

/** "14" / 14 → 14 days ago; an ISO date passes through; anything else is unreadable. */
const sinceOf = (raw: unknown): null | string | undefined => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const days = Number(raw);
  if (Number.isFinite(days) && String(raw).trim() !== "") return new Date(Date.now() - days * 86_400_000).toISOString();
  const t = Date.parse(String(raw));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

export const meetingList: Tool = {
  name: "meeting_list",
  description:
    "Find the user's recorded meetings. Filter by tags (a meeting must have ALL the tags given) and by " +
    "since (a number of days back, e.g. 14, or an ISO date). Returns each meeting's date, title, tags, " +
    "summary, topics and decisions — enough to summarise many meetings at once. Call with no args to " +
    "see the tags in use. Pass id with transcript: true to read one meeting's full transcript.",
  argsSchema:
    '{ "tags"?: string[], "since"?: number | string, "limit"?: number, "id"?: number, "transcript"?: boolean }',
  classify: classify("Read meetings"),
  checkPolicy: allow,
  run: async (a: any) => {
    if (a?.id !== undefined) {
      const m = getMeeting(Number(a.id));
      if (!m) return `ERROR: no meeting ${a.id}.`;
      const ex = getExtraction(m.id);
      const head = `#${m.id} ${m.title ?? "Untitled"} (${m.started.slice(0, 10)}) [${(m.tags ?? []).join(", ")}]`;
      const body = a.transcript ? transcriptText(m.id) || "(no transcript kept)" : (ex?.summary ?? "(no summary)");
      return `${head}\n${body}`;
    }
    const since = sinceOf(a?.since);
    if (since === null) return `ERROR: could not read since ${JSON.stringify(a.since)}; use a number of days or an ISO date.`;
    const tags = listOf(a?.tags);
    if (!tags.length && since === undefined && a?.limit === undefined) {
      const used = allTags();
      return used.length ? `Tags in use: ${used.map((t) => `${t.tag} (${t.count})`).join(", ")}` : "No meetings are tagged yet.";
    }
    const rows = findMeetings({ limit: Math.min(Number(a?.limit) || 30, 100), since: since ?? undefined, tags });
    if (!rows.length) return "No meetings match.";
    return rows
      .map((m) => {
        const ex = getExtraction(m.id);
        const lines = [`#${m.id} ${m.title ?? "Untitled"} — ${m.started.slice(0, 10)} [${(m.tags ?? []).join(", ")}]`];
        if (ex?.summary) lines.push(`  Summary: ${ex.summary}`);
        if (ex?.topics.length) lines.push(`  Topics: ${ex.topics.join("; ")}`);
        for (const d of ex?.decisions ?? []) lines.push(`  Decision: ${d.text}`);
        if (!ex?.summary) lines.push("  (not summarised yet — use id with transcript: true to read it)");
        return lines.join("\n");
      })
      .join("\n\n");
  },
};

export const meetingTag: Tool = {
  name: "meeting_tag",
  description:
    "Add or remove tags on a recorded meeting. add and remove are lists of short labels like " +
    "\"standup\" or \"hooks\"; tags are case-insensitive.",
  argsSchema: '{ "id": number, "add"?: string[], "remove"?: string[] }',
  classify: classify("Tag a meeting"),
  checkPolicy: allow,
  run: async (a: any) => {
    const m = getMeeting(Number(a?.id));
    if (!m) return `ERROR: no meeting ${a?.id}.`;
    const drop = new Set(listOf(a?.remove).map(normalizeTag));
    const next = setTags(m.id, [...(m.tags ?? []).filter((t) => !drop.has(t)), ...listOf(a?.add)]);
    return `Meeting #${m.id} tags: ${next.join(", ") || "(none)"}`;
  },
};
