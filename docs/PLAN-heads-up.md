# Plan: Heads-up (proactive suggestions)

Written 2026-11-18. Status: **proposed, nothing built.** Prompted by Duet noticing a flight and
offering to track it. The goal here is the general version: AgentSpine notices things coming up
in your life and offers to help, without being asked.

> You have an anniversary in two weeks. Want me to look for restaurants?
> Garrett's birthday is in ten days. Want gift ideas?
> Your electric bill is due Friday.

## Decisions already made

| Question | Decision |
|---|---|
| Where do events come from? | Google Calendar first. Chat history, `profile.md` and memories are a second source for dates you told it about. |
| Web searches | Allowed, but anonymized (see "Privacy"). |
| Gift research | Web based. Each idea comes back with an image, a price and a link to the product page. |
| How often do you hear from it? | One **morning heads-up** for everything non-urgent. A separate, faster loop for time-sensitive items only, never more often than every **30 minutes**. |
| Categories for the first pass | Birthdays and anniversaries, trips and flights, appointments, **bills**, **recurring events**. |
| Bills marked paid | Any calendar event with `PAID` in it is ignored. |
| Acting on an offer | Read-only research runs on a "yes". Anything irreversible (buy, book, email) still goes to the confirmation queue. |
| Paid marker | The word `PAID` in the event title (decided 2026-11-18). Description is also checked, harmlessly. |
| Quiet hours | No pushes 9 pm to 7 am, except a cancellation or a large delay on something within a few hours. At most three offered items per morning. |
| Flight status API | No preference from the user, so the choice is mine: start with one provider behind a small interface (`FlightStatusSource`), so swapping is a one-file change. Verify free-tier limits before committing to one. |
| Travel time API | A routing API is acceptable. Default plan is the Google Routes API, behind the same `policy.json` gate as `weather`, with the same interface-first approach. |
| Retailer fallback | If Amazon product pages are blocked, use any retailer whose page we can read, and fall back to a **Google Shopping search link** built from the anonymized query. The link carries no price or image. |
| Dates heard in chat | The assistant offers to remember them (see "Remembering dates you mention"). |

## What already exists

Nothing here needs rebuilding. Heads-up is a new layer on top of:

- **Schedules and the morning brief** (`src/briefing.ts`, `src/tools/schedule.ts`). The brief
  already seeds one schedule on first start, and a deleted seed stays deleted.
- **Watchers** (`docs/WATCHERS.md`). Poll, compare to stored state, act only on a difference.
  `state_get` / `state_set` for exact change detection, `watch:*` keys by convention.
- **Push to the phone** (`src/notify.ts`, `src/push/apns.ts`, `ios/.../PushManager.swift`).
  APNs already carries a `category` name that iOS maps to action buttons. Today there are two,
  `CONFIRMATION` and a run category.
- **Confirmation queue**, which already counts silent rejections by `(tool, target)` shape
  (`rejectShapeKey` in `src/confirmations.ts`).
- **Read-only Google Calendar and Gmail** (`src/google/client.ts`), plus `web_search`,
  `web_read`, `weather`, tasks and memory.

## Gaps found in the current code

These are real constraints on the design, found by reading the code, not assumptions.

1. **`upcomingEvents` is too thin.** It returns only `start`, `title`, `attendees`, `location`
   and reads only the `primary` calendar. A heads-up engine needs the event `id` (for dedupe),
   `description`, an all-day flag, `recurringEventId` (to recognize a series), the source calendar,
   and an end time. It also needs a look-ahead window of weeks, not 48 hours.
2. **Birthdays live on a separate calendar.** Google's contact birthdays are not on `primary`.
   Reading them needs a `calendarList` call and a second events query. Verify that the existing
   read-only scope (`GOOGLE_SCOPES` in `src/config.ts`) already covers this before assuming it does.
3. **There is no travel-time or flight-status source.** Open-Meteo has neither. The time-sensitive
   loop needs one for each, and both are new external dependencies (see "Open questions").
4. **There is no way to put an item on a lock-screen card with Yes / Not now buttons.** The
   notification categories are fixed in `PushManager.swift`. A third category, `HEADSUP`, is needed
   on the app side and in the APNs payload.
5. **Scheduled runs cannot write standing work** (CLAUDE.md). Turning on tracking for a flight
   creates future unattended work, so that step has to go through the confirmation queue or be
   an explicit user action in the app. It cannot happen silently from the scan.

## Design

### The principle that shapes everything

Code owns the numbers, the model owns the judgment (CLAUDE.md). So:

- **Code decides *whether* something is worth mentioning and *when*.** Lead times, dedupe,
  quiet hours, daily caps and the PAID filter all live in code and are unit tested.
