# Plan: Heads-up, what comes next

Written 2026-11-18, against `main` at `e72b6f1`. Status: **proposed.** Nothing here is built.

`PLAN-heads-up.md` is the record of what was built (Phases 0 to 5 and three follow-ups) and why.
This is the spec for what remains. It is ordered by what unblocks what, and every item says how
you would know it is done.

## Summary

| # | Workstream | Size | Who | Depends on |
|---|---|---|---|---|
| A | Verify what has only run against fixtures | S | You, with me on call | none |
| B | Learn from dismissals | M | Me | A3 (needs real answers to learn from) |
| C | A rollout checklist | S | Me | A |
| D | Lead-time overrides in Settings | M | Me | none |
| E | Retention: stop old cards and photos piling up | S | Me | none |
| F | Telemetry: know whether it is helping | S | Me | none |
| G | Live Activity for a flight | L | You (Xcode) and me | A1, A3 |
| H | Small items and conditional work | S each | Me | various |

The recommended order is A, then E and F together (they are small and make everything after them
measurable), then B, C and D, with G only if you still want it after living with the flight watch.

## What is true today, so this spec does not argue with it

- Phases 0 to 5 and the follow-ups are on `main`. Typecheck, lint and every suite pass except
  `write-file`, which fails on Node 22 and is unrelated.
- **Never exercised for real:** the Google calendar reads, web search and retailer pages, the AeroDataBox
  and TomTom integrations, APNs delivery of the Heads-up categories, and all of the iOS Swift written in
  Phases 4 and 5 (uncompiled).
- The 30 minute watch floor, the call budgets, the quiet hours and the "Yes is the consent" rule are
  settled decisions in `PLAN-heads-up.md` and are not reopened here.

---

## A. Verify what has only run against fixtures

Everything below has passed tests but has never met reality. A bug found here is cheaper than one
found on the morning it matters. This is a checklist for you; I fix whatever it turns up.

### A1. Build the iOS app

1. Open `ios/AgentSpine.xcodeproj`, build for a device or simulator.
2. Expect a small fix or two: the Swift was written without a compiler.

Done when: the app builds with no errors and the Heads-up tab, its Settings screen and the three
notification categories appear. If it does not build, paste the first errors and I fix them in one pass.

### A2. Run the full check on Node 24

`npm run check` on the Mac. Two things it proves that this container cannot: the whole suite on the Node
version the project requires, and `test/ios-models.test.mjs`, which compiles the app's Heads-up models
against Foundation and decodes real server output through them.

Done when: it exits 0. A failure in `ios-models` means the wire contract and the Swift disagree, and the
message names the field.

### A3. A shakedown, one rung at a time

Run these in order. Each has a pass condition and a thing to send me if it fails. Do not move on until
the rung passes; this is the same discipline as `ROLLOUT.md`.

| Rung | Do | Pass | If not, send me |
|---|---|---|---|
| 1. Calendar | Restart, open Heads-up, press **Check now** | It lists real items from your calendar, none marked PAID, no holidays or sports | The status it shows, and which calendars you expected |
| 2. Morning push | Wait for 7:15, or press Check now | One push, correct wording, opens the Heads-up tab | The text it sent |
| 3. Chat dates | Say "Garrett's birthday is March 4" in a thread | A card under "Dates it noticed" within seconds | What you typed |
| 4. Gift research | Press **Yes, find gift ideas** on a birthday | Cards appear in under two minutes | The "Searched for" line and what came back |
| 5. Restaurants | Set `DEFAULT_LOCATION`, then Yes on an anniversary | Local results | The same |
| 6. Flights | Add the key and the policy switch, Yes on a real flight | A "Tracking" note, then a real status | The watch note on the card |
| 7. Drives | Add `TOMTOM_API_KEY` and `HEADSUP_HOME`, Yes on a timed appointment with a place | A "leave by" push about an hour before | The watch note |
| 8. Lock screen | Make exactly one item due, press Check now, long-press the push | Buttons appear and work | Which buttons, and what happened |

Done when: rungs 1 to 5 pass. Rungs 6 to 8 pass or are consciously skipped.

Record two numbers while doing rung 4, because workstream H1 depends on them: how many cards had a price
and a photo, and how many were link-only.

### A4. Confirm each provider's real free tier

Check the AeroDataBox (RapidAPI) and TomTom dashboards. The published figures disagree and TomTom's own
page suggests its v1 Calculate Route API may not be in the free plan.

