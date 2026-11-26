# The spine: what each screen reads

R0 of `docs/PLAN-open-work.md` section 15. The drawings are `index.html` beside this file (open it
through any static server from the repository root, so the shared tokens load). This file is the one
contract the web, Mac and iPhone clients are built against. Nothing here exists until its R item
builds it; each shape says which fields already exist and where they come from.

Rules that apply to every shape below:

- **Code fills every field.** The only model-written text on any of these screens is a chat answer
  (Ask) and, if R9's second half is ever built, the "For today" wording. Order, counts, "late",
  "days since" and agreement numbers are computed on the server.
- **Other people's text is marked.** Mail subjects, calendar titles, quotes and transcript lines are
  `untrusted: true` strings in the sense of `tagUntrusted`: shown, never put into a goal or prompt
  by a client. A client sends ids, never these strings, back to the server.
- **Work material carries its pin.** Anything from meetings, projects, people or mail is
  `where: "local"`; a client never offers to send it anywhere.
- **Approve only from the card.** No list shape below carries an approve action. A row links to
  `GET /api/confirmations/:id`.
- Times are ISO strings; `atMs` is milliseconds into a meeting.

Legend: **[exists]** already stored or served, **[new]** added by the named R item,
**[check]** not yet confirmed and must be checked before the item that needs it.

---

## Shared pieces

```ts
/** A point in a meeting. Every quote on every screen is one of these. */
interface Moment {
  meetingId: number;          // [exists] kn_claims.source_ref "meeting:<id>", meeting_work_items.meeting_id
  meetingTitle: string;       // [exists] untrusted
  at: string;                 // [exists] the meeting's start
  atMs: null | number;        // [exists] kn_claims.at_ms, meeting_work_items.start_ms
  speaker: null | string;     // [exists] kn_claims.speaker
  quote: string;              // [exists] kn_claims.passage, meeting_work_items.quote; untrusted
  /** Playback is offered only while the audio is kept. MEETING_KEEP_AUDIO_HOURS defaults to 0,
   *  so by default this is false and the client shows the transcript around atMs instead. */
  audio: boolean;             // [exists] meetings/audio.ts, checked per meeting
}

type Direction = "you-owe" | "they-owe" | "unknown"; // [new R7] from who it is owed to on kn_claims
type Where = "local" | "cloud";                       // [exists] runs.private / served
```

`GET /api/meetings/:id/around?atMs=` **[new R4]** returns the transcript segments within a minute of
`atMs` (from `meeting_segments`, which are timed **[exists]**), for when `audio` is false.

## 1. The spine — `GET /api/spine` **[built R1]**

As built: Today, field for field, plus two fields, so every client keeps the Today words it has.
`Later` and `Seen` stay on `/api/today` and answer with Today alone; a client keeps the last `ahead`.
No model call, and it never waits on Gmail or Calendar.

```ts
interface Spine extends Today {           // Today as src/today.ts builds it [exists]
  ahead: SpineAhead[];                    // src/day-line.ts
  calendarAsOf: null | string;            // the last clean read stored by Heads-up or the check-in
}

interface SpineAhead {
  allDay: boolean;
  at: string;                             // ISO, or a bare date for an all-day event
  detail: string;                         // a schedule's spec, or a calendar's name
  key: string;                            // "schedule:<id>" or "event:<start>|<title>"
  kind: "event" | "schedule";
  scheduleId: null | number;
  title: string;                          // untrusted when kind is "event"
  untrusted: boolean;
}
```

Ahead is each enabled schedule's next run before midnight and today's events from
`src/calendar-cache.ts` that have not started, all-day first, at most 30. "Prep" from the R0 drawing
is not in it: nothing defines prep yet, and its counts are R7's.

## 2. The decision card — `GET /api/confirmations/:id` **[built R2]**

As built (`src/decision-card.ts`). The facts' sentences are the server's, so no client words them.

```ts
interface DecisionCard {
  alwaysAllow: null | { approvals: number; target: string; tool: string }; // only when offered
  args: string;
  conversationId: null | number;
  expiresAt: null | string;
  facts: {
    leaves: null | string[];             // outgoingText parts; null when the declaration failed
    leavesLine: string;
    origin: "button" | "helper" | "schedule" | "unknown" | "you-typed";
    readOutside: boolean;                 // runs.read_outside on the run, its root, or its thread
    undo: "irreversible" | "reversible";
    undoLine: string;
    where: "cloud" | "local" | "none";
    whereLine: string;
    whyLine: string;
  };
  id: number;
  nextId: null | number;                  // next pending card, oldest first
  pinned: boolean;                        // alwaysConfirm: no rule may skip it
  position: { index: number; of: number };
  state: string;
  summary: string;
  tool: string;
  ts: string;
}
```

Approve and Reject stay on `POST /api/confirmations/:id/approve|reject`, which re-check policy and
`tool.refuse`. "Always allow" posts `{tool, target}` to `/api/proposals` [exists]. Approve is held for
0.8 s on every client (`HOLD_MS`, `DecisionWords.holdSeconds`).

## 3. Trust dials — `GET /api/modes`, `POST /api/modes/:feature` **[new R3]**

```ts
interface Dial {
  feature: "checkin" | "inbox-sort" | "headsup" | "outbox" | "outgoing";
  label: string;
  mode: "off" | "watch" | "on";
  /** The modes a screen may choose. A guard (outgoing) only ever tightens, so its looser modes are absent. */
  allowed: ("off" | "watch" | "on")[];       // [new R3, Fable decides .env ceiling vs default]
  guard: boolean;
  agreement?: { agreed: number; of: number; days: number }; // arithmetic in code, Watch only
}

interface WouldHave {
  id: number;
  at: string;
  feature: Dial["feature"];
  action: string;                            // code-written: "Would have pushed", "Would have stayed quiet"
  subject: string;                           // untrusted
  thumbsDown: boolean;
}
// GET /api/modes/:feature/would-have?days=7 -> WouldHave[]   (from the log each feature keeps [exists])
// POST /api/modes/:feature/would-have/:id/thumbs-down
```