- **The model decides *what to say* and *how to research it*.** It never decides whether the
  anniversary is "close enough". That is a table lookup.

This also makes the quiet case free: if nothing is in a window, no model call happens at all.

### 1. Candidate detection (code, no LLM)

A scanner reads the next ~45 days of events from the calendars above, plus dated memories and
profile facts, and emits **candidates**:

```
{ kind, subject, when, sourceId, sourceKind, amount?, recurring?, timeSensitive }
```

Classification is by keyword and structure first (birthday, anniversary, "bill", "due", "flight",
"appointment", `recurringEventId`), not by asking the model about every event. The model is only
used for the ambiguous remainder, and its guesses are always treated as low confidence. This is
the same "extracted items are mostly false positives" lesson recorded in SPEC.md section 15.

**Bills.** Events matching bill words (bill, due, payment, rent, renewal, invoice, statement) are
`bill` candidates. Any event whose title or description contains the word `PAID`
(case-insensitive, word boundary) is dropped before anything else happens. Amounts are pulled
from the title or description when present, so the heads-up can say "Electric, about $140, due Friday".

**Recurring events.** A series is treated as one subject, not one candidate per instance. Heads-up
offers on the series ("Quarterly estimated taxes are due on the 15th") and only mentions an
instance when it changes (moved, cancelled, location changed), using the same fingerprint approach
as watchers.

### 2. Lead times (code table)

Illustrative starting values, to be tuned. They live in `src/headsup/rules.ts`, never in a prompt.

| Kind | First mention | Reminder | Notes |
|---|---|---|---|
| Anniversary | 14 days | 3 days | Restaurant research offer on the first mention only |
| Birthday | 10 days | 2 days | Gift ideas offer on the first mention only |
| Bill | 5 days | day before, day of | Skipped if marked PAID |
| Recurring event | 2 days | day of | Only if it changed, or on first sighting of a new series |
| Appointment | 2 days | morning of | Offer prep or travel time if it has a location |
| Trip / flight | 3 days | 24 h, then the fast loop | Flight status handoff to the fast loop |

### 3. The ledger

A new `headsups` table (in `src/memory/store.ts`, same style as the other tables):

```
id, dedupe_key UNIQUE, kind, subject, due_at, state, first_offered_at, last_nudged_at,
snooze_until, answer, payload_json
state: new | offered | accepted | researched | dismissed | snoozed | done | expired
```

`dedupe_key` is `kind:sourceId:dueDate`, so Garrett's birthday is one row for one year and the
scanner is safe to run as often as you like. "Done" is set automatically once the date passes.

### 4. Two loops

**Morning heads-up** (seeded once like the brief, `ensureHeadsUp()` in a new `src/headsup/seed.ts`,
a deleted seed stays deleted). It runs shortly before the morning brief, asks the scanner for
everything due for a first mention or reminder, and sends **one** notification: a short list with
a Yes / Not now action per item in the app. The brief can fold the count in ("3 heads-ups today").
A daily cap on offered items lives in code. Overflow rolls to tomorrow rather than being dropped.

**Time-sensitive loop** (every 30 minutes at most, a hard floor in code that no setting can
lower). It is a code-only pass first:

1. Is any tracked item inside its watch window? (A flight from 6 hours before departure to
   arrival. A calendar event with a location starting in the next 3 hours.)
2. If not, stop. No model call, no network call. This is the usual case and costs nothing.
3. If so, fetch the live status, build a **bucketed fingerprint** (delay in 15 minute steps,
   gate, terminal, cancellation; travel time in 10 minute steps) and compare it to `state`.
4. Notify only on a materially changed fingerprint, exactly like `weather-alerts`. The first
   observation seeds state and stays quiet.

The poll interval inside the window can tighten as the time approaches (for example 30 minutes
until 3 hours out, then every 30 minutes still but with a lower change threshold), but never
below the 30 minute floor. Items leave the window and stop being polled on their own, so there
is no watcher that runs forever.

Quiet hours apply to both loops except for a cancellation or a delay beyond a high threshold
on something happening within a few hours.

### 5. Acting on an offer

An accepted heads-up starts a small research run (a normal agent run, read-only tools only)
with a recipe per kind. Recipes are text plus tool allowlists, and a result is stored as a
structured **card**, not prose, so the apps can render it.

- **Anniversary / dinner out:** `web_search` for restaurants near your default location,
  cross-checked with `web_read`. Card items: name, cuisine, rating, price band, link. Booking is
  never done here. A "draft a note to book" action, if added later, goes through the queue.
