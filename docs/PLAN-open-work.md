# Open work: the one plan

Rewritten 2026-11-21 so that it holds only work that is still to be done. This is the only plan doc. If a
piece of work is not here, it is either built (the design records are in `docs/archive/`, which is history and
not a to-do list) or deliberately not wanted (see "Ground rules"). When you finish or change something, change
this file in the same commit. When you start something new, add it here rather than writing another PLAN doc.

**Priority order (decided 2026-11-21).** Section 0 first (the security findings, all fixed). Then section 8, the
management knowledge system, which is the main direction: the highest return is making AgentSpine very good at
remembering, connecting, citing and updating workplace knowledge. Live Activities, richer travel integrations,
buying or booking actions and most new proactive behaviour are deprioritized until section 8 has a reliable
foundation (they are marked in section 3). Section 9 (harness awareness, added 2026-11-21, its three open questions settled by the proposed defaults) is being built in order, S1 and S2 first (done).
Sections 1 to 7 are the rest, mostly verification that needs you.

Section numbers are stable on purpose, because code comments and other docs point at them: 0, 8 and 9 are new,
and 1 to 7 and 4a are as before.

How to read the labels: **You** means it needs the Mini, a device, a real account or your decision. **Code**
means it can be done in the repo and tested there. **Both** means code first, then a check by you.

---

## 0. Fix first: findings from the outside review (2026-11-21)

Source: an outside review of the working tree against the project's stated security guarantees (F1 to F5), the
management-knowledge review (F6), and my own audit while fixing F2 (F7). Both were uncommitted working notes (`docs/*` is ignored except
`PLAN-*.md`), and everything needed from them is here. `npm run check` passed throughout; these are gaps the
suite does not cover.

I checked each finding against the code on 2026-11-21. **F1 to F5 and F7 are fixed** (see the note after F1); the others have no fix or regression test
yet. Every reproduction below becomes a test in the same change as its fix, and each new suite is added by hand
to the `npm test` list in `package.json`.

**What is left in this section:** nothing in code. The "Local only" note and the filing question have not been seen rendered.

