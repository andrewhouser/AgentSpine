/**
 * Resources at your level: a few explanations worth reading, chosen for what you already know.
 *
 * Someone who put a thing in exactly the right metaphor can save you days, and they're hard to
 * find from a search box because a search doesn't know you know A but not B. This builds the
 * queries from the topic's profile (the interviewer's known/gaps and the examiner's level),
 * lets the model choose from the results, and then holds it to them in code: every URL it
 * returns must be one the search actually produced, or it's dropped.
 *
 * What it never does: put project documents into a search query. The queries come from the topic
 * name, the subject you asked about and the gaps you stated. For a topic linked to a project, the
 * choosing runs on the local model, like all of that topic's study calls.
 */
import { webSearch } from "../tools/web-search.ts";
import { pickResources } from "./roles.ts";
import type { Resource } from "./roles.ts";
import type { TopicRow } from "./store.ts";
import { topicJson } from "./store.ts";

export type Searcher = (query: string) => Promise<string>;

let searcher: Searcher = (query) => webSearch.run({ query }, { policy: {} as never });
/** Tests swap the search out with this. */
export const __setSearcher = (fn: null | Searcher): void => {
  searcher = fn ?? ((query) => webSearch.run({ query }, { policy: {} as never }));
};

const LEVEL_WORDS = ["absolute beginner", "beginner", "beginner", "intermediate", "advanced", "expert"];

/** URLs as they appear in search output, minus the punctuation that often trails a link in prose. */
export const urlsIn = (text: string): Set<string> =>
  new Set((text.match(/https?:\/\/[^\s<>"'\])]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")));

/** The queries this learner's profile implies: the subject at their level, and their first gap. */
export const queriesFor = (topic: TopicRow, subject: string, gaps: string[]): string[] => {
  const level = topic.level != null ? LEVEL_WORDS[Math.max(0, Math.min(5, topic.level))] : "beginner";
  const qs = [`${subject} explained ${level} tutorial`];
  const gap = gaps.find((g) => g.toLowerCase() !== subject.toLowerCase());
  if (gap) qs.push(`${gap} ${topic.name === subject ? "" : `${topic.name} `}explained clearly`.replace(/\s+/g, " "));
  return qs;
};

export interface Found {
  /** Picks dropped because their URL wasn't in the search results. */
  invented: number;
  queries: string[];
  resources: Resource[];
}

export const findResources = async (
  topic: TopicRow,
  opts: { dontKnow?: string; know?: string; subject?: string } = {},
): Promise<Found> => {
  const profile = topicJson(topic, "profile") ?? {};
  const subject = (opts.subject ?? "").trim().slice(0, 120) || topic.name;
  const known = [...(opts.know ? [opts.know] : []), ...(Array.isArray(profile.known) ? profile.known : [])].map(String).slice(0, 6);
  const gaps = [...(opts.dontKnow ? [opts.dontKnow] : []), ...(Array.isArray(profile.gaps) ? profile.gaps : [])].map(String).slice(0, 6);
  const queries = queriesFor(topic, subject, gaps);
  const results: string[] = [];
  for (const q of queries) {
    try {
      results.push(await searcher(q));
    } catch (err) {
      results.push(`(search failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const text = results.join("\n\n");
  const real = urlsIn(text);
  if (!real.size) return { invented: 0, queries, resources: [] };
  const picked = await pickResources(topic, subject, known, gaps, text.slice(0, 12_000));
  const seen = new Set<string>();
  let invented = 0;
  const kept = picked.filter((r) => {
    const url = r.url.replace(/[.,;:!?]+$/, "");
    if (!real.has(url)) {
      invented++;
      return false;
    }
    if (seen.has(url)) return false;
    seen.add(url);
    r.url = url;
    return true;
  });
  return { invented, queries, resources: kept.slice(0, 5) };
};
