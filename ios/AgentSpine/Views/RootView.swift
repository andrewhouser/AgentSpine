import SwiftUI

/// Thirteen tabs (iOS folds all but four into "More"), and a deep link that can reach into any of them.
///
/// Approvals are not a tab: they are asked in the thread that wanted them, and a thread with a
/// question waiting carries a blue dot. The Threads tab's badge counts those threads, because
/// it is the only work here that is *blocked on you* — everything else is informational, and a
/// badge on an informational tab is how a badge stops meaning anything.
struct RootView: View {
    @Environment(AppState.self) private var state
    @Environment(Settings.self) private var settings
    @Environment(PushManager.self) private var push

    @State private var tab: AppTab = .threads
    @State private var threadPath: [Int] = []
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $tab) {
            // The user's order, from Settings → Tab bar. iOS shows the first four and folds the
            // rest under More, so the order is the whole of the customisation.
            ForEach(settings.tabs, id: \.self) { item in
                content(for: item)
                    .spineScreen()
                    .tabItem { Label(item.title, systemImage: item.symbol) }
                    .badge(badge(for: item))
                    .tag(item)
            }
        }
        .task {
            // A first launch with nothing configured should land on Settings rather than on an
            // empty thread list with an error under it.
            if !settings.isConfigured {
                tab = .settings
            } else {
                await state.refresh()
                push.registerIfAuthorized()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back to the app is exactly when the lists are most likely to be stale —
            // you have probably just answered something from a notification.
            guard phase == .active, settings.isConfigured else { return }
            Task {
                await state.refreshConversations()
                push.refreshAuthorization()
            }
        }
        .onChange(of: push.pendingDeepLink) { _, link in
            guard let link else { return }
            switch link {
            case .threads:
                // An approval with no thread to open (an older server): the list, where the
                // dot shows which thread is asking.
                tab = .threads
                threadPath = []
                Task { await state.refreshConversations() }
            case .study:
                // The daily "N cards due" push.
                tab = .study
            case .headsup:
                // The morning summary, or "gift ideas ready".
                tab = .headsup
            case .conversation(let id):
                tab = .threads
                // Replace rather than push: tapping two notifications should not build a stack
                // of threads you have to unwind.
                threadPath = [id]
            }
            push.pendingDeepLink = nil
        }
    }

    private func badge(for tab: AppTab) -> Int {
        switch tab {
        case .threads: return state.waitingThreads
        case .headsup: return state.headsupWaiting
        default: return 0
        }
    }

    @ViewBuilder private func content(for tab: AppTab) -> some View {
        switch tab {
        case .threads:
            NavigationStack(path: $threadPath) {
                ConversationsView()
                    .navigationDestination(for: Int.self) { ThreadView(conversationID: $0) }
            }
        case .headsup: NavigationStack { HeadsupView() }
        case .tasks: NavigationStack { TasksView() }
        case .study: NavigationStack { StudyView() }
        case .schedules: NavigationStack { SchedulesView() }
        case .projects: NavigationStack { ProjectsView() }
        case .files: NavigationStack { FilesView() }
        case .clients: NavigationStack { ClientsView() }
        case .search:
            NavigationStack {
                SearchView(openThread: { id in
                    self.tab = .threads
                    threadPath = [id]
                })
            }
        case .meetings: NavigationStack { MeetingsView() }
        case .builds: NavigationStack { BuildsView() }
        case .activity: NavigationStack { ActivityView() }
        case .settings: NavigationStack { SettingsView() }
        }
    }
}
