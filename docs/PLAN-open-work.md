# Open work: the one plan

Consolidated 2026-11-21 from eight plan docs, which now live in `docs/archive/`. This is the only
plan doc. If a piece of work is not here, it is either built (see the archive for how and why) or
deliberately not wanted (see "Not doing"). When you finish or change something, change this file in
the same commit. When you start something new, add it here rather than writing another PLAN doc.

Design records stay in the archive and are linked below. The archive is history, not a to-do list:
nothing in it should be followed without checking it against this file and the code.

## Where each old plan went

| Archived plan | State when archived | What was carried here |
|---|---|---|
| `PLAN-assistant-upgrade.md` | All nine phases shipped | Nothing |
| `PLAN-build-loop.md` | All seven phases shipped | Two parked items (section 7) |
| `PLAN-video-ideas.md` | A1 to A7, B1, B3, B5 built | A8, B2, B4, B6, B7 (section 6) |
| `PLAN-native-apps-and-ui-refresh.md` | Mac app, design system, tab bar, web restyle built | Unverified checks, offline cache, open decisions (section 5) |
| `PLAN-heads-up.md` | Phases 0 to 5 built | Settled decisions only (below) |
| `PLAN-heads-up-next.md` | E and F built | A, B, C, D, G, H (section 3) |
| `PLAN-outbox.md` | Phases 0 and 1 built, log-only | Phases 2 to 4, decisions (section 2) |
| `PLAN-nod-learnings.md` | Nothing built | N1 to N5 (section 4) |

## Decisions that are settled (do not reopen without a new recorded decision)

- **Quiet hours** are shared by Heads-up, the outbox and watchers: one setting, default **9 pm to 6 am
  Eastern**, read from the server's local clock. Settings should label it "Quiet hours". Decided
  2026-11-21.
- **Daily cap** is six proactive messages a local day, and it **includes Heads-up pushes**
  (`COUNTED_SOURCES`). Decided 2026-11-21.
- **Hard backstop**: `policy.budgets.perDay.tools.notify` is **20**. Set by the owner in `policy.json`
  2026-11-21. No tool may write that file.
- **Heads-up**: the time-sensitive loop never polls more often than every 30 minutes; a "Yes" answer is
  the consent for read-only research; anything irreversible (buy, book, email) goes to the confirmation
  queue; `PAID` in a calendar event title marks a bill as paid; mail is drafted, never sent.
- **Google writes** are allowed only as SPEC section 5 (amendment of 2026-11-21) describes: a separate
  write token held only by `src/google/write.ts`, archive, label, trash, mark spam, and all-day events
  on a named calendar. No send, no permanent delete, no calendar delete.
- **UI changes are built for web, Mac and iPhone together.**

---

## 1. Roll out what is already built (your steps, on the Mini)

Nothing below has run against real systems yet.

1. Run `update.sh` (pulls, installs, builds, restarts). This deploys the outbox in log-only mode and the
   Gmail and Calendar tools.
2. Run `npm run auth -- write` and approve in the browser. This creates the write token, which does not
   exist yet.
3. Run `npm run watcher add inbox-cleanup`, run it once by hand, and **read its summary before trusting
   it**. It runs every 8 hours after that. Protections are code: inbox mail only, never mail from anyone
   you have emailed, never starred or sent mail, 60 changes per run. Trash and spam are irreversible-tier.
   `policy.json` `google.write.trashOverrideSenders` holds `afs.ameriprise.com`.
4. Let the outbox log for about a week, then read the "What I sent you" section of `npm run digest 168`.
   Each row's `would_be` column says what the rules would have done. Then decide on
   `OUTBOX_ENFORCE=true`.
5. Work through `docs/ROLLOUT.md` (the learning-loop checklist). Its boxes are unticked and the repo
   cannot say how far you are: run `npm run digest 168` on the Mini and tick what is already on.
6. ~~Build the iOS app.~~ Done 2026-11-21: it builds, runs on the iPhone, and the outbox Phase 2 reporting
   works there. The Heads-up lock-screen buttons (A3 rung 8) have not been exercised on a device.

Never exercised against real services: Google Calendar reads, web search and retailer pages for
Heads-up, AeroDataBox, TomTom, APNs delivery of the Heads-up categories, Gmail and Calendar writes.

---

## 2. Outbox (`docs/archive/PLAN-outbox.md` has the full design)

