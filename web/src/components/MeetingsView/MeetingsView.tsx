/**
 * Meetings — the live transcript, and everything recorded before it.
 *
 * ## Why this is its own section and not a button inside a project
 *
 * There is one microphone. "Is something recording right now" is a fact about the machine,
 * not about any project, and a Record button living inside each project view would let you
 * press two of them. Capture is global; *filing* is per-project, which is the dropdown on
 * each finished meeting.
 *
 * ## Assign after, not before
 *
 * The project selector is available while recording and stays available afterwards, because
 * you often do not know which project a meeting was about until it is over. Choosing one on
 * a finished meeting is what indexes its transcript into that project.
 *
 * ## Why the rejected work items are on screen
 *
 * Extraction proposes work items; a strict second pass throws most of them out. The thrown-out
 * ones are listed here, greyed, with the reason. It would look tidier to show only survivors,
 * and it would be the wrong call: measured on a real recording the first pass was wrong 5
 * times out of 5, and a UI that hides that is asking you to trust a number you cannot see.
 * The rejects are also the fastest way to notice the verifier has started rejecting real work.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AudioDevices,
  CoachAnswer,
  ContextCard,
  ContextCards,
  Meeting,
  MeetingEvent,
  MeetingExtraction,
  MeetingSegment,
  MeetingWorkItem,
  Project,
} from "../../lib/types.ts";

import { useMeetingStream } from "../../hooks/useMeetingStream.ts";
import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import styles from "./MeetingsView.module.css";

const NO_MEETINGS: Meeting[] = [];
const NO_DEVICES: AudioDevices = { allowed: [], devices: [], enabled: false };

const clock = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", hour: "numeric", minute: "2-digit", month: "short" });

/** Plain-English reason a candidate never reached the queue. */
const REJECTION: Record<string, string> = {
  "already-done": "already done",
  "not-a-task": "not a task",
  unanchored: "quote not in the transcript",
  unverified: "not checked",
};

interface MeetingDetail {
  extraction: MeetingExtraction | null;
  segments: MeetingSegment[];
  workItems: MeetingWorkItem[];
}

const NO_DETAIL: MeetingDetail = { extraction: null, segments: [], workItems: [] };

/**
 * The sidecar: what we already know about whatever is being said right now.
 *
 * Retrieval only — three rankings, no generation. Generation runs at 35 tok/s on this
 * hardware, which is fine for one deliberate ask and impossible for a panel that refreshes
 * while people are talking.
 *
 * **A card with nothing strong in it renders as nothing.** No placeholder, no "no results",
 * no least-irrelevant chunk padded out to three. A ranking always returns something, so a
 * card that always has content teaches you to stop reading it; a card that is usually empty
 * and occasionally right is worth the glance. That is also why the whole strip disappears
 * rather than sitting there empty.
 */
const CardGroup = ({ cards, title }: { cards: ContextCard[]; title: string }) => {
  if (!cards.length) return null;
  return (
    <div className={styles.cardGroup}>
      <h4 className={styles.cardHead}>{title}</h4>
      {cards.map((card) => (
        <div className={styles.card} key={`${card.source}-${card.text.slice(0, 24)}`}>
          <p className={styles.cardText}>{card.text}</p>
          <span className={styles.cardSource}>{card.source}</span>
        </div>
      ))}
    </div>
  );
};

/**
 * The coaching answer.
 *
 * Rendered as notes and never as prose to recite. Five seconds is a long silence and reading
 * off a second screen is visible on camera, so the useful shape is the one you would have
 * written on a card beforehand — a number, a name, a decision already made — not a sentence
 * to say. The question it answered is shown underneath because the transcript is rough, and
 * an answer to a misheard question should be obvious at a glance rather than puzzling.
 */
const CoachPanel = ({ answer, coaching }: { answer: CoachAnswer | null; coaching: boolean }) => {
  if (!coaching && !answer) return null;
  return (
    <div className={styles.coach}>
      <h4 className={styles.coachHead}>
        Notes
        {answer && !coaching && <span className={styles.coachTime}>{(answer.elapsedMs / 1000).toFixed(1)}s</span>}
      </h4>
      {coaching && <p className={styles.waiting}>thinking — about five seconds…</p>}
      {answer && (
        <>
          <div className={styles.coachNotes}>{answer.notes || "nothing on this."}</div>
          {answer.question && <p className={styles.coachQuestion}>answering: “{answer.question}”</p>}
        </>
      )}
    </div>
  );
};

