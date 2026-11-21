/**
 * Turn due flash cards into one notification a day.
 *
 * Deliberately blunter than the task sweep: a task has a deadline someone set, a card is
 * only worth reviewing, and a nudge per due card would train you to swipe them all away. So
 * it is one push, at most every `minHours`, only while something is due, and it says how many
 * — the point of spaced repetition is a short daily review, and the push is the prompt for it.
 * `notify` never throws; the throttle stamp is written whether or not a transport is set up,
 * so an install with no push configured does not retry every ten minutes.
 */
import { DASHBOARD_PUBLIC_URL } from "../config.ts";
import { notify } from "../notify.ts";
import type { NotifyOpts } from "../notify.ts";
import { countDue, getMeta, listTopics, setMeta } from "./store.ts";
const KEY = "cards_nudged";
/** `send` is a seam for tests, so they never push a real notification. */
export const sweepDueCards = async (
  minHours = 20,
  at: Date = new Date(),
  send: (title: string, body: string, opts?: NotifyOpts) => Promise<unknown> = (t, b, o) =>
    notify(t, b, { ...o, kind: "flash cards", source: "study" }),
): Promise<boolean> => {
  const n = countDue(undefined, at);
  if (!n) return false;
  const last = getMeta(KEY);
  if (last && at.getTime() - Date.parse(last) < minHours * 3_600_000) return false;
  setMeta(KEY, at.toISOString());
  const topics = listTopics().filter((t) => countDue(t.id, at) > 0).map((t) => t.name);
  try {
    // A tap opens the Study screen (iOS via `screen`, ntfy via `click`), not a chat: reviewing
    // cards is a loop of answer, grade, next, and that's clumsy as a conversation.
    await send(`${n} study card${n === 1 ? "" : "s"} due`, `Five minutes of recall: ${topics.slice(0, 3).join(", ")}.`, {
      ...(DASHBOARD_PUBLIC_URL ? { click: `${DASHBOARD_PUBLIC_URL}/study` } : {}),
      priority: 2,
      push: { collapseId: "study-due", priority: 2, screen: "study" },
      tags: ["brain"],
    });
  } catch (err) {
    console.warn(`[study] card nudge failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
};