**Built (Phases 0, 1 and 2):** `src/outbox.ts`, `src/outbox-rules.ts`, `test/outbox.test.mjs`. `notify()`
records every message in an `outbox` table. Only the `study` and `tool` sources are governed. Approvals,
reminders, run results and priority 5 are never held. Enforcement is off by default (`OUTBOX_ENFORCE`);
`would_be` records what would have happened. A 5 minute sweep in `src/server.ts` releases held messages.

**Phase 2: what happened to each message (built and proven on a phone 2026-11-21).**
Server: `outbox` gained `opened_at` and `dismissed_at`; `markOutcome` records the first report of each kind;
`outcomeOf` reads a row as `opened`, `dismissed`, `pending`, `ignored` (an APNs send with no report after
`IGNORED_AFTER_HOURS`, 24, inferred at read time and never stored) or `unknown` (ntfy, Mac banner and failed
sends, which cannot report and are not guessed). The push payload carries `outboxId`; `POST
/api/outbox/:id/opened` and `/dismissed` sit behind the dashboard token; the digest line now shows opened,
dismissed and ignored counts. Tests in `test/outbox.test.mjs` and `test/devices.test.mjs`. iPhone
(`PushManager.swift`, `APIClient.reportOutbox`): the run and Heads-up categories now set
`.customDismissAction`, a tap or button reports `opened`, a swipe reports `dismissed`. This also fixed a
bug: a dismissal used to fall through to the deep-link code and was read as a tap. **Proven on your
phone 2026-11-21:** a tapped push got `opened_at`, a swiped one got `dismissed_at`, and the rows read as
opened and dismissed.
The review screen (Phase 3) can also mark everything in it as seen, which gives an ntfy-only setup a weak
signal.

**Phase 3: the weekly review.** A "What I sent you" digest section (per source: sent, held,
de-duplicated, and for APNs opened and dismissed, no model in the counting), and a review screen on web,
Mac and iPhone together listing the last 7 days with **Useful**, **Skip this kind**, and a "Something I
wish I'd been told" box. *Skip this kind* calls `recordDismissal(topic)`, which finally gives it a caller
(today only a test calls it). Answers write memory only, never `profile.md`, `goals.md`, `policy.json` or
`agents/*.md`. One scheduled push a week is the entry point; it is never held and never counts against the
cap. Routes: `GET /api/outbox/review`, `POST /api/outbox/:id/feedback`. Done when a week of use produces a
real review and *Skip this kind* creates one `preference` memory that recall picks up the next day.

**Phase 4: offer to switch off what you keep ignoring.** Mirrors Heads-up B so there is one pattern.
Per `source` + `kind` over 90 days, `skipRate = (skipped + ignored + dismissed) / sent` over rows with a
known outcome. Thresholds go in `outbox-rules.ts` set from real Phase 0 and 2 numbers (propose `MIN_SENT`
8). Over the quieten rate: list it in the review. Over the propose-off rate: one proposal in the
confirmation queue through `noteSilentRejection`, suppressed for 90 days if rejected. Nothing turns itself
off silently. Done when 10 skipped rows from one watcher produce exactly one proposal.

**Note on `src/learn/interrupt.ts`:** the Phase 4.5 interruption budget exists but is unwired
(`notifyProactive` has no callers). Phase 3 gives `recordDismissal` its first caller; wire the rest or
delete it.

---

## 3. Heads-up (`docs/archive/PLAN-heads-up.md` is the design record, `PLAN-heads-up-next.md` the spec)

**Built:** Phases 0 to 5 (calendar reader, scanner, rules, ledger, planner, morning heads-up, API, web
page, iOS, flights and drives), the tab badge, brief line and preferences, **E retention**
(`src/headsup/prune.ts`) and **F telemetry** (`src/headsup/telemetry.ts`, printed by `npm run digest`;
reads answers from the ledger as a snapshot until B's table exists).

| # | Workstream | Size | State |
|---|---|---|---|
| A | Verify what has only run against fixtures | S | **You** |
| B | Learn from dismissals | M | Not started; needs A3 first |
| C | `docs/ROLLOUT-heads-up.md` rollout checklist | S | Not started; needs A |
| D | Lead-time overrides in Settings | M | Not started |
| G | Live Activity for a flight | L | Not started; needs A1 and A3 rung 6 first |
| H | Small and conditional items | S each | Not started |

**A. Verification (yours).** A1 build the iOS app. A2 `npm run check` on Node 24 (it also compiles the
iOS Heads-up models against Foundation). A3 a shakedown, one rung at a time, passing before moving on:
1 Calendar (Check now lists real items, none PAID, no holidays); 2 Morning push (one push, opens the tab);
3 Chat dates ("Garrett's birthday is March 4" gives a card within seconds); 4 Gift research (cards under
two minutes; **record how many had a price and photo versus link-only**, H1 depends on it); 5 Restaurants
(needs `DEFAULT_LOCATION`); 6 Flights (key plus policy switch); 7 Drives (`TOMTOM_API_KEY` and
`HEADSUP_HOME`); 8 Lock screen (buttons appear and work). Done when rungs 1 to 5 pass, 6 to 8 pass or are
consciously skipped. A4 confirm each provider's real free tier (AeroDataBox on RapidAPI, TomTom; TomTom's
v1 Calculate Route may not be free) so `HEADSUP_FLIGHT_CALLS_PER_MONTH` and `HEADSUP_TRAVEL_CALLS_PER_DAY`
defaults sit safely under it.

