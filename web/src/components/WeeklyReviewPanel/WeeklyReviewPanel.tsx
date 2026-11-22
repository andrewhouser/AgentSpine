import { useState } from "react";

import type { LessonCard, OutboxReview, RetroCard, ReviewItem } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "./WeeklyReviewPanel.module.css";

const NONE: null | OutboxReview = null;

const SOURCE_LABELS: Record<string, string> = {
  digest: "Daily digest",
  headsup: "Heads-up",
  run: "Scheduled jobs",
  study: "Study",
  tool: "Watchers and briefs",
};

/** "the daily digest: morning" reads better in a sentence as "the daily digest (morning)". The server's topic string is a stable key, so the wording is fixed here. */
const sayTopic = (topic: string): string => {
  const at = topic.lastIndexOf(": ");
  return at < 0 ? topic : `${topic.slice(0, at)} (${topic.slice(at + 2)})`;
};

const RETRO_LABELS: Record<RetroCard["kind"], string> = {
  auto_approval: "Auto-approval",
  code_change: "Code change",
  memory_correction: "Memory correction",
  missing_capability: "Missing capability",
  recipe: "Recipe",
  routine: "Routine",
};

const OUTCOME_LABELS: Record<ReviewItem["outcome"], string> = {
  dismissed: "you swiped it away",
  ignored: "not opened",
  opened: "you opened it",
  pending: "delivered, not opened yet",
  unknown: "this channel cannot tell",
};

/**
 * Settings → Weekly review: what was sent to you in the last 7 days, with Useful and Skip this kind on
 * each, and a box for something you wish you had been told. Every figure is counted in SQL; no model is
 * involved. An answer writes memory only: it never edits profile.md, goals.md, policy.json or a schedule,
 * so "skip" makes the assistant quieter about a topic without switching anything off.
 */
