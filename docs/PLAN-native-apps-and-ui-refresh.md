# The native Mac app, and a UI refresh across every client

Written 2026-11-18, updated the same day after `main` gained Heads-up (phases 0 to 5) and
`PLAN-heads-up-next.md`. Approved. **Phase 1 is done and verified on a Mac; phase 2 is partly done.** See "Where this stands" at the end for the handoff.

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

**Status: done (2026-11-19).** The iPhone app builds, the `AgentSpine Mac` target builds and opens a window, and `npm run check` passes on a Mac with Node 24. The text below is the record of what was decided and done.

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

Done when: the iPhone app is unchanged and green, and the Mac target compiles the shared
files (six here, plus the two `Design/` files from phase 2) and launches an empty window. The Mac app's first real screen is phase 3.

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
- Screen fonts: the simple `.font(.caption)` style forms in `Views/` now use `SpineFont` (2026-11-19). Left as they were: fixed-size symbol fonts, `.system(...)` mono forms and a few conditional weights. Grouped-list rows still use the system cell fill.

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

**Status (2026-11-19). Complete.** Built and confirmed working on the Mac by the user: the split view,
thread list with the waiting dot, ⌘, Settings scene (`SwiftUI.Settings`, because our
`Settings` class shadows the scene), the thread view with live streaming (`MacThreadDetail`,
the same ledger-plus-stream rule as the phone), the composer (`MacComposer`: Return sends,
Shift-Return a new line), the inline `MacApprovalCard` (goes through `AppState.answer`, no new
write path), ⌘N for a new thread (`MacNewThread`), ⌘K search (`MacSearch`, the same
read-only `/api/search` as the phone), the model tier menu in the thread toolbar, pop-out thread
windows (context menu, "Open in New Window"), and image attach by button or drop, in threads
and new threads. Details worth knowing:
- Windows showing the same thread stay in step through `MacThreadHub`: a send, a finished turn,
  an approval or a tier change nudges the others, which reload and attach to the run in flight.
- A thread gets its title from the server after the turn is saved, which can take a while on the
  local model, so `AppState.refreshUntilTitled` polls the list for about 90 seconds.
- Attaching an image in ⌘N creates the thread first, because the server only binds an upload to a
  turn in the same conversation. Abandoning the screen after that leaves an empty thread.
- Keyboard navigation in the lists is the native `List` behaviour (↑/↓), nothing custom.
- Images only: PNG, JPEG, HEIC and WebP. No clipboard paste or drag from a web page yet.
`ToolCallRow`, `PrettyJSON`, `AttentionDot`, `LiveTurnView` and `DecisionNote` live in the shared
`Design/Components/`. The `ComponentGallery` Mac previews and the done-when test against the real
server were checked by the user. Phase 3 is complete; hands-free is not planned for Mac.

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

**Status (2026-11-19).** Started. Written, not yet built or run: the sidebar is now sections
(`MacSection`), and every section except Threads is the phone's own screen in a navigation stack,
shared between the targets rather than copied. That is Heads-up (with its preferences as a sheet
from the toolbar), Tasks, Study, Schedules, Projects, Files, Clients, Meetings, Builds, Activity,
Memory, Auto-approvals and Agents. The iOS-only modifiers those screens used are wrapped in
`Design/PlatformShims.swift` (inline title, number pad, capitalization, grouped list style,
leading and trailing toolbar placement, `PlatformImage`), so the phone is unchanged. Search is
⌘K rather than a section, and Settings is the ⌘, scene. In Projects a thread opens in
`MacThreadDetail`. (Builds, Activity and the menu bar extra were built later; see below.)

**Mac notifications (2026-11-19).** Local, while the app runs: `MacNotifier` posts a banner
"Approval needed" with the summary when `MacApprovalWatcher`'s 30-second poll sees an approval it
has not seen, and only when the app is not in front. The first poll after launch only seeds the
set, so what was already waiting is not news. A click activates the app and opens that thread
(`.macOpenThread`, handled in `MacRootView`); banners for approvals answered elsewhere are taken
down. The banner has no Approve or Reject: answering stays in the app, through the confirmation
queue. The system permission prompt appears the first time there is something to say, not at
launch. Builds with no warnings; not yet seen: the permission prompt and a real banner need your
build running while another app is in front. Not done: replies finishing and Heads-up items (the
phone gets those by push), and real push to a Mac, which needs `src/push/apns.ts` to stop using
one global `apns-topic`.

