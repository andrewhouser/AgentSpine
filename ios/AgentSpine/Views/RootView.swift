import SwiftUI

/// Thirteen tabs (iOS folds all but four into "More"), and a deep link that can reach into any of them.
///
/// Approvals are not a tab: they are asked in the thread that wanted them, and a thread with a
/// question waiting carries a blue dot. The Threads tab's badge counts those threads, because
/// it is the only work here that is *blocked on you* — everything else is informational, and a
/// badge on an informational tab is how a badge stops meaning anything.
struct RootView: View {
    enum Tab: Hashable {
        case threads, headsup, tasks, study, schedules, projects, files, clients, search, meetings, builds, activity, settings
    }

    @Environment(AppState.self) private var state
    @Environment(Settings.self) private var settings
    @Environment(PushManager.self) private var push

    @State private var tab: Tab = .threads
    @State private var threadPath: [Int] = []
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $threadPath) {
                ConversationsView()
                    .navigationDestination(for: Int.self) { ThreadView(conversationID: $0) }
            }
            .tabItem { Label("Threads", systemImage: "bubble.left.and.text.bubble.right") }
            .badge(state.waitingThreads)
            .tag(Tab.threads)

            NavigationStack {
                HeadsupView()
            }
            .tabItem { Label("Heads-up", systemImage: "sparkles") }
            .badge(state.headsupWaiting)
            .tag(Tab.headsup)

            NavigationStack {
                TasksView()
            }
            .tabItem { Label("Tasks", systemImage: "checklist") }
            .tag(Tab.tasks)

            NavigationStack {
                StudyView()
            }
            .tabItem { Label("Study", systemImage: "brain.head.profile") }
            .tag(Tab.study)

            NavigationStack {
                SchedulesView()
            }
            .tabItem { Label("Schedules", systemImage: "clock") }
            .tag(Tab.schedules)

            NavigationStack {
                ProjectsView()
            }
            .tabItem { Label("Projects", systemImage: "folder") }
            .tag(Tab.projects)

            NavigationStack {
                FilesView()
            }
            .tabItem { Label("Files", systemImage: "doc.text") }
            .tag(Tab.files)

            NavigationStack {
                ClientsView()
            }
            .tabItem { Label("Clients", systemImage: "person.crop.rectangle.stack") }
            .tag(Tab.clients)

            NavigationStack {
                SearchView(openThread: { id in
                    tab = .threads
                    threadPath = [id]
                })
            }
            .tabItem { Label("Search", systemImage: "magnifyingglass") }
            .tag(Tab.search)

            NavigationStack {
                MeetingsView()
            }
            .tabItem { Label("Meetings", systemImage: "person.2.wave.2") }
            .tag(Tab.meetings)

            NavigationStack {
                BuildsView()
            }
            .tabItem { Label("Builds", systemImage: "hammer") }
            .tag(Tab.builds)

            NavigationStack {
                ActivityView()
            }
            .tabItem { Label("Activity", systemImage: "list.bullet.rectangle") }
            .tag(Tab.activity)

            NavigationStack {
                SettingsView()
            }
            .tabItem { Label("Settings", systemImage: "gearshape") }
            .tag(Tab.settings)
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
}
