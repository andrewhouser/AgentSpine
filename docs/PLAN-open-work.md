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
Sections 1 to 7 are the rest, mostly verification that needs you. Section 10 (added 2026-11-22: Claude Desktop
parity on local models, self-change and self-learning) is proposed and not yet placed in this order; that is
its first open decision. Section 12 (added 2026-11-24: what Claude Duet does that AgentSpine does not) is
proposed and not placed either; its own "Sequence and decisions" says what waits on what.

Section numbers are stable on purpose, because code comments and other docs point at them: 0, 8, 9, 10, 11 and
12 are new, and 1 to 7 and 4a are as before.

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

**What is left in this section:** nothing in code. You: read your existing schedules against F9 below, since one that sends to someone its text does not name will now ask. The "Local only" note and the filing question have not been seen rendered.

**F8 (found and fixed 2026-11-24): a scheduled run clicked buy, pay and transfer buttons without asking.** The
`browser` tool did not set `confirmWhenUnattended`, so the scheduled pre-approval skipped gate 2 for its risky
clicks and every form submit. That was the documented rule for schedules working as written, but the README
already named the threat it left open (a job that reads a hostile page) and closed it only for standing work.
Now `confirmWhenUnattended` may be a function of the arguments, and the browser's queues a click or submit
that reads as buying, paying or moving money; a plain submit or send stays pre-approved. Suite:
`test/unattended-asks.test.mjs`. What it does not close (a button labelled "Continue", delete clicks) is in
section 12 D2.

**F9 (found and fixed 2026-11-24): a scheduled run mailed or messaged anyone without asking.** `mac_control`
sends took the same path as F8, and the tool's only check was the app allowlist. With Mail or Messages
allowlisted, a job that had just read a hostile page or email could send what it had read to any address.
Now an unattended `send_mail` or `send_message` asks unless the job's own task text tells it to send to that
recipient, read by `directedBy` as a chat message is. The text is carried as `RunContext.approvedTask`, set
by the runner for schedules and the heartbeat and handed unchanged to subagents, whose own goal is a brief
the model wrote. Fixed with it: `directedBy` read "archive mail from billing@example.org" as an instruction
to mail that address, in a chat too, because "mail" is also a send verb; whoever follows "from" is now
dropped from the recipient window. Suites: `test/unattended-asks.test.mjs` (the rule),
`test/mac-directed.test.mjs` (the reading of the text), and `test/unattended-handoff.test.mjs`, which starts
real runs through the runner and reads the text a tool is given in a schedule, its subagent, the heartbeat
and a chat turn. That last one was checked by breaking the wiring both ways: handing a subagent its own
brief let a send to an address named only in the brief go out, and the suite failed on it.
Costs, accepted: "text me the brief" names nobody, so it asks (name the number or contact, or use `notify`);
a schedule that says only "run pi-brief" asks about every send, because the recipient is in the recipe and
not in the task.

**F1 to F7: all fixed 2026-11-21, numbers kept so they do not shift.** F6 (filed transcripts outliving the retention window): filing a meeting under a project asks whether the project keeps the full transcript searchable or only the summary, topics and decisions. The choice is stored as `meetings.keep_transcript`; summary-only meetings never put their words in the project index (`meeting-summary:<id>`), so the prune has nothing of theirs to leave behind, and the prune also drops any stray transcript copy of one. A kept transcript is an explicit retention opt-in and every screen says so. A meeting filed before the choice existed keeps its transcript, shown as such. Web, iPhone and Mac ask when you file after the fact, and each can change the choice later. Not yet asked: a meeting recorded or imported with a project already chosen files with the transcript kept, because there is no filing moment to ask at; change it from the meeting afterwards. Moving a meeting now carries its index copy to the new project, un-filing removes it, and delete clears copies from every project (2026-11-23, SPEC §15 phase 1 decision 9). Copies stranded by moves before that fix stay until someone runs `npm run meetings:orphans -- --apply`; the command without the flag only reports. Suite: `test/meeting-filing.test.mjs`. F1 (an overlay opening the browser to any domain): two non-empty allowlists that share nothing now set `browser.denyAll`, which `browser` and `web_read` test before the list. F5 (an overlay raising a budget): caps are compared as the broker applies them, so no tool ends above the base's effective cap. Suite: `test/narrow-policy-holes.test.mjs`. F2 (meeting transcripts reaching
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
3. ADDED (you ran `npm run watcher add inbox-cleanup`). **First run found a defect (2026-11-21), and the design was wrong:** it reported "0 new messages, inbox is clean" with 18 unread in the inbox. `gmail_search` only looked at mail newer than its last run (stamped before the search even succeeded, capped at 24 hours), so older mail was never reviewed and mail left alone never got a second look. It now works through the inbox as it stands: `sinceKey` means "remember which messages I have reviewed" (by id, for a week), so each call returns the inbox's unreviewed mail whatever its age, a failed search reviews nothing, the result's first line says how many were already reviewed and how many more are waiting, and the summary may not call the inbox clean. A backlog is worked through across batches and runs, bounded by the watcher's cap on changes per run. On the Mini: `git pull`, `./update.sh`, remove and re-add the watcher so it takes the new wording (`npm run watcher remove <id>`, `npm run watcher add inbox-cleanup`), `npm run watcher reset-window`, then Run now. Still to do: run it once by hand, and **read its summary before trusting it**. It
   runs every 8 hours after that. Protections are code: inbox mail only, never mail from anyone you have
   emailed, never starred or sent mail, 60 changes per run. Trash and spam are irreversible-tier.
   `policy.json` `google.write.trashOverrideSenders` holds `afs.ameriprise.com`.
4. Let the outbox log for about a week, then read the "What I sent you" section of `npm run digest 168`. Each
   row's `would_be` column says what the rules would have done. Then decide on `OUTBOX_ENFORCE=true`.
5. Work through `docs/ROLLOUT.md` (the learning-loop checklist). One box is ticked and 22 are not, and the repo
   cannot say how far you are: run `npm run digest 168` on the Mini and tick what is already on.

6. Instagram publishing (built 2026-11-22, `docs/INSTAGRAM.md`). It is off and has never called Meta. The
   nine setup steps in that doc are all yours: confirm the account type, create the Meta app, host the JPEGs
   (the DJLive R2 bucket), add the `instagram` section to `policy.json` without `publish`, store the token
   with `npm run instagram -- token`, seed the queue from the djlive kit, read `npm run instagram -- dry-run`,
   publish one approved test post, then approve a week at a time. Still to build if wanted: a queue screen in
   the dashboard and apps (approval is the CLI or the confirmation queue today).

Never exercised against real services: Google Calendar reads, web search and retailer pages for Heads-up,
AeroDataBox, TomTom, APNs delivery of the Heads-up categories, Gmail and Calendar writes, the Instagram API.

---

## 2. Outbox (`docs/archive/PLAN-outbox.md` has the design)

Phases 0 to 4 are built, with enforcement off by default (`OUTBOX_ENFORCE`). Phase 2 (opened and dismissed
reports) is proven on a phone. What is left is verification and data.

**Phase 3, the weekly review.** Done when a real week has produced one real review and one *Skip this kind*
that yields exactly one `preference` memory which recall picks up the next day.
- Built 2026-11-22: the Sunday push carries `screen: "review"`, and a tap opens the review as a sheet on iPhone.
  Not yet tapped on a real push.
- Decided and built 2026-11-21: answering Useful about a message of a kind you skipped retires that kind's
  "Skip this kind" note (it deletes only the exact interrupt-origin dismissal memory, never one you wrote), and the
  kind can be skipped again afterwards. Tested in `test/outbox-review.test.mjs`. The review screens on web, iPhone
  and Mac say so under the list (2026-11-22).
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
because they finish or verify what is already built. One new decision since: on 2026-11-24 you lifted this
for the check-in alone (section 12 D1).

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
- H2 web sidebar badge for open heads-ups: built 2026-11-21 (offered items plus dates to confirm, the same rule as
  the iPhone; hidden when Heads-up cannot be read). Not seen rendered.
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
  baseline. Heads-up was traced 2026-11-25: an event title (written by whoever sent the invite) becomes a heads-up's
  `subject`. It never reaches a web search query: gift and dinner queries are built from a fixed shape, and only the
  local model's re-validated summary fills it, with every protected name checked out (`assertAnonymous`). It reaches
  push text (your own phone) and travel watches (the event's location goes to the routing provider, by design).
  Two holes found and fixed: `headsup_status`, which the scheduled morning brief calls, returned titles bare and
  without `privateOutput`, so an invite's title reached the model as plain text and could reach the cloud tier (now
  tagged untrusted and declared private); and gift research gave the whole title to the local model as "who" when
  it was not "X's birthday", so a crafted title could steer which remembered facts became search words (now a title
  that is not name-shaped gives no "who", no recall and no model call, and the name it does give is labelled data).
  Suites: `test/headsup-brief.test.mjs`, `test/headsup-research.test.mjs`. The fixtures above do not yet include a
  calendar-title payload for the live run. The write token raised the value of
  this work, since a hostile email is now worth more to an attacker.
- **N1 memory provenance.** Built 2026-11-21: a friction note now records the run that first met the error
  (`recordFriction` takes the run id from the broker). Nothing uses `origin` to change recall or pruning, by design.
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
on a thread that has touched private material (F7), and the new composer (2026-11-22): on the iPhone the mic
inside the box, the waveform while dictating, and the gap above the tab bar; on web the waveform; and stop on all
three against a real slow turn (the server half is covered by `test/stop-run.test.mjs`, the screens are not seen
running). This list is the same check that sections 2, 3 and 4 ask for, in one pass.

**The plan card: look at it running, then decide on a model-written plan (You, then Code).** Built 2026-11-22:
the run's own tool calls become the steps, so it costs no model tokens. `src/plan.ts` is the pure state
machine. `src/events.ts` folds every event a run publishes through it and publishes a `plan` event with the
whole list each time the list changes. Web (`PlanCard`), iPhone (`LiveTurnView`) and Mac (`MacTurnSpine`) draw
only the newest list, so there is one set of rules, in TypeScript, covered by `test/plan.test.mjs`.
Decided while building:
- Consecutive calls with the same label merge into one step ("Searching the web ×3"). A label that comes back
  after a different step becomes a new step, so a step shown as done never reopens.
- A trailing "Writing the reply" step is waiting until the answer lands. A run that answers without calling any
  tool gets no plan, so the card never shows for a one-step reply.
- A denied or errored call fails its step, unless another call in the same step succeeded. A queued call shows
  the step as waiting on your approval. A stop or a failure marks whatever was still running as failed.
