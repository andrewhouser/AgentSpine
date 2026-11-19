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
                .navigationSplitViewColumnWidth(min: 260, ideal: 320, max: 460)
        } detail: {
            if let selectedThread {
                MacThreadDetail(conversationID: selectedThread)
                    .id(selectedThread)
            } else {
                EmptyNotice(
                    symbol: "bubble.left.and.text.bubble.right",
                    title: "No thread selected",
                    detail: "Pick a thread from the list."
                )
                .background(Spine.Palette.bg)
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
