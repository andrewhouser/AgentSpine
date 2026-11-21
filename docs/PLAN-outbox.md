# Plan: The outbox — one place every message to you passes through

Written 2026-11-21, against `main` at `9e98f0f`. Status: **Phases 0 and 1 built, enforcement off by default.**
Phases 2 to 4 are proposed. Nothing has run against real traffic yet.

## Build status

| Phase | State |
|---|---|
| 0. `outbox` table, every `notify()` recorded | Built: `src/outbox.ts`, `src/outbox-rules.ts`, hook in `src/notify.ts` |
| 1. Quiet hours, repeats, soft cap, held summary | Built, but **log-only until `OUTBOX_ENFORCE=true`**. In log-only mode `would_be` records what it would have done and everything is delivered as before. |
| 2. Opened and dismissed reporting | Not started (needs iOS Swift) |
| 3. Weekly review screen and feedback | Not started. The digest already has the counts (`npm run digest`). |
| 4. Propose switching off a source | Not started |

**To turn enforcement on:** run for a week, read the "What I sent you" section of `npm run digest`
(its `would be held or collapsed` column is the number to judge by), then set `OUTBOX_ENFORCE=true`
and restart the dashboard. Held messages are released by a 5 minute sweep in `src/server.ts`.

Deviations from the design below, made while building:

- Sources are `chat`, `confirmation`, `digest`, `headsup`, `outbox`, `reminder`, `run`, `study`, `tool`
  and `unknown`. There is no `watcher` or `schedule`: watchers and scheduled briefs speak through the
  `notify` tool, so they are `tool` (unattended) or `chat` (a live chat that asked for a push, exempt).
  Only `study` and `tool` are governed.
- In log-only mode the cap and repeat checks look at rows that were *sent*, which includes ones
  enforcement would have held, so the would-be counts can run slightly high. They are an upper bound.
- Not wired: `.env.example` (`OUTBOX_ENFORCE` is documented in `src/config.ts`), and the Phase 1 item
  about routing proactive callers through `notifyProactive`. The outbox now does that job for the
  rules that matter; the judge gate stays unwired and off.


This came from comparing AgentSpine with Anthropic's guide to "always-on agents" (a five-piece
model: inbox, timers, memory, permissions, outbox). Four of the five are covered, and the
permissions piece is stronger here than in the guide. The outbox is where the two designs differ:
the guide says an agent should *start quiet and earn attention*, and measure that by looking back
at what it sent. AgentSpine has the pieces for that but not the loop.

## Summary

| Phase | What | Changes behavior? | Size |
|---|---|---|---|
| 0 | Log every notification to an `outbox` table | No | S |
| 1 | Quiet hours, de-duplication and a soft cap, for proactive sends only | Yes | M |
| 2 | Record what happened to each message (opened, dismissed, ignored) | No | M |
| 3 | Weekly "what I sent you" review, with feedback that is remembered | Yes | M |
| 4 | Propose switching off a source you keep ignoring | Yes | S |

Order is strict, and Phase 0 runs for about a week before Phase 1 is switched on, so the numbers
decide the thresholds. That is the same discipline as `ROLLOUT.md`.

## What is true today

Read this before the design, because the first draft of this idea assumed less existed than does.

- **`notify()` in `src/notify.ts` is the only door.** It runs APNs and ntfy together and falls back
  to a Mac banner. It never throws. It has no memory: nothing records what was sent.
- **Callers:** `broker.ts` (approval needed), `confirmations.ts`, `digest.ts`, `tasks/sweep.ts`
  (your reminders), `study/sweep.ts`, `runner.ts` (finished or failed runs), `headsup/morning.ts`,
  `headsup/watch/loop.ts`, and the `notify` tool in `src/tools/notify.ts`.
- **The interruption budget (LEARNING Phase 4.5) is mostly unwired.**
  - The hard rail is `policy.budgets.perDay.tools.notify`. In `policy.json` `perDay` is `{}`, which
    means unlimited. It also only counts calls through the `notify` *tool*, not the direct callers.
  - `notifyProactive` in `src/learn/interrupt.ts` is a judge gate, off by default
    (`JUDGE_INTERRUPTIONS_PROACTIVE`). **Nothing in `src/` calls it.** Only its comment says who should.
  - `recordDismissal` in the same file turns a dismissal into a `preference` memory. **Only a test
    calls it.** No client has a way to dismiss.
