import SwiftUI

/// Five tabs, and a deep link that can reach into any of them.
///
/// The approvals tab carries a badge because it is the only tab that represents work *blocked
/// on you* — everything else is informational, and a badge on an informational tab is how a
/// badge stops meaning anything.
struct RootView: View {
    enum Tab: Hashable {
        case threads, approvals, schedules, projects, meetings, activity, settings
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
            .tag(Tab.threads)

            NavigationStack {
                ApprovalsView()
            }
            .tabItem { Label("Approvals", systemImage: "checkmark.shield") }
            .badge(state.queueBadge)
            .tag(Tab.approvals)

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
                MeetingsView()
            }
            .tabItem { Label("Meetings", systemImage: "person.2.wave.2") }
            .tag(Tab.meetings)

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
                await state.refreshApprovals()
                push.refreshAuthorization()
            }
        }
        .onChange(of: push.pendingDeepLink) { _, link in
            guard let link else { return }
            switch link {
            case .approvals:
                tab = .approvals
                Task { await state.refreshApprovals() }
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
