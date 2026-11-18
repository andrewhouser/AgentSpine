# Plan: Heads-up (proactive suggestions)

Written 2026-11-18. Status: **Phases 0, 1, 2, 2b and 3 built** (calendar reader, scanner, rules, ledger, planner, the morning heads-up, the API and the web page). Phase 4 onward is proposed. Prompted by Duet noticing a flight and
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
| Travel time API | A **free** provider is preferred. Default plan: **TomTom Routing API** free tier (reported as 2,500 requests/day, with live traffic), behind a `TravelTimeSource` interface and the same `policy.json` gate as `weather`. Verify the current limit on TomTom's pricing page before Phase 5. Fallback if that falls through: HERE's free tier, or OpenRouteService (free, but static road speeds, no live traffic). Google Routes is not the default: its traffic-aware requests are in a paid tier. |
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

**Morning heads-up** (a code-only timer in the dashboard, `src/headsup/morning.ts`, not a seeded
schedule row: see "Decisions made while building"). It runs shortly before the morning brief, asks the scanner for
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

**Phase 0: groundwork (small, no behavior change). Built.**
- Extend `upcomingEvents` to a richer `CalEvent` (id, description, all-day, end, recurrence,
  calendar) over a configurable window. Keep the current callers working.
- Read the contact birthdays calendar. Confirm scope coverage.
- Still to check, before Phase 5: how the scheduler runs code-only jobs (`digest.ts`, `prune.ts` and `reflect.ts` look like
  precedents) so the fast loop does not need a model turn to find out nothing is happening.

**Phase 1: scanner, rules and ledger (server only, fully testable offline). Built.**
- `src/headsup/` with the classifier, the PAID filter, the lead-time table, the ledger and dedupe.
- Tests with fixture calendars: PAID is ignored, a recurring series is one subject, a birthday is
  offered once, a snooze is honored, quiet hours and the daily cap hold.

**Phase 2: morning heads-up. Built (web and server; the iOS half is Phase 4).**
- Seeded schedule, one combined notification, `/api/headsups` endpoints, and Yes / Not now / Never.
- Web list. No research yet: "Yes" just records the answer.

**Phase 2b: remembered dates. Built.**
- Chat date detector, proposal into the confirmation queue, `date` memory kind read by the
  scanner. Tests: only user messages count, duplicates of calendar events are skipped.

**Phase 3: research recipes and cards. Built (server and web; iOS is Phase 4).**
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
2. **Routing key.** TomTom needs a free developer account and API key. Your home and common
   destinations are sent to it, so it is gated in `policy.json` and off until you turn it on.

Decided 2026-11-18: the scanner reads **all calendars you can read except holidays and sports**.
Detection is by Google's calendar id (holiday calendars end in
`#holiday@group.v.calendar.google.com`) and by name for sports (team, league and schedule
calendars), with an exclusion list in config so you can add or remove calendars. The contact
birthdays calendar is always included.

## What is built so far

| File | Role |
|---|---|
| `src/google/client.ts` | `listCalendars`, `eventsBetween`, `mapCalendarEvent` and the richer `CalendarEvent`. `upcomingEvents` is unchanged, so `calendar_upcoming` behaves as before. |
| `src/headsup/calendars.ts` | Which calendars are read: all except holidays and sports, with `HEADSUP_INCLUDE_CALENDARS` / `HEADSUP_EXCLUDE_CALENDARS`. |
| `src/headsup/rules.ts` | Every constant: lead times, daily cap, quiet hours, snooze, the 30 minute floor. Classification and the PAID filter. |
| `src/headsup/scan.ts` | Events to candidates. Pure. A recurring series collapses to one candidate. |
| `src/headsup/ledger.ts` | The `headsups` and `headsup_mutes` tables, offers, answers (yes, later, never), expiry. |
| `src/headsup/plan.ts` | What to offer now: lead-time stages, snooze, mutes, cap, quiet hours. Pure, ledger injected. |
| `src/headsup/index.ts` | Wiring only: fetch every in-scope calendar (one failing does not lose the rest), scan, plan. |
| `test/headsup-scan.test.mjs`, `test/headsup-ledger.test.mjs` | 140 checks, including multi-morning scenarios. |

Decisions made while building, so they are not rediscovered later:

- **Date-only events are never parsed as timestamps.** `new Date("2026-11-20")` is UTC midnight and
  lands a day early west of Greenwich. All-day dates stay strings, and day counts compare dates,
  so a DST change cannot shift a lead time.
- **Stages only move forward.** A first scan that happens late (one day before a birthday) offers the
  *latest* crossed stage, not a stale "ten days out" mention, and records it so the earlier one is
  never offered afterwards.
- **A recurring series fingerprint is time of day plus place, never the date.** The date advances every
  week by design, so including it would flag every instance as "changed".
- **A mute ignores amounts and digits**, so muting "Water bill $40" also mutes next month's "$52.10".
- **Expiry compares calendar dates, not instants**, so an all-day event is still open at 3pm that day.

### Phase 2 (morning heads-up)

