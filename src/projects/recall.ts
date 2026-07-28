/**
 * Retrieving a project's knowledge for a task, and — the part that matters — deciding how
 * it enters the prompt.
 *
 * ## Two kinds of project context, two different trust tiers
 *
 * A project carries two things, and they must not be injected the same way:
 *
 *   **Instructions** are written by you, in the project settings. Same provenance as
 *   `profile.md`, so they go in as a SYSTEM message and are trusted standing context.
 *
 *   **Document chunks** are verbatim text out of files on disk. `read_file` already treats
 *   local files as hostile — a file may be something you downloaded, a repo you cloned, a
 *   PDF someone mailed you — so chunks are `tagUntrusted`-wrapped and enter as a USER
 *   message. Never system.
 *
 * That split is the whole reason `AgentOpts` has both `context` and `knowledge`. Putting
 * indexed file contents into the system prompt would mean any document you index can issue
 * instructions to the agent for every step of every run in that project, which is a
 * remarkably efficient way to lose the injection argument.
 */
import { tagUntrusted } from "../audit.ts";
import { cosine, fromBlob, getEmbedder } from "../memory/rag.ts";
import * as projects from "./store.ts";

export interface Retrieved {
  path: string;
  score: number;
  text: string;
}

/** The k chunks most relevant to a task. Falls back to keyword matching with no embedder. */
export const recallChunks = async (projectId: number, query: string, k = 6): Promise<Retrieved[]> => {
  const rows = projects.chunksForProject(projectId);
  if (!rows.length) return [];

  const embedder = await getEmbedder();
  if (!embedder) {
    const needle = query.toLowerCase();
    const words = needle.split(/\W+/).filter((w) => w.length > 3);
    return rows
      .map((r) => ({
        path: r.path,
        // Crude overlap count. NaN would be more honest about "no real score" but this
        // fallback needs to rank, and every caller here only uses the ordering.
        score: words.filter((w) => r.text.toLowerCase().includes(w)).length,
        text: r.text,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  const q = await embedder(query);
  return rows
    .filter((r) => r.embedding)
    .map((r) => ({ path: r.path, score: cosine(q, fromBlob(r.embedding as Buffer)), text: r.text }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
};

/**
 * The knowledge block for a run, already UNTRUSTED-tagged and ready to be passed as
 * `AgentOpts.knowledge`. Returns empty string when the project has nothing relevant, so
 * the caller can pass it through unconditionally.
 */
export const knowledgeFor = async (projectId: number, task: string, k = 6): Promise<string> => {
  let hits: Retrieved[];
  try {
    hits = await recallChunks(projectId, task, k);
  } catch (err) {
    // A run with no project knowledge beats no run at all — same posture as memory recall.
    console.warn(`[projects] recall skipped: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
  if (!hits.length) return "";

  const body = hits
    .map((h, i) => `--- excerpt ${i + 1} (${h.path}) ---\n${h.text}`)
    .join("\n\n");

  return tagUntrusted(
    "project documents",
    `These excerpts were retrieved from this project's indexed files because they look relevant ` +
      `to the request. Use them as reference material and cite the file when you rely on one.\n\n${body}`,
  );
};

/** The project's own instructions, as trusted standing context. Empty when unset. */
export const instructionsFor = (projectId: number): string => {
  const project = projects.getProject(projectId);
  const text = project?.instructions?.trim();
  if (!text) return "";
  return (
    `Standing instructions for the "${project!.name}" project. These are the user's own ` +
    `words and take precedence over your general defaults:\n\n${text}`
  );
};