**Mac layout follows the UI Directions (2026-11-19).** Compared against "AgentSpine UI
Directions" (Desktop PDF: Mac Threads, Meetings with the coach column, Heads-up; phone Threads,
a thread, the tab bar, Heads-up). The first Mac shell had drifted from this plan's own "Mac
layout" line: sections in a sidebar, then a separate thread-list column, then the thread. It is
now what the directions draw: one sidebar (`MacSidebar`) holding New thread (⌘N), search (⌘K),
the sections, the thread list (hollow amber dot = a question waiting, solid accent dot = unread
reply) and a connection footer, with a single detail pane. Study, Clients, Activity, Memory,
Auto-approvals and Agents fold under "More" so the threads keep the room. `MacThreadList` is
gone. Built and driven in the running app: both Mac and iPhone schemes build.

Two things that cost time and are worth knowing. A sidebar row needs `.tag` as its *last*
modifier: with `.badge` after it the `List` cannot see the tag and the row silently ignores
clicks (found by clicking through the running app, not by reading the code). And the first
launch of a freshly built copy can show "Not connected" for a moment before the Keychain read
lands; wait and look again before concluding the settings are lost.

**The thread is now a spine (2026-11-19).** `MacTurnSpine` lays a turn's agent side onto the
existing `SpineRow`: a solid node per tool call in the verdict's colour, the reply beside the
line, a hollow amber node where a question is waiting. One view draws a finished turn (from the
ledger) and the live one (from the stream), so a turn cannot look different the instant it stops
streaming. `ToolCallRow` gained `flat` (one line: tool, target, verdict; no box) for the rail; the
phone keeps the boxed default and `LiveTurnView` is unchanged. Your messages stay as bubbles
outside the rail, as in the directions. A waiting call and its approval are one node: nothing
links a confirmation to its action in the API, so `MacTurnSpine` pairs them on the client by tool
(and by arguments when the call has them; a live call has none yet), each confirmation taking the
first unclaimed queued call, and the approval card replaces that call's row. A confirmation with
no matching call stays below the reply. Builds; not yet seen with a real pending approval. If two
queued calls share a tool and arguments the pairing is by order, which is safe because the card
still answers by confirmation id.

Thread top bar: the "Local only" pill is built (`MacThreadDetail.localOnlyPill`). It shows while
the thread is not pinned to Cloud and no recorded turn ran at Cloud, so it describes what has
happened, not what the next Auto turn may do; it says nothing about sensitivity, which the
server enforces. The pill sits outside macOS 26's toolbar glass plate (`sharedBackgroundVisibility`),
which had drawn a second capsule round it. The speaker button reads the latest reply through the
phone's `ReadAloud` (now shared: its `AVAudioSession` calls are iOS-only); it needs the server's
Kokoro voice service, see `docs/VOICE.md`. Heard on a real reply: not yet. The inspector button
opens the system inspector column (`MacThreadInspector`, remembered in `mac.threadInspector`),
modelled on Claude's own panel: a sectioned, read-only summary of the thread the view already
holds, so it makes no request of its own. Four cards: Model (what the thread is pinned to, and the model that actually answered each turn,
with the provider host for Cloud; a warning when Cloud was asked for and a local model answered),
Context (`Turn.contextUsed`, grouped into Memories, Earlier conversations and Also in view by the
server's "memory: " / "earlier conversation: " prefixes, each group collapsed), Tool calls (by
tool, a bar for the count and the worst verdict) and Child runs. Builds; redrawn from a flat list
to cards; not yet seen running.