export const WeeklyReviewPanel = () => {
  const [review, refresh] = useResource(api.outboxReview, NONE);
  const [wish, setWish] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  if (!review) return null;

  const run = async (work: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      setMessage(await work());
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const answer = (item: ReviewItem, value: "skip" | "useful"): Promise<void> =>
    run(async () => {
      const r = await api.answerOutbox(item.id, value);
      if (value === "useful") return "Noted.";
      return r.remembered
        ? `Noted. I will be quieter about ${sayTopic(r.topic)}.`
        : `Already noted: I am quieter about ${sayTopic(r.topic)}.`;
    });

  const answerCard = (card: RetroCard, value: "accept" | "reject"): Promise<void> =>
    run(async () => (await api.answerRetro(card.id, value)).message);

  const answerLesson = (card: LessonCard, value: "accept" | "reject"): Promise<void> =>
    run(async () => (await api.answerLesson(card.id, value)).message);

  const sendWish = (): Promise<void> =>
    run(async () => {
      const r = await api.sendOutboxWish(wish);
      setWish("");
      return r.remembered ? "Noted. I will bring up things like that." : "I already had that one.";
    });

  return (
    <section>
      <h2 className={styles.subhead}>Weekly review</h2>
      <p className={styles.note}>
        What I sent you in the last {review.days} days. Tell me which were useful and which kinds to skip. Skipping
        saves a note that I should not interrupt you about that kind again unless it is clearly more important; it
        does not switch anything off, and you can forget the note under Memory. Looking at this list marks it as seen.
        A Sunday evening push tells you when a week is ready.
      </p>

      {review.tally.length > 0 && (
        <ul className={styles.counts}>
          {review.tally.map((t) => (
            <li key={t.source}>
              {SOURCE_LABELS[t.source] ?? t.source}: {t.sent} sent
              {t.held > 0 && `, ${t.held} held`}
              {t.deduped > 0 && `, ${t.deduped} repeats removed`}
              {t.opened > 0 && `, ${t.opened} opened`}
              {t.dismissed > 0 && `, ${t.dismissed} dismissed`}
              {t.ignored > 0 && `, ${t.ignored} ignored`}
            </li>
          ))}
        </ul>
      )}

      {(review.quiet ?? []).length > 0 && (
        <>
          <p className={styles.note}>
            Kinds you mostly skip, over the last 90 days. Nothing is switched off. For a scheduled job at the top of
            the list, a proposal to turn it off waits in Approvals.
          </p>
          <ul className={styles.counts}>
            {review.quiet.map((q) => (
              <li key={`${q.source}:${q.kind}`}>
                {q.topic}: skipped {q.skipped} of {q.counted} ({Math.round(q.rate * 100)}%)
              </li>
            ))}
          </ul>
        </>
      )}

      {(review.lessons?.cards ?? []).length > 0 && (
        <>
          <p className={styles.note}>
            Lessons waiting for you ({review.lessons?.total}). No run can see these until you keep one. Keep a lesson only
            if it is true and you want similar future runs to follow it. It was written by a model that may have read web
            pages or mail.
          </p>
          {(review.lessons?.cards ?? []).map((card) => (
            <div className={styles.item} key={card.id}>
              <p className={styles.body}>{card.text}</p>
              <div className={styles.meta}>
                {card.source === "before_review" ? "Saved before lessons were reviewed" : "From a self-critique"}
                {card.runId !== null && `, run #${card.runId}`}
              </div>
              <div className={styles.actions}>
                <button className={styles.button} disabled={busy} onClick={() => void answerLesson(card, "accept")} type="button">
                  Keep
                </button>
                <button className={styles.button} disabled={busy} onClick={() => void answerLesson(card, "reject")} type="button">
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {(review.retro ?? []).length > 0 && (
        <>
          <p className={styles.note}>Ideas from your week. Nothing here has been changed.</p>
          {(review.retro ?? []).map((card) => (
            <div className={styles.item} key={card.id}>
              <div className={styles.title}>{card.title}</div>
              <div className={styles.meta}>
                {RETRO_LABELS[card.kind]}, from runs {card.runIds.map((id) => `#${id}`).join(", ")}
              </div>
              <p className={styles.body}>{card.why}</p>
              <div className={styles.actions}>
                <button className={styles.button} disabled={busy} onClick={() => void answerCard(card, "accept")} type="button">
                  {card.kind === "routine" ? "Queue for approval" : "Keep"}
                </button>
                <button className={styles.button} disabled={busy} onClick={() => void answerCard(card, "reject")} type="button">
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      <div className={styles.wish}>
        <input
          aria-label="Something I wish I'd been told"
          className={styles.input}
          maxLength={300}
          onChange={(e) => setWish(e.target.value)}
          placeholder="Something I wish I'd been told…"
          value={wish}
        />
        <button className={styles.button} disabled={busy || !wish.trim()} onClick={() => void sendWish()} type="button">
          Save
        </button>
      </div>

      {/* Always rendered, so an answer does not push the list down under the cursor. */}
      <div aria-live="polite" className={`${styles.status} ${styles.reserved}`}>
        {message}
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {review.items.length === 0 && <div className={styles.empty}>Nothing to review yet.</div>}
      {review.items.length > 0 && <p className={styles.note}>Useful also clears an earlier Skip for that kind of message.</p>}

      {review.items.map((item) => (
        <div className={styles.item} key={item.id}>
          <div className={styles.title}>{item.title}</div>
          <div className={styles.meta}>
            {SOURCE_LABELS[item.source] ?? item.source} · {new Date(item.created).toLocaleString()} ·{" "}
            {OUTCOME_LABELS[item.outcome]}
          </div>
          {item.body && <p className={styles.body}>{item.body}</p>}
          <div className={styles.actions}>
            <button
              aria-pressed={item.feedback === "useful"}
              className={`${styles.button} ${item.feedback === "useful" ? styles.chosen : ""}`}
              disabled={busy}
              onClick={() => void answer(item, "useful")}
              type="button"
            >
              Useful
            </button>
            <button
              aria-pressed={item.feedback === "skip"}
              className={`${styles.button} ${item.feedback === "skip" ? styles.chosen : ""}`}
              disabled={busy}
              onClick={() => void answer(item, "skip")}
              title={`Files a note about: ${item.topic}`}
              type="button"
            >
              Skip this kind
            </button>
          </div>
        </div>
      ))}
    </section>
  );
};
