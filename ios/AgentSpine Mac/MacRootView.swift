import SwiftUI

/// The Mac window: a sidebar (new thread, search, sections, the threads, connection status) and
/// one detail pane beside it, as in `docs/archive/PLAN-native-apps-and-ui-refresh.md`.
///
/// A thread opens in the detail pane; every other section is the phone's screen in a navigation
/// stack, which already knows how to push its own detail.
struct MacRootView: View {
    @Environment(AppState.self) private var state
    @Environment(Settings.self) private var settings
    @Environment(\.scenePhase) private var scenePhase

    @State private var section: MacSection = .today
    @State private var selectedThread: Int?
    @State private var composingNew = false
    @State private var searching = false
    @State private var headsupPrefs = false
    /// Per window, restored by macOS with the window: the section and thread it was showing.
    @SceneStorage("mac.section") private var savedSection = MacSection.today.rawValue
    @SceneStorage("mac.thread") private var savedThread = 0
    @State private var restored = false

    var body: some View {
        NavigationSplitView {
            MacSidebar(selection: sidebarSelection, newThread: startNewThread) { searching = true }
                .navigationSplitViewColumnWidth(min: 230, ideal: 270, max: 360)
        } detail: {
            switch section {
            case .today:
                // Where the window opens (PLAN-open-work section 14, U1). It needs the selection
                // to open a thread, so it is drawn here and not by MacSectionContent.
                MacTodayView { target in open(target) }
            case .threads:
                threadDetail
            case let other:
                MacSectionContent(section: other)
                    .id(other)
            }
        }
        .focusedSceneValue(\.macSection, $section)
        .onAppear {
            guard !restored else { return }
            restored = true
            section = MacSection(rawValue: savedSection) ?? .today
            selectedThread = savedThread == 0 ? nil : savedThread
            // A window that was on Threads with nothing open has nothing to show: Today instead.
            if section == .threads, selectedThread == nil { section = .today }
        }
        .onChange(of: section) {
            savedSection = section.rawValue
            if section != .threads { composingNew = false }
        }
        .onChange(of: selectedThread) { savedThread = selectedThread ?? 0 }
        .sheet(isPresented: $searching) {
            MacSearchSheet { id in
                composingNew = false
                section = .threads
                selectedThread = id
            }
        }
        .sheet(isPresented: $headsupPrefs) {
            NavigationStack { HeadsupPrefsView() }
                .spineScreen()
                .frame(minWidth: 480, minHeight: 520)
                .environment(state)
                .environment(settings)
        }
        .toolbar {
            if section == .headsup {
                ToolbarItem {
                    Button { headsupPrefs = true } label: {
                        Label("Heads-up preferences", systemImage: "slider.horizontal.3")
                    }
                    .help("Heads-up preferences")
                }
            }
        }
        .task {
            if settings.isConfigured {
                await state.refresh()
                await TodayStore.shared.load()
            }
        }
        // A notification was clicked: show that thread.
        .onReceive(NotificationCenter.default.publisher(for: .macOpenThread)) { note in
            guard let id = note.object as? Int else { return }
            section = .threads
            selectedThread = id
            composingNew = false
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back to the window is when the lists are most likely to be stale.
            guard phase == .active, settings.isConfigured else { return }
            Task {
                await state.refreshConversations()
                // Also puts the Dock badge right, whichever section is showing.
                await TodayStore.shared.load()
            }
        }
    }

    @ViewBuilder private var threadDetail: some View {
        if composingNew {
            MacNewThread { id in
                composingNew = false
                selectedThread = id
            }
        } else if let selectedThread {
            MacThreadDetail(conversationID: selectedThread)
                .id(selectedThread)
        } else if !settings.isConfigured {
            VStack(spacing: Spine.Space.md) {
                EmptyNotice(
                    symbol: "network",
                    title: "Connect to your server",
                    detail: "Enter the server address and dashboard token in Settings."
                )
                SettingsLink { Text("Open Settings…") }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Spine.Palette.bg)
        } else {
            EmptyNotice(
                symbol: "bubble.left.and.text.bubble.right",
                title: "No thread selected",
                detail: "Pick a thread from the sidebar, or press ⌘N to start one."
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Spine.Palette.bg)
        }
    }

    /// A row on Today was clicked. A thread or an approval's thread opens in the detail pane; a
    /// run has no pane of its own here, so it opens Activity, where runs are listed.
    private func open(_ target: TodayTarget) {
        switch target {
        case .thread(let id):
            composingNew = false
            selectedThread = id
            section = .threads
        case .approval(let approval):
            guard let id = approval.conversationId else { return }
            composingNew = false
            selectedThread = id
            section = .threads
        case .run: section = .activity
        case .tasks: section = .tasks
        case .headsup: section = .headsup
        case .schedules: section = .schedules
        case .meetings: section = .meetings
        }
    }

    private func startNewThread() {
        section = .threads
        selectedThread = nil
        composingNew = true
    }

    /// One selection for sections and threads. Having a thread open (or the new-thread screen)
    /// is `section == .threads`; the thread row is highlighted only then.
    private var sidebarSelection: Binding<MacSidebarItem?> {
        Binding(
            get: {
                if section == .threads {
                    return composingNew ? nil : selectedThread.map(MacSidebarItem.thread)
                }
                return .section(section)
            },
            set: { item in
                switch item {
                case .thread(let id):
                    section = .threads
                    selectedThread = id
                    composingNew = false
                case .section(let picked):
                    section = picked
                    composingNew = false
                case nil:
                    break
                }
            }
        )
    }
}