| File | Role |
|---|---|
| `src/headsup/morning.ts` | `runMorningHeadsup`: gates, scan, record, one notification. `sweepHeadsup` is the timer entry point. |
| `src/server.ts` | Timer every 10 minutes, and `/api/headsups` (list, `preview`, `run`, `:id/answer`). |
| `web/src/components/HeadsupView/` | The Heads-up page: open items, three answers, history, "Check now". |
| `test/headsup-morning.test.mjs` | 41 checks through the `fetchEvents` / `send` seams. |

Decisions made while building:

- **A timer, not a schedule row.** A schedule row runs the agent loop, which is a model call every
  morning even on an empty day, and sends private dates through a prompt for nothing. The deviation
  from the original plan is deliberate. The cost is that it does not appear on the Schedules page;
  `HEADSUP_ENABLED=false` and `policy.json` (Google reads) are the switches instead.
- **Not before 7:15, never in quiet hours, once per calendar day**, stamped in `kv` so a restart does
  not repeat it. `force` ("Check now") skips the first and third but never quiet hours.
- **A failed calendar read backs off for an hour** and is logged, so a revoked token does not
  produce a line every ten minutes. One failing calendar does not lose the others.
- **Offers are recorded before the push is sent.** If the push fails the item is still on the list,
  which is better than offering it again tomorrow as though it were new.
- **The wording is code, not a model.** Lines are built from the event's own title and a lead-time
  phrase ("Rent $1,800 due: in 5 days"). Cheaper, deterministic, and no private date goes through
  a prompt. The model arrives with Phase 3's research.
- **Button labels are "Got it / Remind me tomorrow / Don't suggest this".** They map to the answers
  `yes / later / never`. Until research exists, "Yes" has nothing to do, so the label is honest.
  Phase 3 relabels it ("Yes, find gift ideas").
- **The push is intentionally plain for now.** It carries `screen: "headsup"` and a collapse id.
  The iOS build ignores an unknown screen and shows no buttons, so nothing breaks before Phase 4
  adds the `HEADSUP` category.
- **Privacy note.** Notification text contains event titles ("Garrett's Birthday"). That is the same
  posture as task and study notifications. With APNs it goes through Apple; with a public ntfy
  topic it is readable by anyone who knows the topic name, so use a private topic.

Not done yet from Phase 2: folding the count into the 7:30 morning brief.

### Phase 2b (remembered dates)

| File | Role |
|---|---|
| `src/headsup/detect.ts` | Finds "Garrett's birthday is March 4" in a chat message. Pure, strict, no model. |
| `src/headsup/dates.ts` | The `headsup_dates` table, proposing, saving on approval, feeding the scanner, calendar de-duplication. |
| `src/tools/date-remember.ts` | The `date_remember` tool: irreversible-tier and `confirmWhenUnattended`, so it always queues. |
| `src/runner.ts` | One line: a `chat` run hands the user's message to the detector. |
| `src/server.ts` | `GET /api/headsups/dates`, `DELETE /api/headsups/dates/:id`. Approval reuses `/api/confirmations`. |
| `test/headsup-dates.test.mjs` | 93 checks, mostly negative cases, plus chat -> approval -> offer end to end. |

Decisions made while building:

- **Regex, not a model.** The plan said "the model confirming and extracting". A clause either states
  a person, an occasion and a date or it does not, and code recognises that reliably, privately and
  for free on every chat turn. The cost is that loosely-worded dates are missed ("Garrett turns 40 on
  the fourth"); the assistant can still save those through the `date_remember` tool when you say so.
  Every hit is a proposal you approve, so a miss costs a sentence and a false hit costs one question.
- **What is deliberately not detected:** "my birthday" (your own is not a heads-up), questions and
  conditionals, impossible dates (Feb 30), non-people ("it's birthday"), and any message over 400
  characters, which is probably a paste of somebody else's words. A lowercase name is not a name:
  only a capitalised word, or "my"/"our" plus a relation, counts.
- **Proposals go to the inbox, not the chat thread.** Approving from a thread resumes it with a model
  turn ("Approved: remember a date"), which is a model call and a message for a one-line fact. The
  inbox does not resume. They show on the Heads-up page under "Dates it noticed", in the normal
  approvals list, and in the existing unanswered-approval reminder push.
- **A date asked about is never asked about again**, in any state. Declining Mia's birthday does not
  bring it back next week when you mention it again. The search is the latest 100 confirmations.
- **Calendar overlap is resolved at scan time, not proposal time.** Checking the calendar when you
  type would put a Google call on every chat turn. Instead a remembered date is dropped when a
  calendar event of the same kind, on the same day, shares a name with it (or when it has no name,
  as with "Your Anniversary"). So you can remember a date that is also on the calendar and still hear
  about it once.
- **Remembered dates work with Google off.** They need no network and no account, so the morning
  job runs for them even when `policy.json` has Google reads disabled. The `disabled` status now
  means only `HEADSUP_ENABLED=false`.
- **"my" becomes "your".** The assistant is the one speaking: "Your Wife's Birthday: in 10 days".
- **Feb 29 falls back to Feb 28** in a common year, so a leap-day birthday is not skipped three years in four.
- **Numeric dates are month/day** (US). One that cannot be (25/12) is read as day/month.
- **The memory is a convenience.** Approval also writes "Garrett's birthday is March 4." as a `date`
  memory so "when is Garrett's birthday?" recalls it. If that write fails the date is still saved.

### Phase 3 (research and cards)

| File | Role |
|---|---|
| `src/headsup/research/net.ts` | `safeGet`: fetches a public URL and refuses anything private (SSRF guard). |
| `src/headsup/research/product.ts` | Reads a product card (title, price, image) from a page's JSON-LD and Open Graph tags. Pure. |
| `src/headsup/research/query.ts` | Builds the queries that leave the machine, and refuses any containing a name. |
| `src/headsup/research/recipient.ts` | Summarises what you know about the person, with the local model only, and re-validates the result in code. |
| `src/headsup/research/cards.ts` | Card store, the image cache (sniffed by bytes, never SVG). |
| `src/headsup/research/run.ts` | `researchHeadsup`: the orchestrator. Everything injected, so it runs offline in tests. |
| `src/tools/web-search.ts` | New `searchHits()`: structured results from the same providers. `web_search` itself is unchanged. |
| `src/server.ts` | "Yes" starts research for birthdays and anniversaries; `POST /api/headsups/:id/research` retries; `GET /api/headsups/images/:id` serves cached photos. |
| `web/.../HeadsupView` | Result cards with photo, price, host and link; the "Yes" button names what it will do; polling while it looks. |
| `test/headsup-net`, `-product`, `-research` | 69, 93 and 63 checks. |

What "Yes" does now: a birthday looks for gift ideas, an anniversary looks for restaurants. Bills,
appointments, flights and recurring events have nothing to look up, so their button stays "Got it".

Decisions made while building:

- **The model sees only your own memories, never the web.** The one model call summarises what you
  remember about the person into a closed relationship, a few interest phrases, an optional budget
  and cuisines, on the local model only (`sensitivity: "private"`). Page text is read by code and is
  never shown to a model, so a hostile page has nothing to talk to.
- **The query has no field for a name, and three layers anyway.** The fixed shape has none; free-text
  interests that mention a known name are dropped; and `assertAnonymous` throws before any search if a
  finished query still contains one. Names protected are the people in remembered dates, in every
  birthday and anniversary heads-up (calendar contacts included), and any capitalised word found in
  the memories used. That last rule is cautious: it also drops places and brands from interests. Cuisines,
  weekdays and months are exempt, because "Thai" is not a person and the restaurant search needs it.
  Bills and appointments are not protected, so "electric guitar" survives a bill called "Electric".
- **Relationships are collapsed to seven words** (partner, parent, child, sibling, relative, friend,
  colleague). "My brother Garrett" identifies someone even without the name; "a sibling" does not.
- **The page shows exactly what was searched**, as "Searched for: ...". You can see what left the machine.
- **SSRF is guarded at connect time.** Product pages and image links are attacker-controlled strings,
  and this machine sits next to the model host and the dashboard. Addresses are checked inside the
  socket's own DNS lookup (so a rebinding name is refused), IP literals up front, and every redirect hop.
  No dependency: `node:http(s)` lets us own the lookup, `fetch` does not. Bodies are capped while
  streaming, including after decompression.
- **Images are kept by the server, and judged by their bytes.** JPEG, PNG, GIF or WebP only, never SVG,
  whatever `Content-Type` claimed. Served with `nosniff` and a locked-down CSP. The apps load them from
  here, so a phone never contacts a retailer (which would tell it your address and that you are shopping).
  Not resized: there is no image library in the dependencies, and a 1.5 MB cap keeps it bounded.
- **The card links to the page that was fetched**, never to a canonical URL or `url` field the page
  declares, since a hostile page could point those anywhere.
- **Fallback ladder:** a readable page gives a full card; an unreadable one gives a link-only card from
  the search result's own title and snippet; nothing at all gives one Google Shopping (gifts) or Google
  Maps (restaurants) search link built from the same anonymous query. Cards without a price say
  "no price available" instead of hiding the gap.
- **Restaurants need `DEFAULT_LOCATION`.** Without one the web results would not be local, so no web
  search is made and the card is a Maps link, which knows where you are when you open it. With one, the
  city goes to the search provider, the same consent as `weather`.
- **Research needs `policy.web.searchEnabled`.** With it off, you get the fallback link and a note.
- **A heads-up you said Yes to stays on the page** (birthdays and anniversaries only), so the results are
  there to read. This fixed a Phase 2 gap found by running the real server: "open" used to drop an item
  the moment it was accepted.
- **A push says when it is ready** ("3 gift ideas ready"), only when there are real ideas, not a bare link.

Not done, deliberately:

- **No headless-browser fallback for blocked retailers.** Amazon and some others serve bots a block
  page, which the ladder handles by degrading. A browser fallback would read more pages but is slower,
  heavier and a larger attack surface. Worth revisiting only if the link-only cards turn out to be common.
- **No availability or booking for restaurants** (OpenTable, Resy), and no buying. Both would be new
  integrations; buying is irreversible-tier and queued.
- **Prices are "seen on" a date, never a promise.** Use "Look again" to refresh.