- A subagent is one step ("Handing off to researcher"). The child's own calls stay under the child's run id.
- Changed 2026-11-22 (Andrew: the call-by-call rows buried the reply): on web and Mac the card is the chat's
  whole record of what a turn did, live and after it ends. The thread API sends a finished turn's `plan`, folded
  from its stored actions by `planFromActions` with the same rules. Every call, with its arguments and result,
  is in the Trace tab (web) or the new Chat/Trace switch (Mac). An approval still shows in chat. The iPhone is
  unchanged: the card while the turn runs, the tool-call rows after.
Left to do:
1. Watch it on a real multi-step turn on all three clients (You). Not yet seen running: the Swift targets build
   and the web typechecks, but no screen has been looked at.
2. Labels for remote MCP tools read "Using <tool name>". Give them better ones if that looks raw.
3. The Activity view doesn't stream runs, so scheduled runs don't show the card yet. Add it there if that
   view starts following a live run.
4. Only if the tool-call steps feel thin: a 3 to 7 step plan written by the model, on the `deep` tier only, as one more
   action in the JSON protocol. Prefill is the expensive part on the model host, and a small local model is
   the least reliable at extra protocol, so it stays off `fast` and `standard` until measured.

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
- **iPhone offline cache (built 2026-11-22; checks recorded below).** `Core/OfflineCache.swift` keeps the raw replies
  for the thread list, threads, tasks, files, projects and runs you opened, shown under an "Offline: saved copy" notice
  with their age when the server is unreachable (or answers 502 to 504). Nothing is fetched ahead, and writes are not
  queued. A question from a saved copy has no Approve or Reject, even if the network returns, until the thread reloads
  fresh, because a stale approval is a security problem. The files use iOS complete file protection and are left out of
  backups. The copy is tied to one server and token, wiped on a rejected token or when the app is unconfigured, removed
  after 14 days, capped at 25 MB (2 MB per reply), and follows deletions on the next fresh list. A run's raw trace is
  not kept, because it carries the profile and recalled memories; attachments and meeting transcripts are not cached.
  Settings shows its size and can delete it. The Mac has a no-op stub. Suite: `test/ios-offline-cache.test.mjs`.
  **Checked in the simulator (2026-11-22, throwaway server):** a saved thread showed its approval with no Approve or
  Reject while the server was down and after it came back. A fresh reload restored the buttons, and an approval
  rejected elsewhere in the meantime left the thread on reload. The same run found Settings reloading on the first
  typed token character, which showed a stuck "rejected token" error and could erase the copy. Now only a passing
  connection test reloads, only the owning token's rejection wipes, and removing the server or token wipes at once.
  A failed keychain read no longer counts as a sign-out: only "item not found" does, so a launch before the first
  unlock keeps the copy and retries the read when the app comes forward or makes a request.
  **Gateway fallback checked in the simulator (2026-11-22, local proxy answering each status):** 502, 503 and 504 each
  showed the saved list under the offline notice (the saved thread was opened under 502 only). A 500 showed its error
  instead of the copy. No write was sent during the outages, Try again recovered without a relaunch, and removing the
  token still erased the copy.
  **Checked on the real iPhone (2026-11-23, reported by Andrew):** the token survived a force quit on a signed build,
  and the app passed the check with the dashboard stopped behind real `tailscale serve`.
  **File protection checked on a real iPhone 16 Pro Max (2026-11-23, Xcode debugger):** `manifest.json` reports
  `NSFileProtectionComplete`, and reading it from inside the app returned 601 bytes unlocked, 0 after 30 seconds
  locked, and 601 after unlocking. The saved replies use the same write options but were not read individually.