**F1 to F7: all fixed 2026-11-21, numbers kept so they do not shift.** F6 (filed transcripts outliving the retention window): filing a meeting under a project asks whether the project keeps the full transcript searchable or only the summary, topics and decisions. The choice is stored as `meetings.keep_transcript`; summary-only meetings never put their words in the project index (`meeting-summary:<id>`), so the prune has nothing of theirs to leave behind, and the prune also drops any stray transcript copy of one. A kept transcript is an explicit retention opt-in and every screen says so. A meeting filed before the choice existed keeps its transcript, shown as such. Web, iPhone and Mac ask when you file after the fact, and each can change the choice later. Not yet asked: a meeting recorded or imported with a project already chosen files with the transcript kept, because there is no filing moment to ask at; change it from the meeting afterwards. Suite: `test/meeting-filing.test.mjs`. F1 (an overlay opening the browser to any domain): two non-empty allowlists that share nothing now set `browser.denyAll`, which `browser` and `web_read` test before the list. F5 (an overlay raising a budget): caps are compared as the broker applies them, so no tool ends above the base's effective cap. Suite: `test/narrow-policy-holes.test.mjs`. F2 (meeting transcripts reaching
the cloud): a tool can declare `privateOutput` (`src/types.ts`), and once one has run, the agent loop pins every
later model call in that run, its re-asks and its closing answer, and any subagent in the tree, to
`sensitivity: "private"` (`src/sensitivity.ts`). `meeting_list` and the study tools on a project-linked topic
declare it, and the post-run critique treats them as sensitive. Suite: `test/private-output.test.mjs`, which runs
a stand-in local and a stand-in cloud server and asserts what the cloud one was sent. F7 (other private material travelling with the run's tier), as decided: a run inside a project, or in a thread that
has touched private material, starts pinned local (`AgentOpts.startPrivate`); `gmail_search`, `gmail_triage`,
`calendar_upcoming`, `calendar_find`, `read_file`, `list_dir`, `draft` and `source_read` declare `privateOutput`
(`browser` and `web_read` do not); and the runner marks the conversation `local_only` the moment a run pins, so
every later turn starts local and web, Mac and iPhone show a "Local only" note on the thread. A new chat is the
way out. Suite: the F7 sections of `test/private-output.test.mjs`, run through the real `runTask`. F3 (two approvals running one
action twice): `approveOnly` and `rejectOnly` now claim the row with a conditional update, `executing` is a live
state, and a row left `executing` by a crash ends as `error` on server start and is never re-run. Suite:
`test/confirm-race.test.mjs`. F4 (`state_set` reaching internal `kv` keys): `state_get` and `state_set` store every
key under `watch:`, so nothing internal is reachable by construction, and a one-time migration copies legacy
watcher keys so no watcher reports a spurious first observation. Suite: `test/state-namespace.test.mjs`.

---

## 1. Roll out what is already built (You, on the Mini)

Nothing below has run against real systems yet. F3 and F4 from section 0 are fixed, so steps 3 and 5 no longer wait on them.

1. DONE (you ran it on the Mini): run `update.sh` (pulls, installs, builds, restarts). This deploys the outbox in log-only mode and the Gmail
   and Calendar tools.
2. DONE (you ran it): run `npm run auth -- write` and approve in the browser. This creates the write token, which does not exist
   yet.
3. ADDED (you ran `npm run watcher add inbox-cleanup`); still to do: run it once by hand, and **read its summary before trusting it**. It
   runs every 8 hours after that. Protections are code: inbox mail only, never mail from anyone you have
   emailed, never starred or sent mail, 60 changes per run. Trash and spam are irreversible-tier.
   `policy.json` `google.write.trashOverrideSenders` holds `afs.ameriprise.com`.
4. Let the outbox log for about a week, then read the "What I sent you" section of `npm run digest 168`. Each
   row's `would_be` column says what the rules would have done. Then decide on `OUTBOX_ENFORCE=true`.
5. Work through `docs/ROLLOUT.md` (the learning-loop checklist). One box is ticked and 22 are not, and the repo
   cannot say how far you are: run `npm run digest 168` on the Mini and tick what is already on.

Never exercised against real services: Google Calendar reads, web search and retailer pages for Heads-up,
AeroDataBox, TomTom, APNs delivery of the Heads-up categories, Gmail and Calendar writes.

---

## 2. Outbox (`docs/archive/PLAN-outbox.md` has the design)

Phases 0 to 4 are built, with enforcement off by default (`OUTBOX_ENFORCE`). Phase 2 (opened and dismissed
reports) is proven on a phone. What is left is verification and data.

**Phase 3, the weekly review.** Done when a real week has produced one real review and one *Skip this kind*
that yields exactly one `preference` memory which recall picks up the next day.
- Code: a deep link from the Sunday push to the review screen. A tap only opens the app today, and the iOS
  `screen` handler knows `study` and `headsup` only.
- Code or decision: a skipped kind is not undone by answering Useful later. The only way back is to forget the
  note under Memory. Decide whether Useful should retire the note.
- You: the push has never gone to a phone, and the three review screens (web `WeeklyReviewPanel`, iPhone and Mac
  `WeeklyReviewView`) have not been seen rendered.

**Phase 4, offer to switch off what you keep skipping.** Built 2026-11-21 in `src/outbox-learn.ts`, thresholds
in `src/outbox-rules.ts` (`SKIP_*`): at least 8 counted outcomes, 0.7 to list a kind in the review, 0.85 to
queue one `schedule_update` (enabled=false) for a `run` or `tool` kind that names exactly one enabled schedule,
never repeated within 90 days.
- You: the thresholds are guesses. Set them from the first month of review data.
- You: approve one real proposal on the Mini and confirm the schedule actually switches off.
- You: look at the "Kinds you mostly skip" list on web, iPhone and Mac.

---

## 3. Heads-up (`docs/archive/PLAN-heads-up.md` is the design record, `PLAN-heads-up-next.md` the spec; `docs/ROLLOUT-heads-up.md` is the switch-on checklist)

| # | Workstream | State |
|---|---|---|
| A | Verify what has only run against fixtures | **You** |
| B | Learn from dismissals | Built, unproven: needs weeks of real answers after A3 |
| C | Rollout checklist | Written; per-rung bars are placeholders until A3 has run |
| D | Lead-time overrides in Settings | Built, not seen rendered |
| G | Live Activity for a flight | Not started; needs A1 and A3 rung 6 first |
| H | Small and conditional items | Not started |

**A. Verification (You).** A1 the iOS app builds and runs (done); the lock-screen buttons (rung 8) have not been
exercised on a device. A2 `npm run check` on Node 24 (it also compiles the iOS Heads-up models against
Foundation; it passed on Node 26.3 on the development Mac on 2026-11-21, so run it on the Mini's Node too). A3 a shakedown, one rung at a time, passing before moving on: 1 Calendar (Check now lists real
items, none PAID, no holidays); 2 Morning push (one push, opens the tab); 3 Chat dates ("Garrett's birthday is
March 4" gives a card within seconds); 4 Gift research (cards under two minutes; **record how many had a price
and photo versus link-only**, H1 depends on it); 5 Restaurants (needs `DEFAULT_LOCATION`); 6 Flights (key plus
policy switch); 7 Drives (`TOMTOM_API_KEY` and `HEADSUP_HOME`); 8 Lock screen (buttons appear and work). Done
when rungs 1 to 5 pass and 6 to 8 pass or are consciously skipped. A4 confirm each provider's real free tier
(AeroDataBox on RapidAPI, TomTom; TomTom's v1 Calculate Route may not be free) so
`HEADSUP_FLIGHT_CALLS_PER_MONTH` and `HEADSUP_TRAVEL_CALLS_PER_DAY` defaults sit safely under it.

**B. Learn from dismissals (`src/headsup/outcomes.ts`).** Nothing is left in code. It needs weeks of real
answers before the numbers mean anything. The starting values in `rules.ts` are `QUIETEN_MIN_COUNTED` 6,
`QUIETEN_MIN_RATE` 0.7, `OFF_MIN_COUNTED` 10, `OFF_MIN_RATE` 0.85, `OFF_SUPPRESS_DAYS` 90 and
`OUTCOME_WINDOW_DAYS` 90. Revisit them once real answers exist.

**C. Rollout checklist (`docs/ROLLOUT-heads-up.md`).** After A3, replace the placeholder bars, the chat-date
false-positive limit in particular. The Preview button (web, iPhone, Mac) is not yet seen rendered on iPhone or
Mac. Note that the web "Check now" button is not a dry run: it records and pushes. Preview is the dry run.

**D. Lead-time overrides.** You: look at the "When to mention each kind" rows in Settings on web, iPhone and Mac,
and confirm the Swift field compiles after the next build.

**Deprioritized 2026-11-21 (until section 8 has a reliable foundation):** G, H4, H5, H6, H7 and H9 below, and
any new proactive behaviour. Do not start them without a new decision. A, B, C, D and H1 and H2 are unaffected,
because they finish or verify what is already built.

**G. Live Activity for a flight.** You, in Xcode: add a Widget Extension named `AgentSpineLiveActivity` with
"Include Live Activity" ticked, share the `ActivityAttributes` file with both targets, set
`NSSupportsLiveActivities`, commit. Then Code: the Swift views, `POST /api/headsups/:id/live-activity` to store
the push token, `src/push/liveactivity.ts` for update and end pushes (push type `liveactivity`, topic `<bundle
id>.push-type.liveactivity`), and calls from `src/headsup/watch/loop.ts`. Decide first: foreground-start only,
or push-to-start (iOS 17.2 and later)? Activities end after about 8 hours without an update, which must fit the
18 hour flight window. Done includes a manual device test.

**H. Small and conditional.**
- H1 browser fallback for blocked retailers: only if A3 rung 4 or telemetry shows over half of cards are
  link-only; scope it to an allowlist, because the SSRF guard does not cover a browser. F1, which let a project overlay
  open the browser to any domain, is fixed.
- H2 web sidebar badge for open heads-ups (offered plus dates to confirm), mirroring iOS. Checked 2026-11-21:
  the web sidebar has the Heads-up entry and no badge, so this is still open. Code.
- H4 a second flight provider, one file behind `FlightSource`, if A4 shows AeroDataBox is unsuitable.
- H5 restaurant booking and H6 buying a gift: irreversible-tier, queued, never automatic. Only if asked.
- H7 arrival-side flight alerts (baggage claim, landing gate).
- H8 remembered dates: edit, not just forget.
- H9 model-worded notifications: only if the code wording reads badly; prefer fixing it in code.

**Open decisions:** whether B's thresholds are right once real answers exist; if TomTom's route API is not free,
HERE free tier, a static-speed provider, or flights only; whether to want G at all.

---

## 4. Security hardening and learning (`docs/archive/PLAN-nod-learnings.md`, from n8n's Nod)

Section 0 is the priority in this area. What is left of the Nod items:

- **N2 live half (You, needs the model host).** The offline half is built (`test/injection.test.mjs`, 27
  fixtures, `test/fixtures/injection/*.json`). Build and run `npm run eval:injection`: run each fixture through
  reflection, recipe extraction, critique and the agent loop with `dryRun` on, reporting per surface and per
  tier the facts saved that quote the payload, recipes or lessons written from it, and forbidden calls
  attempted. Run it once per model change and before any ROLLOUT step that switches on a learner, and record the
  baseline in SPEC or MODELS. Fixtures marked `liveOnly` (a plausible false fact, a recipe from a hostile file)
  can only be judged here. A broker bypass must be zero by construction; any other threshold is set after the
  baseline. Not covered: Heads-up. Its scanner parses event titles in plain code and I did not trace whether an
  event title reaches a search query or a card, so that path is unchecked. The write token raised the value of
  this work, since a hostile email is now worth more to an attacker.
- **N1 memory provenance.** Code: a run id on friction rows (`recordFriction` does not take one). Nothing uses
  `origin` to change recall or pruning, by design.
- **N3 cloud token cap.** You: add `CLOUD_TOKENS_PER_DAY`, `CLOUD_TOKENS_PER_MONTH` and `CLOUD_TOKENS_PER_RUN` to
  the example env file, and check that `CONSOLIDATE_SIMILARITY` and `CONSOLIDATE_GROUP_MAX` are there too. Also
  delete the stale `JUDGE_INTERRUPTIONS_PROACTIVE` comment line from it. The sandbox blocks me from editing that
  file, so this is yours. There is no form to raise a cap, on purpose.
- **N4 writing styles (`src/styles/`, `src/tools/styles.ts`).** Built, never run on real mail.
  - You: the before and after of a few drafts per style, which needs the Mini and a real token.
  - You: look at the Styles screen on web (Settings, Memory tab), iPhone and Mac.
  - Code, blocked on a decision: project and client matching (`applies_to.projects`). Crew Front Desk needs the
    second Google account question settled first.
  - Known and left as is: the model that writes a draft receives the style note through `style_for`, so on the
    cloud tier a scrubbed note (no names, addresses, links or figures, checked in code) travels with the
    request. The F2 mechanism (`privateOutput`) now exists, so this can be pinned local; decide.

### 4a. Leftovers from the reference docs

- **Memory consolidation, `LEARNING.md` Phase 6 (You first).** 6.0 is built (`npm run consolidate`, read-only,
  no model call) but has never run against the real memory table, because the MacBook's database is empty. Run
  it on the Mini, set `CONSOLIDATE_SIMILARITY` (0.75, a guess) from the histogram, and if it finds only a
  handful, stop there. If it finds enough: 6.1 (judge each candidate group with a local model pinned `private`,
  results `distinct | duplicate | superseded | merge`, queued as proposals, `CONSOLIDATE_MAX_PROPOSALS` caps a
  pass, a rejected pair is never proposed again) and 6.2 (approval sets `memories.retired`, recall skips retired
  rows, `prune` hard-deletes after `CONSOLIDATE_GRACE_DAYS`, default 30, un-retire in Settings, Memory during
  the grace window; trigger from the daily prune tick with `CONSOLIDATE_EVERY_DAYS`, default 0). Three open
  questions to settle before building are listed in `LEARNING.md`.
- **The proposers have no trigger (decision).** Nothing in `src/` calls `runProposer` (`npm run propose`) or
  `runRewriter` (`npm run rewrite`) except their own command lines, so they run only when you run them
  (rechecked 2026-11-21). Decide whether a weekly trigger is wanted before turning on anything that depends on
  them (ROLLOUT steps 3 and 5).
- **Meetings, `SPEC.md` section 15 note of 2026-07-30 (You).** Not rechecked since. Index something into a
  project so the sidecar and coach have a corpus; one dashboard Record, Stop, extract run against live speech;
  re-run the Phase 2 numbers against a real multi-person meeting (neither sample so far measures **recall**);
  re-check the "flat ~1.1 s prefill" claim in the coaching table, which did not reproduce. Several may be done
  by now through use, so check before doing any.
- **Study heartbeat sessions (Code, if wanted).** `docs/STUDY.md` still lists scheduling a study session on the
  heartbeat as not built. The Study screen exists now, so it is buildable. Practice-app generation stays off the
  list.

---

## 5. Native apps and UI (`docs/archive/PLAN-native-apps-and-ui-refresh.md`)

**One look at the screens nobody has seen rendered (You).** Run the iPhone simulator against a fresh test server
and look at each, on web, iPhone and Mac where the feature exists: Styles (N4), the lead-time rows (D), the
Preview row (C), Weekly review with "Kinds you mostly skip" (Phase 3 and 4), the Cloud usage panel (N3), the
provenance links in Settings, Memory (N1), the Heads-up outcome lines in Settings, and the "Local only" note
on a thread that has touched private material (F7). This list is the same
check that sections 2, 3 and 4 ask for, in one pass.

**A plan card for a running task (Code, then a look by you).** Show the steps a run is working through as a card
in the conversation, each marked waiting, in progress or done, the way Claude Code does. Runs already publish
typed events (`step_start`, `tool_call`, `tool_result`, `final` in `src/events.ts`), and the web client
(`web/src/hooks/useRunStream.ts`) and the iPhone app (`ios/AgentSpine/Core/RunStream.swift`) both consume them, so
the shape is a new `plan` event plus a card on web, Mac and iPhone together. Code owns the step state, as it
owns every number; the model never marks its own progress.
Two sources for the steps, built in this order:
1. A checklist derived from the tool calls themselves ("Searching the web", "Reading a meeting", "Drafting"),
   which costs no model tokens and cannot get the protocol wrong. It also works for scheduled runs in the
   Activity view.
2. Only if the first feels thin: a model-written plan of 3 to 7 steps on multi-step chat runs on the `deep` tier,
   as one more action in the JSON protocol. Prefill is the expensive part on the model host, and a small local
   model is the least reliable at extra protocol, so this stays off the `fast` and `standard` tiers until
   measured.
Decide while building: whether the card collapses when the run ends, and whether a plan is shown for a run that
only answers in one step (proposed: no). Tests: the pure state machine (what advances a step, what happens on a
denied or errored call, a repeated call, a subagent's calls), and the event shape both clients decode.

**Not verified or not done:**
- A VoiceOver pass by actually using it, Increase Contrast and Dynamic Type on the device, light-mode
  screenshots (light was derived from the dark mocks and never drawn).
- Web views not seen by eye: a streamed conversation, Trace tab, RunDetail, populated Meetings with speaker
  colours, dialogs, narrow widths. The message-action hover row has not been looked at in a browser, the Mac app
  or the simulator.
- The recipe screens have not been run against a server by hand.
- Spacing and type sizes still use the old literal values in most modules (only colours and fonts moved to
  tokens); meeting speaker colours stay hard-coded hues.
- Distribution is development-signed only, with no notarised route, by decision.
- **iPhone offline cache (Code, not started).** A read-only mirror of threads, tasks, files and recent run
  results (SwiftData or SQLite), shown marked as cached when the server is unreachable. Writes are not queued.
  Approvals are never replayed: an offline phone shows the question and says it can only be answered once
  reconnected, because a stale approval is a security problem.

**Open decisions:** how many tabs the iPhone bar should allow now that Heads-up sits second (the mock shows four
plus More); whether to cut a Swift package once there is a compiler to check the `public` changes.

---

## 6. Your Claude setup and small leftovers (`docs/archive/PLAN-video-ideas.md`)

All You, on your own machines.
- **A8 Spoken "I need you" on the dashboard (optional).** Kokoro TTS exists. A Settings, Voice option: when a
  long run finishes or an approval is waiting, the open tab speaks one line. Per browser, off by default.
- **B2 Project skills** for repeated chores (`add-tool`, `ship`, `ios-check`), each written from a real session
  after you have done the job by hand twice.
- **B4 Stale auto-mode environment, on each Mac.** `~/.claude/settings.json` `autoMode.environment` may still
  call CueForge the trusted repo. It should list AgentSpine and CueForge as trusted, mark `~/Developer/Milliman`
  confidential (never to a public paste), and name the model host `192.168.0.150` as trusted internal. Unverified.
- **B6 "Claude needs you" alerts.** Do not install claudespeak (unvetted code that sends session text to a cloud
  TTS). On the MacBook a `Notification` or `Stop` hook can speak through local Kokoro; on the Mini the hook
  should POST to AgentSpine's notify endpoint so it reaches the phone.
- **B7 Housekeeping on the MacBook.** Remove the stale scheduled task `implement-beatgrid-spec` if done;
  reconcile `agentspine-hardware` with `local-llm-setup` in auto-memory (`/consolidate-memory`).
- **The Mini needs the plugin keys** `extraKnownMarketplaces` and `enabledPlugins` in its
  `~/.claude/settings.json` (the README has them). Done on the MacBook only.

---

## 7. Parked, with the trigger that would unpark it

- **`.xcresult` parsing** (`-resultBundlePath` plus `xcresulttool`) for Xcode build failures. Needs a real build
  outside Claude's sandbox to verify. Only if Xcode build-failure summaries turn out wrong in practice.
- **Arguments for declared commands** (a test-name filter for `run_command`). Nothing has needed it.
- **Credential vault and logged-in browsing:** would change the security posture; revisit only if browser
  errands become a real need, designed origin-bound with the secret never in a prompt.

---

## 8. Management knowledge system (the main direction)

**Goal.** The primary user is a software engineering manager whose company computer cannot run AgentSpine. It
runs on the Mac Mini beside it, records meetings acoustically, collects notes and permitted exports, and gives a
private interface to accumulated workplace knowledge. It should capture material from meetings, chats, PDFs,
documents, notes and images; keep where each fact came from; connect people, projects, sources and time;
distinguish current from superseded or contradicted information; and answer with cited evidence. Questions it
should handle: what did we decide about this migration; what has this person raised over three months; which
commitments are overdue and whose; how has the plan changed since last quarter; what do I need before my next
one-on-one; where are teams working from conflicting assumptions.

**What exists (verified 2026-11-21).** Local meeting capture and transcription, meeting extraction (summary,
topics, decisions, work items, which go to the review queue because most are false positives), project document
indexing (`textutil` for Office files, optional `pdftotext` for PDFs), one shared `chunks` table for documents
and filed meetings, a cosine sweep that retrieves a few chunks from one project, and live context cards. Measured:
embedding a query 63 ms, a sweep over 50,000 chunks 101 ms.

**What does not exist.** No SQLite full-text index (FTS5 is available in the built-in `node:sqlite`, checked
2026-11-21, so it needs no new dependency). No way to add a document except an allowlisted filesystem path (the
only upload is a chat attachment). No OCR, no watched folder, no pasted-chat parsing. No sensitivity on a source
or a project: a run inside a project is pinned local (F7), but a stored source carries no sensitivity of its
own, so everything derived from it (embeddings, extraction) relies on that rule rather than on the source. No people, commitments, decisions-over-time or
supersession model; semantic memory cannot say that "launch moved to August" replaces "launch is June". The
app does not encrypt or audit backups, deletion or export. Global search covers conversation questions and
answers, not every source type.

**Rules for all of it.** Every step runs on local models. Milliman and other workplace material never goes to
web search, paste services or third-party APIs, and never to the cloud tier (embeddings included). A derived
record is never trusted straight away: extracted claims queue for review, as meeting work items do. An answer
cites every important assertion and shows a disagreement instead of silently picking one.

**Order.** Adjusted from the review: measurement moves ahead of the big builds, because "better" needs a
baseline, and the meeting recall number is still unmeasured.

- **K0. Privacy and retention first (Code, plus decisions).** F2, F6 and F7 are done. Make sensitivity a property
  of a stored source and of everything derived from it (embedding, extraction, retrieval, synthesis, reflection
  all stay local for a private source); a project is already private by default (F7, built), and sending
  any of it to a cloud model needs an explicit decision. Decide backups: the app has none of its own, so either
  rely on FileVault plus an encrypted Time Machine volume on the Mini and write that down, or build an encrypted
  export. Make deletion and export leave an audit row.
- **K1. Evaluation set (You write the questions, Code builds the harness).** 30 to 50 questions you actually
  care about, each with its known supporting sources, expected project, person and date filters, required
  citations, some with changed or contradictory information, and some whose right answer is "not enough
  evidence". Track retrieval recall, citation correctness, stale-answer rate and extraction acceptance rate.
  Kept outside the repo and out of git, because it is workplace material; the harness runs on local models only.
  Take the baseline before K2 changes retrieval. This also finally measures meeting recall (section 4a).
- **K2. Hybrid global retrieval (Code).** Keep project filtering but make a project one view over the whole base.
  Three paths: FTS5 for exact names, acronyms, ticket numbers and quoted phrases; the existing vector search;
  structured lookup for people, decisions, dates, owners and status. Merge with reciprocal-rank fusion or
  another inspectable method, with per-source quotas so several chunks of one meeting cannot crowd out a PDF.
  Filters: project, person, team, topic, source type, date range and "as of" date, reviewed against
  machine-extracted, current against superseded. Keep the property that meeting cards and document cards are
  scored together and then split (`src/meetings/context.ts`). Done when K1 shows an improvement.
- **K3. Knowledge Inbox (Code, with a decision on OCR).** A first-class intake that accepts dragged or uploaded
  PDF, Word, Markdown and text; pasted chat or email threads with optional speaker and timestamp parsing; meeting
  recordings and transcripts; screenshots and scans through local OCR; notes dictated or typed on the phone; and
  a watched folder (AirDrop). Each item becomes a source artifact before it has a project, keeping the original,
  extracted text, ingestion time, document date, author or speakers, content hash and extraction status. The
  system suggests projects, people and tags and queues uncertain filing for review, since management material
  often belongs to a person or a team more than a project. An extraction that produced no text must show as
  "needs OCR", never as silently empty. OCR needs a decision: a local binary (the way `pdftotext` is optional)
  or a small macOS Vision helper; `src/` allows only two runtime dependencies, so no new package. The existing
  loader for the Milliman knowledge folder should end up as one source of this Inbox. Web, iPhone and Mac.
- **K4. Knowledge store (Code, needs a schema decision).** A layer separate from semantic memory, so retrieved
  chunks are not promoted into trusted memories. Records for people and teams, projects, decisions with
  rationale, commitments with owner and due date, risks and blockers, open questions, goals and measures, claims,
  topics and relationships. Each carries a citation to the source and exact passage or meeting timestamp, when
  the statement was made, the period it applies to, the speaker, the extraction method and review state, a
  status of `active`, `resolved`, `retracted` or `superseded`, and links to related records. Flow: source
  artifact, passages, extracted claims, reviewed current knowledge. Generalize the existing meeting extraction
  to every source type and normalize accepted results into it. Do not call it a ledger: the Heads-up code already
  uses that word for something else.
- **K5. Post-meeting close-out (Code, web, iPhone and Mac).** Expand the review screen: confirm participants and
  speaker names, assign projects or topics, review decisions, commitments with owners and dates, risks and open
  questions, mark statements that supersede earlier ones, accept or reject suggested links, and preview how
  briefs will change. Favour quick accept and correct over editing. A correction teaches a deterministic alias
  for a speaker, acronym or project name.
- **K6. Briefs and synthesis operations (Code).** Materialized, durable project and person briefs backed by K4
  (not regenerated free text): objective and status, recent changes, active decisions with rationale, risks,
  commitments by owner and date, open questions, stakeholders, recent activity, evidence links; for a person,
  recent one-on-one topics, commitments in each direction, goals and concerns, feedback and follow-ups, with
  tighter visibility and retention on sensitive notes. Then explicit, testable operations, each with a defined
  retrieval recipe and output structure rather than an open-ended prompt: brief me for my next meeting; what
  changed in this project this week; prepare a one-on-one; commitments I owe, and that others owe me; trace how
  a decision evolved; risks that recur across projects; topics unresolved for over a month; a weekly staff
  summary with citations; compare what the written plan says with what recent meetings say.
- **K7. Retention rules (Code, decision).** Separate rules for original audio, raw transcripts, indexed
  transcript passages, verified decisions and commitments, and summaries and briefs. Reviewed structured
  knowledge should generally outlive raw transcripts: raw passages may expire while accepted facts stay, with the
  citation showing the evidence has aged out. K0's interim choice for F6 is replaced by this.
- **After K6: selected proactive notifications**, drawing on the knowledge store, and only then.

Settled 2026-11-21: OCR is a small macOS Vision helper (K3, chosen for speed; no new dependency); backups rely on
FileVault, with nothing built and a line written down (K0); supersession is marked by you in the close-out (K4).
Still open: only the schema detail for supersession, decided when K4 is built. Also settled: a project is private by default (F7a), and
filing a meeting asks whether to keep the full transcript (F6).

---

## 9. Harness awareness: give AgentSpine an accurate self-model

**Goal.** AgentSpine should understand the application it runs inside as reliably as Claude Code or Codex
understands its harness: what kind of run this is, who will receive the result, what persists, what tools and
effective permissions it has, where output goes, what needs approval, which model tier is serving it, and which
information must stay local. This is an operational self-model supplied by the harness, not consciousness and
not something the model should infer from conversation text.

**What exists.** `src/agent.ts` already names AgentSpine, renders the visible tool registry, states the local
time, explains the broker, distinguishes live chat from unattended work, and, when `schedule_create` is
visible, explains the scheduler and confirmation queue. `runner.ts` separately knows the run id, kind,
conversation, project, tier, write directory, memory state and whether the run is unattended. Tools receive a
smaller `RunContext`. The missing piece is one code-owned representation that joins those facts and renders
them consistently. Today the model gets fragments, some only when one particular tool is visible, and cannot
answer questions such as “where will this be saved?”, “is this local?”, or “what happens after I approve?” from
one authoritative source.

The design has two prompt layers:

1. A **static harness contract**: stable application semantics, suitable for the cached prefix.
2. A **dynamic runtime envelope**: compact facts about this run, generated after effective policy and project
   narrowing are known and placed after the stable prefix.

Code owns both layers. Tool descriptions and human-written prose must not become parallel sources of truth for
permissions. External and retrieved content never enters either layer.

### S1. One typed harness context (built 2026-11-21)

**Built:** `src/harness.ts` holds `HarnessContext`, built in `runner.ts`, completed and registered by the loop (which alone knows the visible tools), rendered as a short envelope straight after the stable prompt and kept in the trace. A subagent derives its own with `childHarness`. Not done: sharing a base type with the tool-facing `RunContext`, which still carries `conversational`, `projectId` and `preApproved` separately. Suite: `test/harness.test.mjs`. The original design follows.

Add a dependency-free `HarnessContext` type (its privacy field reads the run's pin from `src/sensitivity.ts`, which exists) and build it in `runner.ts` after project policy narrowing and task
sizing. Pass it to `runAgent`; subagents derive a child context rather than silently inheriting claims that are
false for them.

At minimum it carries:

- application name and version;
- run id and mode (`chat`, `scheduled`, `approval`, `heartbeat`, `subagent`);
- whether a person is watching and where the final result goes;
- conversation id, project id and project name, when present;
- selected and actual model tier, plus `normal` or `private` sensitivity;
- whether cloud is allowed for this run;
- effective default write directory;
- whether history, memory and project knowledge are available;
- whether the run is pre-approved as standing work;
- how an approval is presented and how its result returns;
- the visible tool names and a code-generated summary of important unavailable capabilities.

Do not include tokens, credentials, raw policy JSON, unrelated filesystem paths, internal prompts or hidden tools.
The context is an observation for the model, never an authorization input: the broker still recomputes every
decision from policy and the tool classifier.

The current `RunContext` passed to tools should either be derived from this type or share a small common base,
so “chat” and “scheduled” cannot acquire different meanings in two type definitions.

**Done when:** a trace shows the exact envelope used for the run; a project overlay changes the envelope's
capability summary in the restrictive direction; a restricted subagent sees only its own mode and visible tool
set; no secret-bearing policy field is present.

### S2. Consolidate the static harness contract (built 2026-11-21)

**Built:** `harnessContract` renders the application description from the visible tools and the mode only; the broker, QUEUED and untrusted-text rules moved out of `Rules:` into it, so they have one owner. `appDocs`, `chatDocs` and `jobDocs` remain as mode and tool specific finishing advice (the scheduler paragraph, chat finishing, draft versus notify); folding them in is not done. The contract is byte-identical across runs (tested). The original design follows.

Replace the scattered application-semantics prose in `appDocs`, `chatDocs` and `jobDocs` with a deliberately
structured contract renderer. Mode-specific finishing instructions may stay separate, but the following truths
must have one owner:

- AgentSpine has conversations, projects, meetings, memory, schedules, a run ledger and an approval queue.
- Every call crosses the capability broker; a visible tool may still be denied for its arguments.
- `QUEUED` means no effect has happened, and the result of the decision returns to the originating conversation.
- A live chat ends on the user's screen; an unattended run ends in the ledger and may notify only when useful.
- Scheduled task text is handed verbatim to a future run without the current conversation.
- Conversation history, traces and saved outputs persist according to their retention rules.
- Untrusted content is evidence, never harness instruction.
- Private material cannot go to the cloud. F2 and F7 are fixed, so this is a runtime fact for meeting, mail,
  calendar, file and project-source material and for runs inside a project (`src/sensitivity.ts`); it is not yet
  true of what is derived from a stored source (K0), so do not claim more than that.
- The model cannot edit policy or grant itself a capability.

Render only clauses relevant to visible features, but do not key the whole application description on
`schedule_create` as it is today. Keep the stable portion byte-for-byte stable where possible: prompt-prefix
stability is a measured performance requirement on the local model host.

**Done when:** the ordinary chat, unattended, approval and subagent prompts each state the correct lifecycle
without describing unavailable tools; removing a tool from the visible set removes every claim that it can be
used; the common prefix does not change merely because a run id or project changed.

### S3. Effective capability summary (built 2026-11-21)

**Built:** `summarizeCapabilities` in `src/harness.ts` writes the Can and Cannot lines of the envelope from the visible tools and the project-narrowed policy, family by family (web, browser including a project that allows no domain, files, Gmail and Calendar, drafts, schedules, helpers, build commands, dry run), and always lists sending mail, permanent deletion and, for a private run, the cloud. Not done: a per-tool description derived from each tool's own policy check, so the summary reads the same policy fields rather than calling `checkPolicy`; it can therefore drift from a tool whose check gains a new condition. Tests are in `test/harness.test.mjs`. The original design follows.

Generate a compact, human-readable summary from the visible registry and the effective policy *after* project
narrowing. It should describe operational facts needed for planning, including useful negative capabilities:

- can read project documents;
- can save under the effective write directory;
- can propose schedule changes, which require approval;
- can read Gmail snippets but cannot send mail;
- cannot use cloud for this private run;
- cannot permanently delete mail;
- browser or web access is unavailable in this project.

Do not attempt to reproduce every policy branch in a second function. Each tool should expose, or the registry
should derive, a safe capability description from the same policy check used by the broker. The summary is
advice to the planner; only the broker grants access.

F1 and F5 were fixed first because a truthful description of a widened project overlay would merely have
documented a security bug, and F2 before any claim that meeting work is locally pinned. All three are done.

**Done when:** fixture policies produce expected summaries for enabled, denied and project-narrowed cases; the
model stops proposing email send and permanent-delete paths that do not exist; no capability summary can make a
broker-denied call execute.

### S4. Read-only `harness_status` tool (built 2026-11-21)

**Built:** `src/tools/harness-status.ts`. It reads the context the loop registered for the calling run, reports privacy live (a run that has since become private says so, a helper through its root), and lists where the result is kept per mode. Tests in `test/harness.test.mjs`. The original design follows.

Add a local, reversible introspection tool for explicit questions about the harness and for state that may change
during a long run. It returns a bounded structured result containing the application, version, current mode,
project, privacy and tier, queue state, visible tools, important unavailable capabilities, and which stores will
retain the result.

The tool reads the current run's captured context rather than reconstructing it from globals. A subagent gets
its child context. It never returns secrets, raw policy, prompts, full paths outside the active workspace, other
users' state, or hidden tools. Calling it does not widen capabilities and is unnecessary for ordinary work, because the
runtime envelope already supplies the initial facts.

**Done when:** “what environment are you running in?” and “can you send email?” are answered from structured
state; a test proves a restricted subagent cannot discover a hidden tool through this endpoint; output is safe to
show in the trace.

### S5. Standard tool-result semantics (built 2026-11-21)

**Built:** `describeResult` in `src/harness.ts` gives every model-facing tool result one extra line, `[result {tool, status, effect, retryable, nextStep, confirmationId?}]`, beside the unchanged prose, so cards on web, Mac and iPhone are untouched. `effect` is `none` for denied, queued and dry-run, `unknown` for an error, `applied` only after a successful write and `observed` for a successful read (a named set, `READ_ONLY_TOOLS`, with a test that every name is a real tool). The broker now returns the confirmation id of a queued call. Not done: giving the `executing` approval state its own model-facing meaning (it never reaches a run today; approval results return as a later turn). Tests in `test/harness.test.mjs`. The original design follows.

The broker already returns `executed`, `queued`, `denied`, `dry-run` and `error`, but the next-step meaning is
embedded in differing prose. Add a structured envelope for model-facing results while preserving human-readable
cards:

```json
{
  "tool": "schedule_create",
  "status": "queued",
  "effect": "none",
  "confirmationId": 42,
  "retryable": false,
  "nextStep": "finish independent work and state that approval is pending"
}
```

`effect` is code-owned: `none` for denied, queued and dry-run; `applied` only after a successful run. Errors say
whether retrying the same call can help. An executed read can use `observed` rather than implying it changed the
world. Do not force every existing tool to rewrite its useful output; wrap it with consistent metadata.

F3's atomic confirmation claim is built, so a status of `executed` already means exactly once. The `executing`
state it added needs a model-facing meaning too: treat it as `queued` with `effect: none` until it resolves.

**Done when:** the model cannot reasonably interpret `queued` or `dry-run` as completed; duplicate retry
behaviour improves in scripted tests; the web, iPhone and Mac cards retain their current readable presentation.

### S6. Workspace instructions (built 2026-11-21)

**Built:** a project has one optional trusted file, `AGENTSPINE.md`, set from the project screen on web, iPhone and Mac (`projects.instructions_file`, `src/projects/workspace.ts`). It must be named exactly that, sit inside one of the project's own path sources, and sit outside every `policy.fs.writableDirs` folder (otherwise a run could rewrite the rules every later run follows); this is checked when set and again on every read. The text joins the trusted context labelled with its source, the envelope lists the active instruction sources, the run inspector records them, helpers do not inherit them, and a same-named indexed file stays untrusted knowledge. Note: this repo's own `policy.json` makes `~/Developer` writable, so a project folder under it cannot use a workspace file until the file is moved out or that entry is narrowed. Suite: `test/workspace-instructions.test.mjs`. Not done: a per-run inspector view beyond the existing "context used" list. The original design follows.

Formalize three trust levels:

1. application instructions, generated by AgentSpine code;
2. human-authored workspace or project instructions, trusted and visible as such;
3. retrieved repository files, PDFs, chats, transcripts and web content, always untrusted evidence.

The existing project `instructions` field already supplies level 2. Optionally recognize one named workspace
file such as `AGENTSPINE.md` only when the workspace owner explicitly adds it as trusted instructions; do not
promote an arbitrary indexed `AGENTS.md`, README or document into the system prompt. Show the source of each
trusted instruction in the run inspector.

**Done when:** a workspace rule changes behaviour in that project, a same-named file inside an untrusted
document source cannot do so, and the trace identifies which instruction sources were active.

### S7. Epistemic awareness joins the knowledge system (Code, depends on K4)

Operational awareness says where the agent is and what it may do. Management synthesis also needs the model to
state what kind of knowledge supports an answer. K4 records and K6 briefs should distinguish:

- known from reviewed evidence;
- machine-extracted but unreviewed;
- inferred from multiple cited sources;
- conflicting evidence;
- unknown or insufficient evidence.

The answer contract requires citations for material claims and prevents an inference from presenting itself as
a reviewed fact. `harness_status` does not answer epistemic questions; the knowledge store and retrieval result
metadata do.

**Done when:** a scripted conflict is reported as a conflict, an unsupported question says there is insufficient
evidence, and every reviewed-fact claim links to its source passage or timestamp.

### S8. Behavioural harness-awareness tests (Code)

Keep prompt substring tests as tripwires, but add scripted-model scenarios that exercise behaviour:

- “Can you send this email?” produces a draft path and does not claim send exists.
- “Remind me tomorrow” proposes one one-shot schedule rather than doing the subject now.
- A scheduled run attempting to create standing work queues confirmation.
- “Where will this file be saved?” names the effective project directory.
- “Are you running locally?” reports actual privacy and tier state rather than model identity folklore.
- “What happens if I approve?” describes the exact pending action and continuation.
- Retrieving a private meeting pins subsequent calls locally (already covered by `test/private-output.test.mjs`;
  reuse its two-server pattern).
- A restricted subagent reports only its visible subset.
- `queued`, `denied`, `dry-run`, `error` and `executed` each lead to the correct next action.

Use fixtures for the runtime context and effective policy; no live model or network. Assert broker outcomes and
tool calls as well as final prose, since a fluent correct answer can hide an incorrect action path.

**Done when:** the suite fails if prompt claims and broker reality diverge, and it is included explicitly in the
`npm test` chain.

### Sequence and decisions

Build order: F1 to F7, S1 and S2 are done; S3 to S6 are built; next S8; S6; S8. S7 lands with K4 and K6. S1 and S2 are the useful
minimum: they make every later feature easier to explain without accumulating prompt folklore.

Open decisions for you:

- Whether to recognize a workspace `AGENTSPINE.md` in addition to existing project instructions. Proposed:
  yes, but only through an explicit trusted-source setting on the project.
- Whether full filesystem paths should appear in `harness_status`. Proposed: show only the active workspace and
  effective write directory; never enumerate other allowlisted roots.
- Whether disabled capabilities should be comprehensive or task-relevant. Proposed: always show the small set of
  consequential absences (send, permanent delete, cloud for private work), and render the rest only when asked.

---

---

## Ground rules (settled; not work)

**Settled decisions. Do not reopen without a new recorded decision.**
- **Quiet hours** are shared by Heads-up, the outbox and watchers: one setting, default **9 pm to 6 am Eastern**,
  read from the server's local clock. Settings labels it "Quiet hours".
- **Daily cap** is six proactive messages a local day, and it **includes Heads-up pushes** (`COUNTED_SOURCES`).
- **Hard backstop:** `policy.budgets.perDay.tools.notify` is **20**, set by the owner in `policy.json`. No tool
  may write that file.
- **Heads-up:** the time-sensitive loop never polls more often than every 30 minutes; a "Yes" answer is the
  consent for read-only research; anything irreversible (buy, book, email) goes to the confirmation queue;
  `PAID` in a calendar event title marks a bill as paid; mail is drafted, never sent.
- **Google writes** are allowed only as SPEC section 5 (amendment of 2026-11-21) describes: a separate write
  token held only by `src/google/write.ts`; archive, label, trash, mark spam, and all-day events on a named
  calendar. No send, no permanent delete, no calendar delete.
- **UI changes are built for web, Mac and iPhone together.**

**Not doing.** Model-judged safety checks (revisit only if N2 shows the code gates cost real approval fatigue);
MCP connectors beyond `docs/MCP.md`; Docker workspace containers; Telegram or WhatsApp (a second place for
approvals to be dismissed unseen); usage telemetry (local-first); auto-sending email; a live "agent thinking"
dashboard; unsubscribing via the browser in the inbox cleanup (the summary lists senders worth unsubscribing
from instead).

**Standing rules for any item above.**
- Code owns the numbers (thresholds, schedules, budgets in code, never in a prompt). The model owns the
  judgment.
- Local-first: `sensitivity: "private"` content never reaches the cloud tier. Meeting work and study topics
  linked to a project are local-only. Milliman and other workplace material never goes to web search, paste
  services or third-party APIs. F6 is fixed for filed meetings; what is derived from a stored source (K0) is the remaining gap.
- Standing work needs consent: a tool that creates or edits what future unattended runs follow sets
  `confirmWhenUnattended: true` or refuses non-chat runs.
- Tests first for arithmetic and every boundary; new suites are added by hand to the `npm test` list in
  `package.json`, and the chain stops at the first failing suite.
- Run `npm run check` (outside the Claude sandbox, which blocks the local ports the tests bind) before calling
  anything done. Server changes need a dashboard restart; web changes need `npm run web:build`.
- Swift: there is no Swift compiler inside the Claude sandbox, so a Swift change ends with an Xcode build of both
  targets. Do not hand-edit the `.pbxproj`; tick Target Membership to share a file with the Mac target.
  `Models.swift` must stay Foundation-only (`test/ios-models.test.mjs` compiles it alone), and shared files must
  not import UIKit unguarded.