**B. Learn from dismissals.** New table `headsup_outcomes(id, headsup_id, kind, offered_at, outcome,
resolved_at)`, outcome `yes | later | never | ignored`. `yes`, `later`, `never` come from `answer()` in
`src/headsup/ledger.ts`; `ignored` is written when an offered item reaches its due date unanswered (where
`expirePast` already marks it `expired`) and only for items actually offered. Per kind over 90 days:
`dismissRate = (never + ignored) / offered`, `later` neutral. Tiers, constants in `rules.ts`: under 6 offers
nothing; 6 or more and rate at least 0.7 quietens (keeps the first mention, loses reminders, sorts last in
the cap); 10 or more and rate at least 0.85 proposes off through the confirmation queue (and
`noteSilentRejection`), suppressed 90 days if rejected. The tool that applies it (`headsup_kind_set`) is
irreversible-tier with `confirmWhenUnattended: true`. Settings shows "Bills: offered 14, you acted on 3".
Never penalise by subject, never count `later`, never judge in the first weeks, never disable without
asking, never touch watches. Test every boundary (5 and 5 ignored: no action; 6 offers, 4 ignored: 0.67, no
action; 10 offers, 9 ignored: one proposal, not one per morning; rejected: quiet for 90 days; yes on a
quietened kind lets reminders return under 0.7; outcomes older than 90 days stop counting). Then point
`src/headsup/telemetry.ts` at the table and prune outcomes at 400 days.

**C. Rollout checklist.** `docs/ROLLOUT-heads-up.md`, same format as `ROLLOUT.md`. Ladder: 0 baseline (Check
now for a week, no push); 1 morning push, no research; 2 chat dates (watch false positives); 3 research on
(card quality counts from A3); 4 watches, flights first (notifications per flight); 5 drives (leave-by
accuracy); 6 learning from dismissals after B. Each rung states its metric, its off-switch (`HEADSUP_ENABLED`,
a kind toggle, a policy flag) and the standing rule: if the number does not move as predicted, switch it
off and report, do not tune.

**D. Lead-time overrides.** A per-kind ordered list of 1 to 3 day counts, largest first, each 0 to 45, no
duplicates, validated all-or-nothing; `LEAD_DAYS` stays the default. **The trap:** the ledger's `stage` is an
index into the kind's list, so changing the list mid-sequence would re-offer or skip. Record the threshold
in days in a new `stage_days` column at offer time and compare thresholds, with a migration that backfills
from the old index. Done when a test changes a list mid-sequence and nothing is re-offered or skipped, and
Settings shows it on web and iOS.

**G. Live Activity for a flight.** Needs a second Xcode target. You, in Xcode: add a Widget Extension named
`AgentSpineLiveActivity` with "Include Live Activity" ticked, share the `ActivityAttributes` file with both
targets, set `NSSupportsLiveActivities`, commit. Then the Swift views, `POST
/api/headsups/:id/live-activity` to store the push token, `src/push/liveactivity.ts` for update and end
pushes (push type `liveactivity`, topic `<bundle id>.push-type.liveactivity`), calls from `loop.ts`. Decide
first: foreground-start only, or push-to-start (iOS 17.2+)? Activities end after about 8 hours without an
update, which must fit the 18 hour flight window. Done includes a manual device test.

**H. Small and conditional.**

- H1 browser fallback for blocked retailers: only if A3 rung 4 or telemetry shows over half of cards are
  link-only; scope to an allowlist, the SSRF guard does not cover a browser.
