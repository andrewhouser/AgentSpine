# Rollout: turning Heads-up on, one reversible step at a time

Heads-up is built and tested, but most of it has only run against fixtures (`docs/PLAN-open-work.md`
section 3, workstream A). This is how to switch it on for real: a ladder where each rung is safe to
sit on indefinitely, and you climb only when the rung below has shown the number it is supposed to.
It is the same format as `ROLLOUT.md`, which covers the learning loop.

Two rules that apply to every rung:

- **If the number does not move as predicted, switch the rung off and report it. Do not tune it.**
  A threshold nudged to make a bad week look good is how a feature turns into a story. The
  thresholds are in `src/headsup/rules.ts`, and changing one is a code change with a reason in the
  commit, not a dial.
- **Restart the dashboard after any `.env` change.** `policy.json` is re-read every heartbeat, so a
  policy edit alone needs no restart. On the Mini, `./update.sh` restarts it, and the README's
  "Updating & restarting the service" has the `launchctl` commands for a restart alone.

Where the numbers come from: `npm run digest 168` prints a "Heads-up" section (offers by kind and what
became of them, research runs by rung, watches started and notified, provider budget used, calendar
read failures). Every figure is a SQL count or a stored counter, never a model's summary.

A fact that shapes rung 0: the **Check now** button (`POST /api/headsups/run`) is the morning job run
by hand. It records what it offers and sends the push. It is not a dry run. The dry run is
the **Preview** button on the Heads-up screen (web, iPhone and Mac), which calls
`GET /api/headsups/preview`: it reads the calendars, writes and sends nothing, and works even with
`HEADSUP_ENABLED=false`.

---

## Rung 0: Baseline, no push

Find out what it would say before it says anything.

In `.env` on the Mini: `HEADSUP_ENABLED=false`, then restart. That stops the morning job and Check
now (both answer "disabled"). Preview still works, since it only reads. Press **Preview** on the
Heads-up screen each morning for about a week. It lists what Check now would offer, with each
item's kind, how far off it is, and whether it would be a first mention or a reminder.

- [ ] Preview lists real items from the calendars you expect, in the right kinds.
- [ ] **No item is a paid-for bill or a holiday.** A paid bill or a public holiday showing up means
      the calendar exclude list needs work (`HEADSUP_EXCLUDE_CALENDARS`, `HEADSUP_INCLUDE_CALENDARS`),
      not the rules.
- [ ] Items sit in the right kind (a birthday is not an anniversary, a bill is not an appointment).
- [ ] Wrote down how many items a typical morning would offer. Compare it to the cap (`DAILY_CAP`,
      3 by default, changeable in Settings).

Metric: the false-positive count over the week. Predicted: zero paid bills and zero holidays.
Off-switch: this rung is already the off state. Nothing persists.

---

## Rung 1: The morning push, no research

`HEADSUP_ENABLED=true`, restart. Leave `policy.json` `web.searchEnabled` as it is for now, and do not
touch the flight or drive switches. The morning job runs once after 7:15 local, outside quiet hours
(9 pm to 6 am by default), and sends one push.

- [ ] One push per morning at most, and none on a morning with nothing to say.
- [ ] Tapping it opens the Heads-up tab. (The lock screen buttons are rung 7 below.)
- [ ] The first mention comes at the lead time in Settings, and a reminder comes only at the later
      stage, never the same day twice.
- [ ] Answering Yes, Not now and Never behaves: Never also mutes that subject.

Metric: offered by kind and what became of them, from `npm run digest 168`. Predicted: you act on most
of what it offers in the first week. A kind you ignore most of the time is the signal for rung 6.
Off-switch: `HEADSUP_ENABLED=false`, or untick a kind in Settings (anything already tracked keeps going).

---

## Rung 2: Dates you tell it in chat

Say "Jordan's birthday is March 4" in a chat. A card should appear within seconds, and it is
stored as a remembered date, not a calendar event.

- [ ] A date stated in chat becomes a card, and shows in the Heads-up tab.
- [ ] **False positives:** over a week of ordinary chat, count dates it remembered that you did not
      mean as a standing date ("my flight is on the 4th"). Delete those from the tab.
- [ ] A remembered date can be forgotten, and the forgotten one does not come back.

Metric: remembered dates that were wrong, over total remembered. Predicted: rare. The plan sets no number, so
decide one before you start (one in ten is a reasonable bar) and write it here. Past it, stop: the date
detector is guessing, and that is a code fix in `src/headsup/dates.ts`.
Off-switch: untick the kind in Settings, or delete the dates (`DELETE /api/headsups/dates/:id`).

---

## Rung 3: Gift and restaurant research