interface SidecarProps {
  answer: CoachAnswer | null;
  cards: ContextCards | null;
  coaching: boolean;
  onCoach: () => void;
  projectId: null | number;
}

const Sidecar = ({ answer, cards, coaching, onCoach, projectId }: SidecarProps) => {
  const total = cards ? cards.documents.length + cards.meetings.length + cards.memories.length : 0;

  return (
    <aside className={styles.sidecar}>
      <div className={styles.sidecarTop}>
        <h3 className={styles.sidecarHead}>Context</h3>
        <button className={styles.coachButton} disabled={coaching} onClick={onCoach} type="button">
          {coaching ? "Thinking…" : "Help me"}
          <kbd className={styles.kbd}>⌘/</kbd>
        </button>
      </div>

      <CoachPanel answer={answer} coaching={coaching} />
      {total === 0 && (
        <p className={styles.waiting}>
          {cards === null
            ? "listening — context appears once there is something to search on…"
            : "nothing relevant to what is being said right now."}
        </p>
      )}
      {cards && (
        <>
          <CardGroup cards={cards.meetings} title="Said before" />
          <CardGroup cards={cards.documents} title="In the project" />
          <CardGroup cards={cards.memories} title="Remembered" />
        </>
      )}
      {projectId === null && (
        <p className={styles.hint}>
          No project assigned, so only memories are searched. Pick one above to include this
          project's documents and earlier meetings.
        </p>
      )}
    </aside>
  );
};

interface ExtractionPanelProps {
  busy: boolean;
  detail: MeetingDetail;
  onExtract: () => void;
}

/**
 * What was made of the transcript.
 *
 * Note what is absent: the model's own confidence in any of this. It reports one, it reported
 * `high` on five consecutive wrong answers, and a number that survives being wrong every time
 * is worse than no number — a reader will spend trust on it.
 */