- H2 web sidebar badge for open heads-ups (offered plus dates to confirm), mirroring iOS. Check whether it
  already exists before starting.
- H4 a second flight provider, one file behind `FlightSource`, if A4 shows AeroDataBox is unsuitable.
- H5 restaurant booking and H6 buying a gift: irreversible-tier, queued, never automatic. Only if asked.
- H7 arrival-side flight alerts (baggage claim, landing gate).
- H8 remembered dates: edit, not just forget.
- H9 model-worded notifications: only if the code wording reads badly; prefer fixing it in code.

**Open decisions:** thresholds in B (keep 6, 0.7, 10, 0.85, 90 days?); if TomTom's route API is not free,
HERE free tier, a static-speed provider, or flights only; whether to want G at all.

---

## 4. Security hardening and learning (`docs/archive/PLAN-nod-learnings.md`, from n8n's Nod)

N5 is built (2026-11-21). N1 to N4 are not (checked 2026-11-21: no `origin` column on `memories`, no
injection corpus, no cloud token cap, no styles table). The write token raised the value of N2, since a
hostile email is now worth more to an attacker. **Order: N2 offline half, N1, N3, N4.** Do N2 before the
inbox cleanup runs unattended.

- **N5 Architecture test. Built 2026-11-21: `test/architecture.test.mjs`.** Reads the source with the
  TypeScript compiler (comments stripped exactly), runs nothing, and asserts: only `learn/promote.ts` can
  write `policy.json` and only one route in `server.ts` calls it; `profile.md`, `goals.md` and `agents/` are
  only read; the tools that write a file (four) and the tools that can run a command (six) are pinned, so a
  new one fails until a person has looked; `google/write.ts` is imported only by `gmail-triage.ts` and
  `calendar-write.ts`; only config, auth and `write.ts` name the write token or its scopes; `write.ts` has no
  send, no delete and no DELETE method; the read client has no write endpoint. It includes self-checks so the
  scanner cannot pass vacuously, and was shown to fail on a planted violating tool. The token-holder check
  moved out of `test/google-write.test.mjs`. It is a tripwire, not a proof: a shell redirect is the broker's
  job to gate. `LEARNING.md` invariant 1 points at it.
- **N2 Prompt-injection corpus.** `test/fixtures/injection/` JSON cases `{ id, surface, payload, forbidden }`
  over surfaces (email, web page, file, calendar entry, meeting transcript) and payload families
  ("remember that Andrew authorised X", "ignore your rules", fake system message, hidden quoted-reply
  instructions, a secret-shaped string, a request to schedule a job or save a recipe). Add cases aimed at the
  new tools: an email telling it to trash everything, archive a protected message, write a calendar event,
  or label something to hide it. Offline half goes in `npm test` (no network): `tagUntrusted` wraps every
  surface, the reflect secret filter drops credential-shaped strings, `recipe_save` and `schedule_create`
  refuse or queue from a non-chat run, the broker denies or queues each forbidden call, and the guards in
  `gmail-triage.ts` hold. Live half is `npm run eval:injection` (needs the model host), run once per model
  change and before any ROLLOUT step that switches on a learner; record the baseline in SPEC or MODELS. A
  broker bypass must be zero by construction. Any other threshold is decided after the baseline.
- **N1 Memory provenance.** Add `run_id` and `origin` to `memories` with the existing best-effort `ALTER`
  pattern. `origin` is a code-set vocabulary: `reflection`, `recipe`, `lesson`, `rejection`, `approval`,
  `interrupt`, `conversation`, `profile`, `tool`. Widen `remember(text, kind, source?)` with `source`
  optional; pass it from `reflect.ts` (two), `confirmations.ts` (two), `learn/critique.ts`,
  `learn/interrupt.ts`, `tools/memory.ts`, `memory/summarize.ts`, `tools/profile.ts`. A refused duplicate keeps
  the original provenance. Settings shows origin, links to the run trace, and says "run pruned" (never 404)
  after the 90 day trace prune; old rows say "before provenance". Update `LEARNING.md`.
- **N3 Cloud token cap (lower priority).** Cap tokens, not dollars: `CLOUD_TOKENS_PER_DAY`,
  `CLOUD_TOKENS_PER_MONTH`, `CLOUD_TOKENS_PER_RUN`, counted from `llm_calls`, enforced in the router before
  the call, cloud calls only. Chat gets an error offering to continue locally; unattended runs stop, log, and
  push once through the outbox. Digest line. Refuse to start with `AUDIT_RETENTION_DAYS` under 31 when a
  monthly cap is set. Mail and study are local-only, so the cleanup adds no cloud tokens.