- **Web, Mac and iPhone matched (2026-11-21).** Web has a thread inspector beside the chat (`ThreadInspector`,
  toggled from the chat tab bar, remembered in `localStorage`) with four cards plus a **Tokens** card (in, out, calls,
  by model, and effective tok/s with model time; from `usage` on each turn, which `usageForRuns` sums from
  `llm_calls` for the turn and its child runs. Effective speed includes prefill until LP1 can time decode alone).
  Mac and iPhone share one `ThreadInspectorView.swift` (the inspector column on Mac, a sheet from the thread's
  toolbar on iPhone; it is listed in the Mac target's membership exceptions in the project file). The project
  screen is split into Conversations, Documents, Tasks and Settings on web and, by a segmented picker in the shared
  `ProjectsView.swift`, on Mac and iPhone. Settings on all three has the transcript-retention override with the
  rules list, and a delete-project button. Both Xcode targets build. The three AVAudioSession deactivations Xcode
  flagged as hang risks now go through `AudioSessionGate` (a serial queue; activations wait for a pending one).
  **Not done:** looking at any of it on a running app; on Mac, deleting the project shown in the detail pane
  leaves the pane to be changed by hand.

- **Files page folders (built 2026-11-25).** Files are grouped by the project they were written in, with a General
  folder last for the rest; **All** keeps the flat list and a search box covers both. `GET /api/files` now returns
  `project_id` and `project_name` (joined run, conversation, project in `src/deliverables.ts`, no new column) and
  returns up to 500 files, up from 200. Web (`FilesView.tsx`, `web/src/lib/fileGroups.ts`) and iPhone and Mac
  (`FilesView.swift`, `FileGroup` in `Models.swift`) share the rules. Suite: `test/file-groups.test.mjs` (server join
  and web grouping). **Not done:** the Swift half has no test of its own, and I have not seen it on a running app.

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

- **K0. Privacy and retention first (built 2026-11-21).** F2, F6 and F7 are done. Backups rely on FileVault
  and an encrypted backup disk, written down in the README ("Where your data lives, and how it is protected").
  Deletion and retention now leave an audit row (`data_events`, `GET /api/data-events`): a conversation, a
  memory, a meeting, a kept recording, a project, an indexed source, and the transcript retention prune; ids,
  counts and project names only, never content or a title, and not pruned with the run ledger. Suite:
  `test/data-audit.test.mjs`. Not built: a per-source sensitivity flag. A project is private by default, which
  covers everything filed in one; the gap is an item with no project, so K3 makes every Inbox item private until
  a person says otherwise, and K2 and K4 inherit the source's sensitivity for everything derived from it. There
  is no export path today; when K3 or K6 add one it must call `logDataEvent("export", ...)`.
- **K1. Evaluation set (harness built 2026-11-21; You write the questions).** `npm run eval:knowledge -- /path/to/questions.json [k]`
  (`src/eval/knowledge.ts`) runs your questions through four retrieval modes against the live database:
  `baseline` (the old cosine-only recall), `fts`, `vector` and `hybrid`, and prints recall@k, mean reciprocal
  rank and the leak rate (a forbidden source appearing), with ids and numbers only, never question text or
  passages. Question format: `id`, `question`, `project`, `expectSources` (path or ticket-like text),
  `forbidSources`, `kinds`, `since`, and `expectNone` (reports the best score so a no-evidence threshold can be
  chosen from real data). Keep the file outside the repository. **You (deferred 2026-11-21): write 30 to 50 questions** you actually
  care about (some with changed information, some whose right answer is "not enough evidence"), then run it on
  the Mini before changing retrieval again; `VECTOR_MIN_SIMILARITY` is set from the result: run it with `KNOWLEDGE_VECTOR_MIN=0.15`, `0.25` and `0.35` in front of the command and keep the value with the best recall and no new leaks. `eval/questions.example.json` is an invented template to copy outside the repo. Suite:
  `test/knowledge-eval.test.mjs`, which shows each path winning its own kind of question and the fused mode
  winning both. Not built: citation correctness, stale-answer rate and extraction acceptance rate (they need
  K4's records and K6's answers). This also still measures meeting recall (section 4a) once questions exist.
- **K2. Hybrid global retrieval (built 2026-11-21, structured lookup waits for K4).** `src/projects/search.ts`:
  an FTS5 index over `chunks` (kept in step by triggers, built into `node:sqlite`, no dependency) and the existing
  vector search, fused by reciprocal-rank fusion with the path that found each hit recorded, a per-source quota
  (two by default) so one meeting cannot crowd out a document, and filters for project (or the whole base), source
  kind and a date range. Run-level project recall (`recallChunks`, `knowledgeFor`) uses it, so an exact name or
  ticket number is now found without an embedding; the live meeting cards keep their cosine path because they
  threshold on it. `GET /api/knowledge/search` exposes it. Suite: `test/knowledge-search.test.mjs`. The vector
  floor (`VECTOR_MIN_SIMILARITY`, 0.25) is a guess to set from K1. **Filters and the structured path (built
  2026-11-25, backend and agent tools; no screen yet).** `searchFiltered` (`src/knowledge/retrieval.ts`) adds a person
  or team filter (a passage must name the person, by recorded name or alias as a whole word, or for a team the team
  or any recorded member; a bare first name is not a match until it is taught as an alias) and an evidence filter
  (`reviewed`, `extracted`, `none`, by what backs the source). Both narrow before the per-source quota, so the list
  still fills, and neither re-orders what it keeps. "As of" for passages is `until` (`asOf` on the API); for claims it
  was already in `listClaims`. The structured path is in `knowledge_claims` (`gatherEvidence`): with a person, team
  or kind, the store's owners, speakers and kinds decide which claims qualify and the question's words only narrow
  them, after dropping names and words that restate the filter, so "what has Sam raised" answers from Sam's claims.
  An unknown person or team is an error, never an answer for everyone. `knowledge_search` and `knowledge_claims` take
  `person`, `team`, `evidence` and `kind`; `GET /api/knowledge/search` takes `person`, `team`, `evidence` and `asOf`
  and keeps its array shape. Fixed with it: `knowledge_claims` did not keep a project run to its own project, as
  `knowledge_search` did, so a project chat could read another project's claims; it is pinned now. Suite:
  `test/knowledge-filters.test.mjs`. The web Drop zone's "Search everything" has
  them (2026-11-25): project, a person or team picker (people and teams from the knowledge store), what backs the
  source, and From and As of dates; a change re-runs the search on screen, and each hit now shows its project, date
  and what backs it. Checked in a real browser against a seeded database, desktop and phone width. iPhone and Mac have
  the same filters in a collapsible "Filters" group in the shared `InboxView.swift` (2026-11-25; written in a
  sandbox with no Swift toolchain, so **not compiled or run: build it in Xcode first**), and their hits show the same
  project, date and evidence line. Not built: any measurement of whether the filters help, which is K1's questions
  again. Search everything is on the Drop zone screen on web, iPhone and Mac (native added
  2026-11-22, built but not seen running). The agent tool is built (2026-11-22): `knowledge_search`
  declares `privateOutput`, and a run inside a project can search only that project.
  Done when K1 shows an improvement: that measurement is still to be taken.
- **K3. Knowledge Inbox (built 2026-11-21: backend and screens on web, iPhone and Mac; the screens have been built but not seen on the native apps).** `src/inbox/`:
  every file, screenshot, scan, pasted thread and typed note becomes a source artifact (`inbox_items`) before it
  has a project, with the original kept untouched under `INBOX_DIR`, its content hash (the same bytes twice are one
  item), when it arrived, document date, author and speakers, and an extraction status. Text is extracted with the
  project indexer's converters; images and PDFs with no text layer are read by a small macOS Vision helper
  (`tools/vision-ocr.swift`, compiled once with `swiftc`, no dependency, fully local); when OCR is unavailable the
  item is `needs_ocr`, and one OCR could not read is `ocr_failed`, never silently empty. Pasted chats and emails
  are parsed for speakers, times, author and date. The watched folder (`INBOX_WATCH_DIR`) is scanned on the
  confirmation watchdog's clock, skipping hidden, partial and just-landed files. Chunks are indexed straight away
  under a hidden "Knowledge Inbox" project, so global search finds an item before anyone files it; the item is
  private by default, a project is only SUGGESTED (from the words in each project's name and instructions) and
  applied only when a person files it, and filing moves its chunks. Deleting removes the original, the text and
  the index and leaves an audit row. API: `GET /api/inbox/status`, `GET /api/inbox`, `POST /api/inbox/files`,
  `POST /api/inbox/paste`, `PATCH`, `POST .../reprocess` and `DELETE /api/inbox/:id`. Suite: `test/inbox.test.mjs`.
  **Screens:** web has a Drop zone entry (called Inbox until 2026-11-25, renamed because Inbox reads as email; routes, `/api/inbox` and the hidden "Knowledge Inbox" project keep the old name) (drop or choose files, paste a thread or type a note, search everything with
  the path that found each hit shown, items with an honest status, the suggested project with a one-click file,
  a project picker, try again, delete); iPhone and Mac share one `InboxView` (add files, paste text, context menu
  and swipe actions) and an Inbox tab or sidebar row. `InboxView` is in `Views/InboxView.swift`, shared by both targets. I looked at the web screen through the page's own DOM (the pane
  was not on screen), not by eye. A PDF's own date is now read from its Info dictionary or XMP (`src/inbox/metadata.ts`)
  when nobody gave one, and each ready item records known people whose names appear in it and tags already in use
  whose words appear in it (`suggested_people`, `suggested_tags`); the web Drop zone shows them, with one click to add
  the tags, and nothing is applied by itself (2026-11-21; a PDF whose metadata sits in a compressed object stream
  gives no date, and the item keeps the day it was added). **Dictated notes (built 2026-11-22; the microphone path
  not run on any client):** web has Dictate in the Drop zone's text card, and iPhone and Mac have "Dictate a note…". The
  transcript waits in an editable box and nothing is stored until Add, because Whisper mishears names; the item records
  `via: dictation`. The Mac had no dictation, so a small recorder for it lives in the shared `InboxView.swift`.
  **Not built:** the iPhone share sheet; adopting the existing Milliman
  knowledge-folder loader as one source of the Inbox (that folder is off limits to this sandbox, so it needs you or
  a session on the Mini). The suggested people and tags also show on iPhone and Mac (2026-11-22, in the shared
  `InboxView`; built, not seen running), with one tap to add the tags and nothing applied by itself.
- **K4. Knowledge store (backend built 2026-11-21; screens are K5).** `src/knowledge/`: a layer separate from
  semantic memory. Records are `kn_claims` (kinds `decision`, `commitment`, `risk`, `question`, `goal`, `status`,
  `claim`), `kn_entities` (people, teams, topics, with aliases that merge two spellings into one) and `kn_links`.
  Every claim must carry its source and the exact passage (and a meeting timestamp where there is one) or it is
  refused; it also records when it was said, the period it applies to, its speaker, owner, due date, how it was
  found (`manual`, `meeting-extraction`, `model`, `inferred`), a review state (`proposed`, `reviewed`, `rejected`)
  and a status (`active`, `resolved`, `retracted`, `superseded`). Nothing is trusted until a person reviews it;
  only a person marks supersession (`supersede`), which keeps the trail (`chain`) and makes "as of a date"
  queries answer from what was current then. `findConflicts` reports reviewed, active claims that say different
  things about one topic, and `evidenceLevel` labels a claim reviewed, machine-extracted, inferred, conflicting,
  superseded or retracted (section 9, S7). Meeting decisions and work items are NORMALIZED into claims (a false
  positive is not carried over, a filed work item is already reviewed), not extracted twice; other sources go
  through a local, `private`-pinned model whose every claim must quote the source word for word, and a quote that
  is not in the text is dropped, so a small model cannot invent a decision and cite it. Deleting a meeting or an
  inbox item removes the claims cited to it and the audit row says how many. API: `GET/POST /api/knowledge/claims`,
  `GET/PATCH .../claims/:id` (review, correct, resolve, retract), `POST .../claims/:id/supersede`,
  `GET /api/knowledge/conflicts`, `/entities`, `/summary`, `POST /api/inbox/:id/extract`, and
  `POST /api/knowledge/meetings/:id`. Retrieval carries the evidence level (2026-11-21, `src/knowledge/retrieval.ts`):
  each hit from `GET /api/knowledge/search` has `evidence {level, claims, reviewed, unreviewed}` read from the claims
  cited to its source (`none` when nobody analysed it, then `machine-extracted`, `inferred`, `reviewed`, or
  `conflicting`; retracted and superseded claims do not count), and a project run's excerpt header says the same in
  words, so a passage with no reviewed claims is not read as a fact. It annotates and never re-ranks. Suites:
  `test/knowledge-store.test.mjs`, `test/knowledge-retrieval.test.mjs`. **Not built:** the review and
  close-out screens (K5), model extraction on ingest by default (it runs on request, to spare the model host),
  and nothing yet that RANKS by evidence (K2 ranking is unchanged). **Topic entities in use (built 2026-11-22; web,
  iPhone and Mac screens not seen running):** a claim keeps the words it used and links to one topic (`topic_id`), so
  a taught alias or merge now changes conflicts, recurring risks, answers and briefs. Only a person's acceptance creates
  a topic; a model's proposal can join an existing one and cannot add to the list. A topic whose last claim is deleted
  goes with it unless a person taught it another name. `GET /api/knowledge/briefs/topic/:id` and "Topic brief" on all
  three clients show one subject across projects; `GET /api/knowledge/claims?topic=` filters by it. Existing reviewed
  claims are linked on the next start. Suite: `test/knowledge-topics.test.mjs`. Added 2026-11-21: a
  `measure` claim kind (linked to the goal it measures with `link(measure, goal, "measures")`, shown under
  "Measures" in the project brief), and relationships a person enters between people and teams (`member_of`,
  `reports_to`, `works_with`; `relate`, `unrelate`, `relationsOf`; `GET/POST/DELETE /api/knowledge/relations`),
  followed through an alias merge and shown in person and one-on-one briefs. Model extraction on ingest stays
  on request: turning it on by default spends the model host on every item and is your call, not a default I chose.
- **K5. Review and close-out screens (built 2026-11-21; not seen rendered on the native apps).** A Knowledge
  screen on web (sidebar), iPhone (a tab, under More by default) and Mac (sidebar): claims waiting for review with
  their cited words and source, Accept (web also lets you correct the text first), Reject, and after accepting a
  decision or status, "Does this replace an earlier one?" with the earlier reviewed claims of the same kind and
  project, so supersession is always a person's act; conflicting information with "This one is wrong"; and a brief
  reader (a project brief, or one of the six operations). It reads the API in K4 and K6. `KnowledgeView` is in `Views/KnowledgeView.swift`, shared by both targets.
  **One-step close-out (built 2026-11-22 on web, iPhone and Mac; not seen running).** A finished meeting has "Close out
  this meeting": name the speakers, choose the project and topics, accept, reject or leave each extracted item, say
  what each decision replaces, and read how the briefs will change. `src/knowledge/closeout.ts` previews by applying the
  plan in a transaction, building the real briefs and rolling back, and Save stays locked until that preview is shown
  for the current choices. A save lands whole or not at all; filing into the project index follows it, and a failure
  there is reported without undoing the save. One decision can now replace several: the trail and the undo read
  `kn_links`, because `supersedes_id` holds one id and lost the others. Filing a meeting now moves its claims too, on
  every path, where before they stayed out of the project's brief. Suite: `test/knowledge-closeout.test.mjs`.
  **Not built:** attributing a claim to a named speaker from the diarized timestamp (diarization can be wrong, so that
  needs its own review step), and teaching an alias for a project name, because projects are not knowledge entities.
  **Added 2026-11-22 on web, iPhone and Mac (built, not seen running; extraction not run on the live model):** "Teach
  a name" for a person, team or topic (`POST /api/knowledge/entities/:id/aliases`). A name that already belongs to
  another entity changes nothing until you confirm the merge, because a merge cannot be undone. A Drop zone button runs
  model extraction on request, and what it finds arrives as proposed claims.
- **K6. Briefs and synthesis operations (backend built 2026-11-21; the screens are not).** `src/knowledge/briefs.ts`:
  briefs are ASSEMBLED from reviewed claims by code, with a fixed recipe and output shape per operation, never written
  freehand by a model, so every line is a claim with its id, source, exact cited words and evidence level, and an
  empty section says "Nothing recorded". Unreviewed claims are never mixed in; they are counted as "waiting for
  review". A project brief (goals, active decisions, risks, commitments by due date with overdue flagged, open
  questions, recent changes, conflicting information, people involved), a person brief (what they own, what they
  raised, what they said; "owed to them by others" is stated as not recorded), and the operations `next-meeting`,
  `what-changed`, `commitments` (overdue first, optionally one person), `recurring-risks`, `stale-topics` and
  `weekly-summary`, plus `decisionTrace` (how a decision evolved). Any brief can be asked as of an earlier date,
  rendered as Markdown with each citation (`?format=md`), and is materialized in `kn_briefs` so it is the same
  document until refreshed. API: `GET /api/knowledge/briefs/{project|person|op|trace}/...`. Suite:
  `test/knowledge-briefs.test.mjs`. Added 2026-11-21: a claim can be marked sensitive
  (`PATCH .../claims/:id {"sensitive": true}`), which keeps it in the store and on the review screen but leaves it
  out of every brief, its Markdown, `knowledge_claims` answers and decision traces, with the count withheld stated,
  and drops stored briefs so nothing lingers; `oneOnOne` (`GET .../briefs/one-on-one/:person`) assembles a person's
  commitments, open raised items, recent words and team line from recorded facts only, with no invented talking
  points; `comparePlan` (`POST .../briefs/plan {plan, project?}`) matches each plan line to reviewed decisions and
  commitments by shared words and lists what is recorded for it, which plan lines have nothing recorded, and which
  recorded items the plan does not mention, without judging agreement. The web Knowledge screen has the brief
  reader (with a person picker for person and one-on-one briefs), the plan comparison and a sensitive checkbox on
  claims awaiting review. iPhone and Mac have the same brief reader, person and one-on-one briefs and plan comparison
  (2026-11-22, in the shared `KnowledgeView`; built but not seen running), and the sensitive switch and claim
  correction during review. **Not built:** a check that the plan comparison helps on a real plan (the matching is
  plain shared words, a first guess to tune on real plans).
