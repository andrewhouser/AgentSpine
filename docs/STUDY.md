# Study: learning with AgentSpine

`LEARNING.md` is about AgentSpine learning *you*. This is the other direction: AgentSpine helping
you learn something, using techniques from learning science.

## The premise

You learn by **producing**: recalling, predicting, explaining, attempting. Rereading feels like
learning and mostly isn't (in the studies the design draws on, rereading four times kept about 40%
after a week; reading once and being tested kept about 61%). So every tool either makes you produce
something and records how it went, or turns a miss into something to produce again later.
`study_explain`, the only passive one, files a recall card and tells you to say it back.

## The tools

All are called by the chat agent; you just talk to it ("quiz me on Okta", "I'm learning X, interview me").

| Role | Tool | What it does |
|---|---|---|
| Interviewer | `study_interview` | Asks what your real goal, deadline, level and test format are, then saves a profile. Flags vague answers. |
| Mapmaker | `study_map` | Builds an ordered curriculum with dependencies and the usual sticking points. |
| Explainer | `study_explain` | Explains one concept at child / beginner / teenager / expert level, files a card, demands an explain-back. Given the `task` you were stuck in, it also files a **redo card due tomorrow**: the whole task again, from scratch, no help. |
| Examiner | `study_quiz` + `study_answer` | One question at a time, harder after each right answer. Stops when you guess or miss twice running, and sets your level. |
| Socratic questioner | `study_quiz` mode `socratic` | Why / what-if questions that build on your last answer. Never gives the answer; shows your gaps at the end. |
| Checker | `study_check` | Grades your *process* on something you made. Does not rewrite it. |
| Listener | `study_listen` | You explain back verbally, in writing and/or as a described diagram. Graded against the source, flags where the forms disagree. |
| Diagnostician | `study_diagnose` | Reads your recent misses and names the shared root misunderstanding, with cards that test it. Needs 3+ misses. |
| Sparring partner | `study_spar` | Role-played practice with a persona, difficulty and a per-answer time limit enforced from the clock. |
| Clerk | `study_cards` `from_notes` | Messy notes to a clean outline or flash cards. Adds nothing you did not write. |
| (finder) | `study_resources` | 3–5 explanations pitched at your level, chosen with what the interviewer recorded you know and don't. Every link must appear in the web search results or code drops it. Never searches with project documents. |
| (ledger) | `study_topic` | List / inspect / set goal and level / link to a project / delete. |
| (memory) | `study_cards` | Spaced repetition: `due` shows the question only, `review` grades your recall and reschedules. |

## Where the model stops and code starts

The model judges content: is this answer right, what is the gap. Code owns every rule with a
number in it: the difficulty ramp, when a session ends, the spar time limit, what counts as a miss
(under 70%), what is due, and the card schedule (`src/study/schedule.ts`, SM-2 with 1 and 3 day
first intervals and a 10-minute retry after a lapse). The hidden key points a question is graded
against are stored but never returned to you.

## Redo without help

Being walked through the step you were stuck on feels like having learned the task. The only
test is doing the whole thing again, cold. So when `study_explain` gets the `task` you were
attempting, it files a `redo` card due **tomorrow** (redoing it a minute later is copying). The
card asks for the full task from the start, names the step you were stuck on, and is graded
against the explanation's key points, like any recall, on the Study screen or in chat.

## Questions you were asked in meetings

After a meeting's extraction runs, if the meeting is filed under a project, AgentSpine looks for
the questions people put to **you** (`src/study/meeting-questions.ts`):

1. **Code finds them, by speaker.** "You" is the speaker you named `me` on the meeting page (or a
   name in `MEETING_SELF_NAMES`). A question is a turn by someone else containing one, answered by
   your next turn. The model never decides a question was put to you.
2. **The local model keeps the substantive ones** (no logistics, small talk or "can you hear me")
   and words each as a standalone card.
3. **The answer key comes from the project's documents, never the room.** Meeting transcripts are
   indexed into the same project, so recall leaves out `meeting` chunks. Otherwise the answer
   would be whatever you said on the spot. A source the model cites but wasn't shown is dropped.
   If the documents don't cover a question, the draft says so and is marked.
4. **Nothing becomes a card on its own.** Candidates wait under "Questions you were asked" on the
   meeting page, showing the quote, what you said, and the draft. Edit, then **Add to Study**, or
   **Dismiss**. Accepted cards go under a study topic named after the project and linked to it, so
   they're graded locally. A re-run (after naming yourself, say) never offers back a question
   you've already decided.

Every model call here is `sensitivity: "private"`, like all meeting work.

## Using it with a project

Link a topic to a project (`study_topic set` with `project: "this"`, or create it from inside a
project's conversation) and questions, explanations and grading are drawn from that project's
indexed documents, for example the Milliman CX knowledge. A topic linked to a project is **pinned
to the local model**: project documents are work material and a study aid is not a reason to send
them to the cloud. Topics with no project may use the cloud tier like any other call.

## The Study screen (web and iPhone)

Card review is the one loop you repeat daily, and as a chat it took a round trip per card. So it
has its own screen: **Study** in the web sidebar and a Study tab in the iPhone app. It shows the
question, you type (or dictate) your recall, and only then does it show the grade and the answer.
That order is the point: a self-rated "I knew that" is the feeling rereading gives you. Both
screens and `study_cards review` in chat call the same `reviewWithRecall` (`src/study/review.ts`),
so grading, scheduling and the ledger are identical wherever you answer. "I don't know" counts as
forgotten without a model call. If the model gives no usable grade, the card is left untouched
and you can simply press Check again.

Below the review sits each topic: its goal, examiner level, cards due, read-versus-produced count,
the mapmaker's curriculum, and which chat tool to reach for next. Everything with a back and forth
(interview, map, quiz, explain-back, sparring) stays in chat.

API: `GET /api/study`, `GET /api/study/due?topic=` (the question only; the answer is never sent
before a recall), `POST /api/study/cards/:id/review {answer}`.

## Reminders

Once a day at most, while any card is due, `sweepDueCards` sends one notification ("N study cards
due"). It runs from the dashboard server beside the task sweep. It goes through the outbox as the
`study` source, which is one of the governed ones: with `OUTBOX_ENFORCE` on, quiet hours hold it, a repeat
inside 12 hours is collapsed, and it counts toward the daily cap (`docs/PLAN-open-work.md` section 2). A tap opens the Study screen: on
the iPhone through the push's `screen: "study"`, and in ntfy through a click URL when
`DASHBOARD_PUBLIC_URL` is set.

## Data

Five tables in the main SQLite file: `study_topics`, `study_cards`, `study_attempts`, `study_meta`,
and `study_meeting_questions` (the candidates waiting for review, see "Questions you were asked in
meetings").
`study_attempts` is the ledger of everything you produced; the diagnostician and the
read-versus-produced counter in `study_topic get` both read from it. Deleting a topic removes its
cards and history and is the one study action that asks for confirmation.

## Not built yet

Scheduling a study session on the heartbeat, and generating practice apps. The Study screen
covers most of what the practice apps were for. Say if you want either.

Tests: `node test/study.test.mjs` (scripted model; no network).
