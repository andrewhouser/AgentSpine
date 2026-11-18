# The native Mac app, and a UI refresh for both platforms

Written 2026-11-18. Planned, not started. Nothing here has been built.

The goal: a SwiftUI app for macOS 15+ that feels native on the MacBook Pro and the Mac Mini,
and a visual refresh that the iPhone app gets at the same time. Both are clients of the one
server. There is no shared database and no second brain.

Structured like [PLAN-build-loop.md](PLAN-build-loop.md): decisions and invariants first, then
phases ordered so each is useful alone.

## Decisions already made

| Question | Answer |
|---|---|
| Shared "brain"? | No. The dashboard server stays the single writer. The apps are clients over Tailscale. |
| Where does the server run? | Unchanged (the 16 GB Mini). Moving it to the model host is a separate decision. |
| Framework | SwiftUI, as native as possible. No web shell. |
| Minimum OS | macOS 15. iOS stays at 17 for now. |
| UI refresh | Done in the shared layer so the iPhone gets it too. |
| Offline | Out of scope here. A read-only cache belongs in the iPhone app, as a follow-up (see the end). |
| Meeting audio | Captured on the Mac, streamed to the server. Transcription and extraction stay on the server. |

## Invariants

1. **The server owns state.** The apps hold no authoritative data. Anything they keep is a
   cache that can be deleted without loss.
2. **No new write paths around the broker.** The Mac app calls the same API as the web client
   and the iPhone. Approvals still go through the confirmation queue.
3. **Inference never moves to a client.** Transcription stays on the model host, per
   SPEC section 15 and MODELS.md.
4. **The dashboard token stays in the Keychain**, never in a plist or a defaults key.
   (`Core/Keychain.swift` already does this. Keep it.)
5. **Meeting audio is private by default.** Capture only starts on an explicit user action,
   shows a persistent recording indicator, and the existing `sensitivity: "private"` and
   project-linked local-only rules apply unchanged on the server.

## What exists today

`ios/AgentSpine` is about 8,600 lines of SwiftUI. `Core/` has `APIClient`, `Models`,
`AppState`, `RunStream` (SSE), `Keychain`, `Settings`, `Dictation`, `ReadAloud`, `HandsFree`.
`Views/` has one file per tab, twelve tabs in `RootView`. The Xcode project uses a
file-system-synchronized group, so new files are picked up without editing the `.pbxproj`.

UIKit is used in only six files: `SettingsView`, `AttachmentImage`, `HandsFree`, `Settings`,
`PushManager`, `AgentSpineApp`. That is the whole porting surface for the data layer. The
audio files (`Dictation`, `ReadAloud`, `HandsFree`) use AVFoundation or Speech and need a
look in phase 1.

## The one real server change

Meeting capture is **server-side today**. `POST /api/meetings` takes a `device` name and
`src/meetings/session.ts` starts ffmpeg against an audio device attached to the machine
running the server (`src/meetings/audio.ts`). A laptop's microphone is not attached to that
machine, so the Mac app cannot use this path.

What the Mac app needs is an **ingest path**: the client captures audio, sends 16 kHz mono
s16le PCM in small chunks, and the server feeds it into the same pipeline ffmpeg feeds
today. Everything downstream (VAD, transcription, diarization, extraction, coach) is
unchanged.

Open design points for that endpoint, to be settled in phase 5 and recorded in SPEC 15:
- Transport: chunked POST per few seconds, or a WebSocket. Chunked POST fits the existing
  `readBody` server and survives Tailscale reconnects more simply. Lean this way.
- Resume: a chunk carries a sequence number, so a dropped connection does not lose or
  duplicate audio. The client buffers unsent audio on disk while the server is unreachable.
- Policy: `startMeeting` checks the device against an allowlist. A client-sourced meeting
  needs an equivalent (a named, allowlisted "remote source"), not a bypass of that check.
- One recording at a time, as now (`/api/meetings/live`).

This is the only phase that touches `src/`. It follows the `src/` rules in CLAUDE.md:
erasable TypeScript, no new runtime dependencies, tests as plain node scripts.

## Phases

Each is useful alone. Order is deliberate: the riskiest structural step goes first.

### Phase 1: extract `AgentSpineKit`

Move the platform-neutral half of `Core/` into a local Swift package that both apps import:
`APIClient`, `Models`, `RunStream`, `Keychain`, and the non-UI parts of `AppState` and
`Settings`. Keep `PushManager`, `HandsFree` and similar platform code in the app targets, or
behind a small protocol if the shared code needs them.

Done when: the iPhone app builds and behaves identically, now importing the package.
Nothing visible changes. This is the step that proves the shared approach, so do not start
phase 2 until it is green on a device.

Risks: access control (`internal` types that now cross a module boundary need `public`),
and `@Observable` state that mixes data and UIKit calls. Expect a mechanical but wide diff.

### Phase 2: design system

Do the refresh once, in the package, before building more screens on top of the old look.

- Replace the ad hoc styling in `Chrome.swift` with a small token set: spacing scale,
  type scale, semantic colors (light and dark), corner radii, and the verdict and status
  colors currently hard-coded in `VerdictBadge`.
- Shared components that both platforms use: thread bubble and tool-call row, approval
  card, status badge, empty state, error notice, markdown text.
- Platform adaptation lives in the components, not the screens: pointer hover and
  context menus on Mac, larger touch targets on iPhone.
