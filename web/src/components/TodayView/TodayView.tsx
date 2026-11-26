import { useEffect, useState } from "react";

import type { Headsup, Spine, Today } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { liveLine } from "../../lib/moments.ts";
import { prepLine } from "../../lib/people.ts";
import {
  hoursUntil,
  todayBriefText,
  todayDoneLine,
  todayExpiryLine,
  todayFirstLine,
  todayLaterLine,
  todaySinceLabel,
  todayTaskLine,
  todayWaitingLine,
} from "../../lib/today.ts";
import { ApprovalCard } from "../ApprovalCard/ApprovalCard.tsx";
import { AskBar } from "../AskBar/AskBar.tsx";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import own from "./TodayView.module.css";

const NOTHING: null | Spine = null;
/** How often the screen reads again while it is open. It costs no model time, only a few queries. */
const REFRESH_MS = 60_000;

const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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
  onOpenView: (view: "headsup" | "meetings" | "schedules" | "tasks") => void;
}

/**
 * Everything waiting, on the screen the app opens on (PLAN-open-work section 14, U1 and U2).
 *
 * The server decides what is here and in what order; no model is asked. An approval's row is
 * one line, and Approve is not on it: opening the row shows the whole proposed action in the
 * same card a thread uses, and the buttons are there. A one-line preview with Approve beside
 * it would make approving a rubber stamp.
 */