- **K7. Retention rules (built 2026-11-21).** Separate rules per kind of thing, stated from the same numbers the
  code enforces (`src/knowledge/retention.ts`, `GET /api/retention`): original audio (`MEETING_KEEP_AUDIO_HOURS`),
  raw transcripts (`TRANSCRIPT_RETENTION_DAYS`, 30), a transcript indexed in a project (only if you chose to keep
  it when filing, then until the meeting is deleted, or for `INDEXED_TRANSCRIPT_RETENTION_DAYS` if you set one),
  reviewed decisions and commitments (kept when their transcript expires, with their exact cited words and the
  note that the evidence has aged out), claims nobody reviewed (removed with their evidence), summaries and
  extractions (until the meeting is deleted), inbox items (until you delete them), and the deletion records
  (kept, without content). Deleting a meeting or inbox item is still total, reviewed claims included. This
  replaces the interim F6 behaviour. Suite: `test/retention.test.mjs`. A project can have its own raw-transcript window
  (2026-11-21, backend only): `PATCH /api/projects/:id {"transcriptRetentionDays": n}` (0 keeps that project's
  transcripts until the meeting is deleted, `null` follows the global setting), enforced per meeting by
  `expiredMeetingIds`, so with the global window off only a project's own window expires anything. The indexed
  transcript lifetime stays global. Project Settings on web, iPhone and Mac shows the rules and sets the override.
  The Knowledge screen on all three shows the global rules (2026-11-22, not seen running on the native apps); they
  are read-only there because the numbers are server config.
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

**Built:** `src/harness.ts` holds `HarnessContext`, built in `runner.ts`, completed and registered by the loop (which alone knows the visible tools), rendered as a short envelope straight after the stable prompt and kept in the trace. A subagent derives its own with `childHarness`. Both it and the tool-facing `RunContext` now extend one `RunFacts` base (`conversational`, `preApproved`, in `src/types.ts`), filled from the run's kind by `isConversationalKind` and `isUnattendedKind`; the loop reads them from the context when it has one, so the envelope and the broker cannot disagree (2026-11-21). `projectId` stays on `RunContext` only, since the envelope carries the whole project. Suite: `test/harness.test.mjs`. The original design follows.

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

**Built:** `harnessContract` renders the application description from the visible tools and the mode only; the broker, QUEUED and untrusted-text rules moved out of `Rules:` into it, so they have one owner. `appDocs`, `chatDocs` and `jobDocs` no longer restate the lifecycle: the application description, what QUEUED means for a schedule and the verbatim hand-off to a later run moved into the contract, and the unattended and chat advice lost its "your final reply is the whole answer" / "your summary is the record" openers. What remains in them is finishing advice only (when to schedule, draft versus notify, answering the current message), and a test counts that each lifecycle claim appears once per prompt and that removing a tool removes its claims (2026-11-21). The contract is byte-identical across runs (tested). The original design follows.

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

**Built:** `summarizeCapabilities` in `src/harness.ts` writes the Can and Cannot lines of the envelope from the visible tools and the project-narrowed policy, family by family (web, browser including a project that allows no domain, files, Gmail and Calendar, drafts, schedules, helpers, build commands, dry run), and always lists sending mail, permanent deletion and, for a private run, the cloud. Each family tool now defines `available(policy)`, the switch-and-allowlist half of its own gate (`checkPolicy` calls it first), and the summary asks the tool instead of re-reading policy fields; the field reading stays only as a fallback and a test requires the two to agree. That closed a real drift: an absent `schedules.enabled` read as on in the summary while `schedule_create` refused (2026-11-21). A condition that depends on arguments (a path, a URL) cannot be described without a call, so it stays out of the summary. Tests are in `test/harness.test.mjs`. The original design follows.

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

**Built:** `describeResult` in `src/harness.ts` gives every model-facing tool result one extra line, `[result {tool, status, effect, retryable, nextStep, confirmationId?}]`, beside the unchanged prose, so cards on web, Mac and iPhone are untouched. `effect` is `none` for denied, queued and dry-run, `unknown` for an error, `applied` only after a successful write and `observed` for a successful read (a named set, `READ_ONLY_TOOLS`, with a test that every name is a real tool). The broker now returns the confirmation id of a queued call. `executing` (an approval claimed but not finished) is described as `queued`, effect `none`, until it resolves (2026-11-21); it never reaches a run today, so this is a guard, not a live path. Tests in `test/harness.test.mjs`. The original design follows.

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

### S7. Epistemic awareness joins the knowledge system (answer rules built 2026-11-21; brief wording built 2026-11-22)

**Built:** `src/knowledge/answer.ts` decides, in code, whether the store supports an answer (`supported`, `conflicting` or `insufficient`) by matching the question against reviewed claims that are still in force, and renders each claim with its id, evidence level, source, timestamp in the recording and exact words. Disagreeing reviewed claims come back as a CONFLICT to be reported with both sides; where nothing reviewed matches, the text says INSUFFICIENT EVIDENCE and not to fill the gap; unreviewed matches appear only as leads. The read-only tool `knowledge_claims` (declares `privateOutput`, so the run stays local) returns it, `asOf` answers as of a date, and `harnessContract` adds the answer rule only when the tool is visible. The match is plain shared words on purpose, since a wrong "supported" invents a fact and a wrong "insufficient" sends the person to look. Suite: `test/knowledge-answer.test.mjs`. Briefs now say the same five things on every client, because all three render the server's Markdown: each line reads "known from reviewed evidence", "machine-extracted, not reviewed", "inferred from cited sources" or "conflicting evidence" (or says it was replaced or retracted), and an empty section says "Insufficient evidence" (`EVIDENCE_WORDS` in `src/knowledge/store.ts`). Not built: nothing yet calls the tool unprompted (the model must choose to), and no live-model check that it does.


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

### S8. Behavioural harness-awareness tests (built 2026-11-21)

**Built:** `test/harness-behaviour.test.mjs` runs the real loop, broker and tools against a scripted model under two explicit policies (ask about everything, and trust drafts and schedules in chat) and asserts what the model was told and what then happened: a send request, a reminder, a scheduled run creating standing work, where a file is saved, local or cloud, what approval does, a private meeting pinning the run, a restricted helper, and each result status. It found and fixed four divergences between prompt and broker: the summary said mail is never sent although `mac_control` can send through Mail after approval, drafts and schedules were described as always queued although `policy.trust.chatAutoTools` runs them at once in a live chat and pre-approved runs do not ask about drafts, the scheduler and draft paragraphs in `src/agent.ts` repeated those claims, and the refusal for an unavailable tool had no result line. Not done: scenarios for a live model; these use a scripted one by design.

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

Build order: F1 to F7, S1 and S2 are done; S3 to S6 and S8 are built; S7's data model is in K4, and its answer contract waits for K6; S6; S8. S7 lands with K4 and K6. S1 and S2 are the useful
minimum: they make every later feature easier to explain without accumulating prompt folklore.

Open decisions for you:

- Whether to recognize a workspace `AGENTSPINE.md` in addition to existing project instructions. Proposed:
  yes, but only through an explicit trusted-source setting on the project.
- Whether full filesystem paths should appear in `harness_status`. Proposed: show only the active workspace and
  effective write directory; never enumerate other allowlisted roots.
- Whether disabled capabilities should be comprehensive or task-relevant. Proposed: always show the small set of
  consequential absences (send, permanent delete, cloud for private work), and render the rest only when asked.

---

## 10. Claude Desktop parity on local models, self-change and self-learning (added 2026-11-22)

**The goal, in your words:** a system that works like Claude Desktop, with more than it offers, served by local
MLX models; that you can question about its own code and that proposes and makes changes to it; and that
reflects on its work with you and proposes changes and routines you had not thought of.

**What the survey of 2026-11-22 found.** The privacy rule is not what holds this back. With local models as
the target, "private never reaches the cloud" costs almost nothing. What costs is the shape of the loop around
a 28 tok/s model, the "Not doing" list, and learners that are built but have never been switched on. Nothing in
this section loosens the broker, the confirmation queue, `tagUntrusted` or LEARNING invariants 1 to 5: those are
security, not privacy, and every item below adds injection surface.

Labels are local to this section: LP (loop), CP (capabilities), SC (self-change), SL (self-learning). Only LP1
is built. Every measurement named below needs the model host, so every item is **Both** unless marked.

### LP. The agent loop

