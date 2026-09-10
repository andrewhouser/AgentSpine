/**
 * Look forward, not only for change (LEARNING.md Phase 4.3 & 4.6).
 *
 * A watcher compares the present against the past. Anticipation is usually just *earlier*:
 * read the calendar a couple of hours ahead, notice what is about to happen, and prepare the
 * brief before the meeting rather than when asked. Calendar, gmail, and projects tools all
 * already exist — the missing piece was a job whose question is "what is about to happen"
 * rather than "what changed".
 *
 * This module does not act. It assembles the TASK TEXT for such a job — a prompt handed to a
 * normal run through the normal broker, so every tool it then calls is gated exactly as
 * always. The horizon job is the endpoint of Phase 4.6: the heartbeat stops reading a static
 * `goals.md` and instead runs the watcher shape against your own near future, acting only on
 * a difference and staying silent otherwise — the same three-line contract `WATCHERS.md`
 * argues for.
 */
import { HORIZON_HOURS } from "../config.ts";

/**
 * The horizon task, phrased as watcher-shaped standing instructions. Deliberately silent by
 * default: it prepares work quietly (a draft, a stash entry, a note in the summary) and only
 * pushes when something genuinely warrants an interruption — which the Phase 4.5 gate then
 * judges. The hours window comes from config so it is one knob, not a number baked into a
 * prompt.
 */
export const horizonTask = (hours = HORIZON_HOURS): string =>
  [
    `Look at what is about to happen and get ahead of it. This runs unattended and should be`,
    `quiet: prepare things, do not announce them.`,
    ``,
    `1. Read the calendar for the next ${hours} hours (calendar_upcoming).`,
    `2. For each upcoming event, gather what would help: who is on it, any recent mail about`,
    `   it, anything in the relevant project. Prepare a short brief.`,
    `3. Use state_get/state_set to remember what you have already prepared, keyed by event, so`,
    `   you do not redo it every run and do not raise the same thing twice.`,
    `4. Deliver quietly by default — a draft or a note in your final summary. Only notify the`,
    `   user's phone if something is genuinely time-sensitive and they would want to be`,
    `   interrupted for it (a conflict, a thing they must act on before the event).`,
    `5. If nothing is coming up and nothing has changed since last time, finish with a short`,
    `   "nothing on the horizon" and take no action.`,
  ].join("\n");

/**
 * The heartbeat's horizon goal (Phase 4.6). Same shape as `horizonTask` but widened past the
 * calendar to the assistant's own standing state — pending confirmations, and (once those
 * exist) stale watchers and open proposals — so a heartbeat becomes "act on a difference in
 * my near future", not "run a static goal every tick".
 */
export const heartbeatHorizonGoal = (hours = HORIZON_HOURS): string =>
  [
    horizonTask(hours),
    ``,
    `Also check whether anything is already waiting on the user (pending confirmations) and,`,
    `if so, mention it briefly in your summary rather than adding more.`,
  ].join("\n");
