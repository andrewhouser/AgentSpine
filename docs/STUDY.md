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
| Explainer | `study_explain` | Explains one concept at child / beginner / teenager / expert level, files a card, demands an explain-back. |
| Examiner | `study_quiz` + `study_answer` | One question at a time, harder after each right answer. Stops when you guess or miss twice running, and sets your level. |
| Socratic questioner | `study_quiz` mode `socratic` | Why / what-if questions that build on your last answer. Never gives the answer; shows your gaps at the end. |
| Checker | `study_check` | Grades your *process* on something you made. Does not rewrite it. |
| Listener | `study_listen` | You explain back verbally, in writing and/or as a described diagram. Graded against the source, flags where the forms disagree. |
| Diagnostician | `study_diagnose` | Reads your recent misses and names the shared root misunderstanding, with cards that test it. Needs 3+ misses. |
| Sparring partner | `study_spar` | Role-played practice with a persona, difficulty and a per-answer time limit enforced from the clock. |
| Clerk | `study_cards` `from_notes` | Messy notes to a clean outline or flash cards. Adds nothing you did not write. |
| (ledger) | `study_topic` | List / inspect / set goal and level / link to a project / delete. |
| (memory) | `study_cards` | Spaced repetition: `due` shows the question only, `review` grades your recall and reschedules. |

## Where the model stops and code starts

The model judges content: is this answer right, what is the gap. Code owns every rule with a
number in it: the difficulty ramp, when a session ends, the spar time limit, what counts as a miss
(under 70%), what is due, and the card schedule (`src/study/schedule.ts`, SM-2 with 1 and 3 day
first intervals and a 10-minute retry after a lapse). The hidden key points a question is graded
against are stored but never returned to you.

## Using it with a project

Link a topic to a project (`study_topic set` with `project: "this"`, or create it from inside a
project's conversation) and questions, explanations and grading are drawn from that project's
indexed documents, for example the Milliman CX knowledge. A topic linked to a project is **pinned
to the local model**: project documents are work material and a study aid is not a reason to send
them to the cloud. Topics with no project may use the cloud tier like any other call.

## Reminders

Once a day at most, while any card is due, `sweepDueCards` sends one notification ("N study cards
due"). It runs from the dashboard server beside the task sweep.

## Data

Four tables in the main SQLite file: `study_topics`, `study_cards`, `study_attempts`, `study_meta`.
`study_attempts` is the ledger of everything you produced; the diagnostician and the
read-versus-produced counter in `study_topic get` both read from it. Deleting a topic removes its
cards and history and is the one study action that asks for confirmation.

## Not built yet

A dedicated web or iOS screen (it is chat-only today), scheduling a study session on the
heartbeat, and generating practice apps. Say if you want any of them.

Tests: `node test/study.test.mjs` (scripted model; no network).
