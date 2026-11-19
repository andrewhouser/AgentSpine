# The native Mac app, and a UI refresh across every client

Written 2026-11-18, updated the same day after `main` gained Heads-up (phases 0 to 5) and
`PLAN-heads-up-next.md`. Approved to start. Nothing here has been built yet.

The goal: a SwiftUI app for macOS 15+ that feels native on the MacBook Pro and the Mac Mini,
and a visual refresh that the iPhone app and the web client get too. Both are clients of the one
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
| Web client | Gets the same identity in a late phase (7), as a **styling change only**: no layout, feature or structure changes. |
| Visual identity | A strong one of its own: "the spine". See "Design direction" below. |
| Main entry point (Mac) | The main window, Claude-like: sidebar of threads, a conversation, a composer. The menu bar item is secondary. |
| iPhone tab structure | Restructured. The user chooses which tabs sit in the bar and which fold under More, in Settings, by drag and drop. |
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

## Design direction: the spine

Approved by the user on 2026-11-18, from mock screens (a Design canvas, not code). The mocks
are a reference, not a spec: exact colors, type and spacing get settled in phase 2.

- **The motif.** Every agent turn hangs on a thin vertical line. Each tool call is a node on
  it, colored by the broker's verdict (executed, denied, queued, dry run, error). A hollow
  amber node is a question waiting on the user, and carries Approve and Reject inline. The
  same line appears in the Mac thread, the iPhone thread and the active-tab marker.
- **Ground and accent.** Deep blue-slate surfaces with a cool blue accent and bone-colored
  text. Verdict colors are separate from the accent. Deliberately not cream, serif and
  terracotta, so it does not read as a copy of Claude or ChatGPT.
- **Type.** A characterful grotesque for titles, a clean sans for reading, a mono face for
  tool names and numbers. Final faces are chosen in phase 2; SwiftUI needs them bundled, so
  check licensing and size then.
- **Mac layout.** Sidebar (new thread, search, sections, recent threads, connection status),
  a centered conversation column, a composer with attach, dictate and tier. Meetings get a
  transcript column plus a coach column with context cards and the possible action items.
- **Light theme.** Not drawn yet. Phase 2 defines both from one token set.

## Interaction with the Heads-up work

`PLAN-heads-up-next.md` is the spec for what remains of Heads-up. It touches the same files
and screens this plan restyles, so the order matters.

| Heads-up item | Effect on this plan |
|---|---|
| A1 build the iOS app, A2 `npm run check` on Node 24 | Gate for phase 1. The refactor starts from a tree known to compile. |
| B, E, F (server: outcomes, retention, digest) | No overlap. Server only. Can proceed in parallel. |
| B (Settings line per kind: "offered 14, you acted on 3") and D (lead-time overrides in Settings) | New Settings UI on web and iOS. Build them with today's components if they land first; phase 2 and phase 7 restyle them. Do not block either plan on the other. |
| G Live Activity | Needs a second Xcode target (widget extension). Do it **after phase 1**, so the project file is edited once in a known state, and note that it is iPhone only (no Mac equivalent). |
| H2 web sidebar badge | Small change in `Sidebar`; phase 7 restyles the same component. Take it before phase 7 and keep the styling untouched. |
| Per-item answer token and the `HEADSUP` notification categories | The Mac app needs the same narrow-token answer call and categories. The call lives in the shared `APIClient`, so the Mac gets it from phase 1. |

Other effects now recorded:
- The mock screens need a Heads-up screen (offers, result cards, "Dates it noticed", the three
  answers). It is drawn in phase 2 before the Heads-up screen is built on either platform.
- The default iPhone tab bar is Threads, Heads-up, then two more, and the customization screen
  lists thirteen tabs. The saved order has to cope with tabs added by later app versions.
- Heads-up's "Yes is the consent" rule and quiet hours are server decisions. The apps only show
  and answer; they never decide.

## What exists today

`ios/AgentSpine` is about 8,600 lines of SwiftUI. `Core/` has `APIClient`, `Models`,
`AppState`, `RunStream` (SSE), `Keychain`, `Settings`, `Dictation`, `ReadAloud`, `HandsFree`.
`Views/` has one file per tab, thirteen tabs in `RootView` (Heads-up arrived on `main` as the second tab, so it is one of the
four iOS shows without opening More). The Xcode project uses a
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

### Phase 1: share the platform-neutral code with the Mac target

**Changed from the first draft** (2026-11-18, agreed with the user). The plan was a local Swift
package. That needs `public` on about 2,000 lines of types, properties and initializers, with no
compiler in this sandbox to catch a miss. Instead the files are **compiled into both targets**,
which needs no access-control changes. A package can still be cut later, with a compiler to
check it.

What is shared, all in `ios/AgentSpine/Core/` and not moved:
`Models.swift`, `APIClient.swift`, `RunStream.swift`, `AppState.swift`, `Settings.swift`,
`Keychain.swift`. An audit found them already free of UIKit apart from two spots, fixed in this
phase:
- `Settings.swift` named the device "iPhone" when UIKit is missing. It now names a Mac by its
  computer name.