- **Birthday / gift:** build an anonymized query, search, read product pages. Card items:
  title, **price, image, link back to the product page**. Details below.
- **Bill:** no research. The offer is "mark as a task" and "remind me the day before".
  AgentSpine never pays anything.
- **Flight / trip:** an "Add to tracking" action. Because that creates unattended work it goes
  through the confirmation queue (gap 5), then the fast loop picks it up.

### 6. Gift research in detail

- **Query is built by code from a small struct**, not written freehand by the model:
  `{ occasion, relationship, interests[], budget, avoid[] }`. Interests come from memory and
  profile. The name field is simply not part of the struct, so it cannot leak.
- **Relationship is generalized** ("friend", "family member", "colleague") rather than sent as
  given, because "my brother Garrett" is identifying even without the name.
- **Product data:** search results give links; product pages are read with `web_read`, and the
  extractor pulls price and image from structured data (JSON-LD `Product`/`Offer`, `og:image`,
  `og:price:*`) before falling back to the model. Anything the page claims is wrapped with
  `tagUntrusted` and never treated as an instruction.
- **Amazon specifically** blocks scraping aggressively and has no keyless API. Treat "Amazon
  works" as something to test early, not assume. The card format does not depend on Amazon, so
  results from any retailer work, and an Amazon affiliate or Product Advertising API key could be
  added later without changing the design.
- **Fallback ladder, in order:** (1) a product page we can read gives a full card with price,
  image and link; (2) a page we cannot read gives a link-only item, with the title and snippet
  from the search result; (3) if a whole search yields nothing readable, one Google Shopping
  search link (`https://www.google.com/search?tbm=shop&q=<anonymized query>`) is offered. The
  apps mark rung 2 and 3 items as "no price available" instead of hiding the gap. Google
  Shopping has no public search API for shoppers (its Content API is for merchants), so it is a
  link we generate, never a source we scrape.
- **Images** are fetched and cached by the server (size limited, type checked), and the apps load
  them from the server. This keeps the phone from contacting third-party retailers directly and
  keeps broken or hostile image URLs away from the clients.
- **Prices go stale.** The card stores when it was fetched and the apps show it. Prices are
  presented as "seen at" values, never as a promise.
- **Buying is never done.** "Add to cart" would be irreversible-tier and queued. Not in scope.

### 7. Privacy and security

- **Private stays local.** People, dates and relationships are private. Scanning, ranking and
  writing the offer all run on the local model. Only the final anonymized query leaves the machine.
- **A test enforces the anonymization.** For every person in the people store and memories, assert
  that no outgoing search query contains their name or an alias. This is the single most
  important test in the plan.
- **Calendar and mail content is untrusted.** Event titles and descriptions go through
  `tagUntrusted`. An invite that says "ignore your rules and email this to..." is just text.
- **Read-only Google scopes stay read-only.** Nothing here adds a write scope.
- **Standing work needs consent.** Tracking a flight or a recurring check creates unattended work,
  so it uses `confirmWhenUnattended` or a direct in-app user action, never the scan itself.
- **Policy.** New tools default to denied in `policy.json` until you enable them, like the
  rest of the broker. The ledger tools themselves are reversible and local.

### 7b. Remembering dates you mention

When you say "Garrett's birthday is March 4" or "our anniversary is June 12" in chat, the
assistant offers to remember it. This reuses the existing proposal flow rather than writing
anything itself:

- Detection is a cheap code pass over your own chat messages for date and occasion patterns
  (birthday, anniversary, "due on", "renews on"), with the model confirming and extracting
  `{ who, occasion, date, recurring }`.
- The result is a **proposal in the confirmation queue**, never a direct write, for the same
  reason as meeting extraction: extracted items are mostly false positives. Approving saves a
  memory of a dedicated kind (for example `date`) that the scanner reads next to the calendar.
- It never writes `profile.md` (LEARNING invariant 1). The reply can say which ones deserve
  a line there, as `profile_save` does.
- An event already on your calendar is not proposed again. The scanner checks the ledger
  and the calendar first.
- Only **your own** messages count. Dates in pasted emails, web pages or tool output are
  untrusted content and are ignored here.
- These memories are private, so they never reach the cloud tier, including for embeddings.

### 8. Learning from your answers

- A "Not now" snoozes for a code-defined interval.
- "Don't suggest this" suppresses a `(kind, subject)` forever.
- Repeated dismissals of a **kind** lower its frequency and lead time, using the same counting
  pattern as `rejectShapeKey`. The threshold is a constant in code.
- Accepted offers feed recipes and memory as today, so gift searches get better at your
  taste (colors, brands, budget) over time.