- **LP1 Stream the answer.** `src/llm.ts` and `src/router.ts` do not stream. At 28 tok/s a 500-token reply is
  about 18 seconds of nothing on screen. The final answer is inside `{"action":"final","summary":...}`, so it
  cannot stream as it stands. Proposed: a reply that does not open with `{` is the answer, in plain prose, and
  is streamed; a tool call stays one JSON object. This also removes the cut-off-final failure (the answer that
  loses its closing brace at the token cap, `AGENT_STEP_MAX_TOKENS` comment in `src/config.ts`). Web, Mac and
  iPhone together. Measure the parse-failure rate before and after on the same prompts.
  **Baseline (2026-11-23, `bench/lp1-baseline.mjs`, Qwen3.6-35B, 14 synthetic requests x 3, one step each, no
  re-ask):** all 9 tool requests returned a tool call. Of the 33 samples meant to finish, 6 returned valid final
  JSON, 21 did not parse and 6 called a tool instead. No reply was truncated or empty, and none errored. The two
  failing replies inspected were correct plain prose with no JSON wrapper, which is the shape LP1 proposes. The
  bench uses the real system prompt (median 11,305 prompt tokens) but not the live envelope, context or history,
  so this is a before-and-after reference and not the production failure rate. Streamed replies from
  `mlx_lm.server` do report usage with `stream_options.include_usage`.
  **Prose format and streaming built for chat turns (2026-11-23).** `readReply` in `src/agent.ts` takes plain
  prose as the answer, keeps real tool calls, and re-asks on a broken JSON attempt or a short promise of work.
  Unattended runs and subagents keep strict JSON. Same bench after: tool requests 9 of 9, finishing samples 27 of
  33 (was 6), unparsed 0 (was 21). The other 6 are both 500-word writing requests choosing a tool, including an
  unrequested `write_file`; the format does not fix that. A chat step streams through `onDelta` in `src/llm.ts`;
  `src/answer-stream.ts` holds back anything that could still be a tool call and sends whole-text `answer`
  snapshots, so a reconnect cannot duplicate text and a retry or tool call can clear it. Checked: the real loop on
  the model host with no tools (a 9.2s answer showed text at 3.3s, no tool JSON shown), and a scripted stream on web
  and the iPhone simulator (preview, retraction, growing answer).
  **Text-form tool calls and looping replies rejected (2026-11-24).** A live chat turn (13,924 prompt tokens,
  Qwen3.6-35B) wrote its tool calls as bare text (`web_search` / `query=...`), repeated one to the 4,096-token
  cap, and the prose rule above showed all 13,286 characters as the answer after 3m56s with no tool run.
  `readReply` now treats a tool name on its own line followed by `key=value` as a failed attempt, and
  `src/reply-loop.ts` stops a streamed reply once one block of lines has repeated six times. Both get a re-ask
  that shows the JSON tool form, not the "keep it shorter" one. Checked on the model host: a 5-token request
  right after hanging up on a 3,000-token stream took 2.2s against a 2.2s baseline, so the hang-up frees the
  server; and with the real chat system prompt, the text-form reply and the re-ask, 4 of 4 samples returned a
  JSON tool call in 4-7s. Not reproduced: the same prompt without the live envelope gave a correct tool call 3 of
  3 times, so what tipped the live turn into text form is unknown. Not re-run end to end on the dashboard.
  **Live on the deployed dashboard (2026-11-23, `7ccac76`, web, local model).** A 500-word answer with 13,887
  prompt tokens showed its first text 56s after sending and then grew steadily; a second one showed text at 37s and
  finished at 65s. No tool JSON appeared. A weather request ran its tool, showed the card and answered. Stop ended
  the run within 0.2s and removed the partial text, and after a reload only "Stopped before it finished." remained.
  Scrolling up held the position while text grew.
  **Two bugs from that test, fixed in `f46dfb9` and rechecked live on web (2026-11-23):** (1) when an answer
  finished, the live text was removed a moment before the saved message rendered (scroll height 2,301 to 1,232 and
  back to 2,333), and the view then scrolled to the bottom even if the reader had scrolled up. All three clients now
  keep the live turn until the saved one has loaded and follow only a reader at the end. (2) A stopped call adds
  model time but no output tokens, so effective speed fell from 8.1 to 6.1 tok/s with output unchanged at 1,368.
  Speed is now taken over `reportedMs`, the time on calls that reported tokens. Recheck: a reader scrolled up stayed
  at 2,474px through the end of a reply, the scroll height never dropped, and the same thread read 8.1 tok/s again.
  iPhone: checked by you against the live dashboard (2026-11-24). That test found the long-press menu on your own
  message (Edit and resend, Retry, Copy) never opened, because text selection claimed the press. The phone bubble
  now has no text selection, its Copy covers the message, and the menu was confirmed on the device. A finished
  reply has a long-press menu too (Copy, Select text in a sheet, Read aloud, Star, Save to file, Context used),
  also confirmed on the device; a streaming reply has none. Not checked:
  the Mac app against the live dashboard, including both fixes (it builds; the simulator has no working connection
  and the real token is not available to Claude).
  First-token time is not stored, so the Tokens card still shows effective speed.
- **LP2 "Local deep": thinking on for hard steps.** `NO_THINKING` is sent on every local call (`src/llm.ts`).
  A run that has read mail, a calendar, a file or a project is pinned local, and `resolveTier` turns `deep`
  into `standard` for it, so a task sized `deep` gets the same effort as an easy one. Proposed: on a pinned run
  sized `deep`, the plan step and a re-ask after a failed step run on the same endpoint with thinking on and a
  larger token cap. Code decides when; no model switch, so no reload cost. Measure the added seconds per step
  and whether the builder and multi-part chat tasks finish more often.
- **LP3 Budgets by tokens, with compaction at a threshold (built 2026-11-25; numbers not yet set on the model
  host).** The step count is now a ceiling (`MAX_STEPS` 10, a subagent 6, a unit's own `maxSteps`, all unchanged),
  and each loop also has a token budget and a wall-clock budget scaled from it: `RUN_TOKENS_PER_STEP` (22,000) and
  `RUN_MS_PER_STEP` (72 s) in `src/config.ts`, both settable in `.env`. Tokens are the host's own counts when it
  reported every call, else a characters-over-four estimate. Time paused for a person (LP5) does not count. Over
  budget, the run is closed out with what it gathered, as at the step cap; at 80% of either, the model is told once
  to finish (appended to the message it is about to read, so the prefix holds). With coarse steps the warning can
  be skipped, when one step jumps from under 80% to over the budget. Compaction (`src/compact.ts`): once the loop's
  own messages pass `COMPACT_AT_TOKENS` (30,000 estimated), older tool results become stubs down to 60% of that,
  keeping the newest two whole and never touching the prefix before the run's goal; each full result is held under
  a ref `read_more` opens, and a run without `read_more` is never compacted. Events: `budget`, `compacted`. These
  and LP5's pause are also kept with the run (`run_notes`, pruned with it, `GET /api/runs/:id` `notes`), because the
  live stream keeps a finished run's events for five minutes and a background job is looked at later. Web
  (2026-11-25): the Activity page's run view has an "Along the way" section in words (`web/src/lib/runNotes.ts`,
  suite `test/run-notes.test.mjs`), checked in a browser at desktop and phone width; a live chat turn shows the same
  lines as they happen, which was typechecked but not seen running. iPhone and Mac do not show them yet. Suite:
  `test/run-budget.test.mjs`, whose compaction rows fail with compaction switched off. Not done: setting the three
  numbers from a week of real runs, and raising `MAX_STEPS` so the token budget, not the count, is what binds;
  chat history (8 turns in 6,000 characters) is unchanged.
- **LP4 More than one tool call per step (measure first).** The protocol is one JSON action per turn and every
  step pays prefill. Bench native tool calling on the standard model through `mlx_lm.server` against the current
  protocol: parse failures, steps per task, seconds per task. Switch only if it wins. Not checked: how well
  `mlx_lm.server` handles native tool calls.
- **LP5 Chat goes ahead of scheduled work (built 2026-11-25; not yet seen on the model host).** `src/queue.ts` has two
  lanes: `person` (a chat turn, an approval being carried out, a command-line run) and `background` (a schedule, a
  watcher, the heartbeat). A person's work starts before any background work still waiting, and a background run
  already going hands the model over at its next step boundary, where the loop checks for a stop (`yieldToPerson`
  in `src/agent.ts`), then resumes ahead of other background work. It is paused, not stopped; a stop asked for while
  paused lands when it resumes. A model call in flight is not interrupted, so a chat can still wait for one step's
  call, which keeps each run's prompt prefix whole. The lane rides on AsyncLocalStorage, so a subagent pauses with
  its parent. A paused run publishes `paused_for_person` with how long it waited, and keeps it as a run note (see LP3).
  Suite: `test/queue-lanes.test.mjs`, whose real-run row fails with the yield removed. Not checked: how long a chat
  waits in practice on the Mini (one step of a job, which is one model call; measure it with a watcher running).
- **LP6 Load tool descriptions on demand (built 2026-11-25, off by default until measured).** Measured: tool
  descriptions were about 40,000 characters (about 10,000 tokens) of a chat run's 11,500-token system prompt, 85
  tools. `src/tool-docs.ts`: with `TOOL_DOCS_MODE=core`, sixteen core tools (memory, web, `read_more`, knowledge,
  tasks, Gmail and Calendar reads, file reads, weather, `tool_help`) keep their full description and the rest are one
  line each (name and first sentence), about 11,500 characters in all. The new read-only `tool_help` returns full
  instructions for tools this run can use, appended to the history so the cached prefix holds. A run with 20 tools
  or fewer (a unit) still sees all of them in full. A failed call to a tool whose instructions were never read is
  told to read them. In the default mode nothing changes and `tool_help` is not offered. Suite:
  `test/tool-docs.test.mjs`. Not done: the bench on the model host (does the model read before it guesses, and what
  does the first request of a run save), then switching the default.

### CP. Capabilities (each waits on a decision below)

- **CP1 MCP over stdio, and a privacy flag per server (built 2026-11-25; no real server run yet).**
  `src/mcp/stdio.ts`: a server entry gives `url` (remote) or `command` (a local program, an argument list spawned
  without a shell). The child gets a minimal environment (PATH, HOME, locale, plus the entry's `env` values and the
  `envFrom` names), not this process's keys and tokens. It starts on first use, is restarted once if it died, and is
  stopped on re-discovery and at exit; a request from the server (sampling, roots) is refused and a ping answered.
  `privateOutput` per server: on by default for a local server, off for a remote one, so a local server's tools pin
  the run local like a file read. Gating is unchanged (deny by default, the `tools` list, `readOnlyHint` or the
  queue, `confirmWhenUnattended`, the outgoing-text check on arguments). Suite: `test/mcp-stdio.test.mjs` with a
  fake server in `test/fixtures/mcp/`. Not done: a real server (the filesystem or git server) on the Mini, and LP6,
  which keeps every exposed tool's description out of the prompt prefix until asked for; until then set `tools`.
- **CP2 Google: real drafts, timed events, user-directed send (drafts and timed events built 2026-11-25; send and
  RSVPs wait for N2).** Recorded as SPEC section 5's third amendment. The `draft` tool, on approval, saves an email
  draft in Gmail Drafts (`policy.drafts.gmail`), threaded by `replyTo`, or puts an event with an exact start on the
  calendar named by `policy.drafts.calendar` (one of `google.write.calendars`), with no attendees and no
  notifications; `src/google/write.ts` gains `createDraft` and `createTimedEvent` and still has no send. Work text
  stays a file: a project run, a conversation with a private recall (`runs.work_private`, set by the runner) or a
  private non-Google tool call. The same check runs on approval, from the run that queued the card
  (`ToolContext.queuedByRunId`). Scheduled runs ask; a chat skips the card only with `draft` in
  `policy.trust.chatAutoTools`, which you chose. Suite: `test/draft-google.test.mjs` (Google stubbed). Not done:
  a real draft and event against your account, and send and RSVPs, which wait for N2's live baseline.
- **CP3 A scratch interpreter.** `run_command` runs only declared commands, so there is nothing like Claude's
  analysis tool for arithmetic over a file. A `sandbox-exec` scratch directory with no network and a time
  limit. This is not the Docker workspace container that "Not doing" rules out, but it is close enough to need
  your yes.

### SC. Self-change: ask it about its own code, and have it propose and make changes