- `Keychain.swift` would have used macOS's legacy login keychain, which ignores the accessibility
  class and can prompt after a rebuild. On macOS it now sets `kSecUseDataProtectionKeychain`.
  iOS behavior is unchanged. The service name stays `net.agentspine.ios` on both, so the
  token already saved on the phone is not orphaned.

Stays per-platform: `PushManager` (APNs registration differs on macOS), `HandsFree` (uses
`UIApplication`), and all views. `Dictation` and `ReadAloud` use AVFoundation; check them when
the Mac needs them in phase 5, since `AVAudioSession` does not exist on macOS.

Nothing is moved, so `test/ios-models.test.mjs` keeps working as it is. It still extracts the
structs from `Core/Models.swift` and compiles them against Foundation alone, which is exactly
the property the Mac target needs too. Keep `Models.swift` free of UIKit and SwiftUI.

Baseline first. The iOS Swift for Heads-up (phases 4 and 5) has never been compiled, and
`PLAN-heads-up-next.md` A1 asks the user to build it. Do that before anything else here, so a
compile error from Heads-up cannot be mistaken for one from this phase.

**Xcode steps for the user** (Xcode writes the project file, so there is no hand-edited
`.pbxproj`; about 10 minutes):
1. Build and run the iPhone app on `main` plus these two small edits. Confirm it behaves as before.
2. File, New, Target, macOS, App, named `AgentSpine Mac`, SwiftUI, deployment target macOS 15.
   Delete the generated `ContentView.swift` and the `@main` app file it makes, or keep the app
   file and remove its placeholder view; phase 3 replaces it.
3. Select each of the six files above in the project navigator, open the File Inspector, and tick
   `AgentSpine Mac` under Target Membership. The iPhone target stays ticked.
4. Add `https://` handling by giving the Mac target the same `ts.net` App Transport Security
   exception the iPhone has in `Supporting/Info.plist`, and set a development signing team.
5. Build the Mac target. Expect it to fail on anything iOS-only I missed; paste the first errors
   and I fix them in one pass.

Done when: the iPhone app is unchanged and green, and the Mac target compiles the six shared
files and launches an empty window. The Mac app's first real screen is phase 3.

Risks: a file that looked neutral but uses an iOS-only API (this is what step 5 finds), and
`@Observable` state that quietly assumes iPhone behavior, such as `scenePhase` handling.

### Phase 2: design system

**Status (2026-11-18).** Started. Done and tested without a Mac:
- `design/tokens.json` is the single source: both themes, derived tints, fonts, radii, spacing,
  type sizes and the verdict mapping. Light and dark come from the approved mocks, and light is
  new (cool paper ground, deeper blue accent).
- `design/generate.mjs` (no dependencies, `npm run design`) writes
  `web/src/styles/tokens.generated.css` and `ios/AgentSpine/Design/Tokens.generated.swift`.
  Both are committed. `ios/AgentSpine/Design/DesignColor.swift` is the small hand-written helper
  that makes a light and dark colour on UIKit and AppKit.
- `test/design-tokens.test.mjs` is in `npm test`. It fails on a stale generated file, a theme
  missing a name, any text or status colour under WCAG AA (4.5:1) on any surface, and any custom
  property `global.css` defines today that the generated file lacks. Both failure modes were
  checked by breaking a token on purpose.
- The Heads-up screen is drawn for Mac and iPhone on the design canvas, with the due dates hung
  on the spine (hollow amber waiting, solid blue researched, green tracking).

Not done yet, and why:
- **The Swift is uncompiled.** `Tokens.generated.swift` and `DesignColor.swift` have never met a
  compiler. For the Mac target, tick membership on both in Xcode as with the six shared files.
- **Shared SwiftUI components: first pass written (2026-11-19), not run.** In
  `ios/AgentSpine/Design/Components/`: `VerdictBadge` and `StatusChip`, `ErrorNotice` and
  `EmptyNotice` (moved out of `Chrome.swift`, same call sites), `SpineRow` (the node and line),
  `ApprovalPrompt` (named so it does not collide with the live `ApprovalCard` in `Views/`, which owns the network call and still needs to adopt it), `ThreadBubble` (now used by `TurnView` and `LiveTurnView`), and `ComponentGallery` (previews in light, dark and large type; iPhone target
  only because it shows `ToolCallRow`). `Design/SpineFont.swift` picks the token families and
  falls back to system fonts. `ToolCallRow` uses the tokens. The files are in the Mac target's
  membership list except the gallery. Typechecked with `swiftc`, then built in Xcode for the iPhone and Mac targets with no
  errors (2026-11-19, reported by the user). Not yet run on a device or checked in the gallery
  previews. `MarkdownText` moved from `Views/` to `Design/Components/` and restyled (parser untouched) so the Mac target can share it. Adopted so far: `ThreadBubble`, `ToolCallRow`, the notices, `MarkdownText`, the live `ApprovalCard` and `AttentionDot` (now the token amber, hollow) and an app-wide accent tint. Screen ground: `spineScreen()` (`Design/Components/SpineScreen.swift`) on each tab's navigation stack (macOS gets a plain background); full coverage of pushed screens needs iOS 18, grouped-list rows keep the system cell fill. Tab bar customization is built (`Core/TabLayout.swift` with a compiled test in `test/ios-tab-layout.test.mjs`, `Views/TabBarSettingsView.swift`, `RootView` now renders `settings.tabs`); Xcode build and a drag test on a device are pending. Still to do: the other screens' own styling (`.secondary`, system colours, `Color(.…Background)`), Dynamic Type and
  VoiceOver checks on a device, and choosing between directions from the gallery.
