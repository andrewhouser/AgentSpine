import { useEffect, useState } from "react";

import type { Spine, Today } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { liveLine } from "../../lib/moments.ts";
import { prepLine } from "../../lib/people.ts";
import {
  hoursUntil,
  todayBriefText,
  todayExpiryLine,
  todayEyebrow,
  todayFirstLine,
  todayLaterLine,
  todaySinceLabel,
  todaySummaryLine,
  todayTaskLine,
} from "../../lib/today.ts";
import { ApprovalCard } from "../ApprovalCard/ApprovalCard.tsx";
import { AskBar } from "../AskBar/AskBar.tsx";
import { DecisionPanel } from "../DecisionPanel/DecisionPanel.tsx";
import { Icon } from "../Icon/Icon.tsx";
import own from "./TodayView.module.css";

const NOTHING: null | Spine = null;
/** How often the screen reads again while it is open. It costs no model time, only a few queries. */
const REFRESH_MS = 60_000;
/** Below this width the decision panel would squeeze the line, so an approval opens inline instead. */
const PANEL_MIN_WIDTH = 1100;

const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", hour12: false, minute: "2-digit" });
const dayTime = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

const wide = (): boolean => typeof window !== "undefined" && window.matchMedia(`(min-width: ${PANEL_MIN_WIDTH}px)`).matches;

/** The greeting. Plain words, the same every day; what changes is the line under it, which code writes. */
const GREETING = "A little clarity for your day.";

interface TodayViewProps {
  /** The ask bar: start an ordinary chat turn with this text, scoped to nothing (section 15, R1). */
  onAsk: (text: string) => Promise<void>;
  /** Something here was answered, so the sidebar's dots and the tab title should be read again. */
  onChanged: () => void;
  onNewChat: () => void;
  onOpenConversation: (id: number) => void;
  /** A 1:1 on the line opens that person's page and its "For today" (section 15, R9). */
  onOpenPerson: (id: number) => void;
  onOpenRun: (id: number) => void;
  onOpenView: (view: "activity" | "headsup" | "meetings" | "schedules" | "tasks") => void;
}

/**
 * Today, as the 2026-11-26 redesign draws it: a date, a greeting and one line of what happened and what
 * needs you, then the spine's three bands (Behind, Now, Ahead) and the ask bar. On a wide screen the
 * approval you picked (else the first waiting) sits beside it as "Your decision"; on a narrow one it opens
 * inline, in the same card a thread uses. The server decides what is here and in what order; no model is
 * asked. Approve is never on a row: it lives only in the card, held.
 */