const ExtractionPanel = ({ busy, detail, onExtract }: ExtractionPanelProps) => {
  const { extraction, segments, workItems } = detail;
  const queued = workItems.filter((w) => w.verdict === "queued");
  const rejected = workItems.filter((w) => w.verdict !== "queued");

  if (!extraction) {
    return segments.length ? (
      <div className={styles.extraction}>
        <button className={styles.extract} disabled={busy} onClick={onExtract} type="button">
          Extract work items
        </button>
        <span className={styles.hint}>
          Runs locally — a summary and decisions are saved, work items go to Approvals for you to
          confirm.
        </span>
      </div>
    ) : null;
  }

  return (
    <div className={styles.extraction}>
      {extraction.status === "running" && <p className={styles.waiting}>extracting — about a minute per half hour…</p>}
      {extraction.status === "failed" && (
        <p className={styles.problem}>Extraction failed: {extraction.note}. The transcript is unaffected.</p>
      )}

      {extraction.summary && <p className={styles.summary}>{extraction.summary}</p>}

      {extraction.topics.length > 0 && (
        <div className={styles.topics}>
          {extraction.topics.map((topic) => (
            <span className={styles.topic} key={topic}>
              {topic}
            </span>
          ))}
        </div>
      )}

      {extraction.decisions.length > 0 && (
        <>
          <h3 className={styles.extractHead}>Decisions</h3>
          <ul className={styles.list}>
            {extraction.decisions.map((d) => (
              <li className={styles.item} key={d.text}>
                {d.text}
                {d.quote && (
                  <span className={styles.quote}>
                    {clock(d.start_ms)} · “{d.quote}”
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {queued.length > 0 && (
        <>
          <h3 className={styles.extractHead}>
            Work items awaiting your approval <a className={styles.queueLink} href="/approvals">Approvals →</a>
          </h3>
          <ul className={styles.list}>
            {queued.map((w) => (
              <li className={styles.item} key={w.id}>
                {w.task}
                {w.owner && <span className={styles.owner}>{w.owner}</span>}
                {w.quote && (
                  <span className={styles.quote}>
                    {clock(w.start_ms ?? 0)} · “{w.quote}”
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {rejected.length > 0 && (
        <>
          <h3 className={styles.extractHead}>
            Proposed and rejected <span className={styles.hint}>kept so the error rate stays visible</span>
          </h3>
          <ul className={`${styles.list} ${styles.rejects}`}>
            {rejected.map((w) => (
              <li className={styles.item} key={w.id}>
                {w.task}
                <span className={styles.verdict}>{REJECTION[w.verdict] ?? w.verdict}</span>
                {w.verdict_note && <span className={styles.quote}>{w.verdict_note}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {extraction.status === "done" && (
        <div className={styles.extractFoot}>
          <span className={styles.hint}>
            {extraction.note} · {(extraction.elapsed_ms / 1000).toFixed(0)}s · {extraction.model}
          </span>
          <button className={styles.extract} disabled={busy} onClick={onExtract} type="button">
            Re-run
          </button>
        </div>
      )}
    </div>
  );
};

interface MeetingsViewProps {
  projects: Project[];
}

export const MeetingsView = ({ projects }: MeetingsViewProps) => {
  const [meetings, reloadMeetings] = useResource(api.listMeetings, NO_MEETINGS);
  const [devices] = useResource(api.meetingDevices, NO_DEVICES);
  const [chosenDevice, setDevice] = useState<string>("");
  const [projectId, setProjectId] = useState<null | number>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<null | string>(null);
  const [open, setOpen] = useState<null | number>(null);
  const [detail, setDetail] = useState<MeetingDetail>(NO_DETAIL);

  const load = useCallback(async (id: number): Promise<void> => {
    const { extraction, segments, workItems } = await api.meeting(id);
    setDetail({ extraction, segments, workItems });
  }, []);

  // Extraction finishes minutes after the meeting does, so it arrives on the stream rather
  // than on a click. Reloading only the meeting that is open keeps a background extraction
  // of some other meeting from yanking the panel being read.
  const onStatus = useCallback(
    (event: MeetingEvent) => {
      reloadMeetings();
      if (event.kind === "extraction" && event.meetingId === open) void load(event.meetingId);
    },
    [load, open, reloadMeetings],
  );
  const live = useMeetingStream(onStatus);
  const tail = useRef<HTMLDivElement>(null);

  const recording = live.status === "recording";
  const allowed = devices.devices.filter((d) => d.allowed);

  // The selection defaults to the first allowlisted device, derived rather than stored. An
  // effect that setState'd a default would render once with an empty select and again with
  // the real one, and would fight the user's choice every time the device list refetched.
  const device = chosenDevice || allowed[0]?.name || "";

  // Follow the transcript as it grows, the way a terminal does.
  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [live.lines.length]);

  const start = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api.startMeeting(device, projectId);
      reloadMeetings();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.stopMeeting();
      reloadMeetings();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openMeeting = async (id: number): Promise<void> => {
    if (open === id) return setOpen(null);
    setOpen(id);
    setDetail(NO_DETAIL);
    await load(id);
  };

  const coachNow = useCallback((): void => {
    if (live.meetingId === null || !recording || live.coaching) return;
    // Fire and forget: the answer arrives on the stream. A 429 means one is already running,
    // which the disabled button already says, so there is nothing to report here.
    void api.coachMeeting(live.meetingId).catch(() => {});
  }, [live.coaching, live.meetingId, recording]);

  /**
   * ⌘/ (Ctrl+/ elsewhere) asks for notes.
   *
   * Bound on the window rather than a focused element, because the whole point is that you
   * press it while looking at the room and not at the browser. Ignored while a field has
   * focus so that typing a project name or a meeting title never fires it.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "/" || !(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ["INPUT", "SELECT", "TEXTAREA"].includes(target?.tagName ?? "");
      if (typing) return;
      e.preventDefault();
      coachNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [coachNow]);

  const extract = async (id: number): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api.extractMeeting(id);
      await load(id);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const assign = async (id: number, value: string): Promise<void> => {
    await api.setMeetingProject(id, value === "" ? null : Number(value));
    reloadMeetings();
  };

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Captured on this machine, transcribed locally. Audio is never saved — only the words."
        title="Meetings"
      />

      {!devices.enabled && (
        <div className={styles.blocked}>
          <strong>Microphone capture is off.</strong> Set <code>audio.enabled</code> to true in{" "}
          <code>policy.json</code> and allowlist a device. <code>npm run listen devices</code> prints
          the exact snippet.
        </div>
      )}

      {devices.enabled && allowed.length === 0 && (
        <div className={styles.blocked}>
          <strong>No microphone is allowlisted.</strong> <code>policy.audio.devices</code> is empty,
          which means no device rather than any device. Run <code>npm run listen devices</code>.
        </div>
      )}

      <div className={`${styles.deck} ${recording ? styles.deckLive : ""}`}>
        <div className={styles.controls}>
          {recording ? (
            <button className={styles.stop} disabled={busy} onClick={() => void stop()} type="button">
              <span className={styles.dot} /> Stop recording
            </button>
          ) : (
            <button
              className={styles.record}
              disabled={busy || !allowed.length}
              onClick={() => void start()}
              type="button"
            >
              Start recording
            </button>
          )}

          <select
            aria-label="Input device"
            className={styles.select}
            disabled={recording || !allowed.length}
            onChange={(e) => setDevice(e.target.value)}
            value={device}
          >
            {allowed.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
            {!allowed.length && <option value="">no allowlisted device</option>}
          </select>

          <select
            aria-label="Project"
            className={styles.select}
            onChange={(e) => setProjectId(e.target.value === "" ? null : Number(e.target.value))}
            value={projectId ?? ""}
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {problem && <div className={styles.problem}>{problem}</div>}
        {live.note && !problem && <div className={styles.note}>{live.note}</div>}
        {live.error && <div className={styles.note}>transcription hiccup: {live.error}</div>}

        {(recording || live.lines.length > 0) && (
          <div className={styles.liveArea}>
            <div className={styles.transcript}>
              {live.lines.map((line) => (
                <p className={styles.line} key={line.key}>
                  <span className={styles.stamp}>{clock(line.startMs)}</span>
                  {line.text}
                </p>
              ))}
              {recording && live.lines.length === 0 && (
                <p className={styles.waiting}>listening — the first words appear in a few seconds…</p>
              )}
              <div ref={tail} />
            </div>
            {recording && (
              <Sidecar
                answer={live.answer}
                cards={live.cards}
                coaching={live.coaching}
                onCoach={coachNow}
                projectId={projectId}
              />
            )}
          </div>
        )}
      </div>

      <h2 className={styles.subhead}>Recorded</h2>
      {meetings.length === 0 && <div className={styles.empty}>Nothing recorded yet.</div>}

      {meetings.map((m) => (
        <div className={styles.row} key={m.id}>
          <div className={styles.rowHead}>
            <button className={styles.rowTitle} onClick={() => void openMeeting(m.id)} type="button">
              {m.title ?? `Meeting ${m.id}`}
            </button>
            <span className={`${styles.badge} ${styles[m.status]}`}>{m.status}</span>
            <span className={styles.meta}>
              {when(m.started)} · {m.word_count} words
            </span>
            <select
              aria-label="File under project"
              className={styles.assign}
              onChange={(e) => void assign(m.id, e.target.value)}
              value={m.project_id ?? ""}
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {m.note && <div className={styles.rowNote}>{m.note}</div>}

          {open === m.id && (
            <>
              <ExtractionPanel busy={busy} detail={detail} onExtract={() => void extract(m.id)} />
              <div className={styles.full}>
                {detail.segments.length === 0 && (
                  <p className={styles.waiting}>No transcript kept for this meeting.</p>
                )}
                {detail.segments.map((s) => (
                  <p className={styles.line} key={s.id}>
                    <span className={styles.stamp}>{clock(s.start_ms)}</span>
                    {s.text}
                  </p>
                ))}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
};
