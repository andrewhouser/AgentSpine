/**
 * The flash-card review, shared by the chat tool (`study_cards review`) and the Study screen
 * (`POST /api/study/cards/:id/review`), so a card answered on the phone and one answered in
 * chat are graded, scheduled and ledgered the same way.
 *
 * The screen keeps the premise: you type (or say) your recall before you see the answer. A
 * self-rated "I knew that" is exactly the feeling of knowing that rereading produces, so the
 * model grades what you actually produced. A blank or "?" counts as forgotten and costs no
 * model call. A topic linked to a project grades on the local model (`gradeRecall` goes
 * through `ask`, which pins those topics private).
 */
import { gradeRecall } from "./roles.ts";
import type { MapModule } from "./roles.ts";
import {
  addAttempt,
  consumptionVsProduction,
  countDue,
  dueCards,
  findTopic,
  getCard,
  listCards,
  listTopics,
  reviewCard,
  topicJson,
} from "./store.ts";

/** Below this a recall is a miss: it feeds the diagnostician and comes back in 10 minutes. */
export const MISS = 0.7;

export interface ReviewResult {
  /** The card's answer, shown only now, after the recall was given. */
  back: string;
  cardId: number;
  due: string;
  feedback: string;
  /** Days until the next review. 0 means it comes back in this sitting. */
  interval: number;
  /** Cards still due across every topic, after this one. */
  remaining: number;
  score: number;
}

export const reviewWithRecall = async (cardId: number, rawAnswer: unknown): Promise<ReviewResult> => {
  const card = getCard(cardId);
  if (!card) throw new Error("no such card; study_cards due shows the next one");
  const topic = findTopic(card.topic_id)!;
  const answer = String(rawAnswer ?? "").trim();
  const gaveUp = !answer || answer === "?";
  const g = gaveUp ? { feedback: "Marked forgotten.", score: 0 } : await gradeRecall(topic, card.front, card.back, answer);
  const after = reviewCard(card.id, g.score)!;
  addAttempt({
    answer,
    answered: true,
    gap: g.score < MISS ? card.front.slice(0, 150) : null,
    prompt: card.front,
    role: "recall",
    score: g.score,
    topicId: card.topic_id,
    verdict: g.score >= MISS ? "recalled" : "forgot",
  });
  return {
    back: card.back,
    cardId: card.id,
    due: after.due,
    feedback: g.feedback,
    interval: after.interval,
    remaining: countDue(undefined),
    score: g.score,
  };
};

/** A due card as the screen may see it: the question only. The answer is never sent before a recall. */
export interface DueCard {
  front: string;
  id: number;
  lapses: number;
  reps: number;
  topicId: number;
  topicName: string;
}

export const dueForScreen = (topicId?: number, limit = 50): DueCard[] => {
  const names = new Map(listTopics().map((t) => [t.id, t.name]));
  return dueCards(topicId, limit).map((c) => ({
    front: c.front,
    id: c.id,
    lapses: c.lapses,
    reps: c.reps,
    topicId: c.topic_id,
    topicName: names.get(c.topic_id) ?? "",
  }));
};

export interface TopicSummary {
  cards: number;
  /** Explanations read, last 14 days. */
  consumed: number;
  due: number;
  goal: null | string;
  id: number;
  level: null | number;
  /** The mapmaker's curriculum, in order, without the stumbling-block detail. */
  map: { dependsOn: string[]; name: string; summary: string }[];
  name: string;
  /** Things produced (answered, explained back, checked, sparred, recalled), last 14 days. */
  produced: number;
  projectId: null | number;
}

export const studyOverview = (): { due: number; topics: TopicSummary[] } => ({
  due: countDue(undefined),
  topics: listTopics().map((t) => {
    const map = (topicJson(t, "map") as MapModule[] | null) ?? [];
    const { consumed, produced } = consumptionVsProduction(t.id);
    return {
      cards: listCards(t.id, 100000).length,
      consumed,
      due: countDue(t.id),
      goal: t.goal,
      id: t.id,
      level: t.level,
      map: Array.isArray(map) ? map.map((m) => ({ dependsOn: m.dependsOn ?? [], name: m.name, summary: m.summary })) : [],
      name: t.name,
      produced,
      projectId: t.project_id,
    };
  }),
});