Needs `policy.json` `web.searchEnabled: true` and, for restaurants, `DEFAULT_LOCATION` in `.env`.
Saying Yes to a birthday or anniversary starts a research run: read-only tools, no name ever in a
query that leaves the machine (`src/headsup/research/query.ts` refuses one).

- [ ] Cards arrive in under two minutes.
- [ ] **Record how many cards had a price and photo versus link-only.** Read it from the digest's
      "Research" line: full card, link-only, fallback link.
- [ ] The queries that left the machine look right (they are shown on the item). None contains a name.
- [ ] Sensitive content stayed local: recipient notes are summarised by the local model only.

Metric: share of runs that ended on a full card. Predicted: at least half. If more than half are
link-only, the retailer pages are blocking the reader, and the conditional item H1 (a browser fallback
behind an allowlist) is the next step, not a lower bar.
Off-switch: `web.searchEnabled: false` in `policy.json`. A Yes then does nothing but record the answer.

---

## Rung 4: Flights (watches)

The first watch. Needs `AERODATABOX_RAPIDAPI_KEY` in `.env` and `policy.json` `"headsup": { "flights": true }`.
Settings shows exactly what is missing until both are set.

First, confirm the provider's real free tier and set `HEADSUP_FLIGHT_CALLS_PER_MONTH` (default 400)
safely under it. The digest prints "Provider budget: flights N/400 this month".

- [ ] One real flight, answered Yes, started a watch. The watch polls no more often than every 30
      minutes (not adjustable).
- [ ] Notifications per flight are few and each is a change that matters (gate, delay, cancellation).
- [ ] A cancellation, or a long delay on a flight leaving within hours, breaks through quiet hours
      and nothing else does.
- [ ] The watch ends by itself after the flight.

Metric: notifications per flight, from "Watches: N started, M of those have notified". Predicted:
a handful for a flight with a delay, none for an on-time one.
Off-switch: `"flights": false` in `policy.json` (watches pause with a note saying why), or stop the
watch from its card.

---

## Rung 5: Drives (leave-by)

Needs `TOMTOM_API_KEY`, `HEADSUP_HOME`, and `"headsup": { "travel": true }`. **Check first whether
TomTom's route call is free for your use.** If it is not, the open decision in
`PLAN-open-work.md` is HERE's free tier, a static-speed provider, or flights only. Set
`HEADSUP_TRAVEL_CALLS_PER_DAY` (default 1000) under whatever the real limit is, and
`HEADSUP_LEAVE_BUFFER_MINUTES` (default 10) to what you actually want.

- [ ] A leave-by time for a real appointment, then compare it to when you actually needed to go.
- [ ] Over several drives, how early or late was the leave-by? Write each one down.

Metric: leave-by error in minutes. Predicted: within the buffer on most drives.
Off-switch: `"travel": false` in `policy.json`.

---

## Rung 6: Learning from dismissals

Built (`src/headsup/outcomes.ts`) but proven on nothing until there are weeks of real answers, so do
not expect anything here before rungs 1 to 3 have run for a month. Over 90 days per kind, once at
least 6 offers are counted and 70 percent or more were never or ignored, reminders stop and only the
first mention remains. At 10 and 85 percent it queues one confirmation to switch the kind off. It
never switches one off by itself.

- [ ] Settings shows "offered N, you acted on M" per kind and the numbers match what you remember.
- [ ] A kind that went quiet was one you really did pass on.
- [ ] A proposal to switch a kind off, if one came, was one you agreed with.

Metric: a quietened kind's later offers are acted on at least as often as before. The thresholds
(6, 0.7, 10, 0.85, 90 days) are the plan's starting values and are an open decision until real answers
exist. Revisit them in a code change with the numbers in the commit message.
Off-switch: tick the kind back on in Settings, or reject the proposal. Quietening itself has no
setting: it ends when the kind's recent answers improve.

---

## Rung 7: The lock screen

Needs the iPhone app and push delivery. The Heads-up push carries Yes, Not now and Never as buttons.

- [ ] The buttons appear on the lock screen and each one answers the item once.
- [ ] A second tap on the same push does nothing (the token is single use).

Off-switch: none needed, since the push is still delivered without acting on it. If it misbehaves,
`HEADSUP_ENABLED=false`.

---

## Where it stops

Rungs 0 to 3 are the core. Done when rungs 1 to 3 pass, and 4 to 7 either pass or are consciously
skipped (which workstream A of the plan also says). Live Activities for a flight (workstream G) are
a separate decision and need rung 4 to have run first.

Anything this ladder turns up that is not a number moving the wrong way, such as a calendar that
needs excluding or a provider that is not free, goes in `PLAN-open-work.md` section 3, not here.