- **Fonts: bundled in the apps (2026-11-19), web still to do.** Bricolage Grotesque, Instrument
  Sans and JetBrains Mono (variable TTFs, about 0.9 MB, SIL OFL, licences in
  `ios/AgentSpine/Fonts/LICENSES-OFL.txt`, fetched from the families' official GitHub repos).
  `SpineFont.registerBundled()` registers them at launch in both apps; if a file is missing the
  system fallback still applies. Not yet checked on screen: whether SwiftUI picks the right
  default instance and weights from the variable files, especially Bricolage's optical size.
  The **web** must self-host them rather than use a font CDN (private tailnet, local-first).
  That belongs to phase 7: `web/public/fonts/` plus `@font-face`, and `src/server.ts` has no
  `.ttf` entry in its MIME map (only `.woff2`), so either add one or convert to woff2.
- Applying the tokens to the existing iPhone screens' fonts and grouped-list rows.

Do the refresh once, in the shared code, before building more screens on top of the old look.

- Replace the ad hoc styling in `Chrome.swift` with a small token set: spacing scale,
  type scale, semantic colors (light and dark), corner radii, and the verdict and status
  colors currently hard-coded in `VerdictBadge`.
- iPhone tab bar customization: a Settings screen where the user reorders and chooses what
  is in the bar. Reordering is **drag and drop**: a SwiftUI `List` in edit mode with
  `.onMove`, with a live preview of the bar above it. The first slot is Threads and fixed;
  the next few slots are the bar and the rest fold under More. The mock uses up and down
  buttons only because a static mock cannot drag. VoiceOver needs the move actions
  (`accessibilityAction`) as well, since drag is not operable there. Persist the order in
  `UserDefaults` through `Settings`, and handle new tabs added by later app versions (append
  them under More) and tabs removed (drop them).
- **One token source for all three clients.** Colors (both themes), type scale, spacing,
  radii and the verdict colors live in a single file under `design/`. A small script, with no
  new runtime dependency, generates the web's CSS custom properties and the Swift constants
  from it, so the spine cannot drift between platforms. The generated files are committed,
  and `npm run check` fails if they are out of date.
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

- Port the other tabs as sidebar sections: Heads-up (with its preferences screen and the
  three notification answers), Tasks, Study, Schedules, Projects, Files,
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

### Phase 7: web client restyle (styling only)

Give `web/` the same identity, using the generated tokens. Scope is deliberately narrow.

In scope:
- Replace the colors, fonts, spacing and radii in `web/src/styles/global.css` (about 177
  lines, about 31 custom properties today) and in component CSS with the generated tokens.
  Both themes.
- Draw the spine in the conversation: the vertical line and verdict-colored nodes in
  `ChatView`, `AssistantMessage` and `DecisionBadge`, and the hollow amber node on
  `ApprovalCard`. These are CSS and small markup changes, not behavior changes.
- Restyle the existing components in place: `Sidebar`, `Composer`, `PageHeader`, `ListPage`,
  dialogs and the rest.

Out of scope for this phase:
- Layout and navigation changes. The web UI keeps its current structure. It does **not** adopt
  the Mac's main-window layout.
- New features, new routes, API changes, or reworking component logic.
- Dropping or renaming any element a test or the server depends on.

Done when: every existing screen renders in the new identity in light and dark, nothing moved
or went missing, `npm run web:build` and `npm run lint:css` pass, and `npm run check` is green.
Verify by walking each view once in a browser, since there are no visual tests; say which
views were checked. A later change to the web layout is a separate decision.

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
| Web restyle regresses a screen nobody looks at | Phase 7 walks every existing view in both themes, and keeps markup and behavior unchanged |
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
the shared files after phase 1, and it can then be offered to the Mac app too.

## Decisions from the questions

1. Look and feel: a strong identity of its own (the spine).
2. iPhone tabs: restructure, with the order and the bar contents set by the user, by drag
   and drop.
3. Mac entry point: the main window. The menu bar item stays a secondary surface for
   approvals and quick capture.
4. Web client: restyle only, in phase 7, from the shared tokens. No layout or feature changes.

## Approval gate

Nothing in this plan is implemented. Phase 1 starts only when the user says so.