**What exists.** `policy.build.repos` already declares this repo with `gitWrite` and four commands (`test`,
`typecheck`, `lint`, `webbuild`). The `builder` unit (`agents/builder.md`) has 40 steps, branches before it
edits, and ends on the Builds page. No tool can write `policy.json`, `profile.md`, `goals.md` or `agents/*.md`.

- **SC1 The builder runs on the local model with thinking off, whatever its file says.** `agents/builder.md`
  asks for `tier: deep`, but `read_file` and `list_dir` declare `privateOutput` for every path, so the first
  read pins the run local and `deep` becomes `standard`. LP2 and LP3 are therefore the first work for
  self-change, not an extra. Then measure: give the builder three real changes from this file and record how
  many end with a passing suite. Do not exempt source folders from the pin until that number is known.
- **SC2 Code search (built 2026-11-22).** `search_files` is read-only plain Node with the same allowlist and
  `privateOutput` as `read_file`. The query is literal, because a model-written regex could stall the server's
  event loop. It skips symlinks, dot-folders and credential files, and says when a capped search is incomplete.
- **SC3 A map of its own code in trusted context.** Claude works in this repo from the area table in
  `CLAUDE.md`. AgentSpine has no equivalent: S6's `AGENTSPINE.md` cannot be used here, because `policy.json`
  makes `~/Developer` writable and the file must sit outside every writable folder. Either narrow
  `fs.writableDirs` (You) or have the server supply a fixed, read-only area map for runs in this repo (Code).
- **SC4 A real check command (You, then Code).** The declared commands do not include `npm run check`, and
  nothing builds Swift. Add `check` to this repo's entry in `policy.json` (yours to edit). Until an
  `xcodebuild` command is declared, a self-made UI change covers web only, which breaks the three-clients
  rule, so UI changes stay out of scope for self-change.
- **SC5 Propose, then patch (built 2026-11-25; not yet run on the model host).** `propose_change`
  (`src/tools/propose-change.ts`) queues a card: what, why, the files (repo-relative, at most 20), the test plan
  (default: `npm run check` passes with a test that fails without the change), and the runs that prompted it. It
  always shows the card (`alwaysConfirm`). Approving starts the builder unit as its own run of kind `build`, through
  a new `unit` option on the runner (the unit's instructions lead the trusted context, its tools are the ceiling,
  its `maxSteps` and tier apply). The repo is an AgentSpine checkout declared in `policy.build.repos` with
  `gitWrite`, a separate clone before the served one; the card warns when the served checkout is the only choice
  (SC7). The builder's task says to branch first, follow the test plan, commit and not push; pushes still queue,
  and gate files still show their own card (SC6). Accepting a `code_change` card in the weekly review (SL2) queues
  a proposal from that card's title, reason and runs. Suite: `test/propose-change.test.mjs`. Not done: a run of it
  end to end on the Mini (it needs this repo declared with `gitWrite` and, per SC4, a `check` command), and SC7's
  separate clone, which is yours to make and declare.
- **SC6 Guard the gates in code, not only in policy (built 2026-11-25).** A builder that cannot write `policy.json`
  could still edit the code that reads it. `src/protected-paths.ts` lists eleven files (the five named here, the
  Google and Instagram write modules, and `src/outgoing.ts`, `src/tools/browser.ts` and the list itself). An edit,
  whole-file write, append or move touching one is irreversible, so it queues in a chat and from a schedule, and the
  card carries the change (`diffPreview`, cut at 40 lines with a note to read the rest). A protected path is matched
  in any checkout whose package.json is named `agentspine`, so a separate builder clone (SC7) is covered, ignoring
  case (the Mac's disk does) and following symlinks. `test/architecture.test.mjs` pins the list and is on it.
  Suite: `test/protected-paths.test.mjs`. Decided 2026-11-25: a protected edit always shows its card. Its
  classification carries `alwaysConfirm`, and the broker then ignores `autoApprove`, `userDirected`,
  `trust.chatAutoTools`, a schedule's pre-approval and `irreversibleAlwaysConfirm` being off.
- **SC7 Which checkout it works in (You).** Not checked: whether the builder on the Mini would branch inside
  the checkout the LaunchAgent serves from. If so, give it a separate clone, so a half-made branch is never
  what the next restart loads.

### SL. Self-learning: reflect on the work and propose what you had not asked for

**What exists.** LEARNING phases 0 to 5 are built: reflection facts, friction notes, the denial learner,
recipes, sampled self-critique (`LESSON_SAMPLE_RATE` 0.1), schedule and auto-approval proposers, and the
task-text rewriter. Most of "self-learning" is switching these on, which sections 1 and 4 already list.

- **SL1 Switch on what is built (You).** In order: N2 live half, ROLLOUT step 3, then step 5. This settles the
  open decision in 4a: yes to a weekly trigger for `runProposer`, and for `runRewriter` once step 5 is done.
  Run consolidation 6.0 on the Mini as 4a says.
- **SL2 A weekly retrospective (built 2026-11-22, off until `RETRO_ENABLED=true`).** `src/learn/retro.ts`: one
  local pass, pinned `private`. Code finds the candidates and fixes each card's kind, runs and action; the model
  only picks from the list and words at most 5. Cards appear in the weekly review on web, Mac and iPhone, with one
  push that counts against the daily cap. Accepting a routine queues a disabled job for approval. Every other kind
  records your answer only, and a code-change card starts nothing until SC5 exists. You: run N2's live eval, add
  this surface to it, then switch it on. Not yet run against the real model or a real week. The step cap is
  inferred from a run's tool-call count, because it leaves no marker on the run.
- **SL3 Signals of a bad answer (built 2026-11-22).** `src/learn/signals.ts` counts stops, immediate re-asks,
  edited drafts and rejected proposals, by run id and without task text. `npm run signals` prints them. Nothing
  consumes them until SL2, and none writes a memory. The re-ask window and overlap are guesses to check on real weeks.
- **SL4 Proposals that learn from their own outcomes (built 2026-11-22).** `src/learn/outcomes.ts` and the
  `proposal_log` table cover job, standing-intent and rewrite proposals. A proposal you rejected is not made again.
  A kind with at least 5 answers in 90 days and 80% rejected waits 30 days between proposals. Expiries and policy
  refusals do not count as your no. Auto-approval, style and date proposals are not covered. It takes effect only
  when the proposers run, and they still have no trigger (SL1).
- **SL4a Lessons wait for review (built 2026-11-22).** A sampled self-critique used to reach later runs with no
  person reading it, against LEARNING invariant 2. `src/learn/lessons.ts` holds each one until you keep it in the
  weekly review on web, Mac and iPhone, and moves lessons already stored into that queue on the first start. Not yet
  seen on a running app or against the Mini's real data.
- **SL4b Recipes wait for review, and learned memory stays local (built 2026-11-22).** An audit found a clean run could
  write a recipe later runs received as their own notes, unread. It also measured a fact and a recipe from a private
  project run reaching the cloud through a later ordinary run's recall. Learned recipes now share the lesson queue, with
  their own ceiling of 50. A memory carries `cloud_safe` only when code saw its run stay off private material, and any
  run that recalls one without it is pinned local, along with its thread. Older rows count as private, so most runs
  that recall memory will stay local until newer memories replace them. Not yet seen on a running app or against the
  Mini's real data, and whether anything private already reached the cloud has not been checked.
- **SL5 Know whether it is working (You).** Use the checks in LEARNING, "How to tell it is working, and what to
  delete", after four weeks of SL1. Delete a learner whose output you never accept.
- **SL6 A small private answer key (runner built 2026-11-22; You write the tasks).** `npm run eval:answer-key --
  /path/to/key.json` (`src/eval/answer-key.ts`, format in its header) scores about 20 real tasks with checks in code:
  phrases that must or must not appear, tools that must or must not be called, and a step limit. No model grades
  anything. The key must sit outside the repo at `chmod 600`, and reports carry ids and check names, never task text.
  A scored run uses a throwaway database, a forced dry run and no cloud key, so it cannot reach your ledger or a
  learner, execute a tool, or leave the machine. Because no tool executes, a task that needs source material carries
  it in the row's `context`. `--suggest` lists runs with an SL3 signal and `--draft <runId>` copies one in unapproved;
  it counts only after you add checks and set `approved`. You: write the tasks on the Mini and record a first baseline.
  Tested against stand-in models only, and not yet run on the real model. One pass per task, so a single flipped
  result on a local model may be noise; SL7 must account for that before comparing two versions.
- **SL7 Test a candidate before asking (Code, not started; needs SL6).** Replay the current and proposed versions on
  recent inputs and show the score beside the diff, one change per candidate. Start with watcher rewrites
  (`src/learn/rewrite.ts`). Replays run pinned local and must be unable to send, write or publish. A better score
  informs your decision and never approves a change. It has nothing to test until `runRewriter` has its trigger (SL1).
- **SL8 Version history and after-checks (built 2026-11-22).** `store.updateSchedule` saves the old and new task text
  in one transaction, so no route can change a job without a record (`schedule_versions`, newest 20 per job).
  `src/learn/versions.ts` compares tool calls per run and failed runs for 21 days on each side of a change, with at
  least 5 runs per side, no model, and no verdict once a second change or audit pruning has spoiled the comparison.
  Finished checks appear in the weekly review on web, Mac and iPhone, and every job's History shows its changes. Going
  back only queues a `schedule_update` showing the diff, and that approval is refused if the job changed after it was
  offered. The rewriter leaves text you went back to alone. All the thresholds are guesses to check on real weeks.
  History starts with the first change after this ships, so a job has no earlier versions until then.

### Sequence and decisions

Order: SL1 (nearest to done, and N2 gates the rest); LP1, LP2 and LP5; SC2, SC4, SC5 and SC6, then SC1's
three-change measurement; SL2 feeding SC5; LP3, LP4 and LP6; the CP items as each decision is made. Within SL, the
answer key (SL6) comes first because candidate testing (SL7) depends on it. SL8 can follow in either order.

Decided 2026-11-25:

- Placement: section 10 is the main code direction now, because section 8's code is done and waits on K1. Order,
  by what can be finished and tested off the model host: SC6, then LP5, then LP3; then LP2, LP4 and LP6 (which need
  the model host to prove), and SC5 once SC6 exists. SL1 stays yours, as before.
- CP1: yes, local stdio MCP servers only, with a per-server `privateOutput`.
- CP2: yes to Gmail drafts and timed events; send only after N2's live half has a baseline.
- CP3: yes, no network, enabled per project by you.
- SC6's list: the eight proposed files plus `src/outgoing.ts` and `src/tools/browser.ts` (and the list's own file).
- Source folders stay inside the local pin until SC1's measurement says the local builder is not good enough.

- An edit to a protected file always shows its card, whatever trust or auto-approval is set (built, SC6).

