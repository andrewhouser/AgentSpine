import { useCallback, useRef, useState } from "react";

import type { InboxItem, KnowledgeEntity, KnowledgeHit, KnowledgeSearchFilters, Project } from "../../lib/types.ts";

import { useDictation } from "../../hooks/useDictation.ts";
import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

interface InboxViewProps {
  projects: Project[];
}

/** What each status means, in words. Nothing is ever shown as simply "empty" when it was not read. */
const STATUS: Record<InboxItem["status"], string> = {
  empty: "No text in it",
  failed: "Could not read it",
  needs_ocr: "Not read yet: needs OCR",
  ocr_failed: "OCR found no text",
  ready: "Read and searchable",
};

/** What a hit's source is backed by, in the words the Knowledge screen uses. */
const BACKED: Record<NonNullable<KnowledgeHit["evidence"]>["level"], string> = {
  conflicting: "reviewed claims that disagree",
  inferred: "reviewed, inferred claims",
  "machine-extracted": "extracted claims nobody has reviewed",
  none: "nothing analysed from it yet",
  reviewed: "reviewed claims",
};

/** "person:3", "team:7" or "": one picker for both, because a search narrows to one or the other. */
type Who = "" | `person:${number}` | `team:${number}`;

const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/**
 * The Knowledge Inbox: drop in a file, screenshot or scan, paste a chat or email, or type a note. Each becomes a
 * source before it has a project, is searchable at once, and is filed under a project only when you say so. A
 * suggested project is shown, never applied.
 */
const whoOf = (who: Who): { person?: number; team?: number } =>
  who.startsWith("person:") ? { person: Number(who.slice(7)) } : who.startsWith("team:") ? { team: Number(who.slice(5)) } : {};

