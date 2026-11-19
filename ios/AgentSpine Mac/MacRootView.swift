import SwiftUI

/// The Mac window: sidebar of sections, a content list, and a detail pane.
///
/// Phase 3 builds Threads first, since that is where the work happens; the other sections of
/// the iPhone app arrive in phase 4. The sidebar already has the structure they will slot into.
struct MacRootView: View {
    enum Section: Hashable { case threads }

    @Environment(AppState.self) private var state
    @Environment(Settings.self) private var settings
    @Environment(\.scenePhase) private var scenePhase

    @State private var section: Section? = .threads
    @State private var selectedThread: Int?
    @State private var composingNew = false
    @State private var searching = false

    var body: some View {
        NavigationSplitView {
            List(selection: $section) {
                Label("Threads", systemImage: "bubble.left.and.text.bubble.right")
                    .tag(Section.threads)
                    .badge(state.waitingThreads)
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 190, max: 260)
            .scrollContentBackground(.hidden)
            .background(Spine.Palette.bgSidebar)
        } content: {
            MacThreadList(selection: $selectedThread)
                .onChange(of: selectedThread) { _, id in if id != nil { composingNew = false } }
                .navigationSplitViewColumnWidth(min: 260, ideal: 320, max: 460)
        } detail: {
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
        .sheet(isPresented: $searching) {
            MacSearchSheet { id in
                composingNew = false
                selectedThread = id
            }
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
                    selectedThread = nil
                    composingNew = true
                } label: {
                    Label("New Thread", systemImage: "square.and.pencil")
                }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(!settings.isConfigured)
                .help("New thread (⌘N)")
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
}
