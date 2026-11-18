import { useState } from "react";

import type { Headsup } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

const NONE: Headsup[] = [];

const KIND_LABEL: Record<string, string> = {
  anniversary: "Anniversary",
  appointment: "Appointment",
  bill: "Bill",
  birthday: "Birthday",
  flight: "Flight",
  recurring: "Recurring",
};

/** A date-only value is a calendar day, not an instant: parsing it as UTC shifts it west of Greenwich. */
const parseDue = (iso: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
};

const whenText = (iso: string): string => {
  const due = parseDue(iso);
  const today = new Date();
  const days = Math.round(
    (Date.UTC(due.getFullYear(), due.getMonth(), due.getDate()) -
      Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) /
      86_400_000,
  );
  const day = due.toLocaleDateString([], { day: "numeric", month: "short", weekday: "short" });
  if (days === 0) return `today, ${day}`;
  if (days === 1) return `tomorrow, ${day}`;
  return days > 1 ? `in ${days} days, ${day}` : day;
};

const stateNote = (h: Headsup): string => {
  if (h.state === "snoozed" && h.snoozeUntil) return `snoozed until ${new Date(h.snoozeUntil).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  return h.state === "offered" ? "" : h.state;
};

/**
 * Things the assistant noticed coming up on your calendar. The morning push summarises them;
 * this is the full list, and where you answer. "Got it" and the other two are the same three
 * answers the phone will offer on the notification itself.
 */
export const HeadsupView = () => {
  const [showAll, setShowAll] = useState(false);
  const [items, refresh] = useResource(() => api.listHeadsups(showAll ? "all" : "open"), NONE);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const answer = async (h: Headsup, a: "later" | "never" | "yes"): Promise<void> => {
    await api.answerHeadsup(h.id, a);
    refresh();
  };

  const checkNow = async (): Promise<void> => {
    setBusy(true);
    setNote("");
    try {
      const r = await api.runHeadsups();
      const more = r.deferred ? ` (${r.deferred} more waiting for tomorrow)` : "";
      setNote(
        r.status === "sent"
          ? `Sent ${r.offered} heads-up${r.offered === 1 ? "" : "s"}${more}.`
          : r.status === "nothing"
            ? "Nothing new to mention right now."
            : r.status === "quiet"
              ? "It's quiet hours (9 pm to 7 am), so nothing was sent."
              : r.status === "disabled"
                ? "Heads-up is off. Google reads must be enabled in policy.json (and HEADSUP_ENABLED not false)."
                : `Couldn't check the calendar: ${r.errors.join("; ") || r.status}`,
      );
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Birthdays, anniversaries, bills, appointments and trips it noticed on your calendar. You get one summary each morning; answer here."
        title="Heads-up"
      />

      <div className={styles.toolbar}>
        <button className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={() => void checkNow()} type="button">
          {busy ? "Checking…" : "Check now"}
        </button>
        <label>
          <input
            checked={showAll}
            onChange={(e) => {
              setShowAll(e.target.checked);
              setTimeout(refresh, 0);
            }}
            type="checkbox"
          />{" "}
          Show history
        </label>
      </div>
      {note && <div className={styles.snippet}>{note}</div>}

      {items.length === 0 && <div className={styles.empty}>Nothing coming up that needs a heads-up.</div>}

      {items.map((h) => {
        const open = h.state === "offered" || h.state === "snoozed";
        const note2 = stateNote(h);
        return (
          <div className={styles.card} key={h.id}>
            <div className={styles.body}>
              <div className={`${styles.title} ${open ? "" : styles.done}`}>{h.subject}</div>
              <div className={styles.meta}>
                {KIND_LABEL[h.kind] ?? h.kind} · {whenText(h.dueAt)}
                {h.amount ? ` · ${h.amount}` : ""}
                {h.location ? ` · ${h.location}` : ""}
                {note2 ? ` · ${note2}` : ""}
              </div>
            </div>
            {open && (
              <>
                <button className={`${styles.button} ${styles.primary}`} onClick={() => void answer(h, "yes")} type="button">
                  Got it
                </button>
                <button className={styles.button} onClick={() => void answer(h, "later")} type="button">
                  Remind me tomorrow
                </button>
                <button className={styles.button} onClick={() => void answer(h, "never")} type="button">
                  Don&apos;t suggest this
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};
