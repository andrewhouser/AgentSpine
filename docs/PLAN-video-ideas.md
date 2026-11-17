# Plan: ideas from two videos (AI learning roles, "AI operating system")

Source transcripts: *My AI Setup Feels Like Cheating* (ten AI learning roles, spaced repetition)
and *Turn Claude Code Into Your AI Operating System* (overview map, MCPs, memory, skills,
routines, spoken "I'm done" alerts). Written 2026-11-17 against `main` at 9037b7c.

## What is already done (no work)

- **All ten learning roles plus spaced repetition** shipped in 0fcd730 (`src/tools/study.ts`,
  `STUDY.md`): interviewer, mapmaker, explainer, examiner, Socratic, checker, listener,
  diagnostician, sparring, clerk, SM-2 cards, daily due-card nudge.
- **Most of the "AIOS" video, too:** connectors (Gmail, Calendar, Apple, Chrome, weather), memory
  with Settings → Memory, auto-extracted recipes and lessons (LEARNING.md Phase 3), schedules,
  watchers, heartbeat, morning brief, tasks, drafts ("it writes, you send"), push to the phone,
  local TTS.
- **Where AgentSpine does better than the video, and should stay that way:** the video's hourly
  routine *sends* email replies on its own. AgentSpine drafts and you send. Keep it like that.

So the work below fills real gaps. None of it rebuilds what's there.

## Audit of the earlier plans (2026-11-17)

The root design docs moved to `docs/`. `goals.md` and `profile.example.md` stay at the root
because the code reads `goals.md` from there (`GOALS_PATH`) and setup copies `profile.example.md`.
Nothing was deleted: every moved file is referenced from code, config or the README.

- **PLAN-assistant-upgrade.md**: all 9 phases shipped (trust, tasks, files, search, brief and
  research, clients and time, web views, iOS screens). Nothing left.
- **PLAN-build-loop.md**: all 7 phases shipped. What's left:
  - `.xcresult` parsing (`-resultBundlePath` + `xcresulttool`). It's still the right answer for
    Xcode, but it needs a real build outside Claude's sandbox to verify. **Parked.** Pick it up
    only if build-failure summaries for Xcode turn out wrong in practice.
  - Arguments for declared commands (a test-name filter). It said "nothing has needed it yet",
    and that's still true. **Parked.**
  - The "router vision fallback still wrong" note was stale. `fallbacksFor` fixed it. The doc
    now says so.