export const TodayView = ({ onAsk, onChanged, onNewChat, onOpenConversation, onOpenPerson, onOpenRun, onOpenView }: TodayViewProps) => {
  const [error, setError] = useState("");
  const [today, refresh, setToday] = useResource(
    () =>
      api.spine().catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        return NOTHING;
      }),
    NOTHING,
  );
  const [open, setOpen] = useState<null | number>(null);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
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

  const nothing =
    today !== null &&
    today.approvals.length + today.tasks.length + today.headsups.length + today.since.length + today.threads.length + today.mail.length === 0;
  const nowMs = today ? Date.parse(today.now) : 0;

  return (
    <div className={styles.page}>
      <PageHeader subtitle="One line through the day: what ran, what needs you now, and what is ahead. Nothing here asks the model anything." title="Today" />

      <div className={styles.toolbar}>
        <button className={`${styles.button} ${styles.primary}`} onClick={onNewChat} type="button">
          New conversation
        </button>
        <button className={styles.button} onClick={reload} title="Reads again." type="button">
          Refresh
        </button>
        {today && (
          <button className={styles.button} disabled={speaking} onClick={() => void readAloud(todayBriefText(today.brief))} title="Reads the three lines below aloud, if the voice service is set up." type="button">
            {speaking ? "Reading…" : "Read aloud"}
          </button>
        )}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {today && (
        <div aria-label="Brief" className={own.brief}>
          <div>{todayDoneLine(today.brief.done)}</div>
          <div>{todayWaitingLine(today.brief.waiting)}</div>
          <div className={own.first}>{todayFirstLine(today.brief.first)}</div>
        </div>
      )}

      {today && (
        <div className={own.band}>
          <div className={own.bandLabel}>Behind</div>
          {today.since.length === 0 && <div className={own.quiet}>Nothing has run since you last looked.</div>}
      {today && today.since.length > 0 && (
        <section>
          <div className={own.sectionHead}>
            <div className={own.section}>Ran since you last looked ({today.since.length})</div>
            <button className={styles.button} onClick={() => void act(api.todaySeen)} title="Clears this list. New results will appear here as they finish." type="button">
              Seen
            </button>
          </div>
          {today.since.map((s) => (
            <div className={own.row} key={s.key}>
              <button
                className={own.rowMain}
                onClick={() => (s.runId !== null ? onOpenRun(s.runId) : onOpenView("schedules"))}
                type="button"
              >
                <span className={own.who}>{s.title}</span>
                <span className={s.kind === "ok" ? own.detail : own.urgent}>{todaySinceLabel(s.kind)}</span>
                <span className={own.detail}>{s.detail}</span>
              </button>
              <span className={own.when}>{when(s.at)}</span>
            </div>
          ))}
        </section>
      )}
        </div>
      )}

      {today && (
        <div className={`${own.band} ${own.now}`}>
          <div className={own.bandLabel}>Now</div>
          {today.live && (
            <div className={own.row}>
              <button className={own.rowMain} onClick={() => onOpenView("meetings")} type="button">
                <span className={own.urgent}>{liveLine(today.live.elapsedMs)}</span>
                <span className={own.who}>{today.live.title}</span>
              </button>
            </div>
          )}
      {nothing && <div className={own.quiet}>Nothing needs you right now.</div>}

      {today && today.approvals.length > 0 && (
        <section>
          <div className={own.section}>Waiting on you ({today.approvals.length})</div>
          {today.approvals.map((a) => (
            <div className={own.item} key={a.id}>
              <div className={own.row}>
                <button aria-expanded={open === a.id} className={own.rowMain} onClick={() => setOpen(open === a.id ? null : a.id)} type="button">
                  <span className={own.who}>{a.summary}</span>
                  <span className={a.expiringSoon ? own.urgent : own.detail}>{todayExpiryLine(hoursUntil(a.expiresAt, nowMs)) || a.tool}</span>
                </button>
                <button className={styles.button} onClick={() => setOpen(open === a.id ? null : a.id)} type="button">
                  {open === a.id ? "Hide" : "Review"}
                </button>
                {a.conversationId !== null && (
                  <button className={styles.button} onClick={() => onOpenConversation(a.conversationId as number)} title="Open the thread that asked." type="button">
                    Thread
                  </button>
                )}
                <button className={styles.button} onClick={() => void act(() => api.todayLater(`approval:${a.id}`))} title="Hides it here until tomorrow morning. It still expires when it would have." type="button">
                  Later
                </button>
              </div>
              {open === a.id && (
                <div className={own.full}>
                  <ApprovalCard confirmationId={a.id} onResolved={reload} summary={a.text} tool={a.tool} />
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {today && today.mail.length > 0 && (
        <section>
          <div className={own.section}>Mail from people ({today.mail.length})</div>
          {today.mail.map((m) => (
            <div className={own.row} key={m.key}>
              <span className={own.who}>{m.sender}</span>
              <span className={own.detail}>{m.subject}</span>
              <span className={styles.chip}>{m.bucket}</span>
            </div>
          ))}
        </section>
      )}

      {today && today.tasks.length > 0 && (
        <section>
          <div className={own.section}>Due ({today.tasks.length})</div>
          {today.tasks.map((t) => (
            <div className={own.row} key={t.id}>
              <button className={own.rowMain} onClick={() => onOpenView("tasks")} type="button">
                <span className={own.who}>{t.title}</span>
                <span className={t.overdue ? own.urgent : own.detail}>
                  {todayTaskLine(t)}
                  {t.overdue ? "" : ` · ${timeOf(t.due)}`}
                </span>
              </button>
              <button className={styles.button} onClick={() => void run(() => api.updateTask(t.id, { status: "done" }))} type="button">
                Done
              </button>
              <button className={styles.button} onClick={() => void act(() => api.todayLater(`task:${t.id}`))} title="Hides it here until tomorrow morning." type="button">
                Later
              </button>
            </div>
          ))}
        </section>
      )}

      {today && today.headsups.length > 0 && (
        <section>
          <div className={own.section}>Heads-up ({today.headsups.length})</div>
          {today.headsups.map((h: Headsup) => (
            <div className={own.row} key={h.id}>
              <button className={own.rowMain} onClick={() => onOpenView("headsup")} type="button">
                <span className={own.who}>{h.subject}</span>
                <span className={own.detail}>{[h.kind, h.amount].filter(Boolean).join(" · ")}</span>
              </button>
              <button className={`${styles.button} ${styles.primary}`} onClick={() => void run(() => api.answerHeadsup(h.id, "yes"))} type="button">
                {h.yesLabel}
              </button>
              <button className={styles.button} onClick={() => void run(() => api.answerHeadsup(h.id, "later"))} type="button">
                Remind me tomorrow
              </button>
            </div>
          ))}
        </section>
      )}

      {today && today.threads.length > 0 && (
        <section>
          <div className={own.section}>Replies you have not read ({today.threads.length})</div>
          {today.threads.map((c) => (
            <div className={own.row} key={c.id}>
              <button className={own.rowMain} onClick={() => onOpenConversation(c.id)} type="button">
                <span className={own.who}>{c.title}</span>
                <span className={own.detail}>{when(c.updated)}</span>
              </button>
              <button className={styles.button} onClick={() => void act(() => api.todayLater(`thread:${c.id}`))} title="Hides it here until tomorrow morning. The thread keeps its dot." type="button">
                Later
              </button>
            </div>
          ))}
        </section>
      )}

      {today && today.later > 0 && (
        <div className={own.laterLine}>
          <span>{todayLaterLine(today.later)}</span>
          <button className={styles.button} onClick={() => void act(api.todayLaterClear)} type="button">
            Bring them back
          </button>
        </div>
      )}
        </div>
      )}

      {today && (
        <div className={`${own.band} ${own.ahead}`}>
          <div className={own.bandLabel}>Ahead</div>
          {today.ahead.length === 0 && (
            <div className={own.quiet}>
              {today.calendarAsOf ? "Nothing else on the calendar or the schedules today." : "Nothing scheduled today. The calendar shows here once Heads-up or the check-in has read it."}
            </div>
          )}
          {today.ahead.map((a) => (
            <div className={own.row} key={a.key}>
              <button
                className={own.rowMain}
                disabled={a.kind !== "schedule" && a.personId == null}
                onClick={() => (a.kind === "schedule" ? onOpenView("schedules") : a.personId != null && onOpenPerson(a.personId))}
                type="button"
              >
                <span className={own.when}>{a.allDay ? "all day" : timeOf(a.at)}</span>
                <span className={own.who}>{a.title}</span>
                <span className={own.detail}>{a.kind === "schedule" ? `runs: ${a.detail}` : a.prep ? prepLine(a.prep) : a.detail}</span>
              </button>
            </div>
          ))}
          {today.calendarAsOf && <div className={own.asOf}>Calendar as of {when(today.calendarAsOf)}</div>}
        </div>
      )}

      <AskBar onAsk={onAsk} placeholder="Ask about your day…" />
    </div>
  );
};