- **Quiet hours exist only inside Heads-up** (`src/headsup/prefs.ts`, used by `plan.ts`, `morning.ts`
  and `watch/loop.ts`). A watcher, a study sweep or a scheduled brief that calls `notify` is not held.
- **The `notify` tool's gate is about setting, not volume.** In a live chat it is refused unless you
  asked for a push (`askedForPush`). An unattended run may notify freely.
- **Heads-up has its own daily cap and "ignored" idea** (`PLAN-heads-up-next.md` workstream B,
  `headsup_outcomes`). That is about *offers*. This plan is about *pushes*, of every source. They are
  different tables and both stay.

So the gap is not "no budget", it is "a budget nobody enforces and a dismissal nobody can record".

## Design

### One rule about who is exempt

Everything below applies only to **proactive** messages: ones you did not just ask for. These are
never held, de-duplicated or counted against the cap:

- an approval request (`confirmations`, `broker`), because the agent is blocked on you;
- a reminder you set (`tasks/sweep`);
- a "finished" push you asked for (`notifyOnFinish`);
- anything at priority 5.

This is the same split `notifyProactive` already describes ("a push the user asked for still uses
`notify`"). The outbox makes the split explicit and testable rather than a convention.

### Phase 0. The `outbox` table (log only)

`notify()` gains an optional `source` (and `dedupeKey`) in `NotifyOpts`. A caller that sets nothing
still works, and is recorded as `source: "unknown"` so missing call sites show up in the numbers.

```
outbox(
  id, created, source, kind, title, body,      -- body clipped to 300 chars
  priority, proactive,                          -- proactive: 0 or 1, decided by the caller's source
  decision, reason,                             -- sent | held | deduped | suppressed (Phase 0: always sent)
  via, delivered,                               -- apns | ntfy | mac | none
  collapse_key, dedupe_key,
  opened_at, dismissed_at, feedback, feedback_at
)
```

- Written inside `notify()`, before the transports run, and updated with the result. A failure to
  write the row is logged and swallowed: a notification is a side channel and must never fail the work.
- `source` values: `headsup`, `watcher`, `schedule`, `study`, `digest`, `confirmation`, `run`,
  `reminder`, `tool`, `unknown`.
- **Privacy.** A body can quote mail. It stays in the local SQLite file, is clipped, and is never sent
  to a cloud model. Retention: 90 days, added to `src/prune.ts`.

Done when: `npm run digest` prints a count of messages per source for the last 7 days, and a
deliberate `notify` from each source appears in the table with the right `source`.

### Phase 1. Quiet hours, de-duplication, soft cap

Applies to proactive rows only. All numbers live in a new `src/outbox-rules.ts`, never in a prompt.

1. **Quiet hours.** Reuse the Heads-up window (`getPrefs().quietStartHour` / `quietEndHour`) so there
   is one setting, not two. A proactive message inside it is stored with `decision: held`. When quiet
   hours end, held messages are sent as **one** push ("4 things while you were away") built by code,
   not by a model, with the list in the app. A held message at priority 4 or above that
   `breaksQuietHours` already allows for Heads-up flights is still sent.
2. **De-duplication.** Same `source` + `dedupeKey` within `DEDUPE_HOURS` (default 12) is `deduped`.
   When a caller gives no key, the key is `source + title`.
3. **Soft cap.** At most `PROACTIVE_DAILY_CAP` (default 6) proactive sends a day across all sources,
   *including* Heads-up pushes. Over the cap, messages go to the held digest instead of being dropped.
   Nothing is silently lost, which is what makes the cap safe to turn on.
4. **Hard backstop.** Set `policy.budgets.perDay.tools.notify` to a real number (see open decisions).
   This is the rail a runaway loop hits, independent of everything above.
5. **Wire the judge or leave it.** Either route the proactive callers through `notifyProactive`, or
   delete it. Do not keep a gate that nothing calls. Recommended: route them through it, leave
   `JUDGE_INTERRUPTIONS_PROACTIVE` off, and revisit after Phase 3 has real data on how often a message
   is skipped.

Done when: with the cap set to 1 in a test, the second proactive `notify` is `held`, appears in the
digest push at quiet end, and a confirmation request in the same minute is still sent immediately.

### Phase 2. What happened to each message

Without this, Phase 3 has nothing to learn from. Be honest about what each transport can tell us:

| Transport | Opened | Dismissed | Note |
|---|---|---|---|
| APNs (iPhone) | Yes: the app already opens a deep link on tap; add `POST /api/outbox/:id/opened` | Yes, if the category sets `customDismissAction` | Needs a change in `ios/`. **The Swift here would be uncompiled**, like Heads-up Phases 4 and 5, so it goes on the unverified list. |
| ntfy | No | No | Outcome stays `unknown`. Not guessed. |
| Mac banner | No | No | Same. |

- A row with no `opened_at` and no `dismissed_at` after `IGNORED_AFTER_HOURS` (default 24) on an APNs
  delivery is derived as `ignored` at read time. It is not stored as a fact.
- The push payload carries the outbox `id` so the app can report back. The existing `answer_token`
  pattern in Heads-up is the model: a narrow credential that can do one thing.
- Opening the weekly review (Phase 3) from any client also marks everything in it as seen, so ntfy-only
  setups still get a signal from the review itself.

Done when: tapping a real push on the iPhone sets `opened_at` within seconds, and a dismissed one sets
`dismissed_at`.

### Phase 3. The weekly review

The best idea in the guide is a plain one: once a week, look back at what the agent sent, say which
were useful, which it could have skipped, and which you wished it had sent, then tell it.

- **Where the numbers come from.** `src/digest.ts` already computes everything from SQL and keeps the
  model out of the counting ("the numbers are computed, not narrated"). Add a **"What I sent you"**
  section: per source, how many sent, held, de-duplicated, and (APNs only) opened and dismissed.
  Same rule: no model in the counting.
- **The review screen.** A list of the last 7 days of proactive messages, each with three buttons:
  **Useful**, **Skip this kind**, and (as a separate field at the top) **"Something I wish I'd been
  told"** with a one-line text box. Built for **web, Mac and iPhone together**, per the standing rule
  about chat UI changes.
- **What an answer does.**
  - *Useful*: sets `feedback`, nothing else. It is a signal for the numbers, not a rule.
  - *Skip this kind*: calls the existing `recordDismissal(topic)`, so it becomes a `preference` memory
    ("do not interrupt about X again unless materially more important") that auto-recall already uses.
    This finally gives `recordDismissal` a caller. The topic comes from `source` + `kind`, stable across
    weeks so the memory groups.
  - *Wish I'd been told*: stored as a `preference` memory phrased as something to surface, via the same
    `remember` path.
- **What an answer never does.** It never writes `profile.md`, `goals.md`, `policy.json` or
  `agents/*.md` (LEARNING invariant 1). Memory only.
- **How you get to it.** One push a week, itself counted in the outbox, which is the review's own
  entry point. It is never held by quiet hours (it is scheduled) and never counts against the cap.

Done when: after a week of use, the review lists real messages, tapping *Skip this kind* creates one
`preference` memory, and the next day's recall for that topic includes it.

### Phase 4. Offer to switch off what you keep ignoring

Mirror Heads-up workstream B so there is one pattern, not two. Per `source` + `kind` over the last 90
days, derive `skipRate = (skipped + ignored + dismissed) / sent` for rows with a known outcome only.
Thresholds in `outbox-rules.ts`, to be set from the Phase 0 and 2 numbers, **not** from a guess:

- under `MIN_SENT` (propose 8): do nothing;
- at or above `MIN_SENT` and skip rate over `QUIETEN_RATE`: add the kind to the weekly review as
  "you skipped most of these";
- at or above `PROPOSE_OFF_MIN` and over `PROPOSE_OFF_RATE`: put one proposal in the confirmation
  queue to disable that watcher or schedule, through the existing `noteSilentRejection` path, so a
  rejection is remembered and suppresses the proposal for 90 days.

Disabling a schedule goes through the schedule tools and stays in the irreversible tier, queued when
unattended. **Nothing turns itself off silently.** That is the one thing that must hold.

Done when: a test with 10 skipped rows from one watcher produces exactly one proposal, and rejecting it
suppresses a second one.

## Files

| New | Purpose |
|---|---|
| `src/outbox.ts` | Table, `record()`, `decide()` (hold, dedupe, cap), digest of held messages, outcome derivation |
| `src/outbox-rules.ts` | Every number above, with a comment saying why |
| `test/outbox.test.mjs` | Exemptions, hold and release, cap, dedupe, privacy clip, retention |

| Changed | Change |
|---|---|
| `src/notify.ts` | `source` and `dedupeKey` in `NotifyOpts`; call into `outbox` |
| callers listed above | Pass `source`; proactive ones go through `notifyProactive` |
| `src/digest.ts` | The "What I sent you" section |
| `src/prune.ts` | 90 day retention for `outbox` |
| `src/server.ts` | `POST /api/outbox/:id/opened`, `GET /api/outbox/review`, `POST /api/outbox/:id/feedback` |
| `web/`, `ios/`, Mac target | Review screen; opened and dismissed reporting on iOS |
| `package.json` | Add `test/outbox.test.mjs` to the explicit `npm test` list. It does not discover suites on its own. |
| `CLAUDE.md`, `docs/LEARNING.md` | A row for this plan; a note under 4.5 that the budget is now wired |

Server changes need a dashboard restart. Web changes need `npm run web:build`.

## Rules this must not break

- **Local-first.** Outbox rows, the review and the held digest are built from local data by code. No
  cloud tier, no cloud embeddings.
- **Never throws.** The outbox must not turn a delivered notification into a failed run. A bad write is
  logged and skipped.
- **Code owns the numbers.** Cap, quiet hours, dedupe window and thresholds are constants. The model
  only ever words things.
- **Urgent and requested messages are never held.** A held approval request would stall a run that is
  waiting on you, and a held reminder defeats its purpose.
- **Nothing silent.** Held and de-duplicated messages are visible in the review. A cap that drops
  messages without a trace would look exactly like a quiet day.

## Open decisions

1. **Shared or separate quiet hours?** Recommended: shared with Heads-up, one setting. The cost is that
   a Heads-up setting now governs watchers too, so the label in Settings should say "Quiet hours".
2. **The hard backstop number** for `perDay.tools.notify`. It only counts the `notify` tool, so something
   like 20 catches a looping run without affecting normal use. Your call, because it is `policy.json`
   and no tool may write that file.
3. **Should the cap include Heads-up pushes?** Recommended yes, so "six a day" means six a day. The
   alternative leaves Heads-up on its own cap and risks two budgets adding up to too many.
4. **iPhone reporting.** Phase 2's APNs signal needs a Swift change that cannot be compiled where this
   is written. If you would rather not take that, Phase 3 still works from the review screen alone,
   with no automatic "ignored" signal.

## Not in this plan

Two other ideas from the same comparison are left out on purpose:

- **A bounded `follow_up` tool** so a scheduled run can set its own one-shot reminder. It sits on the
  rule that tools creating work for future unattended runs must queue or refuse, so it needs its own
  decision about whether the unattended case is allowed at all.
- **An event inbox** (`POST /api/events`, drained by the scheduler, same-source events coalesced) so a
  webhook or mail push can wake the agent instead of a poll. Larger, and best built after this, since
  an event source is only as safe as the outbox that reports on it.

## Definition of done

- Phase 0 numbers for a week exist and the thresholds in `outbox-rules.ts` cite them.
- `npm run check` exits 0 with `outbox.test.mjs` in the test list.
- A watcher that fires inside quiet hours is held, then arrives in one morning push.
- One week of the review has been used, and at least one *Skip this kind* changed what the agent does.
