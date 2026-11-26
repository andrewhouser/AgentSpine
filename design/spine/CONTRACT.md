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

## 1. The spine — `GET /api/spine` **[new R1]**

Beside `readToday`, not instead of it, until all three clients have moved. No model call, and it
never waits on Gmail or Calendar.

```ts
interface Spine {
  now: string;
  lookedAt: string;            // [exists] Today's "today:looked"
  count: number;               // [exists] Today.count, the one number for badge, Dock and menu bar
  behind: SpineMoment[];       // [exists] Today.since, newest first, same cap
  needs: SpineMoment[];        // [exists] Today's approvals, tasks, headsups, mail, in Today's order
  ahead: SpineMoment[];        // [new R1] next run of each schedule + today's stored calendar events
}

interface SpineMoment {
  key: string;                 // stable across refreshes, for Later and Seen
  at: null | string;
  kind: "run" | "approval" | "task" | "headsup" | "mail" | "schedule" | "event" | "meeting" | "build";
  title: string;               // untrusted when kind is mail, event or meeting
  detail: string;              // code-written: "expires 11:00", "2 days late", "Watch mode"
  state: "ok" | "failed" | "stalled" | "skipped" | "needs-you" | "ahead";
  where: null | Where;
  /** What a tap opens. Approval rows open the card, never approve. */
  open: { confirmationId?: number; meetingId?: number; personId?: number; projectId?: number; runId?: number; taskId?: number };
  /** Only on calendar events: whether a prep note exists, and the counts behind "2 you owe, 1 they owe". */
  prep?: { ready: boolean; youOwe: number; theyOwe: number; lastOneToOneDays: null | number }; // [new R1, counts R7]
}
```

`ahead` reads schedules' next run from `src/scheduler.ts` **[exists]**. Today's calendar events
must come from what the check-in or Heads-up already stored **[check R1]**: if neither stores
today's events, R1 adds a stored copy written by the check-in, not a live call from this route.

## 2. The decision card — `GET /api/confirmations/:id` **[new R2]**

```ts
interface DecisionCard {
  id: number;
  position: { index: number; of: number };   // one at a time, oldest first
  tool: string;
  title: string;                             // confirmations.summary [exists]
  text: string;                              // the whole proposed action [exists, TodayApproval.text]
  expiresAt: null | string;                  // [exists]
  facts: {
    leaves: string[];                        // the tool's outgoingText parts [exists]; [] = nothing leaves
    where: Where;                            // the run's pin [exists]
    undo: "reversible" | "undoable" | "irreversible"; // the broker's tier [exists]
    why: "you-typed" | "schedule" | "button" | "after-outside-content"; // [new R2] needs a run fact
  };
  /** Offered only when promote.ts would propose it: never for alwaysConfirm, never after outside content. */
  alwaysAllow: boolean;                      // [new R2, Fable decides]
  editable: boolean;
}
```

`POST /api/confirmations/:id/approve` stays as it is **[exists]**. Hold-to-approve is client-side;
the server still re-checks policy and `tool.refuse` at approval time **[exists]**.

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
// POST /api/conversations/:id/messages {task, attachmentIds}            [exists]
//   + scope?: {projectId?: number; personId?: number; meetingId?: number}  [new R1]
// A project scope uses the conversation's project (POST /api/conversations {projectId} [exists]);
// a person or meeting scope is a retrieval filter, never words added to `task`.
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

## 7. A person — `GET /api/people/:id` **[new R7]**

```ts
interface Person {
  id: number;                             // kn_entities, kind person [exists]
  name: string;
  team: null | string;                    // kn_entities kind team [exists]
  lastOneToOne: null | { at: string; meetingId: number };
  nextOneToOne: null | { at: string };    // from the stored calendar [check R1]
  daysSince: null | number;               // code
  open: { claimId: number; text: string; direction: Direction; due: null | string; late: boolean; moment: null | Moment }[];
  heard: { claimId: number; text: string; kind: string; moment: null | Moment; times: number }[]; // reviewed claims naming them
  forToday: string[];                     // R9 first version: code-built lines, oldest owed first
  evidence?: { id: number; text: string; tag: "strength" | "growth"; markedAt: string }[]; // [R7, only if you decide it exists]
}
// GET /api/people -> { id, name, team, youOwe, theyOwe, daysSince }[]
```

`evidence` is absent unless R7's Fable read and your decision say it exists. When present it is
local-only, never recalled into a run about anyone else, and `DELETE /api/people/:id/evidence`
removes all of it in one step.

## 8. A project — `GET /api/projects/:id/page` **[new R8]**

```ts
interface ProjectPage {
  id: number;
  name: string;
  meetings: number;
  decided: { claimId: number; text: string; proposedBy: null | string; agreedBy: string[]; moment: null | Moment }[];
  open: { claimId: number; text: string; raisedIn: number; last: null | Moment }[]; // raisedIn counted in code
  risks: { text: string; namedBy: string; times: number }[];
  waiting: { claimId: number; text: string; direction: Direction; who: string; due: null | string }[];
}
```

`proposedBy` and `agreedBy` need the speakers of a decision's supporting claims **[check R8]**;
`kn_claims.speaker` holds one speaker per claim today.

---

## Answers found while drawing (section 15 listed them as unchecked)

- **Does a claim link to its moment?** Yes. `kn_claims.source_kind` is `meeting`, `source_ref` is
  `meeting:<id>` and `at_ms` is the offset (see `knowledge/closeout.ts` and `knowledge/briefs.ts`,
  which already build `cite: {atMs, passage, source}`).
- **Is audio still there when a quote is played?** Not by default. `MEETING_KEEP_AUDIO_HOURS`
  defaults to 0, so audio is not kept after the transcript is made. Playback is the exception;
  the transcript around the moment is the normal path, and every `Moment` says which applies.
