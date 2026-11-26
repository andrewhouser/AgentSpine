import { useEffect, useState } from "react";

import type { Headsup, HeadsupCard, HeadsupDate, HeadsupDateEdit, HeadsupDates, HeadsupPreview } from "../../lib/types.ts";

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
  booking: "Booking",
  flight: "Flight",
  recurring: "Recurring",
};

/** What became of one reminder, in a word. The reason, when there is one, follows it. */
const REMINDER_STATE: Record<string, string> = {
  pending: "to come",
  sent: "sent",
  skipped: "skipped",
  withdrawn: "withdrawn",
};

const REASON_LABEL: Record<string, string> = {
  changed: "details changed",
  new: "first mention",
  reminder: "reminder",
  snoozed: "back from snooze",
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

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The form's fields as typed. Kept as strings so a half-typed day is not turned into a number early. */
interface DateDraft {
  day: string;
  id: number;
  month: number;
  occasion: string;
  who: string;
  year: string;
}

const draftOf = (d: HeadsupDate): DateDraft => ({ day: String(d.day), id: d.id, month: d.month, occasion: d.occasion, who: d.who, year: d.year ? String(d.year) : "" });

/** What is sent. The server reads it with the rules the `date_remember` tool uses, and says what is wrong. */
const editOf = (d: DateDraft): HeadsupDateEdit => ({ day: Number(d.day), month: d.month, occasion: d.occasion, who: d.who.trim(), year: d.year.trim() ? Number(d.year) : null });

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
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<HeadsupPreview | null>(null);

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

  const [draft, setDraft] = useState<DateDraft | null>(null);
  const [draftError, setDraftError] = useState("");
  const [dateNote, setDateNote] = useState("");

  /**
   * Save a corrected date. Yours to change without a question, unlike a date the assistant
   * proposes. A card made from the old date is withdrawn on the server, so the list of
   * heads-ups is read again too.
   */
  const saveDate = async (): Promise<void> => {
    if (!draft) return;
    setDraftError("");
    try {
      const r = await api.updateHeadsupDate(draft.id, editOf(draft));
      setDraft(null);
      setDateNote(r.withdrawn > 0 ? "Saved. The heads-up made from the old date was withdrawn; the new date will be offered when it is close." : "Saved.");
      refreshDates();
      refresh();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    }
  };

  /** What Check now would send, without sending or recording anything. */
  const previewNow = async (): Promise<void> => {
    setPreviewing(true);
    setNote("");
    try {
      setPreview(await api.previewHeadsups());
    } catch (err) {
      setPreview(null);
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const checkNow = async (): Promise<void> => {
    setBusy(true);
    setNote("");
    setPreview(null);
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
        subtitle="Birthdays, anniversaries, bills, appointments, bookings and trips it noticed on your calendar. You get one summary each morning; answer here."
        title="Heads-up"
      />

      <div className={styles.toolbar}>
        <button className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={() => void checkNow()} type="button">
          {busy ? "Checking…" : "Check now"}
        </button>
        <button className={styles.button} disabled={previewing} onClick={() => void previewNow()} title="Shows what Check now would send. Nothing is sent or recorded." type="button">
          {previewing ? "Looking…" : "Preview"}
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
      {preview && (
        <div className={styles.snippet}>
          <div>
            {preview.offers.length
              ? `Check now would offer ${preview.offers.length}. Nothing was sent or recorded.`
              : preview.deferred
                ? "Nothing would go out right now: it's quiet hours or the daily limit is reached. Nothing was sent or recorded."
                : "Nothing would be offered right now. Nothing was sent or recorded."}
            {preview.deferred > 0 && preview.offers.length > 0 ? ` ${preview.deferred} more would wait for tomorrow.` : ""}
          </div>
          <ul>
            {preview.offers.map((o) => (
              <li key={`${o.kind}:${o.subject}`}>
                {o.subject} · {KIND_LABEL[o.kind] ?? o.kind} · {o.daysUntil === 0 ? "today" : o.daysUntil === 1 ? "tomorrow" : `in ${o.daysUntil} days`} · {REASON_LABEL[o.reason]}
              </li>
            ))}
          </ul>
          {preview.errors.length > 0 && <div>Couldn&apos;t read everything: {preview.errors.join("; ")}</div>}
        </div>
      )}

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
            {h.yesAction === "remind" && (h.reminders?.length ?? 0) > 0 && (
              <div className={results.results}>
                {h.researchNote && <div className={results.status}>{h.researchNote}</div>}
                {h.reminders?.map((m) => (
                  <div className={results.status} key={m.step}>
                    {m.label}, {new Date(m.dueAt).toLocaleString([], { day: "numeric", hour: "numeric", minute: "2-digit", month: "short", weekday: "short" })}:{" "}
                    {REMINDER_STATE[m.state] ?? m.state}
                    {m.reason ? ` (${m.reason})` : ""}
                  </div>
                ))}
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
          {dateNote && <div className={styles.snippet}>{dateNote}</div>}
          {dates.remembered.map((d) =>
            draft?.id === d.id ? (
              <form
                className={styles.card}
                key={d.id}
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveDate();
                }}
              >
                <div className={`${styles.body} ${results.edit}`}>
                  <input aria-label="Who" autoFocus className={results.field} onChange={(e) => setDraft({ ...draft, who: e.target.value })} placeholder="Name, or a relation like my wife" value={draft.who} />
                  <select aria-label="Kind" className={results.field} onChange={(e) => setDraft({ ...draft, occasion: e.target.value })} value={draft.occasion}>
                    <option value="birthday">Birthday</option>
                    <option value="anniversary">Anniversary</option>
                  </select>
                  <select aria-label="Month" className={results.field} onChange={(e) => setDraft({ ...draft, month: Number(e.target.value) })} value={draft.month}>
                    {MONTHS.map((name, i) => (
                      <option key={name} value={i + 1}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <input aria-label="Day" className={`${results.field} ${results.narrow}`} inputMode="numeric" onChange={(e) => setDraft({ ...draft, day: e.target.value })} placeholder="Day" value={draft.day} />
                  <input
                    aria-label="Year, if you know it"
                    className={`${results.field} ${results.narrow}`}
                    inputMode="numeric"
                    onChange={(e) => setDraft({ ...draft, year: e.target.value })}
                    placeholder="Year (optional)"
                    value={draft.year}
                  />
                  {draftError && <div className={styles.error}>{draftError}</div>}
                </div>
                <button className={`${styles.button} ${styles.primary}`} type="submit">
                  Save
                </button>
                <button
                  className={styles.button}
                  onClick={() => {
                    setDraft(null);
                    setDraftError("");
                  }}
                  type="button"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <div className={styles.card} key={d.id}>
                <div className={styles.body}>
                  <div className={styles.title}>{d.title}</div>
                  {d.year ? <div className={styles.meta}>Since {d.year}</div> : null}
                </div>
                <button
                  className={styles.button}
                  onClick={() => {
                    setDraft(draftOf(d));
                    setDraftError("");
                    setDateNote("");
                  }}
                  type="button"
                >
                  Edit
                </button>
                <button className={styles.button} onClick={() => void forget(d.id)} type="button">
                  Forget
                </button>
              </div>
            ),
          )}
        </>
      )}
    </div>
  );
};