No tool and no run may call the POST routes; the store's file joins `PROTECTED_PATHS`.

## 4. Live meeting and closeout **[R4]**

The live screen reads the existing stream: `GET /api/meetings/stream` (segments, status)
**[exists]** and `GET /api/meetings/:id/coach` **[exists]**. New:

```ts
// POST /api/meetings/:id/marks {atMs}  -> {id}      [new R4] stores a timestamp and nothing else
interface CoachLine {                     // [new R4] replaces free coach notes on this screen
  text: string;                           // code-written from a claim, not model prose
  because: Moment;                        // the earlier moment it rests on
}

interface CloseoutItem {                  // GET /api/meetings/:id/closeout [new R4], one at a time
  id: number;
  kind: "commitment" | "remember";
  text: string;                           // untrusted (extracted)
  moment: Moment;
  direction?: Direction;                  // commitments only [new R7]
  owedTo?: null | { personId: number; name: string };
}
// POST .../closeout/:id {answer: "add-task" | "not-mine" | "remember" | "skip", direction?}
```

Answers go through the existing review rule: extracted items are confirmed before they reach
tasks, memory or RAG **[exists]**. This is a new screen over that path, not a new path.

## 5. Ask — the chat turn, with sources **[R5]**

The ask bar starts an ordinary chat turn. Scope travels as a field, never as text in the goal:

```ts
// As built in R1: POST /api/conversations {projectId?} then
// POST /api/conversations/:id/messages {task, attachmentIds}, with `task` exactly the typed text.
// A project scope is the conversation's project and nothing else. Person and meeting scopes
// (a retrieval filter, never words added to `task`) wait for R7 and R4.
interface AnswerSources {                 // attached to the assistant turn [new R5]
  status: "supported" | "insufficient" | "conflicting"; // knowledge/answer.ts [exists]
  supported: { claimId: number; text: string; moment: null | Moment }[];
  notFound: string[];                     // code-written: the parts of the question nothing supports
}
```

## 6. Memory — `GET /api/memories` (extended) **[R6]**

```ts
interface MemoryRow {
  id: number;
  text: string;
  kind: string;                           // [exists]
  from: { route: string; runId: null | number; moment?: Moment } | null; // provenance [exists]; null = before provenance
  uses: number;                           // [new R6] written by recall
  lastUsed: null | string;                // [new R6]
  confirmed: boolean;                     // [new R6] false = "guess"
  cloudSafe: boolean;                     // [exists] cloud_safe; set only by code
}
// POST /api/memories/:id/confirm          [new R6]
// POST /api/memories/:id/local-only       [new R6] clears cloud_safe; there is no route that sets it
// DELETE /api/memories/:id                [exists] Forget
// GET /api/memories?unusedDays=90         [new R6]
```

## 7. A person — `GET /api/people/:id`, `GET /api/people` **[built R7]**

As built (`src/knowledge/people.ts`). No evidence store: you decided to leave it out.

```ts
interface Person {
  aliases: string[];
  daysSince: null | number;               // since the last 1:1
  heard: { claimId: number; kind: string; moment: null | Moment; reviewed: null | string; text: string }[];
  id: number;
  lastOneToOne: null | { at: string; meetingId: number; title: string };
  name: string;
  nextOneToOne: null | { at: string; title: string };   // from the stored calendar
  onTeam: boolean;
  open: { claimId: number; direction: "they-owe" | "you-owe"; due: null | string; inferred: boolean; late: boolean; moment: null | Moment; text: string }[];
}
// GET  /api/people -> { aliases, daysSince, id, name, onTeam, theyOwe, youOwe }[], team first
// POST /api/people/:id/team {on}
// PATCH /api/knowledge/claims/:id {review: "accept", owner, owedTo: "me" | name | null}  corrects direction
```

`Moment` here has no `untrusted` flag field, but its `quote` and `meetingTitle` are other people's words.

## 8. A project — `GET /api/projects/:id/page` **[built R8]**

As built (`src/knowledge/project-page.ts`). There is no `agreedBy`: agreement is not recorded, so the
page names who was present instead.

```ts
interface ProjectPage {
  decided: { claimId: number; moment: null | Moment; present: string[]; saidBy: null | string; text: string }[];
  meetings: number;
  open: { claimId: number; last: null | Moment; raisedIn: number; text: string; topic: null | string }[];
  projectId: number;
  risks: { claimId: number; namedBy: string[]; text: string; times: number }[];
  waiting: { claimId: number; direction: "they-owe" | "unknown" | "you-owe"; due: null | string; late: boolean; text: string; who: null | string }[];
}
```

---

## Answers found while drawing (section 15 listed them as unchecked)

- **Does a claim link to its moment?** Yes. `kn_claims.source_kind` is `meeting`, `source_ref` is
  `meeting:<id>` and `at_ms` is the offset (see `knowledge/closeout.ts` and `knowledge/briefs.ts`,
  which already build `cite: {atMs, passage, source}`).
- **Is audio still there when a quote is played?** Not by default. `MEETING_KEEP_AUDIO_HOURS`
  defaults to 0, so audio is not kept after the transcript is made. Playback is the exception;
  the transcript around the moment is the normal path, and every `Moment` says which applies.