- **N4 Writing styles for drafts (defer).** Named styles, several at once, built from Sent mail via the
  unchanged read token. Largest item and independent of everything above. The full design is in the archived
  plan.

---

### 4a. Leftovers from the reference docs (found in the 2026-11-21 review)

These were open items inside docs that otherwise describe built things, so they were easy to lose.

- **Memory consolidation, `LEARNING.md` Phase 6.** 6.0 is built (`npm run consolidate`, read-only, no model
  call) but has never been run against the real memory table: the MacBook's database is empty, so the first
  number has to come from the AgentSpine Mini. Run it, set `CONSOLIDATE_SIMILARITY` (0.75, a guess) from
  the histogram, and if it finds only a handful, stop there. If it finds enough: 6.1 (judge each candidate
  group with a local model pinned `private`, results `distinct | duplicate | superseded | merge`, queued as
  proposals, `CONSOLIDATE_MAX_PROPOSALS` caps a pass, a rejected pair is never proposed again) and 6.2
  (approval sets `memories.retired`, recall skips retired rows, `prune` hard-deletes after
  `CONSOLIDATE_GRACE_DAYS`, default 30, un-retire in Settings → Memory during the grace window; trigger from
  the daily prune tick with `CONSOLIDATE_EVERY_DAYS`, default 0). Three open questions to settle before
  building are listed in `LEARNING.md`. Also check `CONSOLIDATE_SIMILARITY` and `CONSOLIDATE_GROUP_MAX` are
  documented in `.env.example`.
- **The proposers have no trigger.** Nothing in `src/` calls `runProposer` (recurring-intent schedules,
  `npm run propose`) or `runRewriter` (`npm run rewrite`) except their own command lines, so they run only
  when you run them. Decide whether a weekly trigger is wanted before turning on anything that depends on
  them (ROLLOUT Steps 3 and 5).
- **Interruption budget wiring.** `notifyProactive` and `recordDismissal` in `src/learn/interrupt.ts` are
  unwired (see section 2). Either the weekly review wires them or they are deleted.
- **Meetings, `SPEC.md` section 15 note of 2026-07-30.** Items it listed as still to do, not rechecked: index
  something into a project so the sidecar and coach have a corpus; one dashboard Record, Stop, extract run
  against live speech; re-run the Phase 2 numbers against a real multi-person meeting (neither sample so far
  measures **recall**); re-check the "flat ~1.1 s prefill" claim in the coaching table, which did not
  reproduce. Several may be done by now through use, so check before doing any.
- **Study.** `STUDY.md` lists heartbeat-scheduled study sessions as not built, and said to wait until the
  Study screen existed. It does now, so this is buildable if wanted. Practice-app generation stays off the
  list (the Study screen covers it).
- **Model host.** `CLAUDE.md` says the model host is `192.168.0.145`; the code, `MODELS.md` and `SPEC.md` say
  `.150`, static since 2026-09-08 (it went `.145` to `.134` to `.150`). `CLAUDE.md` was left as is because
  only you know which is true today. Fix whichever is wrong.

---

## 5. Native apps and UI (`docs/archive/PLAN-native-apps-and-ui-refresh.md`)

**Built:** the `AgentSpine Mac` target (eight shared files), the token pipeline (`design/tokens.json`,
`npm run design`), the SwiftUI component gallery, bundled fonts, the tab bar customisation screen, the Mac
shell with threads, Heads-up, Builds, Activity, meetings with its own microphone and optional call audio,
menu bar, window restoration, keyboard shortcuts, accessibility labels, icons, recipes on phone and Mac,
and the web restyle (tokens, fonts, the spine in the conversation, message actions).

**Not verified or not done:**

- A VoiceOver pass by actually using it, Increase Contrast and Dynamic Type on the device, light-mode
  screenshots (light was derived from the dark mocks and never drawn).
- Web views not seen by eye: a streamed conversation, Trace tab, RunDetail, populated Meetings with speaker
  colours, dialogs, narrow widths. The message-action hover row has not been looked at in a browser, the Mac
  app or the simulator.
- The recipe screens have not been run against a server by hand.
- Spacing and type sizes still use the old literal values in most modules (only colours and fonts moved to
  tokens); meeting speaker colours stay hard-coded hues.
