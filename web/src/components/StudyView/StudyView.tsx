import { useState } from "react";

import type { StudyDueCard, StudyOverview, StudyReview, StudyTopic } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import styles from "./StudyView.module.css";

const EMPTY: StudyOverview = { due: 0, topics: [] };
const MISS = 0.7;

const nextText = (r: StudyReview): string =>
  r.interval > 0 ? `Next review in ${r.interval} day${r.interval === 1 ? "" : "s"}.` : "It comes back in about 10 minutes.";

/**
 * The study screen: review due cards, and see where each topic stands.
 *
 * Review is the loop spaced repetition lives on, and as a chat it was a round trip per card.
 * Here it's question, your answer, grade, next. You type the recall BEFORE the answer is shown,
 * because a self-rated "I knew that" is the feeling rereading produces, not evidence. The
 * server grades what you wrote, the same way `study_cards review` does in chat.
 *
 * Everything else (interview, map, quiz, explain-back, sparring) stays in chat, where a back
 * and forth is the point. The topic cards say which one to reach for next.
 */
export const StudyView = () => {
  const [overview, refresh] = useResource(api.studyOverview, EMPTY);
  const [queue, setQueue] = useState<null | StudyDueCard[]>(null);
  const [filter, setFilter] = useState<null | number>(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<null | StudyReview>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reviewed, setReviewed] = useState(0);

  const card = queue?.[0] ?? null;

  const start = async (topic: null | number): Promise<void> => {
    setError("");
    setFilter(topic);
    setReviewed(0);
    setResult(null);
    setAnswer("");
    try {
      setQueue(await api.listStudyDue(topic ?? undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async (given: string): Promise<void> => {
    if (!card || busy) return;
    setBusy(true);
    setError("");
    try {
      setResult(await api.reviewStudyCard(card.id, given));
      setReviewed((n) => n + 1);
    } catch (err) {
      // A 503 leaves the card untouched, so the same answer can simply be sent again.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const next = async (): Promise<void> => {
    setResult(null);
    setAnswer("");
    const rest = (queue ?? []).slice(1);
    // At the end of the list, ask again: a card missed earlier is due again after 10 minutes.
    setQueue(rest.length ? rest : await api.listStudyDue(filter ?? undefined));
    refresh();
  };

  const stop = (): void => {
    setQueue(null);
    setResult(null);
    setAnswer("");
    refresh();
  };

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Recall first, then the answer. Everything else (interview, map, quiz, explain-back, sparring) happens in chat."
        title="Study"
      />

      {queue === null ? (
        <section className={styles.panel}>
          <div className={styles.dueLine}>
            <span className={styles.dueCount}>{overview.due}</span>
            <span>card{overview.due === 1 ? "" : "s"} due</span>
          </div>
          {overview.due > 0 ? (
            <div className={styles.startRow}>
              <button className={styles.primary} onClick={() => void start(null)} type="button">
                Review all
              </button>
              {overview.topics
                .filter((t) => t.due > 0)
                .map((t) => (
                  <button className={styles.button} key={t.id} onClick={() => void start(t.id)} type="button">
                    {t.name} · {t.due}
                  </button>
                ))}
            </div>
          ) : (
            <p className={styles.hint}>
              Nothing due. Cards come back when their interval runs out
              {overview.topics.length ? "" : ". Start a topic in chat: “I'm learning X, interview me”"}.
            </p>
          )}
          {error && <div className={styles.error}>{error}</div>}
        </section>
      ) : card === null ? (
        <section className={styles.panel}>
          <p className={styles.doneLine}>
            {reviewed ? `Done: ${reviewed} card${reviewed === 1 ? "" : "s"} reviewed.` : "Nothing due right now."}
          </p>
          <button className={styles.button} onClick={stop} type="button">
            Back to topics
          </button>
        </section>
      ) : (
        <section className={styles.panel}>
          <div className={styles.cardTop}>
            <span className={styles.topic}>{card.topicName}</span>
            <span className={styles.progress}>
              {reviewed} done · {queue.length - (result ? 1 : 0)} left
            </span>
          </div>
          <p className={styles.front}>{card.front}</p>

          {result === null ? (
            <>
              <textarea
                aria-label="Your answer, from memory"
                autoFocus
                className={styles.answer}
                disabled={busy}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && answer.trim()) void submit(answer);
                }}
                placeholder="Answer from memory. It doesn't need to be word for word."
                rows={3}
                value={answer}
              />
              {error && <div className={styles.error}>{error}</div>}
              <div className={styles.actions}>
                <button
                  className={styles.primary}
                  disabled={busy || !answer.trim()}
                  onClick={() => void submit(answer)}
                  type="button"
                >
                  {busy ? "Grading…" : "Check"}
                </button>
                <button className={styles.button} disabled={busy} onClick={() => void submit("")} type="button">
                  I don't know
                </button>
                <button className={styles.quiet} disabled={busy} onClick={stop} type="button">
                  Stop
                </button>
              </div>
            </>
          ) : (
            <>
              <div className={result.score >= MISS ? styles.verdictOk : styles.verdictMiss}>
                <strong>{Math.round(result.score * 100)}%</strong> {result.feedback}
              </div>
              <div className={styles.backLabel}>Answer</div>
              <p className={styles.back}>{result.back}</p>
              <p className={styles.hint}>{nextText(result)}</p>
              <div className={styles.actions}>
                <button autoFocus className={styles.primary} onClick={() => void next()} type="button">
                  Next card
                </button>
                <button className={styles.quiet} onClick={stop} type="button">
                  Stop
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <h2 className={styles.subhead}>Topics</h2>
      {overview.topics.length === 0 && (
        <div className={styles.empty}>
          No topics yet. In a chat, try “I'm learning statistics, interview me” or “map out Okta for me”.
        </div>
      )}
      {overview.topics.map((t) => (
        <TopicCard key={t.id} topic={t} />
      ))}
    </div>
  );
};

/** The next thing to do with a topic, in the order the study tools build on each other. */
const suggestion = (t: StudyTopic): string => {
  if (!t.goal) return "Next: “interview me about this” sets the goal and level.";
  if (!t.map.length) return "Next: “map this out” builds the curriculum.";
  if (t.level == null) return "Next: “quiz me” finds your level.";
  if (t.consumed > t.produced) return "You've read more than you've produced. Try “quiz me” or explain it back.";
  return "Keep going: “quiz me”, explain a module back, or spar on it.";
};

const TopicCard = ({ topic: t }: { topic: StudyTopic }) => (
  <div className={styles.topicCard}>
    <div className={styles.topicTop}>
      <span className={styles.topicName}>{t.name}</span>
      {t.projectId != null && <span className={styles.badge}>project · local only</span>}
      <span className={styles.level} title="Level from the examiner, 0–5">
        {[1, 2, 3, 4, 5].map((n) => (
          <span className={t.level != null && n <= t.level ? styles.pipOn : styles.pip} key={n} />
        ))}
        <span className={styles.levelText}>{t.level != null ? `${t.level}/5` : "level ?"}</span>
      </span>
    </div>
    {t.goal && <p className={styles.goal}>{t.goal}</p>}
    <div className={styles.stats}>
      {t.cards} card{t.cards === 1 ? "" : "s"} · {t.due} due · last 14 days: {t.produced} produced, {t.consumed} read
    </div>
    {t.map.length > 0 && (
      <details className={styles.map}>
        <summary>Curriculum · {t.map.length} modules</summary>
        <ol>
          {t.map.map((m) => (
            <li key={m.name}>
              <span className={styles.moduleName}>{m.name}</span>
              {m.summary && <span className={styles.moduleSummary}> {m.summary}</span>}
            </li>
          ))}
        </ol>
      </details>
    )}
    <p className={styles.hint}>{suggestion(t)}</p>
  </div>
);