Done when: you know the real monthly or daily limit for each, and I have set
`HEADSUP_FLIGHT_CALLS_PER_MONTH` and `HEADSUP_TRAVEL_CALLS_PER_DAY` defaults to something safely under it.
If TomTom's route API is not free for you, the decision is in section "Open decisions".

---

## B. Learn from dismissals

The one planned behavior that is still missing. `PLAN-heads-up.md` section 8 says repeated dismissals of a
kind should lower how often it appears. Today there is a per-item mute ("Don't suggest this") and nothing
that notices you have dismissed twelve bills in a row.

### Goal

If you consistently ignore or dismiss one kind of heads-up, it should get quieter without you opening
Settings, and it should offer to switch itself off rather than do so silently.

### Design

**Record every outcome.** A small table, `headsup_outcomes`, one row per offer and what became of it:

```
headsup_outcomes(id, headsup_id, kind, offered_at, outcome, resolved_at)
outcome: yes | later | never | ignored
```

- `yes`, `later`, `never` are written by `answer()` in `src/headsup/ledger.ts`.
- `ignored` is written when an offered item reaches its due date still unanswered, which is the moment
  `expirePast` already marks it `expired`. This is the most important signal and the one that is silent today.

**Derive a per-kind rate in code, over a trailing window.** For each kind over the last 90 days:

```
offered = count of rows
acted   = yes
dismissed = never + ignored
dismissRate = dismissed / offered     (later is neutral: it means "not yet", not "no")
```

**Act on it, in three tiers, with constants in `rules.ts`:**

| Tier | Condition | Effect |
|---|---|---|
| Ignore | fewer than 6 offers in the window | Nothing. A small sample is noise. |
| Quieten | 6 or more offers and dismissRate at least 0.7 | That kind keeps its first mention but loses its reminders, and loses its place in the daily cap to other kinds (sorts last). |
| Propose off | 10 or more offers and dismissRate at least 0.85 | A proposal in the confirmation queue: "You have acted on 1 of 12 bill heads-ups. Turn bills off?" |

The proposal reuses the existing confirmation queue and the `noteSilentRejection` pattern in
`src/confirmations.ts`: counted in code, surfaced as a question, never decided silently. Approving it sets
the kind to off in the preferences from workstream "Follow-ups after Phase 5". Rejecting it records that you
want this kind despite ignoring it, and suppresses the proposal for 90 days.

**It is a preference change, so it is standing work.** The tool that applies it (`headsup_kind_set`) must be
irreversible-tier and set `confirmWhenUnattended: true`, per CLAUDE.md. The tier logic that runs
unattended may count and propose; only a person approving may change a setting.

**Show it.** Settings → Heads-up gains a line per kind: "Bills: offered 14, you acted on 3." Seeing why a
kind got quieter is what makes automatic quieting acceptable.

### What this must not do

- **Never penalize by subject.** A birthday is offered once a year, so per-subject rates would be
  meaningless. The unit is the kind.
- **Never count `later` as a dismissal.** Snoozing means "remind me", not "no".
- **Never judge a kind during its first weeks.** The 6-offer floor and the 90-day window exist for this.
- **Never disable anything without asking.** Quieten is automatic and reversible by the next answer. Off is
  always a question.
- **Never touch watches.** A flight you chose to track is not an offer you ignored.

### Edge cases to specify in tests

- A kind with 5 offers and 5 ignored: no action (below the floor).
- 6 offers, 4 ignored, 2 yes: dismissRate 0.67, no action. The threshold is exact.
- 10 offers, 9 ignored: proposal raised once, not once per morning.
- Proposal rejected: not raised again for 90 days even if the rate stays high.
- You answer yes on a quietened kind: the rate drops and reminders return when it falls under 0.7.
- `ignored` is only written for items that were actually offered (a first mention was sent), not for
  candidates the cap deferred.
- Outcomes older than 90 days stop counting.

### Done when

The rate and the tiers are pure functions with tests at every boundary, the proposal appears exactly once
per episode, quietening demonstrably removes reminders for the kind, and the Settings line shows the counts.

---

## C. A rollout checklist

`ROLLOUT.md` turns on the learning loop as a series of small reversible steps, each with a number to read
before climbing. Heads-up needs the same, because every rung adds a way to be wrong in front of you.

Deliverable: `docs/ROLLOUT-heads-up.md`, same format as `ROLLOUT.md`. The ladder:

0. **Baseline.** Press Check now for a week without the morning push. Read what it would have said.
1. **Morning push on, no research.** Only "Got it" answers. Number to watch: how many offers you act on.
2. **Chat dates.** Watch the "Dates it noticed" list. Number: false positives (cards you reject).
3. **Research on.** Number: the card quality counts from A3, and any "Searched for" line that looks wrong.
4. **Watches on, flights first.** Number: notifications per flight, and whether any were wrong.
5. **Drives.** Number: leave-by accuracy against what actually happened.
6. **Learning from dismissals** (after B). Number: dismiss rate per kind before and after.

Each rung states its off-switch (`HEADSUP_ENABLED`, a kind toggle, a policy flag) and the rule that applies
everywhere in `ROLLOUT.md`: if the number does not move the way the rung predicts, switch it off and report,
do not tune.

Done when: the file exists and every rung has a metric, an off-switch and a pass condition.

---

## D. Lead-time overrides in Settings

`PLAN-heads-up.md` promised "lead-time overrides". Kinds, cap and quiet hours shipped; the numbers in
`LEAD_DAYS` (birthday 10 and 2, anniversary 14 and 3, bill 5, 1 and 0, and so on) are still code-only.

### Design

A preference per kind: an ordered list of 1 to 3 day counts, largest first, each from 0 to 45 (the look-ahead
window), no duplicates. Validation is all-or-nothing, like the other preferences. `LEAD_DAYS` stays the
default; stored values override it.

### The trap to design around

The ledger's `stage` is an **index into the kind's list**. If the list changes length or order while an item
is mid-sequence, an index recorded under the old list means something different under the new one, and an
item could be re-offered or skipped.

Decision (recommended): record the **threshold in days** at offer time, in a new `stage_days` column, and
have the planner compare thresholds, not indexes. Then changing the list can only affect future thresholds,
never reinterpret a past one. The migration backfills `stage_days` from the old index and `LEAD_DAYS`.

### Done when

Overrides save and validate, the planner uses them, a test changes a list mid-sequence and proves nothing is
re-offered or skipped, and Settings shows the numbers per kind on web and iOS.

---

## E. Retention

A real gap found while writing this: research results are never cleaned up. `replaceCards` deletes a
heads-up's photos only when it is researched again, and `headsups`, `headsup_cards`, `headsup_images`,
`headsup_watches` and `headsup_outcomes` all grow forever. Photos are up to 1.5 MB each, six per research.

### Design

Add to the existing daily prune (`src/prune.ts`; read how it is scheduled before changing it):