export const TodayView = ({ onAsk, onChanged, onOpenConversation, onOpenPerson, onOpenRun, onOpenView }: TodayViewProps) => {
  const [error, setError] = useState("");
  const [today, refresh, setToday] = useResource(
    () =>
      api.spine().catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        return NOTHING;
      }),
    NOTHING,
  );
  const [chosen, setChosen] = useState<null | number>(null);
  const [isWide, setWide] = useState(wide);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    const q = window.matchMedia(`(min-width: ${PANEL_MIN_WIDTH}px)`);
    const onChange = (): void => setWide(q.matches);
    q.addEventListener("change", onChange);
    return () => {
      clearInterval(timer);
      q.removeEventListener("change", onChange);
    };
  }, [refresh]);

  const reload = (): void => {
    setError("");
    refresh();
    onChanged();
  };

  const act = async (fn: () => Promise<Today>): Promise<void> => {
    setError("");
    try {
      // "Later" and "Seen" answer with Today, so it is shown without a second read; Ahead is kept as it was.
      const next = await fn();
      setToday(today ? { ...today, ...next } : null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      reload();
    }
  };

  const readAloud = async (text: string): Promise<void> => {
    setSpeaking(true);
    setError("");
    try {
      const url = URL.createObjectURL(await api.speak(text));
      const audio = new Audio(url);
      audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
    } catch (err) {
      setError(`Could not read it aloud: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSpeaking(false);
    }
  };

  if (!today) return <div className={own.page}>{error && <div className={own.error}>{error}</div>}</div>;

  const nowMs = Date.parse(today.now);
  const needs = today.approvals.length + today.tasks.length + today.headsups.length + today.threads.length + today.mail.length;
  // The panel holds the approval you picked, else the first one waiting (oldest first, as the server orders).
  const panelId = isWide ? (chosen !== null && today.approvals.some((a) => a.id === chosen) ? chosen : (today.approvals[0]?.id ?? null)) : null;

  return (
    <div className={`${own.layout} ${panelId !== null ? own.withPanel : ""}`}>
      <div className={own.page}>
        <div className={own.eyebrowRow}>
          <span className={own.eyebrow}>{todayEyebrow(today.now)}</span>
          <span className={own.tools}>
            <button className={own.quiet} onClick={reload} title="Reads again." type="button">
              Refresh
            </button>
            <button className={own.quiet} disabled={speaking} onClick={() => void readAloud(todayBriefText(today.brief))} title="Reads the summary aloud, if the voice service is set up." type="button">
              {speaking ? "Reading…" : "Read aloud"}
            </button>
          </span>
        </div>
        <h1 className={own.greeting}>{GREETING}</h1>
        <p className={own.summary}>{todaySummaryLine(today.brief)}</p>
        <p className={own.first}>{todayFirstLine(today.brief.first)}</p>

        {error && <div className={own.error}>{error}</div>}

        <section className={own.band}>
          <h2 className={own.bandLabel}>Behind</h2>
          {(today.undo ?? []).map((u) => (
            <div className={own.row} key={`undo-${u.actionId}`}>
              <span className={own.mark}>
                <Icon name="check" size={14} />
              </span>
              <span className={own.main}>{u.line}</span>
              <button className={own.chipButton} onClick={() => void run(() => api.undoAction(u.actionId))} title="Offered for a few minutes after it happened" type="button">
                Undo: {u.undoLine}
              </button>
              <span className={own.time}>{timeOf(u.at)}</span>
            </div>
          ))}
          {today.since.length === 0 && (today.undo ?? []).length === 0 && <div className={own.quietLine}>Nothing has run since you last looked.</div>}
          {today.since.map((s) => (
            <button className={own.row} key={s.key} onClick={() => (s.runId !== null ? onOpenRun(s.runId) : onOpenView("schedules"))} title={s.detail} type="button">
              <span className={`${own.mark} ${s.kind === "ok" ? "" : own.markBad}`}>{s.kind === "ok" ? <Icon name="check" size={14} /> : "!"}</span>
              <span className={own.main}>
                {s.title}
                {s.kind !== "ok" && <span className={own.bad}> · {todaySinceLabel(s.kind)}</span>}
              </span>
              <span className={own.time}>{timeOf(s.at)}</span>
            </button>
          ))}
          <div className={own.bandFoot}>
            <button className={own.link} onClick={() => onOpenView("activity")} type="button">
              View activity
            </button>
            {today.since.length > 0 && (
              <button className={own.link} onClick={() => void act(api.todaySeen)} title="Clears this list. New results appear as they finish." type="button">
                Seen
              </button>
            )}
          </div>
        </section>

        <section className={`${own.band} ${own.now}`}>
          <h2 className={own.bandLabel}>
            Now {needs > 0 && <span className={own.needPill}>{needs} need you</span>}
          </h2>
          {today.live && (
            <button className={`${own.card} ${own.cardLive}`} onClick={() => onOpenView("meetings")} type="button">
              <span className={own.cardMain}>
                <span className={own.cardTitle}>{today.live.title}</span>
                <span className={own.cardSub}>{liveLine(today.live.elapsedMs)}</span>
              </span>
              <Icon name="arrow" />
            </button>
          )}
          {needs === 0 && !today.live && <div className={own.quietLine}>Nothing needs you right now.</div>}

          {today.approvals.map((a) => {
            const selected = panelId === a.id;
            const expiry = todayExpiryLine(hoursUntil(a.expiresAt, nowMs));
            return (
              <div key={a.id}>
                <div className={`${own.card} ${selected ? own.cardSelected : ""}`}>
                  <button className={own.cardMain} onClick={() => setChosen(isWide ? a.id : chosen === a.id ? null : a.id)} type="button">
                    <span className={own.cardTitle}>{a.summary}</span>
                    <span className={`${own.cardSub} ${a.expiringSoon ? own.bad : ""}`}>{expiry || a.tool}</span>
                  </button>
                  <span className={own.chip}>Needs approval</span>
                  <button className={own.quiet} onClick={() => void act(() => api.todayLater(`approval:${a.id}`))} title="Hides it here until tomorrow morning. Its own expiry is unchanged." type="button">
                    Later
                  </button>
                  {a.conversationId !== null && (
                    <button aria-label="Open the thread" className={own.iconButton} onClick={() => onOpenConversation(a.conversationId as number)} title="Open the thread" type="button">
                      <Icon name="arrow" />
                    </button>
                  )}
                </div>
                {!isWide && chosen === a.id && <ApprovalCard confirmationId={a.id} onResolved={reload} summary={a.text} tool={a.tool} />}
              </div>
            );
          })}

          {today.tasks.map((t) => (
            <div className={own.row} key={`t-${t.id}`}>
              <button aria-label={`Done: ${t.title}`} className={own.check} onClick={() => void run(() => api.updateTask(t.id, { status: "done" }))} title="Mark done" type="button" />
              <button className={own.main} onClick={() => onOpenView("tasks")} type="button">
                <span className={own.title}>{t.title}</span>
                {t.waitingOn && <span className={own.sub}>{todayTaskLine(t)}</span>}
              </button>
              <span className={t.overdue ? own.bad : own.dueText}>{t.overdue ? "Overdue" : `Due ${timeOf(t.due)}`}</span>
              <button className={own.quiet} onClick={() => void act(() => api.todayLater(`task:${t.id}`))} type="button">
                Later
              </button>
            </div>
          ))}

          {today.mail.map((m) => (
            <div className={own.row} key={m.key}>
              <span className={own.mark}>
                <Icon name="doc" size={14} />
              </span>
              <span className={own.main}>
                <span className={own.title}>{m.sender}</span>
                <span className={own.sub}>{m.subject}</span>
              </span>
              <span className={m.bucket === "urgent" ? own.chip : own.chipQuiet}>{m.bucket === "reply-today" ? "Reply today" : m.bucket === "urgent" ? "Urgent" : "FYI"}</span>
            </div>
          ))}

          {today.headsups.map((h) => (
            <div className={own.row} key={`h-${h.id}`}>
              <span className={own.mark}>
                <Icon name="calendar" size={14} />
              </span>
              <button className={own.main} onClick={() => onOpenView("headsup")} type="button">
                <span className={own.title}>{h.subject}</span>
                <span className={own.sub}>{[h.kind, h.amount ?? ""].filter(Boolean).join(" · ")}</span>
              </button>
              <button className={own.chipButton} onClick={() => void run(() => api.answerHeadsup(h.id, "yes"))} type="button">
                {h.yesLabel}
              </button>
              <button className={own.quiet} onClick={() => void run(() => api.answerHeadsup(h.id, "later"))} type="button">
                Tomorrow
              </button>
            </div>
          ))}

          {today.threads.map((c) => (
            <div className={own.row} key={`c-${c.id}`}>
              <span className={own.mark}>
                <Icon name="ask" size={14} />
              </span>
              <button className={own.main} onClick={() => onOpenConversation(c.id)} type="button">
                <span className={own.title}>{c.title}</span>
                <span className={own.sub}>A reply you have not read · {dayTime(c.updated)}</span>
              </button>
              <button className={own.quiet} onClick={() => void act(() => api.todayLater(`thread:${c.id}`))} type="button">
                Later
              </button>
            </div>
          ))}

          {today.later > 0 && (
            <div className={own.laterLine}>
              <span>{todayLaterLine(today.later)}</span>
              <button className={own.link} onClick={() => void act(api.todayLaterClear)} type="button">
                Bring them back
              </button>
            </div>
          )}
        </section>

        <section className={`${own.band} ${own.ahead}`}>
          <h2 className={own.bandLabel}>Ahead</h2>
          {today.ahead.length === 0 && (
            <div className={own.quietLine}>
              {today.calendarAsOf ? "Nothing else on the calendar or the schedules today." : "Nothing scheduled today. The calendar shows here once Heads-up or the check-in has read it."}
            </div>
          )}
          {today.ahead.map((a) => (
            <button
              className={own.aheadRow}
              disabled={a.kind !== "schedule" && a.personId == null}
              key={a.key}
              onClick={() => (a.kind === "schedule" ? onOpenView("schedules") : a.personId != null && onOpenPerson(a.personId))}
              type="button"
            >
              <span className={own.aheadTime}>{a.allDay ? "all day" : timeOf(a.at)}</span>
              <span className={own.main}>
                <span className={own.title}>{a.title}</span>
                {a.prep && <span className={own.sub}>{prepLine(a.prep)}</span>}
                {!a.prep && a.kind === "event" && a.detail && <span className={own.sub}>{a.detail}</span>}
              </span>
              {a.kind === "schedule" && <span className={own.chipQuiet}>Scheduled</span>}
            </button>
          ))}
          {today.calendarAsOf && <div className={own.asOf}>Calendar as of {dayTime(today.calendarAsOf)}</div>}
        </section>

        <AskBar onAsk={onAsk} placeholder="What would you like to move forward?" />
      </div>

      {panelId !== null && <DecisionPanel confirmationId={panelId} key={panelId} onResolved={reload} />}
    </div>
  );
};