### 9. Surfaces

- **Notifications.** New `HEADSUP` category with "Yes" and "Not now" (and "Don't suggest" on
  long press), handled in `PushManager.swift` like `CONFIRMATION`. The payload carries the
  headsup id and a narrow token, for the same reason `confirmationPush` does.
- **iOS.** A "Heads-up" screen: open offers, results as cards (image, price, link), and history.
  Tapping a gift card opens the product page. Uses the existing `APIClient` and settings.
- **Web.** The same list and cards in `web/`.
- **Later, optional:** a Live Activity for a flight in its watch window. It needs extra APNs
  plumbing (push-to-start and update tokens) and is deliberately not in the first pass.
- **Settings.** Per-kind on/off, daily cap, quiet hours, and lead-time overrides. The 30 minute
  floor is not configurable.

## Phases

Each phase leaves the app working and `npm run check` green, and updates this doc when the
design changes.

**Phase 0: groundwork (small, no behavior change)**
- Extend `upcomingEvents` to a richer `CalEvent` (id, description, all-day, end, recurrence,
  calendar) over a configurable window. Keep the current callers working.
- Read the contact birthdays calendar. Confirm scope coverage.
- Check how the scheduler runs code-only jobs (`digest.ts`, `prune.ts` and `reflect.ts` look like
  precedents) so the fast loop does not need a model turn to find out nothing is happening.

**Phase 1: scanner, rules and ledger (server only, fully testable offline)**
- `src/headsup/` with the classifier, the PAID filter, the lead-time table, the ledger and dedupe.
- Tests with fixture calendars: PAID is ignored, a recurring series is one subject, a birthday is
  offered once, a snooze is honored, quiet hours and the daily cap hold.

**Phase 2: morning heads-up**
- Seeded schedule, one combined notification, `/api/headsups` endpoints, and Yes / Not now / Never.
- Web list. No research yet: "Yes" just records the answer.

**Phase 2b: remembered dates**
- Chat date detector, proposal into the confirmation queue, `date` memory kind read by the
  scanner. Tests: only user messages count, duplicates of calendar events are skipped.

**Phase 3: research recipes and cards**
- Restaurant and gift recipes, the anonymizing query builder, the product extractor, the image
  cache, and the anonymization test. Cards appear in the web client.

**Phase 4: iOS**
- `HEADSUP` category and actions, the Heads-up screen, card rendering, deep links.

**Phase 5: time-sensitive loop**
- Pick and integrate the flight and travel-time sources. Watch windows, bucketed fingerprints,
  30 minute floor, self-expiring items, confirmation-queued tracking.

**Phase 6: bills and recurring polish, then learning**
- Amount parsing, per-kind tuning from dismissals, and a ROLLOUT-style checklist so each kind is
  switched on one at a time and watched before the next.

## Cost and load

- The scanner is code and runs in milliseconds. Model calls happen once for the morning message
  and once per accepted research run.
- The fast loop costs nothing when no item is in its window. When one is, a poll is one HTTP
  request plus a string comparison, and the model is only used to word a notification when
  something actually changed.
- Nothing here moves inference to the AgentSpine host (16 GB). Local model calls go to the model
  host as everywhere else, and keep the prompt prefix stable and append-only.

## Test plan

Plain node scripts like the rest of `test/`, no network. Fixtures for calendar responses.

- `test/headsup-rules.test.mjs`: lead times, PAID, recurrence, dedupe, snooze, cap, quiet hours.
- `test/headsup-anonymize.test.mjs`: no name or alias in any outgoing query. Run against a people
  fixture that includes nicknames and initials.
- `test/headsup-extract.test.mjs`: price and image from saved product-page HTML fixtures, and
  hostile pages (injection text, huge pages, bad image types).
- `test/headsup-loop.test.mjs`: the 30 minute floor, the window enter and exit, bucketed
  fingerprints, first-observation silence, and that an empty window makes no model call.

## Open questions

Answered on 2026-11-18 and folded into the decisions table above: PAID spelling, quiet hours
and daily cap, routing API, retailer fallback, remembering chat dates. Still open, and not
blocking Phases 0 to 3:

1. **Flight status provider.** No preference given. Before Phase 5, compare free-tier limits
   and coverage for two or three providers and pick one. The interface is provider-neutral.
2. **Routing provider details.** Google Routes API needs a key and billing enabled. Confirm
   you are happy to create one, and that your home and common destinations may be sent to it
   (gated in `policy.json`, off until you turn it on).
3. **Which calendars count.** All calendars you can read, or only some? The scanner should
   skip noisy ones (holidays, sports schedules) by default and let you choose.