| What | Kept for |
|---|---|
| Cards and photos of a done, expired or dismissed heads-up | 30 days after it ends |
| Ended watches | 30 days after they end |
| Ledger rows that are done, expired or dismissed | 400 days (so next year's birthday still knows it was muted) |
| Outcomes | 400 days (the learning window is 90) |
| Orphan image files with no row, and rows with no file | removed |

Mutes (`headsup_mutes`) and remembered dates are never pruned: they are what you told it.

### Done when

A test seeds old rows and files, runs the prune, and proves exactly the table above was removed, that
nothing newer was touched, and that a mute from two years ago still holds.

---

## F. Telemetry

You cannot tell whether this helps without numbers, and workstream B needs the same data. Extend the
existing digest (`src/digest.ts`; read how its metrics are computed first) with a Heads-up section:

- Offers per week, by kind.
- Yes, later, never and ignored rates, by kind (from `headsup_outcomes`).
- Research: how many runs, and how many ended on each rung of the ladder (full card, link-only, fallback
  link). This also answers whether a browser fallback is worth building (H1).
- Watches: started, notifications sent per watch, errors, and budget used against each limit.
- Calendar read failures.

Research needs one new fact stored: which rung each run ended on, in the headsup payload.

Done when: `npm run digest` prints the section, with tests over fixture data for each number.

---

## G. Live Activity for a flight

Assessed in `PLAN-heads-up.md` and not built, because it needs a second Xcode target and an APNs path that
cannot be tested from the sandbox. Do this only after A1 and A3 rung 6 prove the flight watch is worth
decorating.

### Split of work

**You, in Xcode (about 10 minutes):**
1. File, New, Target, Widget Extension, named `AgentSpineLiveActivity`, with "Include Live Activity" ticked.
2. Make the generated `ActivityAttributes` file a member of both the app and the extension.
3. Set `NSSupportsLiveActivities` to YES in the app's Info.plist.
4. Commit the resulting project changes.

**Me, once the target exists:**
- The Swift: the attributes, the lock screen and Dynamic Island views, and starting the activity when a flight
  watch becomes active.
- Server: `POST /api/headsups/:id/live-activity` to store the per-activity push token on the watch;
  `src/push/liveactivity.ts` to build and send `update` and `end` pushes (push type `liveactivity`, topic
  `<bundle id>.push-type.liveactivity`, a `content-state` payload); calls from `loop.ts` where it already
  notifies, and an `end` when the flight lands or is cancelled.
- The content state is the `FlightStatus` the loop already holds: phase, delay, gate, terminal, estimated times.

### Decisions needed

- **Start only while the app is open, or support push-to-start?** Push-to-start (iOS 17.2 and later) has its
  own token and lets a lock-screen "Yes, track it" start an activity. Without it, tapping Yes on the lock
  screen would track the flight but not show one.
- Activities end after about eight hours without an update. That fits the 18-hour flight window only if
  updates keep arriving; confirm that is acceptable.

### How it is tested

The payload builder is pure and tested against Apple's documented shape. Delivery is not testable here, so the
spec's done condition includes a manual device test: start a tracked flight, see the activity, force an update,
see it change, see it end.

Done when: the payload builder has tests, the device test passes on your phone, and the plan doc says exactly
what was and was not verified.

---

## H. Small items and conditional work

| # | Item | Trigger | Notes |
|---|---|---|---|
| H1 | **Browser fallback for blocked retailers** | A3 rung 4, or F, shows more than half of cards are link-only | Heavier and a larger attack surface; the SSRF guard does not cover a browser, so scope it to an allowlisted set of retailers. Not before the numbers justify it. |
| H2 | **Web sidebar badge** for open heads-ups | none | Mirrors the iOS rule: offered items plus dates to confirm. Small. |
| H3 | **Fix the `CLAUDE.md` row** | none | Done with this spec: it said "phases 0-4" while Phase 5 was built. |
| H4 | **A second flight provider** | A4 shows AeroDataBox is unsuitable | One file behind `FlightSource`. |
| H5 | **Restaurant availability and booking** | You want it | A new integration (OpenTable, Resy). Booking is irreversible-tier and must go through the confirmation queue. Out of scope until asked. |
| H6 | **Buying a gift** | You want it | Same: irreversible-tier, queued, never automatic. Out of scope until asked. |
| H7 | **Arrival-side flight alerts** (baggage claim, gate on landing) | You want it | The provider fields exist; the loop would need an arrival window. |
| H8 | **Remembered dates: edit, not just forget** | none | Today you forget and re-add. |
| H9 | **Model-worded notifications** | Only if the code wording reads badly in A3 | A model call on the morning push is a real cost and puts private dates in a prompt. Prefer fixing the wording in code. |

---

## Cross-cutting rules for everything above

These are already the project's rules; they are repeated because each workstream touches one.

- **Code owns the numbers.** Every threshold in B, D and E is a constant in `rules.ts`, never in a prompt.
- **Local-first.** Outcomes, rates and dates stay on the machine. Nothing in B or F leaves it.
- **Standing work needs consent.** Anything that changes a setting or starts a watch is irreversible-tier
  with `confirmWhenUnattended`, or a person pressing a button.
- **Tests first for the arithmetic.** B, D and E are pure logic at their core; each boundary gets a test,
  and each guard gets a mutation check, as in Phase 5.
- **Update `PLAN-heads-up.md` in the same change** as any design decision, and the `CLAUDE.md` row.

## Open decisions for you

1. **Is learning from dismissals (B) the right next build, or do you want something from H first?** The
   recommendation is B, because it is the only planned behavior still missing and it makes the feature
   self-correcting.
2. **Thresholds in B** (6 offers, 0.7 to quieten, 10 offers and 0.85 to propose off, a 90 day window): keep
   them, or do you want it quieter or slower to react?
3. **If TomTom's route API is not free for you (A4):** switch to HERE's free tier, accept a static-speed
   provider with no live traffic, or drop drive watching and keep flights.
4. **Live Activity (G):** do you want it at all, and if so push-to-start or foreground only?
5. **Retention windows in E** (30 days for cards and photos, 400 for ledger rows): acceptable?

## Definition of done for this whole spec

`npm run check` is green on Node 24 on the Mac; the iOS app builds; A3 rungs 1 to 5 have passed on real data;
B, E and F are on `main` with their tests; `ROLLOUT-heads-up.md` exists; and `PLAN-heads-up.md` and `CLAUDE.md`
say exactly what is built and what was verified.
