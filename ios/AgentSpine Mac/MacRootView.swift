import SwiftUI

/// The Mac window: a sidebar of sections and the section's own content beside it.
///
/// Threads is the one section with a list and a detail pane of its own, so it is a split inside
/// the detail column; every other section is the phone's screen in a navigation stack, which
/// already knows how to push its own detail.
struct MacRootView: View {
    @Environment(AppState.self) private var state
    @Environment(Settings.self) private var settings
    @Environment(\.scenePhase) private var scenePhase

    @State private var section: MacSection? = .threads
    @State private var selectedThread: Int?
    @State private var composingNew = false
    @State private var searching = false
    @State private var headsupPrefs = false

    var body: some View {
        NavigationSplitView {
            List(selection: $section) {
                ForEach(MacSection.Group.allCases, id: \.self) { group in
                    Section(group.rawValue) {
                        ForEach(MacSection.sections(in: group), id: \.self) { item in
                            Label(item.title, systemImage: item.symbol)
                                .tag(item)
                                .badge(badge(for: item))
                        }
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 200, max: 260)
            .scrollContentBackground(.hidden)
            .background(Spine.Palette.bgSidebar)
        } detail: {
            switch section ?? .threads {
            case .threads:
                HSplitView {
                    MacThreadList(selection: $selectedThread)
                        .onChange(of: selectedThread) { _, id in if id != nil { composingNew = false } }
                        .frame(minWidth: 260, idealWidth: 320, maxWidth: 460)
                    threadDetail
                        .frame(minWidth: 420, maxWidth: .infinity)
                }
            case let other:
                MacSectionContent(section: other)
                    .id(other)
            }
        }
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
            ToolbarItem {
                Button { searching = true } label: {
                    Label("Search", systemImage: "magnifyingglass")
                }
                .keyboardShortcut("k", modifiers: .command)
                .disabled(!settings.isConfigured)
                .help("Search threads (⌘K)")
            }
            ToolbarItem {
                Button {
                    section = .threads
                    selectedThread = nil
                    composingNew = true
                } label: {
                    Label("New Thread", systemImage: "square.and.pencil")
                }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(!settings.isConfigured)
                .help("New thread (⌘N)")
            }
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
            if settings.isConfigured { await state.refresh() }
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back to the window is when the lists are most likely to be stale.
            guard phase == .active, settings.isConfigured else { return }
            Task { await state.refreshConversations() }
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
        } else {
            EmptyNotice(
                symbol: "bubble.left.and.text.bubble.right",
                title: "No thread selected",
                detail: "Pick a thread from the list, or press ⌘N to start one."
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Spine.Palette.bg)
        }
    }

    private func badge(for item: MacSection) -> Int {
        switch item {
        case .threads: return state.waitingThreads
        case .headsup: return state.headsupWaiting
        default: return 0
        }
    }
}