---

## 11. A version other people can install (added 2026-11-24)

Goal: anyone can clone AgentSpine and run their own copy, with none of your data or preferences in
it. Single user per install; logins and multi-user are a separate, later decision (if it comes, one
SQLite file per user rather than a `user_id` on every table).

**Built 2026-11-24:**
- `policy.json` and `goals.md` are no longer tracked; `policy.example.json` (deny-by-default: no
  folders, repos, MCP servers, microphones, browser or Google until you turn them on) and
  `goals.example.md` are the committed starting copies. `npm run setup` (`scripts/setup.mjs`) copies
  every `*.example` file into place, creates `.env` from `.env.example` and adds a `DASHBOARD_TOKEN`,
  and never overwrites an existing file. `loadPolicy` says to run it when `policy.json` is missing.
- The inbox-cleanup watcher's personal rules (named senders, the advisor, the employer) moved to
  `inbox-rules.md` (gitignored, `inbox-rules.example.md` committed), pasted into the task at
  `npm run watcher add inbox-cleanup`. An installed schedule keeps the text it was installed with.
- `update.sh` runs from wherever its clone is, and keeps and restores `policy.json` and `goals.md`
  across the pull that stops tracking them.
- The MFLUX and TTS LaunchAgent plists are templates (`__REPO__`, `__HOME__`), like the dashboard's.
- Code comments, prompt examples, the bench and the tests use invented names (Alex, Sam Rivera, Acme,
  @exampleshow) in place of real people, accounts and employers.

**Still to do:**
- **Publish from a fresh repo, not this one.** The history still holds the old `policy.json`,
  `goals.md`, the inbox rules and everything below, and the `backup-before-secret-scrub` branch may
  hold secrets. A new repo with one starting commit of the cleaned tree is the safe route.
- **Docs prose (done 2026-11-24).** README, SPEC, INSTAGRAM, MODELS, LEARNING, WATCHERS, STUDY,
  ROLLOUT-heads-up and CLAUDE.md use invented names (Alex, Jordan, @exampleshow, Springfield) and the
  example LAN address `192.168.1.50`. Not rewritten, on purpose: this file and `docs/archive/` are your
  working history, so leave both out of the public repo. CLAUDE.md keeps its Machines section, marked
  as the author's setup, because Claude needs it when working on these machines.
- **Model host default (done 2026-11-24).** `LOCAL_BASE_URL` defaults to `http://127.0.0.1:8080/v1`;
  the Mini's `.env` sets `LOCAL_LLM_URL` (checked by you that day).
- **iPhone and Mac apps.** Bundle IDs (`com.houserphotography.*`) are in `ios/Supporting/Local.xcconfig`,
  the Mac target in `project.pbxproj` and the Mac entitlements. Move them all into a gitignored
  `Local.xcconfig` with a committed example, and make APNs use the configured topic, not one global one.
- Committed `services/*/__pycache__/*.pyc` files: deleted and gitignored (2026-11-25).

---

## 12. What Claude Duet does that AgentSpine does not (added 2026-11-24)

Source: Anthropic's announcement of Claude Duet (`claude.com/resources/articles/claude-duet`, dated
2026-10-21, read 2026-11-24). Duet is a research-preview consumer app: a proactive assistant that checks your
connected accounts every few hours, sends a morning brief, works in a cloud VM with its own browser while your
devices are off, and shows you every send, payment, signature and delete before it happens. The page names no
API, SDK or setting, so there is nothing to integrate. This section is the list of its behaviours that
AgentSpine lacks and that fit this project's rules.