- Keep Dynamic Type, VoiceOver labels and Reduce Motion working. Check them as each
  component lands, not at the end.

Deliverable: a component gallery (a SwiftUI preview file) that shows every component in
light, dark and large type. Decide the actual look here. Two or three directions as
screenshots from the previews, then you pick.

Done when: the existing iPhone screens use the new components and look as intended.

### Phase 3: Mac shell and Threads

New macOS target, deployment target macOS 15.

- `NavigationSplitView`: sidebar of sections, content list, detail pane.
- Threads list and live thread view first, since that is where the work happens.
- Mac conventions: real toolbar, ⌘N new thread, ⌘K search, ⌘, Settings scene,
  keyboard navigation in lists, multiple windows (a thread can pop out), standard menu
  bar commands, drag files and images into the composer.
- Connection setup: server URL and token in a Settings scene, token in the Keychain.
  Same Tailscale `ts.net` ATS exception the iPhone uses.

Done when: you can run a conversation, see tool calls stream in, and approve or reject
inline on the Mac, against your real server.

### Phase 4: remaining sections and menu bar

- Port the other tabs as sidebar sections: Tasks, Study, Schedules, Projects, Files,
  Clients, Search, Meetings, Builds, Activity, Memory, Proposals, Agents.
- On the Mac, Builds diffs and Activity traces get the most from the larger window, so
  give those real two-pane layouts rather than stretching the phone layout.
- Menu bar extra: count of threads waiting on you, quick capture field, pending
  approvals with Approve and Reject.
- Notifications. APNs for a Mac app needs its own App ID entitlement and device
  registration (`devices` endpoints exist). Confirm the server's push path handles a macOS
  device token before relying on it. Fall back to local notifications while the app is
  running if it does not.

Done when: nothing you use on the web UI is missing, apart from whatever the iPhone
README already lists as deliberately omitted.

### Phase 5: meeting audio capture

Server (see "The one real server change") and client.

- Microphone via `AVAudioEngine`, converted to 16 kHz mono s16le.
- The far side of a call via ScreenCaptureKit audio capture, which needs the Screen
  Recording permission. Treat this as optional and detect its absence gracefully, so the
  mic-only case is fully usable.
- Persistent recording indicator in the menu bar and window, one-click stop, and a clear
  state when the connection is down and audio is buffering locally.
- Permissions flow with plain explanations of each prompt.
- Coach and live transcript views (already on the iPhone) get a Mac layout, ideally a
  floating side panel that stays out of the call window.

Done when: a real meeting recorded from the laptop shows up in Meetings with a transcript
and extracted items, and the confirmation-queue rules from SPEC 15 are untouched.

### Phase 6: polish and release hygiene

- Window state restoration, sensible default window sizes, full-screen behavior.
- Accessibility pass on the Mac: VoiceOver, keyboard-only use, Increase Contrast.
- App icon and menu bar icon variants.
- Update `README.md`, `ios/README.md` and `ios/ROADMAP.md`, and add a Mac section.
  Record the final design in this document's Status section, as other PLAN docs do.
- Signing and install: same Apple Developer team, a development-signed build on each Mac.
  No App Store, as with the iPhone app.

## How we will test

This sandbox is Linux. SwiftUI macros do not expand here, so Swift can be written and
parse-checked (`swiftc -parse`) but **not compiled or run** by me. Practical consequences:

- Each phase ends with a short "press ⌘R and check these things" list, written by me and
  run by you. Phases are small enough that a failure is easy to place.
- The server side of phase 5 is fully testable here with plain node scripts, including a
  fake chunk stream and a dropped-connection case.
- Throwaway-server testing follows `ios/ROADMAP.md` ("How to run and test this"): a
  demo instance on :8799 with copied `spine.db` and `policy.json`, never the real ledger.
- Anything that needs real hardware (microphone, ScreenCaptureKit, push) is verified by you
  on a Mac, and I will say plainly which checks I could not run.

## Risks

| Risk | Mitigation |
|---|---|
| Package extraction breaks the iPhone app in a wide, hard-to-review diff | Phase 1 is its own change and must be green on a device before anything else starts |
| Redesign churn after screens already exist | Design system lands before the Mac screens, and screens use components only |
| Screen Recording permission friction | Mic-only is a complete, supported mode |
| Audio lost on flaky Wi-Fi | Sequence numbers plus a local disk buffer, tested server-side |
| macOS push registration differs from iOS | Verify early in phase 4, with a local-notification fallback |
| No compiler in this sandbox | Small phases, explicit verification lists, you build on the Mac |

## Follow-up: iPhone offline cache

Separate from this plan. A read-only mirror of threads, tasks, files and recent run results
(SwiftData or SQLite), populated while connected and shown, clearly marked as cached, when
the server is unreachable. Writes are not queued. Approvals in particular must never be
replayed later, because a stale approval is a security problem, so an offline iPhone shows
the question and tells you it can only be answered once reconnected. Build it on top of
`AgentSpineKit` after phase 1, and it can then be offered to the Mac app too.

## Questions to settle before phase 2

1. Look and feel: more system-native (standard materials, minimal custom color) or a
   stronger identity of its own? Phase 2 will show options either way.
2. Should the iPhone's twelve-tab structure change as part of the refresh? On the phone it
   folds eight of them into "More".
3. Do you want the menu bar item to be the primary entry point, or the main window?
