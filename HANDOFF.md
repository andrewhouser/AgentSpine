# Handoff: finishing the 2026-11-26 build

Written by Claude Fable 5.2 for whichever model picks this up. Delete this file when the work is committed.
Read `CLAUDE.md` first, then this, then the sections of `docs/PLAN-open-work.md` each step names.

Every step is marked with the model it is for:

- **[Sonnet]** mechanical, fully specified here.
- **[Opus]** needs the design understood, but not the security model.
- **[Fable]** security or privacy judgement. Do not attempt these on a smaller model.

**The rule for a smaller model:** if a step makes you want to change a file on the Fable list, weaken or
delete a test assertion, add a skip path, or touch `src/broker.ts`, stop. Write what you found under
"Escalations" at the bottom of this file, leave the tree as it is, and tell Andrew which model it needs.
A red check that is honestly reported is a good outcome. A green check reached by loosening a gate is not.

## 0. Merged with GitHub's main (2026-11-26, read this first)

The work below was committed as `d5fb7f8` and merged with 28 commits from GitHub that had built several of the
same items separately (LP3, LP5, LP6, SC5, SC6, D1's source switches, D2, D3, the `.pyc` cleanup). Andrew chose
"GitHub wins": for each of those, GitHub's version is the one in the tree, and the local versions are gone
(`src/outbound.ts`, `src/loop-budget.ts`, `src/turn-gate.ts`, `src/change-proposals.ts`, `src/checkin/prefs.ts`
and their suites). Ported onto GitHub's code: LP2 (`agent.ts`), H6's stall watchdog (`queue.ts` gained
`abandon` and `onPauseChange`, `runner.ts` the watch), SC3's code map (`runner.ts`, `write-file.ts`), the MCP
plan-card labels (`mcp/register.ts`), section 14 (server routes, check-in buckets on GitHub's `sourcePrefs`),
and the iPhone and Mac source switches (now decoding GitHub's reply). `src/tools/browser.ts` changed only to
export `launchHeadless` for the site audit. `src/broker.ts` is GitHub's, untouched.

So in step 7 below: read `src/outgoing.ts` where it says `src/outbound.ts`; GitHub's refused tier is
`Tool.refuse` (suite `test/refused-tier.test.mjs`), not `forbidden`; and item 6 is GitHub's `propose_change`
(suite `test/propose-change.test.mjs`). Add `src/queue.ts` and `src/runner.ts` to the files to read: the
watchdog's `abandon` lets a hung run's code keep going beside the next job.

## 1. Where things stand

- Branch `main`, **nothing committed**, about 186 changed or new files. Do not commit or push unless Andrew asks.
- The only staged change is the deletion of two `.pyc` files. Leave it staged.
- A full `npm run check` passed (exit 0, 149 suites) after the first round of work: sections 3 H8, 5, 10
  (LP2, LP3, LP5, LP6, SC3, SC5, SC6), 11, 12 (D1 settings, D2, D3) and 13 (H1, H4, H6). The plan doc already
  records all of that.
- Then five parallel workers built section 14 (U1 to U10). Each passed its own suites and built both Xcode
  targets, but **the full check has not been run on the combined tree**, and section 14 in the plan doc still
  says "nothing here is built yet".
- No server is running. The preview config `ui-review` in `.claude/launch.json` starts a throwaway server on
  port 8799 from a scratch database that may be gone.

## 2. Traps that cost time

- `npm run check` binds local ports. Run it in the **foreground with the sandbox off**. A background command
  stays sandboxed even with the flag and fails with `listen EPERM`.
- Check the result like this, because a pipe hides the exit code:
  `npm run check > "$TMPDIR/check.out" 2>&1; echo EXIT=$?`
  then count `^[0-9]+ passed, 0 failed` lines and look for `^[0-9]+ passed, [1-9][0-9]* failed`. Grepping
  for `FAIL` matches test names.
- `xcodebuild` also needs the foreground and the sandbox off, run from `ios/`, with
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` and `CODE_SIGNING_ALLOWED=NO`:
  - `xcodebuild -scheme AgentSpine -destination 'generic/platform=iOS Simulator' -derivedDataPath build/ios build`
  - `xcodebuild -scheme "AgentSpine Mac" -destination 'platform=macOS' -derivedDataPath build/mac build`
- Reading a file over about 100 lines returns a helper's notes, not the text. Read ranges under 100 lines
  when you need exact text.
- `.env.example` cannot be read or written here. `git status` prints an error line about it; ignore it, and
  stage named paths.
- `ls` breaks in this shell. Use `/bin/ls` or `export TERM=dumb`.
- Never edit `ios/AgentSpine.xcodeproj/project.pbxproj`, `policy.json`, `profile.md`, `goals.md` or `agents/*.md`.
- Tests fire real macOS banners. That is expected.

## 3. Steps, in order

### Step 1 [Sonnet]: register the new suites and scripts

In `package.json`, append to the `test` chain (one long `&&` line; use a short Python replace, not `sed`):

```
today, today-screen, site-audit, prospects, commitment-tasks, runbook, runbook-words,
watch-list, headsup-sequence, inbox-buckets, carousel
```

each as ` && node test/<name>.test.mjs`. Add two scripts: `"audit": "node src/siteaudit/cli.ts"` and
`"carousel": "node src/carousel/cli.ts"`.

### Step 2 [Sonnet]: three small joins the workers left for the integrator

1. **Booking push category.** In `ios/AgentSpine/Push/PushManager.swift`, add a category `HEADSUP_REMIND`
   with the actions `headsupYes` titled "Yes, set up reminders", then the existing `later` and `never`,
   options `[.customDismissAction]`, and include it in `setNotificationCategories`. Copy the shape of
   `headsupResearch` beside it.
2. **Mail on Today.** `readToday` in `src/today.ts` passes no mail. Join it to the inbox labels:
   `shownLabels(INBOX_SORT_MODE)` in `src/checkin/buckets.ts` returns a record keyed `mail:<id>` and is empty
   unless the mode is `on`. Fill `TodayInput.mail` (`{bucket, key, sender, subject}`) from it and the
   check-in's person-mail list. Add a case to `test/today.test.mjs` for mode off (empty) and on.
   If this needs more than reading those two modules, stop: it is **[Opus]**.
3. **Unused imports.** `web/src/lib/api.ts` may have unused `ClientCommitments` / `CommitmentTask` imports.
   Run `npx eslint web/src/lib/api.ts` and remove only what it reports as unused.

### Step 3 [Sonnet]: the full check, then fix what is mechanical

Run the check as in section 2. Expect about 160 suites. Fix only these kinds of failure yourself:

- eslint or stylelint errors (import order: `npx eslint --fix <that one file>`, never the whole repo);
- TypeScript errors that are a missing field or import between two workers' additions;
- a count in a test that changed because a tab, tool or Heads-up kind was added (`ios-tab-layout`,
  `ios-models`, `headsup-prefs`, `menu-layout`), where the new number is plainly right;
- `test/prompt-snapshot.test.mjs`: read the first differing line. If it is only a tool description this
  work changed on purpose, rerun with `UPDATE_SNAPSHOT=1`. If anything else moved, stop.

Stop and escalate for anything else:

- **[Opus]** a failure in `agent-final`, `harness`, `harness-behaviour`, `stop-run`, `chat-first`,
  `stall-watchdog`, `loop-budget`, `local-deep`, `tool-docs`, `knowledge-closeout`, `meeting-filing`, `runbook`.
- **[Fable]** a failure in `forbidden-tier`, `outbound-check`, `outbound-enforce`, `unattended-asks`,
  `unattended-handoff`, `protected-paths`, `self-change`, `architecture`, `private-output`, `injection`,
  `confirm-race`, `narrow-policy*`, `inbox-buckets`, `run-search`, `site-audit`.

### Step 4 [Sonnet]: build everything once on the combined tree

`npm run web:build`, then both `xcodebuild` commands from section 2. Fix Swift compile errors that are a
duplicate name, a missing `case` in a `switch`, or a missing import. Anything that needs a design choice
is **[Opus]**.

### Step 5 [Sonnet]: look at it running

Start the `ui-review` preview server. If its database is gone, seed one with invented data first and make
sure no enabled schedule is in it. Then check, and write down exactly what you saw and what you did not:

- web: Today (sections, brief, Review then Approve, Later), Schedules (a skipped slot), Clients (Prospects),
  Check-in, Heads-up (edit a date);
- iPhone 17 Pro simulator against `http://localhost:8799` (Settings, Server; any dummy token): Today as the
  first tab, the approval sheet, the More list.

Stop the preview server when done. The Mac app could not be driven in past sessions; say so, do not guess.

### Step 6 [Sonnet]: the plan doc and the snippet for Andrew

In `docs/PLAN-open-work.md`, section 14: change "Nothing here is built yet" in the intro, and add a
"**Built 2026-11-26 ...**" paragraph under each of U1 to U10. The five workers' final reports contain a
ready-to-paste paragraph for each; they are in this session's transcript. Keep every "not verified" and
"not done" line. Do not write that something was seen running unless step 5 saw it.

Then give Andrew these lines for `.env.example`, commented out, since he must add them himself:

```
# OUTBOUND_ENFORCE=true         # deny a call whose outgoing text matches a card number, SSN or credential (default: log only)
# CHAT_FIRST=true               # chat goes ahead of scheduled runs (default off; measure prefill first)
# STALL_IDLE_MS=600000          # idle time before an unattended run is stopped; 0 turns the watchdog off
# STALL_MODEL_MARGIN_MS=30000
# STALL_TOOL_MS=                # default: COMMAND_MAX_TIMEOUT_MS + 60000
# STALL_GRACE_MS=60000
# STALL_SWEEP_MS=30000
# LOCAL_DEEP_THINKING=true      # thinking on for hard steps of a deep run served locally (default off)
# LOCAL_DEEP_MAX_TOKENS=8192
# TOOL_DOCS_ON_DEMAND=true      # full tool descriptions only for a core set (default off)
# LOOP_BUDGET=tokens            # token and time budgets with compaction (default: steps)
# RUN_TOKENS_PER_STEP=1200
# RUN_MS_PER_STEP=90000
# LOCAL_CONTEXT_TOKENS=65536
# INBOX_SORT_MODE=log           # off (default) | log | on
```

### Step 7 [Fable]: security read of the whole diff, before any commit

This is a review, not a rubber stamp. Read `git diff` for the files below and report findings; fix only
what is clearly a defect and has a test.

1. **The gates:** `src/broker.ts`, `src/confirmations.ts`, `src/types.ts`, `src/protected-paths.ts`,
   `src/outbound.ts`, `src/sensitivity.ts`, `src/tools/browser.ts`, `src/tools/write-file.ts`,
   `src/tools/git-write.ts`. Three workers and the parent all edited the broker's neighbourhood. Check the
   order in `executeCall` is: classify, forbidden, allowlist, outgoing-text check, budget, gate 2 with
   `alwaysConfirm`, dry run, queue, run.
2. **`test/architecture.test.mjs` was changed by the audit worker** to allow `src/tools/site-audit.ts` as a
   fifth file-writing tool. Confirm the tool writes in one place and takes no path from the model.
3. **Site audit SSRF (U3):** a host whose DNS answer changes between the check and Chrome's own lookup is
   not closed. Decide whether to pin the resolved address or accept and document it.
4. **Inbox buckets (U7):** the injection surface. Confirm the model's output can only be two enum values,
   that the reply draft takes its recipient and subject from code and never from the model, and that
   nothing a sender wrote can reach a run's goal. N2's live half has not run; U7 must stay off until it has.
5. **Run search (H4):** `recall_output` and `conversation_detail` still return any run by id with no
   privacy check. `store.runTreeIsPinned` exists to close it. Close it or record why not.
6. **`propose_change` (SC5)** and the registry tripwire in `test/forbidden-tier.test.mjs`: confirm a
   non-chat run cannot queue a proposal, and that the tripwire still bites for a new irreversible tool.
7. **Today (U1):** Approve must be reachable only from the full card, never a row, a swipe, or a saved
   offline copy.

### Step 8 [Opus or Fable]: a real UI redesign pass, only if Andrew asks for it

Not started and not in the plan. What the partial review noticed: the iPhone More list is twelve items in
a flat order (it is iOS's own list, so grouping it means a custom screen); light mode was never drawn;
spacing and type sizes are literals; there is no Watch app, widget or Live Activity (each needs a new
Xcode target, which needs Andrew's OK). Needs a browser and a simulator, and all three clients together.

## 4. Decisions that are Andrew's (do not settle these yourself)

- `memory_save` from an unattended run is recalled by later runs without review. Proposed: hold it for the
  weekly review. Not built.
- The system prompt's clock line carries seconds, which breaks the cached prefix on every run. Run
  `node bench/h1-prefix.mjs --runs 3 --out h1.json` on a machine whose `.env` points at the model host first.
- Forgetting a remembered date now also withdraws its open Heads-up card.
- An accepted booking has no cancel button; a booking moved midday can still fire its old reminder.
- Inbox replies are drafted from a 300-character preview, never the body. Possibly too thin.
- A client's project cannot be set from any screen yet, so a client's commitments list stays empty.
- The systems map for a client (section 14, "Proposed, not yet agreed").
- Moving the bundle ids into a gitignored `Local.xcconfig` (needs a `.pbxproj` edit).
- Every switch in the snippet above is off or log-only until he has measured or read the log.

## 5. When it is done

Report to Andrew: the real output of the final `npm run check` (exit code and suite counts), both Xcode
build results, what was seen running and what was not, the Fable review's findings, and the open decisions.
He runs `update.sh` on the Mini himself after he pushes; nothing server-side is live until then.

## Escalations

(Write here: the step, the failing suite or file, the exact error, what you did not do, and which model it needs.)

- **Step 2.2, Mail on Today — [Opus]. Done 2026-11-26 at Andrew's request:** the inbox pass now stores the subject and an `unread` flag on each label (`markUnread`), and `readToday` reads `todayMail(INBOX_SORT_MODE, mail switch)` from the database; cases in `test/today.test.mjs`. The original note: `TodayMail` needs `subject`, but `inbox_labels`
  (`src/checkin/buckets.ts`) stores only `message_id, sender, bucket, reason, mode, at`. The subject is only
  in the check-in's person-mail list, which comes from `previewCheckin()`: an async live Gmail read, while
  `readToday` in `src/today.ts` is synchronous. Joining them means either storing the subject on the label,
  making `readToday` async, or reading a cached check-in list: a design choice. `src/today.ts` and
  `test/today.test.mjs` were left untouched. The plan doc's U1 paragraph says so.
- Steps 1, 2.1, 2.3 (nothing unused), 3, 4, 5 and 6 done on 2026-11-26 by Sonnet; nothing escalated from them.
  Step 7 (Fable security read) is not started.