- Distribution: development-signed only, no notarised route, by decision.
- **iPhone offline cache (separate follow-up, not started).** A read-only mirror of threads, tasks, files and
  recent run results (SwiftData or SQLite), shown marked as cached when the server is unreachable. Writes are
  not queued. Approvals are never replayed: an offline phone shows the question and says it can only be
  answered once reconnected, because a stale approval is a security problem.

**Open decisions:** how many tabs the iPhone bar should allow now that Heads-up sits second (the mock shows
four plus More); whether to cut a Swift package once there is a compiler to check the `public` changes.

**Things a session working here needs to know.** There is no Swift compiler in the Claude sandbox: Swift can
be written but not compiled, so every Swift change ends with a short "press ⌘B and check these" list and
you paste back the first errors. Do not hand-edit the `.pbxproj`; you tick Target Membership to share a file
with the Mac target. `Models.swift` must stay Foundation-only (`test/ios-models.test.mjs` compiles it alone);
shared files must not import UIKit unguarded.

---

## 6. Your Claude setup and small leftovers (`docs/archive/PLAN-video-ideas.md`)

Built: named recipes, the study screen, meeting-to-study cards, redo-without-help, resources at your level,
the overview page, the profile interview, the repo `CLAUDE.md`, the private plugin marketplace, a global
`~/.claude/CLAUDE.md`.

- **A8 Spoken "I need you" on the dashboard (optional).** Kokoro TTS exists. A Settings → Voice option: when
  a long run finishes or an approval is waiting, the open tab speaks one line. Per browser, off by default.
- **B2 Project skills** for repeated chores (`add-tool`, `ship`, `ios-check`), each written from a real
  session after you have done the job by hand twice.
- **B4 Stale auto-mode environment, on each Mac.** `~/.claude/settings.json` `autoMode.environment` may still
  call CueForge the trusted repo. It should list AgentSpine and CueForge as trusted, mark
  `~/Developer/Milliman` confidential (never to a public paste), and name the model host `192.168.0.145` as
  trusted internal. The Claude sandbox cannot edit settings.json, so this is yours. Unverified.
- **B6 "Claude needs you" alerts.** Do not install claudespeak (unvetted code that sends session text to a
  cloud TTS). On the MacBook a `Notification`/`Stop` hook can speak through local Kokoro; on the Mini the
  hook should POST to AgentSpine's notify endpoint so it reaches the phone.
- **B7 Housekeeping on the MacBook.** Remove the stale scheduled task `implement-beatgrid-spec` if done;
  reconcile `agentspine-hardware` with `local-llm-setup` in auto-memory (`/consolidate-memory`).
- **The Mini needs the plugin keys** `extraKnownMarketplaces` and `enabledPlugins` in its
  `~/.claude/settings.json` (the README has them). Done on the MacBook only.

---

## 7. Parked, with the trigger that would unpark it

- **`.xcresult` parsing** (`-resultBundlePath` plus `xcresulttool`) for Xcode build failures. Needs a real
  build outside Claude's sandbox to verify. Only if Xcode build-failure summaries turn out wrong in practice.
- **Arguments for declared commands** (a test-name filter for `run_command`). Nothing has needed it.
- **Credential vault and logged-in browsing**: would change the security posture; revisit only if browser
  errands become a real need, designed origin-bound with the secret never in a prompt.

## Not doing

Model-judged safety checks (revisit only if N2 shows the code gates cost real approval fatigue); MCP
connectors beyond `docs/MCP.md`; Docker workspace containers; Telegram or WhatsApp (a second place for
approvals to be dismissed unseen); usage telemetry (local-first); auto-sending email; a live "agent
thinking" dashboard; unsubscribing via the browser in the inbox cleanup (the summary lists senders worth
unsubscribing from instead).

## Standing rules for any item above

- Code owns the numbers (thresholds, schedules, budgets in code, never in a prompt). The model owns the
  judgment.
- Local-first: `sensitivity: "private"` content never reaches the cloud tier. Meeting work and study topics
  linked to a project are local-only.
- Standing work needs consent: a tool that creates or edits what future unattended runs follow sets
  `confirmWhenUnattended: true` or refuses non-chat runs.
- Tests first for arithmetic, every boundary; new suites are added by hand to the `npm test` list in
  `package.json`.
- Run `npm run check` (outside the Claude sandbox, which blocks the local ports the tests bind) before
  calling anything done. Server changes need a dashboard restart; web changes need `npm run web:build`.