- **SPEC.md**: every feature section is built. Its status lines were stale (§15 said "phases
  1–2", and the top line left out §15–§18), and the Reminders reader it calls unbuilt now exists
  as `mac_control list_reminders`. All three are corrected.
- **LEARNING.md / ROLLOUT.md**: all code is built. ROLLOUT is a checklist *you* work through on
  the running host (baseline digest, then turn learners on one at a time). Its checkboxes are
  unticked, and I can't tell from the repo how far you've got. **Your action:** run
  `npm run digest 168` on the 16 GB AgentSpine Mini and tick off what's already on.
- **STUDY.md**: three items are listed as not built. They're covered by A2 (screen) and A3/A4
  below. Heartbeat-scheduled sessions wait until A2 exists.

---

## A. AgentSpine

Ranked by value per effort.

### A1. Named recipes you save yourself ("turn this session into a skill")  *(M)*  ✅ built 2026-11-17 (web; iOS not yet)
The video's best habit: after a long back-and-forth, say "turn this into a skill". AgentSpine
only learns recipes **implicitly**, from clean runs, chosen by similarity. That gives you no way to
say "remember *how we just did that*, call it `pi-brief`, and do it again when I ask".
- `recipe_save` tool: reads the current conversation and drafts a `when` line, steps and a name.
  It shows you the draft and you confirm before it's stored. Same secret filter as `renderRecipe`.
- Run a recipe by name ("run pi-brief"). A named recipe goes into context when you ask for it,
  not by similarity.
- Settings → Memory: edit a recipe's text, not only forget it.
- Keep the Phase 0 measure (steps per repeated task) so named recipes get judged like the
  automatic ones.

### A2. Study screen: web, then iOS  *(M–L)*  ✅ built 2026-11-17 (web + iOS)
STUDY.md lists "a dedicated web or iOS screen" as not built. Chat is clumsy for the one loop you'll
repeat most: reviewing due cards. This is also the video's "practice app" idea, built once.
- Card review: question, then you answer (typed or spoken), then it grades and reschedules. Uses
  the existing `study_cards due/review`.
- Topic list showing level, cards due, the read-versus-produced ratio (already in
  `study_topic get`) and progress along the mapmaker curriculum.
- iOS: make the daily "N cards due" push open this screen, not a chat.

### A3. Study material from your own meetings  *(M)*  *(the idea only AgentSpine can do)*  ✅ built 2026-11-17 (web)
You get asked backend, Okta and infra questions in meetings and want to answer them with
confidence. The meeting pipeline already transcribes those meetings and files them into Milliman
IntelliScript.
- After a meeting is filed, pull out the questions put to *you* and file them as
  cards or sparring prompts under a topic linked to that project. Code finds questions addressed to
  you only from the speaker label, so those names need to be set.
- The answer key comes from the project's documents (`_knowledge`), not from what you said in the
  room.
- **Local-only**, like all meeting work and project-linked topics. Matching extracted work items,
  these go into a review list first, not straight into the deck. Extraction over-produces
  (SPEC §15).

### A4. Redo without help  *(S)*  ✅ built 2026-11-17
The video's main point about the explainer: once it has explained something, you have to redo the
task from a blank page. `study_explain` already asks for an explain-back. Add a follow-up card due
the next day: "do X from scratch, no help", graded by `study_check`. That's one card kind plus a
line in the tool.

### A5. Resources at your level  *(S)*  ✅ built 2026-11-17
`study_resources`: takes the topic's goal and assessed level plus what you know and don't, and
returns 3–5 explanations or tutorials, each with a reason it fits. Uses `web_search`, then
`web_read` to check each link. Cloud is fine for topics with no project. Project-linked topics stay
local and may simply return nothing.
*As built:* links are checked in code against the search results rather than fetched with
`web_read`. An invented URL is the real failure, and this catches it with no extra page loads or
browser-allowlist questions. Project-linked topics still search, but only with the topic name,
the subject and the gaps you stated, never document text, and the choosing runs on the local
model.

### A6. Overview page: the read-only "AIOS map"  *(M)*
The video's one useful dashboard is plain and read-only. Its job is to show what's installed so
you can **prune** it. Right now AgentSpine spreads this across Settings, Schedules, Projects and
the broker policy.
- One page (and `GET /api/overview`) listing: tools by broker tier; connectors and senses with
  their live status; memory counts by kind (fact, recipe, lesson, standing); schedules and watchers
  with their last result; projects with chunk counts; study topics; the allowlist.
- **Staleness flags:** recipes or lessons not recalled in N days, schedules that keep failing,
  connectors that error, memories never recalled. Each links to where you'd delete it.
- Heed the video's warning: no live agent view, no animation. It's a list, not a cockpit.

### A7. "Get to know me" profile interview  *(S)*
Adapt the `study_interview` pattern to the profile: look at what `profile.md` and memory lack
(location, role, working hours, people you work with), then ask about the gaps one at a time.
Answers save as memories, and you see the list before anything is written.

### A8. Spoken "I need you" on the dashboard  *(S, optional)*
Kokoro TTS is already there. Add a Settings → Voice option: when a long run finishes or an approval
is waiting, the open dashboard tab speaks one line. It's per browser and off by default, matching
the opt-in recording announcement.

**Not proposed:** auto-sending email, a live "agent thinking" dashboard, a practice-app generator
(A2 covers it), and turning on heartbeat-scheduled study sessions before A2 exists (pushing cards
into chat is the clumsy flow A2 replaces).

---

## B. Your Claude setup (MacBook Pro + Mac Mini M4 16 GB, the AgentSpine host)

**The rule for both machines:** everything under `~/.claude` is per machine. Anything in the repo
(`CLAUDE.md`, `.claude/skills/`, `.claude/agents/`) reaches both Macs through git. So put things
in the repo when you can, use a private plugin for personal things that should follow you, and
change per-machine settings only when nothing else will do. Each item is tagged.

### B1. Give AgentSpine a `CLAUDE.md`  *[repo → both machines]*  *(highest value)*
The repo has none. The knowledge that matters most to future sessions lives in auto-memory on
**this MacBook only**: which host does what, "MoE only on the 32 GB, 120 GB/s model Mini", "meeting work is
local-only, never cloud", "read SPEC §15 before touching meetings", "don't 'fix' `agent.ts`
front-loading". The Mini's Claude knows none of it. Move the durable rules into a short
`CLAUDE.md`: layout, how to test (`node test/*.test.mjs`), how to restart (`update.sh`), the
hardware and tier constraints, and pointers to SPEC/LEARNING/STUDY. Keep auto-memory for facts
that change.

### B2. Project skills for AgentSpine's repeated chores  *[repo → both machines]*
This is the video's "session → skill" habit, put where git carries it. Candidates, each written
from a real session once one happens (use `skill-creator`):
- `add-tool`: the README's "Extending it" steps, the broker tier decision, a test, the docs line.
- `ship`: lint, tests, `update.sh`, restart the service, check `/api/status`.
- `ios-check`: build, run in the simulator, run the wire-model contract test.
Add a skill only after you've done the job by hand at least twice.

### B3. Make personal skills and agents follow you with a private plugin  *[both machines, once]*
`~/.claude/skills/dispatch` and `~/.claude/agents/{chief,hauler,inspector,runner,tracker}.md` sit on
this Mac only. Move them into a private GitHub repo set up as a plugin marketplace. Then run
`claude plugin marketplace add <repo>` and install it on **each** Mac. After that, updating them
everywhere is a `git push` plus a plugin update. That beats symlinking dotfiles because the Mini
needs no checkout layout. (AgentSpine's own `agents/` folder is the app's config, not Claude's, so
leave it alone.)

### B4. Fix the stale auto-mode environment  *[per machine: do on both]*
`~/.claude/settings.json` → `autoMode.environment` still calls **CueForge** "the trusted repo" and
your primary use. It doesn't mention AgentSpine, the Milliman folder (sensitive work material), or
the LAN model host `192.168.0.145`. The auto-mode classifier judges actions by that text. Rewrite
it to list AgentSpine and CueForge as trusted repos, mark `~/Developer/Milliman` as confidential
(never to a public paste or gist), and name the model host as trusted internal. Do this on each
Mac. The sandbox blocks me from editing settings.json, so you'll either approve the edit or make it
yourself.

### B5. A short global `~/.claude/CLAUDE.md`  *[per machine, or ship it in the B3 plugin]*
You don't have one yet. Keep it to about ten lines covering how you like to work across *all*
projects (branching and commit habits, which machine is which, "the Mini is the always-on box"). If
it goes in the B3 plugin, it stays identical on both Macs.

### B6. "Claude needs you" alerts: don't install claudespeak as shown  *[decide per machine]*
The video's mod is unvetted third-party code that sends your session text to Fish Audio's cloud.
You already have both halves locally: push notifications are on (`agentPushNotifEnabled`), and
Kokoro is installed on the MacBook (`~/.venvs/tts`).
- **MacBook:** if you want spoken alerts, add a `Notification`/`Stop` hook that speaks a
  one-line summary through local Kokoro. Nothing leaves the machine.
- **Mini (unattended):** speaking to an empty room is no use. Have the hook POST to AgentSpine's
  notify endpoint so it reaches your phone through the existing APNs/ntfy path.

### B7. Housekeeping  *[this MacBook]*
- Remove the stale scheduled task `implement-beatgrid-spec` (CueForge) if it's done.
- Fix auto-memory: `MEMORY.md` is missing `agentspine-hardware` and `agentspine-meetings-feature`.
  `schedule-editing-gap` is **already fixed** in code (`SchedulesView` edits, `api.updateSchedule`),
  so delete it. `agentspine-hardware` (July) lists a 16 GB Mini and an M3 Pro that conflict with
  `local-llm-setup`, so reconcile them (`/consolidate-memory`).

### B8. Keep AgentSpine as the always-on "AIOS"  *(framing, no work)*
The video adds Claude routines for hourly email and morning briefs. You already run those locally
in AgentSpine, with approvals, budgets and local-only rules. Copying them into Claude routines
would mean two systems mailing you about the same inbox. Use Claude Code for *building* and
AgentSpine for *running*.

---

## Suggested order

1. B1 + B7 (an hour, and it removes drift for every later session on both Macs)
2. B4 on both Macs
3. A1 named recipes
4. A2 study screen (web), then A4 and A5 alongside it
5. A3 meeting → study cards
6. A6 overview page, A7 profile interview
7. B3 plugin, B2 skills as chores repeat, B6 if you want alerts