export const InboxView = ({ projects }: InboxViewProps) => {
  const load = useCallback(() => api.inboxList(), []);
  const [items, reload] = useResource<InboxItem[]>(load, []);
  const [status] = useResource(
    useCallback(() => api.inboxStatus(), []),
    null as { ocr: boolean; watchFolder: null | string } | null,
  );
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [searchNote, setSearchNote] = useState("");
  const [scope, setScope] = useState<null | number>(null);
  const [who, setWho] = useState<Who>("");
  const [backed, setBacked] = useState<NonNullable<KnowledgeSearchFilters["evidence"]>>("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [entities] = useResource<KnowledgeEntity[]>(
    useCallback(() => api.knowledgeEntities(), []),
    [],
  );
  const people = entities.filter((e) => e.kind === "person");
  const teams = entities.filter((e) => e.kind === "team");
  const filtered = scope !== null || who !== "" || backed !== "" || since !== "" || until !== "";
  const [extractNotes, setExtractNotes] = useState<Record<number, string>>({});
  const picker = useRef<HTMLInputElement>(null);
  // The transcript lands in the box and waits for Add: Whisper mishears names, and this becomes a searchable source.
  const [dictated, setDictated] = useState(false);
  const appendDictation = useCallback((heard: string): void => {
    setText((current) => (current && !/\s$/.test(current) ? `${current} ${heard}` : `${current}${heard}`));
    setDictated(true);
  }, []);
  const voice = useDictation(appendDictation);
  const micReason = voice.source === "browser" ? voice.browserReason : voice.status?.serverMicReason || null;
  const micBlocked = voice.source === "browser" ? voice.browserReason !== null : voice.status?.serverMic === false;

  const guard = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setError("");
    try {
      await work();
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const addFiles = (files: FileList | null): void => {
    if (!files?.length) return;
    void guard("Adding…", async () => {
      for (const f of Array.from(files)) await api.inboxAddFile(f, f.name);
    });
  };

  /** Only on request: extraction is several calls to the model host. */
  const extract = (id: number): void => {
    void guard("Reading for decisions and commitments…", async () => {
      const { dropped, kept } = await api.inboxExtract(id);
      const found = kept === 0 ? "Nothing to review was found." : `Found ${kept}. Anything new is waiting in Knowledge.`;
      const left = dropped > 0 ? ` ${dropped} left out because the quoted words were not in the text.` : "";
      setExtractNotes((notes) => ({ ...notes, [id]: found + left }));
    });
  };

  // Each filter is passed in, not read from state, so a change can re-run the search with the value just picked.
  const search = async (f: KnowledgeSearchFilters = { evidence: backed, project: scope ?? undefined, since, until, ...whoOf(who) }): Promise<void> => {
    if (q.trim().length < 2) return setHits(null);
    setError("");
    try {
      const found = await api.searchKnowledge(q.trim(), f);
      setHits(found.hits);
      setSearchNote(found.note);
    } catch (err) {
      setHits(null);
      setSearchNote("");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Change one filter and, when there is a search on screen, run it again with the new value. */
  const refine = (change: Partial<{ backed: typeof backed; scope: null | number; since: string; until: string; who: Who }>): void => {
    const next = { backed, scope, since, until, who, ...change };
    setBacked(next.backed);
    setScope(next.scope);
    setSince(next.since);
    setUntil(next.until);
    setWho(next.who);
    if (hits !== null) void search({ evidence: next.backed, project: next.scope ?? undefined, since: next.since, until: next.until, ...whoOf(next.who) });
  };
  const projectName = (id: number): string => projects.find((p) => p.id === id)?.name ?? "";

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Add anything you want to remember. It is read on this Mac, kept private, and searchable at once; you decide which project it belongs to."
        title="Drop zone"
      />

      {status && !status.ocr && (
        <p className={styles.empty}>
          Screenshots and scanned PDFs cannot be read on this machine (OCR needs macOS with the Swift toolchain). They are
          kept and marked &quot;Not read yet&quot;, and can be read later.
        </p>
      )}

      <div
        className={styles.cardStack}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        <strong>Add files</strong>
        <p className={styles.meta}>Drop PDFs, Word files, Markdown, text, screenshots or scans here, or choose them.</p>
        <input hidden multiple onChange={(e) => addFiles(e.target.files)} ref={picker} type="file" />
        <button className={styles.primary} disabled={busy !== ""} onClick={() => picker.current?.click()} type="button">
          Choose files
        </button>
        {status?.watchFolder && <p className={styles.meta}>A watched folder is also taken in automatically: {status.watchFolder}</p>}
      </div>

      <div className={styles.cardStack}>
        <strong>Paste or type</strong>
        <p className={styles.meta}>A chat or email thread keeps who said what and when. A plain note is stored as written.</p>
        <input
          aria-label="Title (optional)"
          className={`${styles.input} ${styles.fullWidth}`}
          onChange={(e) => setName(e.target.value)}
          placeholder="Title (optional)"
          value={name}
        />
        <textarea
          aria-label="Text to add"
          className={`${styles.input} ${styles.fullWidth}`}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value.trim()) setDictated(false);
          }}
          placeholder="Paste a thread, type a note, or dictate one…"
          rows={5}
          value={text}
        />
        <div className={styles.form}>
          {voice.status && (
            <button
              aria-pressed={voice.listening}
              className={styles.button}
              disabled={busy !== "" || voice.busy || micBlocked}
              onClick={() => (voice.listening ? voice.stop() : voice.start())}
              title={micReason ?? undefined}
              type="button"
            >
              {voice.busy ? "Transcribing…" : voice.listening ? "Stop and transcribe" : "Dictate"}
            </button>
          )}
          {(["paste", "note"] as const).map((kind) => (
            <button
              className={styles.primary}
              disabled={busy !== "" || !text.trim() || voice.listening || voice.busy}
              key={kind}
              onClick={() =>
                void guard("Adding…", async () => {
                  await api.inboxPaste(text, { kind, name: name.trim() || undefined, ...(kind === "note" && dictated ? { via: "dictation" as const } : {}) });
                  setText("");
                  setName("");
                  setDictated(false);
                })
              }
              type="button"
            >
              {kind === "paste" ? "Add as a thread" : "Add as a note"}
            </button>
          ))}
        </div>
        {dictated && <p className={styles.meta}>Read it through before adding: names are the words speech recognition most often gets wrong.</p>}
        {voice.error && <p className={styles.error}>{voice.error}</p>}
      </div>

      {busy && <p className={styles.meta}>{busy}</p>}
      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.cardStack}>
        <strong>Search everything</strong>
        <div className={styles.form}>
          <input
            aria-label="Search everything indexed"
            className={`${styles.input} ${styles.grow}`}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
            placeholder="A name, a ticket number, a phrase in quotes, or a question"
            value={q}
          />
          <button className={styles.button} onClick={() => void search()} type="button">
            Search
          </button>
        </div>
        <div className={styles.form}>
          <select
            aria-label="Which project"
            className={styles.input}
            onChange={(e) => refine({ scope: e.target.value === "" ? null : Number(e.target.value) })}
            value={scope ?? ""}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select aria-label="Naming a person or team" className={styles.input} onChange={(e) => refine({ who: e.target.value as Who })} value={who}>
            <option value="">Anyone</option>
            {people.length > 0 && (
              <optgroup label="People">
                {people.map((e) => (
                  <option key={e.id} value={`person:${e.id}`}>
                    {e.name}
                  </option>
                ))}
              </optgroup>
            )}
            {teams.length > 0 && (
              <optgroup label="Teams">
                {teams.map((e) => (
                  <option key={e.id} value={`team:${e.id}`}>
                    {e.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <select
            aria-label="What backs the source"
            className={styles.input}
            onChange={(e) => refine({ backed: e.target.value as typeof backed })}
            value={backed}
          >
            <option value="">Any source</option>
            <option value="reviewed">Backed by reviewed claims</option>
            <option value="extracted">Extracted, not reviewed</option>
            <option value="none">Nothing analysed yet</option>
          </select>
          <label className={styles.meta}>
            From{" "}
            <input aria-label="Dated from" className={styles.input} onChange={(e) => refine({ since: e.target.value })} type="date" value={since} />
          </label>
          <label className={styles.meta}>
            As of{" "}
            <input aria-label="Dated up to" className={styles.input} onChange={(e) => refine({ until: e.target.value })} type="date" value={until} />
          </label>
          {filtered && (
            <button className={styles.button} onClick={() => refine({ backed: "", scope: null, since: "", until: "", who: "" })} type="button">
              Clear filters
            </button>
          )}
        </div>
        {who !== "" && (
          <p className={styles.meta}>
            Only passages that name {entities.find((e) => `${e.kind}:${e.id}` === who)?.name ?? "them"}
            {who.startsWith("team:") ? " or one of its recorded members" : ""}, by a recorded name or alias.
          </p>
        )}
        {searchNote && <p className={styles.meta}>{searchNote.charAt(0).toUpperCase() + searchNote.slice(1)}</p>}
        {hits && hits.length === 0 && <p className={styles.meta}>Nothing found{filtered ? " with these filters" : ""}.</p>}
        {hits?.map((h) => (
          <div className={styles.cardStack} key={h.id}>
            <p className={styles.meta}>
              {h.path}
              {projectName(h.projectId) && ` · ${projectName(h.projectId)}`}
              {h.mtime && ` · ${h.mtime.slice(0, 10)}`} · found by {h.via.join(" and ")}
              {h.evidence && ` · ${BACKED[h.evidence.level]}`}
            </p>
            <p className={styles.snippet}>{h.text.slice(0, 280)}</p>
          </div>
        ))}
      </div>

      <h2 className={styles.title}>Items</h2>
      {items.length === 0 && <p className={styles.empty}>Nothing has been added yet.</p>}
      {items.map((it) => (
        <div className={styles.cardStack} key={it.id}>
          <div className={styles.body}>
            <p className={styles.title}>{it.name}</p>
            <p className={styles.meta}>
              {it.kind} · {when(it.ingested)}
              {it.speakers.length > 0 && ` · ${it.speakers.join(", ")}`}
              {it.author && it.speakers.length === 0 && ` · ${it.author}`}
              {it.via && ` · via ${it.via}`}
            </p>
            <p className={it.status === "ready" ? styles.meta : styles.error}>
              {STATUS[it.status]}
              {it.note ? `: ${it.note}` : ""}
            </p>
            {it.project_id === null && it.suggested_project !== null && (
              <p className={styles.meta}>
                Looks like it belongs to {it.suggestedProjectName ?? "a project"}.{" "}
                <button
                  className={styles.button}
                  onClick={() => void guard("Filing…", () => api.inboxFile(it.id, it.suggested_project))}
                  type="button"
                >
                  File it there
                </button>
              </p>
            )}
            {it.suggested_people.length > 0 && <p className={styles.meta}>May mention {it.suggested_people.join(", ")}.</p>}
            {it.tags.length > 0 && <p className={styles.meta}>Tags: {it.tags.join(", ")}</p>}
            {it.suggested_tags.filter((t) => !it.tags.includes(t)).length > 0 && (
              <p className={styles.meta}>
                Tags in use that fit: {it.suggested_tags.filter((t) => !it.tags.includes(t)).join(", ")}.{" "}
                <button
                  className={styles.button}
                  onClick={() => void guard("Tagging…", () => api.inboxTags(it.id, [...it.tags, ...it.suggested_tags.filter((t) => !it.tags.includes(t))]))}
                  type="button"
                >
                  Add them
                </button>
              </p>
            )}
            {extractNotes[it.id] && <p className={styles.meta}>{extractNotes[it.id]}</p>}
          </div>
          <div className={styles.form}>
            <select
              aria-label={`Project for ${it.name}`}
              className={styles.input}
              onChange={(e) => void guard("Filing…", () => api.inboxFile(it.id, e.target.value === "" ? null : Number(e.target.value)))}
              value={it.project_id ?? ""}
            >
              <option value="">Not filed</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {it.status === "ready" && (
              <button className={styles.button} disabled={busy !== ""} onClick={() => extract(it.id)} type="button">
                Find decisions and commitments
              </button>
            )}
            {(it.status === "needs_ocr" || it.status === "ocr_failed" || it.status === "failed") && (
              <button className={styles.button} onClick={() => void guard("Reading…", () => api.inboxReprocess(it.id))} type="button">
                Try reading again
              </button>
            )}
            <button
              className={styles.button}
              onClick={() => {
                if (window.confirm(`Delete "${it.name}"? Its original, its text and its search index are removed.`)) {
                  void guard("Deleting…", () => api.inboxDelete(it.id));
                }
              }}
              type="button"
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