**Already here, so not work:** the approval gate (the broker's two gates, approvals in chat and on the phone);
working while you are away (the scheduler and watchers on the Mini, headless Chrome); telling you when
something is done or waiting (APNs, ntfy, the confirm watchdog); a morning brief (the "Morning brief" schedule,
and Heads-up); voice and typing in one thread; memory and recipes. A browser you can watch is
`BROWSER_MODE=cdp`, which Duet says it cannot do yet.

**Duet does it, and this plan already says no or not yet. Nothing here reopens these:**
- Sending mail after approval is section 10 CP2 (user-directed send, after N2's live half). Unattended
  auto-send stays in "Not doing".
- Buying things (Link, Shop Pay) is section 3 H5 and H6: irreversible tier, queued, only if asked,
  deprioritized.
- Signing in to sites with stored logins (1Password) is section 7, "Credential vault and logged-in browsing":
  parked.
- A classifier model that approves actions is "Model-judged safety checks" in "Not doing". D2 and D3 below
  are plain code for that reason.

What I checked in the code on 2026-11-24, and what I did not: the broker has two reversibility values and no
refusal tier (`src/broker.ts`, gate 2); the MCP client is HTTP with a static bearer token and no OAuth flow
(`src/mcp/client.ts`); the browser's risky-click pattern is one regex that treats `transfer` and `withdraw`
the same as `submit` (`src/tools/browser.ts`). Traced the same day: a scheduled run, which skips gate 2 as
pre-approved, made those clicks without queueing. That was F8 in section 0. Fixing it turned up F9, the same
path for mail and messages. Both are fixed, and D2 has what they leave open.

### D1. The check-in (built 2026-11-24 with its screens, off by default; the rollout is yours)

What makes Duet feel proactive is one job that looks across everything and says what needs you. Here the
pieces existed separately: watchers, Heads-up, the inbox cleanup, task reminders, the confirm watchdog. Nothing
joined them. New proactive behaviour was deprioritized on 2026-11-21; **you lifted that hold for D1 on
2026-11-24** ("Lift the hold and build"). The hold stands for everything else in section 3's list.

**Built (`src/checkin/`, suite `test/checkin.test.mjs`).** It differs from what this item first proposed in
one way that matters: **there is no model in it.** The proposal had a local model rank the items. Reading
`src/headsup/morning.ts` changed that: Heads-up is deliberately not a schedule row, because a schedule means a
model call every time whether or not there is anything to say, and private text through a prompt for no
reason. The same holds here, more so, since the text would be unread mail. So:
- **Code collects (`sources.ts`).** One reader per source, each returning items with a stable key: unread
  inbox mail (headers only), calendar for the next 4 hours, tasks overdue or due within a day, approvals
  waiting, open Heads-up offers. One source failing does not lose the others.
- **Only mail from a person can start a push.** Everything else already has its own voice: an approval pushes
  when it queues and again from the watchdog, a task nudges when due, Heads-up has its morning push. Those
  ride along as one "Also:" line under a push that mail started, and never start one. Watcher results are
  left out for the same reason: a watcher pushes for itself.
- **"From a person" is Gmail's judgment, not ours.** Unread, in the inbox, not sent by you, no
  List-Unsubscribe header, and none of Gmail's bulk labels (promotions, social, updates, forums, spam, trash).
  Gmail has read the body to decide that, so the check-in gets a judgment about mail with nothing a sender
  wrote ever reaching a prompt. There is no injection surface to add to N2.
- **Once only (`store.ts`, `checkin_seen`).** An item is new the first time its key appears and again only if
  its state changes (a task's due time). `checkin_runs` logs what each check found and said.
- **The numbers (`rules.ts`):** every 4 hours, 60 minutes' back-off after a failed mail read, 25 messages a
  check, four senders named in a push. It keeps quiet hours and the daily cap of six itself (`checkin` is in
  `COUNTED_SOURCES` and `REVIEWED_SOURCES`, not `GOVERNED_SOURCES`), because mail held back by either must
  stay new for the next check, which the outbox cannot arrange. Nothing new means no push.
- **What leaves the machine.** A push goes through APNs and ntfy, so by default it names senders and counts
  and nothing else: no subject, no event or task title. `CHECKIN_PUSH_DETAIL=subjects` adds them.
- **The switch, `CHECKIN_MODE`:** `off` (the default; the timer does nothing), `log` (runs and records what it
  would have sent, sends nothing), `push`. Anything else reads as off.
- **Reading it:** `npm run checkin` (preview: reads only, works with the mode off), `npm run checkin run`
  (Check now), `npm run checkin log`. The same three are `GET /api/checkin/preview`, `POST /api/checkin/run`
  and `GET /api/checkin`.

**Not verified.** Everything above ran against seams: no real Gmail read, no real push, and the dashboard was
not started with it. Whether Gmail returns the `CATEGORY_` labels on your account in a metadata read is the
first thing the preview will show.

**The rollout (You, on the Mini), one rung at a time:**
1. Preview. `npm run checkin` a few times a day for a few days. Is "Mail" the mail you would want to hear
   about? If newsletters appear, or real people are missing, the rule in `isPersonMail` is wrong: change it in
   code with the example in the commit, do not tune around it.
2. Log. Add `CHECKIN_MODE=log` to `.env` on the Mini and restart. After a week, `npm run checkin log 50`: how
   many checks had something to say, and would you have wanted each of them?
3. Push. `CHECKIN_MODE=push`. The weekly review then counts opened against dismissed for "Check-in".

**Still to do:**
- **The screens (built 2026-11-24 on web, iPhone and Mac).** A Check-in item in the web sidebar, the Mac
  sidebar and the iPhone's tabs (under More on a fresh install, so the bar is unchanged): the preview as a
  list grouped by kind, the notification a check now would send or the reason it would not, Check now, and
  the past checks. A push opens it (`/checkin` on the web, `screen: "checkin"` on the phone). Every sentence
  is a pure function, `web/src/lib/checkin.ts` and `CheckinWords` in `Models.swift`, and
  `test/checkin-screen.test.mjs` runs one set of cases through both and has the Swift decode real payloads.
  The iPhone's `CheckinView.swift` and the Mac's `MacCheckin.swift` are separate files because a new file is
  in one target until its Target Membership is ticked; ticking `CheckinView.swift` for the Mac target and
  deleting `MacCheckin.swift` would make it one. Checked: both targets build with `xcodebuild`
  (unsigned, outside the sandbox), and the web screen was looked at in a browser against a throwaway server
  with tasks, an approval and a log, including Check now. **Not seen:** the iPhone and Mac screens rendered,
  the Mail section with real mail on any client, and a tap on a real push.
- **Not built: Settings for each source on or off.** It needs stored preferences on the server first.
- `.env.example` has no entry for `CHECKIN_MODE` or `CHECKIN_PUSH_DETAIL`: the sandbox Claude ran in could not
  read or write that file. Add both, commented out, by hand.
- The interval and the mode are code and env today. Whether they should be settings waits on the log.
- A model's sense of urgency ("this one is from your landlord and has a deadline") is what this version
  gives up. If the log shows Gmail's sorting is too coarse, the next step is a local model ordering the new
  mail only, behind the same seams, with N2 fixtures first. Not before the log says it is needed.

Decided with it, as proposed: the Morning brief stays its own schedule, and Heads-up keeps its morning push.

### D2. A third tier: refused, whoever approves (Code)

**Built 2026-11-25: the refused tier, `neverDomains`, the registry pass, and delete and remove clicks asking from a
schedule. Nothing left in code; setting `BROWSER_MODE=headless` on the Mini is yours.** Shape: not a third
`Reversibility` value but an optional `Tool.refuse(args, run, policy)` that returns a reason or null. The broker
calls it right after the allowlist, before budgets and before every way past the queue, records the result as
a denial, and queues nothing. A refuser that throws refuses. Members so far: the browser's click or submit that
reads as transfer, withdraw, wire, or buying or selling shares, stocks, bonds, options or crypto, and any
navigation to a host in `policy.browser.neverDomains` (also checked by `web_read`, and at run time for a page that
got to one by a redirect or link). A project overlay can add to `neverDomains` and cannot remove the base's.
Money words that are not trades (buy, order, pay, checkout, subscribe) still queue, as H6 says. Suites:
`test/refused-tier.test.mjs` (one row per skip path, and that nothing is queued) and the changed rows in
`test/unattended-asks.test.mjs`. Not done: a screen that lists refusals apart from other denials, and the
bank and broker hosts, which are yours to put in `policy.json`.

Duet will not trade securities or move money between accounts even with your approval. Here every irreversible
action can be approved, and `policy.autoApprove`, `policy.userDirected`, `policy.trust.chatAutoTools` and the
scheduled-run pre-approval can each skip the queue.

- **The trace (2026-11-24): it ran unqueued. That was F8, fixed the same day.** `scheduled` in
  `src/broker.ts` was true for any irreversible call when `run.preApproved` was set and the tool lacked
  `confirmWhenUnattended`, and `browser` lacked it. `preApproved` is set for run kinds `schedule` (watchers
  included) and `heartbeat` (`isUnattendedKind`, `src/harness.ts`), and a subagent inherits it
  (`src/tools/subagent.ts`). Measured by calling `executeCall` on the real `browser` tool with `dryRun` on
  and a throwaway database, so nothing was clicked or queued. What a scheduled run would do:

  | Call | Before | After the fix | Chat turn (unchanged) |
  |---|---|---|---|
  | click "Transfer $500 to external account" | execute | queue | queue |
  | click "Place order" | execute | queue | queue |
  | submit `form#pay` | execute | queue | queue |
  | submit `form#search` | execute | execute | queue |
  | click "Send message" | execute | execute | queue |
  | click "Continue" | execute | execute | execute |

- **The fix.** `confirmWhenUnattended` accepts a function of the arguments (a function that throws counts as
  "ask"). The browser's returns true for a click or submit whose selector, description or text matches the
  money words: buy, purchase, order, checkout, pay, payment, place order, transfer, withdraw, subscribe. The
  money list and the rest of the risky words are two lists that the one risky-click regex is built from
  (`src/tools/browser.ts`). Suite: `test/unattended-asks.test.mjs`. README ("Scheduled jobs are
  pre-approved") and the run's own harness line say so.
- **What F8's fix leaves open.**
  - "Continue", the last row: a button whose label is on neither list is reversible everywhere, in a chat as
    much as in a schedule. The test reads the model's description of the button, not the page. The
    `forbidden` tier and `neverDomains` below are the answer to that, not a longer word list.
  - Delete and remove clicks ran unasked from a schedule. Decided 2026-11-25: they ask now (see the end of this
    section).
  - `BROWSER_MODE` defaults to `auto`, which attaches to a debugging Chrome when one is running, and that
    profile may be signed in. `headless` on the Mini keeps unattended runs in a logged-out profile.
  - `mac_control` sends were the same gap. That was F9, fixed 2026-11-24 (section 0). Still pre-approved
    there, on purpose: notes, reminders and calendar events, which do not leave the machine.
  - **Registry pass (done 2026-11-25).** Every tool that can make an irreversible call, asked "what can a
    steered scheduled run do with this". Changed, so each now queues from a schedule (suite:
    `test/unattended-asks.test.mjs`): `git_write` (push, restore and a commit off the agent's branch could send
    code out or overwrite files; the build loop runs from chat, so no schedule needs it), `write_file`,
    `edit_file` and `move_file` (their only irreversible call is a build manifest, which decides what code the
    build runs), and `study_topic` (delete takes a topic's cards and history). Left as they are, on purpose:
    - `gmail_triage` and `gmail_unsubscribe` are what the inbox-cleanup schedule is for. Their protections are
      code (inbox only, never mail you sent, starred or replied to, 60 changes a run), and the unsubscribe link is
      read by code from the message header and never shown to the model, so a steered run cannot aim it.
    - `draft` writes proposed text to the drafts folder and sends nothing. A steered run could leave a
      misleading draft for you to find, which is a nuisance and not a leak.
    - `schedule_*`, `date_remember`, `headsup_kind_set` and the Instagram tools already ask. `recipe_save` and
      `profile_save` already refuse any run that is not a live chat.
    - Reversible tools I looked at and did not change: `run_command` (only commands declared in `policy.build`
      run), `notify`, `calendar_write` (all-day events on a named calendar), `memory_save` and `state_set`.
      `memory_save` is the one worth a later look: a steered run could plant a memory that later runs recall.
      The provenance work in `test/memory-provenance.test.mjs` is the guard today; I did not re-audit it.
- Add `forbidden` beside `reversible` and `irreversible`. The broker checks it before gate 2, none of the four
  skips apply to it, and it is recorded and shown as an ordinary denial with its reason.
- First members, listed in code: browser clicks and submits whose target reads as moving money or trading
  (transfer, withdraw, wire, buy or sell shares), split out of the one risky-click regex. Buying goods stays
  queued (H6).
- A regex over button text is a heuristic and will miss a bank that labels the button "Continue". Say so in
  the comment, and consider a `policy.browser.neverDomains` list that you fill with your bank and broker.
- Tests: one per skip path, each proving the call is still refused.

### D3. A check on text leaving the machine (Code, log-only first)

**Built 2026-11-25, log-only. Still yours: leave `OUTGOING_ENFORCE` off for a fortnight, read `npm run outgoing`,
then decide.** `src/outgoing.ts` holds the scanner and `Tool.outgoingText(args)` is how a tool says which of
its arguments leave the machine. The broker scans them right after the refused-tier check and puts a note
(`[outgoing check, log only: contains a card number]`) on that call's audit row, whatever happens to the call.
With `OUTGOING_ENFORCE=true` it denies the call and names what matched. A finding never repeats the value.
Declared so far: `draft` (subject, body), `notify` (title, body), `web_search` (query), `mac_control` sends,
the browser's typed text, and every string argument to an MCP tool. The secret rule is the recipe filter
(`looksLikeSecretValue`), reused as the plan said, so its "32 or more opaque characters" clause will catch some
long URLs; the fortnight's log is what tells you. Suite: `test/outgoing.test.mjs`. Not done: Instagram
captions (the tools take a row id, so the caption is checked nowhere yet; the place for it is where the
queue row is written), and URLs the browser and `web_read` are sent to, which can carry text out in a query string.
Proposed and not built, as before: Duet's second tier of health and finance text, which needs a model to judge.

Duet checks each outgoing message for card numbers and government IDs and refuses them. Here the only filter
of that kind drops credential-shaped strings before they are stored as memories.

- One function, applied in the broker to the text arguments of tools whose output leaves the machine: `draft`,
  `mac_control` sends, `notify`, browser typing and submits, `web_search` queries, MCP tool arguments, an
  Instagram caption. A tool declares which arguments those are, as it declares `privateOutput`.
- Refuse on: 13 to 19 digits that pass the Luhn check, a US Social Security number pattern, and whatever the
  memory filter already calls credential-shaped (reuse it, do not write a second one).
- One number in ten passes Luhn by chance, so order and tracking numbers will trip it. Ship it log-only behind
  a switch, as the outbox did with `OUTBOX_ENFORCE`, and enforce only when a fortnight's log shows what the
  false positives are. The denial names what matched.
- Duet's second tier (health and personal finance go out only when you say so) needs a model to judge, which
  "Not doing" rules out. Proposed: do not build it. The local pin already keeps that material off the cloud
  tier, which is the leak that matters here.

### D4. Connectors (You decide; adds to CP1, starts no work)

Duet reaches Slack, QuickBooks, Stripe and thousands more through hosted connectors. The equivalent here is a
remote MCP server per service, and "MCP connectors beyond `docs/MCP.md`" is in "Not doing", with CP1 proposing
to reopen it for local stdio servers only. What Duet adds to that decision:
- Hosted services need OAuth (authorization code with PKCE, refresh tokens kept `0600` outside the repo). The
  client has a static bearer token today, so this is new code, not configuration.
- Every remote server is a third party that sees what is sent to it. It needs CP1's per-server
  `privateOutput`, and Milliman and other workplace material never goes through one.

Proposed: nothing beyond CP1. If you name a service you want, add it as one item, one server at a time.

### Sequence and decisions

Order: the registry pass in D2 first (F8 and F9, which the trace found, are fixed). Then the rest of D2 and
D3, which are small, sit in the broker and need no decision beyond a yes. D1 is built with its screens: its rollout
is yours. D4 waits on CP1.

Decided 2026-11-25:
- Delete and remove clicks in the browser ask from a scheduled run, like money words (built: `DESTRUCTIVE_WORDS`
  in `src/tools/browser.ts`, rows in `test/unattended-asks.test.mjs`). No schedule relied on them.
- `BROWSER_MODE=headless` on the Mini. **You: set it in the Mini's `.env` and restart the dashboard.** The default
  stays `auto` for a laptop; `.env.example` and the README say which machine wants which.
- No schedule pushes with `git_write` or writes a build manifest, so the registry pass's new asks change nothing
  that runs today.
- D2 and D3 alongside section 8: done. `policy.browser.neverDomains`: built, empty by default; your bank and
  broker hosts are yours to add.

Still open:
- (Decided 2026-11-24: the hold on new proactive behaviour is lifted for D1 only.)
- After a week of D1's log: is Gmail's sorting good enough, or does new mail need a local model to order it?
- A named service for D4. Proposed: none until you want one.

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
MCP connectors beyond `docs/MCP.md` (reopened 2026-11-25 for local stdio servers only, which CP1 built; hosted
connectors with OAuth are still not doing); Docker workspace containers; Telegram or WhatsApp (a second place for
approvals to be dismissed unseen); usage telemetry (local-first); auto-sending email; a live "agent thinking"
dashboard; unsubscribing through a browser in the inbox cleanup (one-click unsubscribe is built, SPEC section 5, 2026-11-21; senders
whose link needs a page click are listed as "unsubscribe by hand").

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
