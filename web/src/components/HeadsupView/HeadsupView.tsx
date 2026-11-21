import { useEffect, useState } from "react";

import type { Headsup, HeadsupCard, HeadsupDates } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api, authedPath } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import results from "./HeadsupView.module.css";

const NONE: Headsup[] = [];
const NO_DATES: HeadsupDates = { proposals: [], remembered: [] };

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

const seenOn = (iso: string): string => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

const Card = ({ c }: { c: HeadsupCard }) => (
  <a className={results.item} href={c.url} rel="noopener noreferrer nofollow" target="_blank">
    {c.imageUrl ? <img alt="" className={results.photo} loading="lazy" src={authedPath(c.imageUrl)} /> : <div className={results.noPhoto}>no photo</div>}
    <div className={results.itemTitle}>{c.title}</div>
    {c.kind === "gift" && <div className={results.price}>{c.priceText ?? "no price available"}</div>}
    <div className={results.small}>{c.host}</div>
    {c.note && <div className={results.small}>{c.note}</div>}
    {c.priceText && <div className={results.small}>seen {seenOn(c.fetchedAt)}</div>}
  </a>
);

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
  const [dates, refreshDates] = useResource(() => api.listHeadsupDates(), NO_DATES);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const answer = async (h: Headsup, a: "later" | "never" | "yes"): Promise<void> => {
    await api.answerHeadsup(h.id, a);
    refresh();
  };

  const research = async (h: Headsup): Promise<void> => {
    await api.researchHeadsup(h.id);
    refresh();
  };

  // Research runs in the background after "yes". Poll while any is still looking, then stop.
  const looking = items.some((h) => h.yesAction === "research" && h.state === "accepted" && h.cards.length === 0 && !h.researchError);
  useEffect(() => {
    if (!looking) return;
    // Capped at two minutes: an item accepted before research existed never gets cards, and must
    // not keep the page polling for as long as it is open.
    let ticks = 0;
    const t = setInterval(() => {
      if (++ticks > 30) return clearInterval(t);
      refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [looking, refresh]);

  const decide = async (confirmationId: number, yes: boolean): Promise<void> => {
    await (yes ? api.approveConfirmation(confirmationId) : api.rejectConfirmation(confirmationId, ""));
    refreshDates();
  };

  const forget = async (id: number): Promise<void> => {
    await api.deleteHeadsupDate(id);
    refreshDates();
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
              ? "It's quiet hours (9 pm to 6 am), so nothing was sent."
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
                  {h.yesLabel}
                </button>
                <button className={styles.button} onClick={() => void answer(h, "later")} type="button">
                  Remind me tomorrow
                </button>
                <button className={styles.button} onClick={() => void answer(h, "never")} type="button">
                  Don&apos;t suggest this
                </button>
              </>
            )}
            {h.watch && (
              <div className={results.results}>
                <div className={results.status}>
                  {h.watch.active ? (h.watch.kind === "flight" ? "Tracking this flight" : "Watching traffic") : h.watch.kind === "flight" ? "Flight tracking ended" : "Traffic watch ended"}
                  {h.watch.note ? `: ${h.watch.note}` : ""}
                </div>
                {h.watch.lastPolled && <div className={results.status}>Last checked {new Date(h.watch.lastPolled).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</div>}
              </div>
            )}
            {h.yesAction === "research" && (h.state === "accepted" || h.state === "researched") && (
              <div className={results.results}>
                {h.cards.length > 0 ? (
                  <>
                    <div className={results.grid}>
                      {h.cards.map((c) => (
                        <Card c={c} key={c.id} />
                      ))}
                    </div>
                    {h.query && <div className={results.status}>Searched for: “{h.query}”. No names are ever sent.</div>}
                    {h.researchNote && <div className={results.status}>{h.researchNote}.</div>}
                  </>
                ) : h.researchError ? (
                  <div className={results.status}>Couldn&apos;t finish looking: {h.researchError}</div>
                ) : (
                  <div className={results.status}>Looking…</div>
                )}
                <div className={results.actions}>
                  <button className={styles.button} onClick={() => void research(h)} type="button">
                    {h.cards.length > 0 ? "Look again" : "Try again"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {dates.proposals.length > 0 && (
        <>
          <PageHeader subtitle="You mentioned these in chat. Nothing is remembered until you say so." title="Dates it noticed" />
          {dates.proposals.map((p) => (
            <div className={styles.card} key={p.confirmationId}>
              <div className={styles.body}>
                <div className={styles.title}>{p.summary.split("\n")[0].replace("REMEMBER A DATE: ", "")}</div>
                <div className={styles.meta}>{p.summary.split("\n")[1] ?? ""}</div>
              </div>
              <button className={`${styles.button} ${styles.primary}`} onClick={() => void decide(p.confirmationId, true)} type="button">
                Remember it
              </button>
              <button className={styles.button} onClick={() => void decide(p.confirmationId, false)} type="button">
                Not a date
              </button>
            </div>
          ))}
        </>
      )}

      {dates.remembered.length > 0 && (
        <>
          <PageHeader subtitle="Dates you told it. Anything already on your calendar isn't repeated." title="Dates it remembers" />
          {dates.remembered.map((d) => (
            <div className={styles.card} key={d.id}>
              <div className={styles.body}>
                <div className={styles.title}>{d.title}</div>
              </div>
              <button className={styles.button} onClick={() => void forget(d.id)} type="button">
                Forget
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
};
