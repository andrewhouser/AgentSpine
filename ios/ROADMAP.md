# AgentSpine for iPhone — what's done, what's left

Written 2026-11-07, after closing the "phase 1" gap between the app and the dashboard.
This is a handoff: it assumes you know the project but not this particular stretch of work.

`README.md` beside this file describes the app. This one describes the plan.

---

## Where things stand

> **Added 2026-11-09:** a **Builds** tab (`Views/BuildsView.swift`), for the build loop in
> docs/PLAN-build-loop.md — `GET /api/builds` and `/api/builds/:id/diff`. It was written
> without Xcode: this sandbox blocks `swift-plugin-server`, so SwiftUI macros cannot expand
> and the module cannot be type-checked. Every file parses (`swiftc -parse`, clean), and that
> is all that has been proved — **press ⌘R before trusting it**.
>
> Phase 2 (dictation, tier, memory/policy/proposals, projects, meetings, read-aloud) is below
> and brings coverage to roughly 50 of 55; the table is the phase 1 snapshot.

The app now covers **29 of the 55 API operations the web client uses**, up from 12. It had
the core loop — start work, watch it, approve it, be told about it — and nothing else. It
now also reaches run history, schedules, attachments and projects.

| | Operations | Notes |
|---|---|---|
| Web client uses | 55 | `web/src/lib/api.ts` |
| iOS covered | 29 | `ios/AgentSpine/Core/APIClient.swift` |
| iOS-only | 4 | devices ×3, push test |
| Reachable from no client | 5 | see [Leftovers outside iOS](#leftovers-outside-ios) |

**Git state at the time of writing:** `main` is at `e279043` (the web proposals UI).
The phase 1 work below is **uncommitted** in the working tree — 11 files, +565/−71, iOS only.

---

## How to run and test this

The app needs a dashboard to talk to, and you do not want to test against your real
ledger. Point a throwaway instance at copies:

```bash
cp spine.db policy.json /tmp/agentspine-demo/
SPINE_DB_PATH=/tmp/agentspine-demo/spine.db \
POLICY_PATH=/tmp/agentspine-demo/policy.json \
DASHBOARD_TOKEN=demo-token DASHBOARD_PORT=8799 \
node src/server.ts
```

In the app's Settings use `http://localhost:8799` and `demo-token`. ATS does not apply to
loopback, so the `ts.net`-scoped exception in `Supporting/Info.plist` is not in the way.

Build: the Xcode project uses a `PBXFileSystemSynchronizedRootGroup` for `ios/AgentSpine`,
so **new `.swift` files are picked up automatically** — no `.pbxproj` edit needed.

A fresh `spine.db` copy may have no conversations to look at. Seeding one run with a
markdown reply and a couple of attachment rows is enough to exercise the thread view
without running an agent cycle.

---

## What phase 1 shipped

| Area | Files |
|---|---|
| Run detail, with the raw trace | `Views/RunDetailView.swift` (new) |
| Schedules tab, full CRUD + edit + run history | `Views/SchedulesView.swift` (new) |
| Markdown block renderer + parse cache | `Views/MarkdownText.swift` (new) |
| Attachment thumbnails, full-screen viewer | `Views/AttachmentImage.swift` (new) |
| Photo picker, staged uploads, error banner | `Views/ThreadView.swift` |
| Rename/delete, project label, project picker | `Views/ConversationsView.swift` |
| Run detail drill-down | `Views/ActivityView.swift` |
| Fifth tab | `Views/RootView.swift` |
| `Schedule`, `Project`, `RunDetail`, `TraceMessage`, `Run.scheduleID` | `Core/Models.swift` |
| 12 new endpoints, `longSession` for slow routes | `Core/APIClient.swift` |
| Projects loaded for labelling | `Core/AppState.swift` |

---

## Tasks left

### 0. Housekeeping

- [x] Working tree committed.
- [x] ~~**`ios/README.md` is stale.**~~ Done — the overview block lists Schedules, the
      Threads / Thread / Activity lines say what those screens now do, and it points here.
- [ ] **Delete-a-conversation is unverified.** The confirmation alert is built and shares
      the enum-driven `.alert` that rename was verified against, but no one has watched a
      thread actually get deleted. Worth one pass.
- [x] ~~**No device list in Settings.**~~ Done — Settings → Registered devices lists them,
      swipe to forget.

### Phase 2 — everything below is built

- **Dictation:** composer mic button (`Core/Dictation.swift`). `POST /api/dictate/cancel` is
  deliberately not called: it stops the *server's* mic session, which a phone take never starts.
- **Tier picker:** toolbar menu on the thread.
- **Memory, policy, proposals, agents:** Settings → Assistant. Proposal evidence loads on first expand.
- **Projects tab:** create, delete, edit, sources (add / reindex one / reindex all / remove), threads.
- **Meetings tab:** live strip, start/stop, history, detail (summary, decisions, work items with
  verdicts, transcript, context cards, **coach**, rename, file under project, re-extract). All polling.
  The coach needed `GET /api/meetings/:id/coach` on the server, added in this phase.
- **Voice:** read-aloud on every reply, and a **hands-free** toggle on the thread
  (`Core/HandsFree.swift`): on-device speech detection, `/api/voice/listen` for wake word and
  command, reply read aloud, then back to listening. **Foreground only** and it keeps the screen
  awake; true background listening needs a background audio mode and was not attempted.

### Still unverified

Compiled, the app launches in the simulator, and the server endpoints were exercised with `curl`.
Not exercised: mic recording, playback, hands-free (needs a device and the Whisper/TTS services;
`TTS_URL` is unset on this machine, so read-aloud will report that), the polling loops, and
deleting a conversation from the UI.

---

## Leftovers outside iOS — done

- Web can now edit a schedule in place (name, when, task) via `api.updateSchedule`.
- `/api/agents` is used by the iOS Agents screen.
- `POST /api/do` removed (the CLI `npm run do` is unchanged).

## The `memory_save` bug — fixed

Cause: `remember()` threw "fetch failed" whenever the embeddings endpoint (Ollama) was down, so
the save was lost. It now stores the fact without a vector (keyword recall still finds it) and
logs. `memory_save` also reports "already known" instead of claiming a save.
Second half: a non-chat run with any errored tool call now finishes `failed` (cause first, the
agent's own summary kept in the note) instead of `ok`. Chat is exempt.

---

## Notes worth keeping

Things that cost time to work out.

**Two presentation modifiers of the same kind on one view silently do not work.** Two
`.sheet` modifiers: the second wins and the first never presents. Same for two `.alert`.
This bit the Schedules create/edit pair and the Conversations rename/delete pair, and both
are now driven by one optional enum (`Editor`, `Prompt`). A clean build tells you nothing;
the button just does nothing. One `.sheet` plus one `.alert` on the same view is fine.

**`Text(someString)` does not parse markdown** — only `Text("literal")` does.
`AttributedString(markdown:)` fixes inline styling and nothing else: Foundation's parser
does no block layout, so headings keep their `#` and lists collapse onto one line unless
you pass `inlineOnlyPreservingWhitespace`. `MarkdownText` therefore splits into blocks
itself and uses Foundation only for the inline run inside one.

**Don't use `AsyncImage` for attachments.** The route is behind the dashboard token and
`AsyncImage` takes a URL and can set no headers — which is why the *web* client has to put
`?token=` in every `<img src>` and live with it in the DOM. The app fetches bytes through
`APIClient` and keeps the token out of anything URL-shaped.

**Don't downscale images before upload.** It looks like an obvious win for cellular, but
`src/attachments.ts` deliberately keeps the original and caches a 1024px copy for the
model, noting `look_at_image` could be pointed at a higher ceiling. Shrinking on the phone
destroys data the server means to keep.

**Zooming a `scaledToFit` image by growing its frame does not work.** Inside a 2.5× frame
the image is still letterboxed within *that* frame, so a `ScrollView` origin lands in the
black margin and the picture appears to vanish. `AttachmentViewer` keeps the fitted size
and uses `scaleEffect` plus a clamped offset instead.

**`State(initialValue:)`, not `onAppear`, to seed a form.** `onAppear` fires again when a
sheet returns and will clobber what the user typed.

**A `View`'s `init` runs on every body evaluation.** During a live turn the thread
re-renders several times a second, so anything expensive in an init — markdown parsing, in
this case — is paid for by every turn in the thread on every tick. `BlockCache` exists for
that reason.

**`NavigationLink` inside a `List` row draws its own disclosure chevron.** Fine for a row,
wrong for a chip in a horizontal strip. Use a plain `Button` plus
`.navigationDestination(item:)`.

**The server's JSON is snake_case** because it comes straight out of SQLite rows, so most
models need `CodingKeys`. Adding the models is the bulk of the mechanical work in any new
tab, not the views.

**Nullable columns are nullable.** `messages.content` is null for an assistant message that
was only tool calls; decoding the trace with a non-optional `String` throws and takes the
whole run detail with it.