**What actually served a turn.** `runs.tier` is the tier that was *asked for* (the pin, or the
dispatcher's sizing), not the one that answered. An unconfigured Cloud tier quietly becomes
`standard` (`resolveTier`, by design: "degrading safely"), a private request is pinned local, and
the router can fall back after a failure, so a thread pinned to Cloud could run locally with
nothing to show it. The router now writes what served each call to `runs.served`
(`store.noteServed`: latest model, tier and route, plus a sticky `cloud` flag, true if any call of
the run left the machine), the thread API returns it as `served`, and `/api/status` returns
`cloud: { configured, host, model }`. The "Local only" pill reads `served.cloud` and falls back to
the asked-for tier for older turns. Turns from before this have no record, so they show the tier
with "model not recorded". Needs a dashboard restart; tested in `test/served.test.mjs`.
 It shows finished turns only; the run in flight appears when it ends.

Still different from the directions, in the order worth doing:
- **Heads-up timeline rail: built, not yet seen running.** The Dates column is built
  (`MacHeadsupView`: the phone's list with its date sections off via `showsDates`, beside
  `MacHeadsupDates`: "It noticed" with Remember it and Not a date, "It remembers" with a Forget
  context menu). The list now hangs on the spine (`timeline: true`): each item is a `SpineRow`
  (hollow amber node while it waits on a yes, a plain node otherwise) under a mono date line
  ("Fri Nov 20 · in 2 days", amber while open). Both schemes build. Not yet done: the directions'
  coloured nodes for tracked flights and researched items. The phone keeps the plain list.
- **Sidebar counts: Tasks and Schedules built, Builds not.** `/api/status` now also returns
  `tasks` (open, capped at 300 like the list), beside the `schedules` it already had; the
  connection footer's 30-second probe writes both to `AppState`, so the badges cost no extra
  request. Needs a dashboard restart to show Tasks. Builds has none: a build is a view over the
  actions log, and the directions' "1" has no definition yet (in flight? failed?).
- **Footer status: built, needs a dashboard restart.** The footer shows the server's round trip
  (`/api/status`) and host, and now the directions' "Model host connected 14 ms" line under it.
  `/api/status` carries `model: { ok, ms }` from `src/model-probe.ts`: a `GET <base>/models` to
  the local model host (no model is loaded or run), 1.5 s timeout, cached ten seconds so several
  windows do not each ask the host. Any answer below 500 counts as up. The cost: while the host
  is down, a status call can wait up to 1.5 s once per ten seconds. Tested in
  `test/model-probe.test.mjs`; not yet seen in the app against the real host.
- **Search label.** The directions say "Search everything"; `/api/search` covers threads, so the
  field says "Search threads" until it covers more.
- **Live meeting with a coach column** is phase 5.

**Push finding.** The server cannot yet push to a Mac. `/api/devices` accepts any hex token, but
`sendToDevice` in `src/push/apns.ts` sends one global `apns-topic` (`APNS_BUNDLE_ID`), and the
Mac's bundle id is different (`...AgentSpine.mac`), so APNs would refuse its token with
`TopicDisallowed`. A native Mac push needs a per-device topic stored on the device row, the push
entitlement on the Mac target and a Mac registration. Until then the Mac uses local
notifications while it runs.

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

**Status (2026-11-19).** Started with the screen, not the audio. `MacMeetingsView` is the history on
the left (a "Now" row while something records) and, on the right, `MacLiveMeeting` for a meeting in
progress: the header (red dot, title, a clock that ticks by itself, "Stays on your network", Stop
recording), the transcript grouped by speaker with a colour per speaker and a "Listening" line, and
the Coach column from the directions: Ask now, "Suggested for you" (the coach's notes), "From earlier
notes" (the retrieved context cards) and "Possible action items" (the queued work items, hollow amber,
with the line that they go to the confirmation queue). A finished meeting opens the phone's own
detail screen. It is polled every 3 seconds like the phone, and it uses only routes that exist, so
`src/` is untouched. It builds on both targets; it has not been seen against a live meeting.

Server ingest is built (2026-11-19) and recorded in SPEC 15: `POST /api/meetings/remote` starts a
meeting from a named source in `policy.audio.remoteSources`, and `POST /api/meetings/:id/chunks?seq=N`
carries 16 kHz mono s16le PCM in order, with a retry acknowledged and a gap refused with the number
wanted. `GET /api/meetings/live` now carries `nextSeq`. It needs a dashboard restart, and
`"remoteSources": ["mac"]` added to the `audio` block of `policy.json` (with `enabled: true`), which
only the user can edit. No client uses it yet, so the Mac still records the server's microphone.

Mic capture is built (2026-11-19), and it builds on both targets, but it has not been run against a
live meeting or a real microphone. `MacMicCapture.swift` taps `AVAudioEngine`, converts to 16 kHz
mono s16le and writes a file to `Application Support/AgentSpine/spool/meeting-N/` every three
seconds; a sender posts them oldest first and deletes each once the server has it, so the disk is the
buffer. Offline, it keeps trying (1 s backing off to 10 s) and the live view says how many seconds are
kept on this Mac. A 409 asks `/api/meetings/live` for `nextSeq`: it skips a chunk the server already
has, and gives up if the server stopped the meeting (its ten-minute idle limit), leaving the unsent
files on disk with a notice. Stop waits until the server has every chunk, then stops the meeting;
"Stop without sending" is the way out when it cannot. A route change (headphones) rebuilds the tap and
keeps the chunk numbers. `MacRecordSheet` explains the microphone prompt before macOS shows it, and
points to System Settings when access was refused. The Mac target now has `ENABLE_RESOURCE_ACCESS_AUDIO_INPUT`
and an `NSMicrophoneUsageDescription`. The source name it sends is `mac`, so `policy.audio.remoteSources`
must contain it. "Start a meeting" is a menu: this Mac, or the server's microphone as before.

Mic capture was run against the real server on 2026-11-19 and works. Then added: a microphone level
meter (`MacLevelMeter`: RMS in dB over a 60 dB range, 14 bars, quick fall, read ten times a second
from the recorder so nothing else re-renders) in the live view's capture strip and in the menu bar
panel; and the menu bar indicator, which swaps the icon for `record.circle.fill` while recording (no
colour, because the menu bar draws labels as templates), with a panel at the top of the menu showing
the clock, the meter, the buffering warning and Stop recording without opening the window. The first
version also put a ticking clock in the icon, and the app froze the moment recording started. It was
not sampled (the app had been quit), so the cause is inferred: a `TimelineView` in a `MenuBarExtra`
label. The clock was removed from the label, and the engine's configuration-change handler now
ignores a change that arrives while the engine is running, so a restart cannot trigger itself. If it
freezes again, run `sample <pid> 3` while it is frozen before changing anything else.

Known gaps: spool folders left by a crash are not picked up on the next launch, and audio kept after
the server gave up can only be recovered by hand (it is raw PCM; ffmpeg can wrap it for
`/api/meetings/import`). Nothing warns when the meter stays flat (a muted microphone).

Call audio is built (2026-11-19), optional, and builds on both targets but has **not** been run on a
real call. `MacCallAudio.swift` captures what this Mac plays through `SCStream` (audio only: a 2x2
picture once a second that is discarded; this app's own sound excluded) and converts it to 16 kHz mono
s16le. `PCMSpooler` mixes it into the microphone stream, with the microphone as the clock: each stretch
of mic audio takes that much call audio (silence if none has arrived), the two are added and clamped,
and the server hears one stream, so nothing downstream changed. The record sheet has a "Sources"
section with a toggle (remembered) and a plain explanation of the Screen & System Audio Recording
permission. Without that permission, or if the stream fails or dies mid-meeting, it says so and the
microphone carries on: the meeting already exists, so call audio can only add, never cost, a recording.
The live view and the menu bar panel show a meter per source ("Mic", and "Call" while it is on).

Known limits: with speakers rather than headphones the microphone also hears the far side, so it is
heard twice (slightly delayed); and the two sources are mixed, not kept as separate tracks, so speaker
detection works on the mix. Separate tracks would be a server change.

Phase 5 is otherwise complete. Left: try it on a real call, and the gaps listed above.

### Phase 6: polish and release hygiene

- Window state restoration, sensible default window sizes, full-screen behavior.
- Accessibility pass on the Mac: VoiceOver, keyboard-only use, Increase Contrast.
- App icon and menu bar icon variants.
- Update `README.md`, `ios/README.md` and `ios/ROADMAP.md`, and add a Mac section.
  Record the final design in this document's Status section, as other PLAN docs do.
- Signing and install: same Apple Developer team, a development-signed build on each Mac.
  No App Store, as with the iPhone app.

**Status (2026-11-19).** Built, and it builds on both targets; none of it has been seen in the running
app yet except where stated.

- *Windows.* `WindowGroup` already restores each window's size and place and supports full screen; the
  work was a first-launch size (1200x780, thread windows 720x700) and `@SceneStorage` for the section
  and thread a window was showing, so a relaunch reopens on them.
- *Keyboard.* A Go menu (`MacCommands.swift`, via a focused binding) puts the sidebar's seven sections
  on ⌘1 to ⌘7. ⌘N, ⌘K and ⌘R already existed. Approve is Return and Reject is Escape on the approval card.
- *Accessibility.* Build and run status was colour and symbol only, so VoiceOver now hears "Passed",
  "Failed", "In progress"; decorative glyphs are hidden; the menu bar item has a spoken label that
  includes the waiting count or "recording a meeting"; the three animated scrolls and the "More"
  toggle respect Reduce Motion. The meters have labels and percentage values. Increase Contrast comes
  from the menu bar mark being a template image and the rest using system materials and the shared
  palette; it was not audited screen by screen.
- *Icons.* Both app icons carry the spine mark from the mocks (a spine with a bulb at each end and a
  hollow ring in the middle, accent blue on the slate ground). They are generated by
  `ios/tools/make-icons.swift`; the Mac set is the same art in the standard rounded square with a soft
  shadow. The idle menu bar item is the same mark, a template drawn in code (`SpineMenuMark.swift`, same
  proportions); it still shows the waiting count, and becomes a record circle while recording. The
  first version of all three used the old stack-of-bars logo, which the mocks had replaced.
- *Docs.* `README.md` (the Mac microphone and `remoteSources`), `ios/README.md` (a Mac app section:
  build, recording, keyboard) and `ios/ROADMAP.md` (a pointer here).
- *Settings parity.* A comparison with the web Settings page found one feature the native apps lacked:
  **Recipes** (list, edit, delete; there is no create, since `recipe_save` in a chat is the approved
  path). It is `Views/RecipesView.swift`, shared by the iPhone and the Mac, linked from the iPhone's
  Assistant section. The Mac's Settings window, which only held the server address and token, is now
  two tabs, Server and Assistant; the Assistant tab pushes the same shared screens the phone has
  (recipes, auto-approval proposals, agents, Heads-up, memory, policy). Deliberately not ported:
  theme and text size (the phone and Mac follow the system appearance and Dynamic Type) and the
  wake word (hands-free is a browser feature; nothing native uses it). Both schemes build; the recipe
  screens have not been run against a server by hand.

Not done: a VoiceOver pass by actually using it, an Increase Contrast and Dynamic Type check on the
device, light-mode screenshots, and the notarised/distribution route (the plan says development-signed
only, as with the phone).

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

**Status (first pass built).** `global.css` no longer defines a palette: it imports
`tokens.generated.css` and keeps the reset, the font faces and the text-scale rule. The three faces
(Bricolage Grotesque, Instrument Sans, JetBrains Mono) are the files the iOS app bundles, copied to
`web/public/fonts` and served from this origin; `web/public` is source and is un-ignored in
`.gitignore` (`public/` is the build output). The favicon and touch icon, which `index.html` already
linked but nothing supplied, now come from `ios/tools/make-icons.swift`. The spine is drawn in
`Turn` (a left line behind everything after the user's message), `ToolCallCard` (a verdict-coloured
node, hollow while running) and `ApprovalCard` (a hollow amber node); `DecisionBadge` takes the
accent for a dry run and `PageHeader` the display face. `--attention` changed meaning from a blue
"needs you" to the amber of a pending question, as on the phone. A follow-up fix: the first pass drew
the line but no nodes in an ordinary chat, because the chat only showed tool calls when one was
denied or failed (the full trace lives in the Trace tab). `SpineCalls` now draws every call as one
line on the spine (node, tool, target, verdict; the first six, then "+ N more steps"), and a denial
still opens the full `ToolTrace`. The nodes on `ToolCallCard` are opt-in (`spine`) so the Trace tab
shows no stray dots. Markup changes: one wrapper in `Turn`, one in `ToolCallCard`, one new
component. A second follow-up (2026-11-19), on web, Mac and iPhone together: a failed call that a
later call in the same turn got past is drawn muted and labelled "recovered" instead of red, and
no longer opens the full trace by itself (`recoveredCalls`, mirrored in Swift as `RecoveredCalls`;
both are tested). And your own message gained a row of actions on hover (web, Mac) or long press
(phone): when it was sent, Copy, Retry and Edit and resend. Retry and Edit add a new turn, and are
withheld for a message with images, which cannot be re-sent. **Not checked by eye**: the web and
native builds compile and the rules are tested, but the hover row has not been looked at in a
browser, the Mac app or the simulator. Checked in a browser: a `Turn` with every verdict and a pending
approval, in both themes, with all three fonts loading. Walked, in both themes, against a scratch
server (empty database, port 8799, localhost, no token): the new-conversation page, Search, Tasks,
Files, Meetings, Builds, Overview, Heads-up, Study, Clients, Schedules (with the seeded Morning
brief), Activity, Settings and a project page. Nothing was broken, clipped or unreadable. Not seen,
because they need data or a running model: a real streamed conversation, Trace tab, RunDetail,
populated Meetings with speaker colours, the dialogs, and narrow widths. Spacing and type sizes still use the old literal values in most modules (only
colours and fonts moved to tokens), and the meeting speaker colours stay hard-coded hues.

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

## Where this stands (handoff, 2026-11-19)

Branch: `claude/zen-hamilton-8iyawg`, merged with `main` and pushed. A new session should start by
reading this file, `design/tokens.json`, and `docs/PLAN-heads-up-next.md` (it overlaps, see
"Interaction with the Heads-up work").

### Done and verified

- **Plan, decisions, approval.** Identity "the spine", main-window entry on the Mac, iPhone tabs
  restructured with drag and drop, web restyled in phase 7 (styling only), shared token source.
- **Phase 1.** `AgentSpine Mac` target in `ios/AgentSpine.xcodeproj`: bundle id
  `com.houserphotography.AgentSpine.mac`, macOS 15.6, App Sandbox with Outgoing Connections, the
  `ts.net` ATS exception in `ios/AgentSpine-Mac-Info.plist`, a shared scheme per target. It
  compiles the eight shared files through a membership exception set in the project file:
  `Core/{APIClient,AppState,Keychain,Models,RunStream,Settings}.swift` and
  `Design/{DesignColor,Tokens.generated}.swift`. The Mac app itself is still the template window
  (`ios/AgentSpine Mac/ContentView.swift`).
- **Phase 2, tokens.** `design/tokens.json`, `design/generate.mjs` (`npm run design`), generated
  `web/src/styles/tokens.generated.css` and `ios/AgentSpine/Design/Tokens.generated.swift`,
  `test/design-tokens.test.mjs` in `npm test`. Contrast is enforced at WCAG AA.
- **Mocks.** Design canvas, private: https://claude.ai/artifact/Rg3gLZmvod3ieu7t61YdJz . Boards:
  Mac thread with approval, Mac live meeting, Mac Heads-up, iPhone Threads, Thread, Customize
  tabs (interactive), Heads-up. The source files lived in a session scratchpad that may be gone;
  read them back from the artifact (`Artifact` read, `project/*.dc.html`) before editing.

### Next, in order

1. **Phase 2, SwiftUI components and a gallery.** Replace the styling in
   `ios/AgentSpine/Views/Chrome.swift` with components built on `Spine.Palette`: spine row, verdict
   badge, approval card, status chip, empty and error states, markdown text styling. Add a
   preview-only gallery showing every component in light, dark and large type. Check VoiceOver
   labels as each lands.
2. **Fonts.** Bundle Bricolage Grotesque, Instrument Sans and JetBrains Mono (open licences) in the
   app, and self-host them on the web. No font CDN. Register them in `Info.plist` (`UIAppFonts`)
   and the Mac target.
3. **Tab bar customization screen**, drag and drop (`List` with `.onMove`, edit mode, a live bar
   preview, Threads fixed first, VoiceOver move actions). Persist in `Settings`. Thirteen tabs now,
   Heads-up second by default.
4. Apply the tokens to the existing iPhone screens.
5. **Phase 3**, the Mac shell and Threads. Then phases 4 to 7 as written above.

### Things a new session needs to know

- **No Swift compiler in the sandbox.** Swift can be written but not compiled or parsed. Every Swift
  change ends with a "press ⌘B and check these things" list for the user, and the user pastes back
  the first errors. Keep steps small.
- **Xcode project edits are the user's.** Do not hand-edit the `.pbxproj`. To share another file with
  the Mac target the user ticks Target Membership in the File Inspector, which adds it to the
  exception set. A new file in `ios/AgentSpine/` is iPhone only until then.
- **Keep shared files portable.** `Models.swift` must stay Foundation-only: `test/ios-models.test.mjs`
  compiles it alone. Shared files must not import UIKit unguarded (use `#if canImport(UIKit)`).
  `Keychain.swift` and `Settings.swift` already have macOS branches.
- **`.gitignore` ignores everything in `docs/` except `PLAN-*.md`.** New design docs must be named
  `PLAN-*.md` or they are silently not committed.
- **Heads-up overlaps.** Its Live Activity needs a second Xcode target, so do it after the Mac target
  exists (now true). Its new Settings screens will be restyled by phases 2 and 7. The iOS Heads-up
  Swift was written uncompiled; the user's build of this branch is the first evidence it compiles.
- **Untracked file not ours:** `docs/PLAN-nod-learnings.md`. Leave it alone.
- **How the user likes to work.** Ask clarifying questions, plain language, no em dashes, no emoji.
  Gate implementation on approval. Commit with the `Co-Authored-By` and `Claude-Session` trailers from
  the session, and push to this branch after each commit. Do not open a pull request unless asked.

### Open decisions

1. A light-theme review. Light was derived from the dark mocks and has not been drawn.
2. How many tabs the iPhone bar should allow, now that Heads-up sits second (the mock shows four
   plus More).
3. Whether to cut a Swift package later, once there is a compiler to check the `public` changes.
