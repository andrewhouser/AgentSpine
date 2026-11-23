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
    @State private var showingWeeklyReview = false
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
            settings.retryTokenRead()
            if settings.isConfigured {
                await state.refresh()
                push.registerIfAuthorized()
            } else if settings.isSignedOut {
                // No server or token any more is this app's sign-out, so the private copy goes with it.
                OfflineCache.shared.clear()
                tab = .settings
            } else {
                // The keychain would not answer. The token may be fine, so keep the copy, say why
                // nothing loaded, and try again when the app next comes forward.
                await state.refresh()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            let recovered = settings.retryTokenRead()
            // Coming back to the app is exactly when the lists are most likely to be stale —
            // you have probably just answered something from a notification.
            guard settings.isConfigured else { return }
            Task {
                await state.refreshConversations()
                push.refreshAuthorization()
                if recovered { push.registerIfAuthorized() }
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
            case .weeklyReview:
                // A sheet, because the review lives two levels into Settings and the Settings tab
                // may be folded under More, where pushing onto its stack is not ours to do.
                showingWeeklyReview = true
            case .conversation(let id):
                tab = .threads
                // Replace rather than push: tapping two notifications should not build a stack
                // of threads you have to unwind.
                threadPath = [id]
            }
            push.pendingDeepLink = nil
        }
        .sheet(isPresented: $showingWeeklyReview) {
            NavigationStack {
                WeeklyReviewView()
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showingWeeklyReview = false }
                        }
                    }
            }
        }
    }

    private func badge(for tab: AppTab) -> Int {
        switch tab {
        case .threads: return state.waitingThreads
        case .headsup: return state.headsupWaiting
        default: return 0
        }
    }

    /// Tabs folded under More are already hosted in UIKit's own navigation controller, so a
    /// second `NavigationStack` of our own stacks a second bar and a second back arrow on every
    /// pushed screen (seen on Settings → Tab bar). Those tabs go in bare; the bar's tabs keep
    /// their own stack because nothing else supplies one there.
    @ViewBuilder private func stacked<Content: View>(_ tab: AppTab, @ViewBuilder _ content: () -> Content) -> some View {
        if TabLayout.more(settings.tabs).contains(tab) {
            content()
        } else {
            NavigationStack { content() }
        }
    }

    @ViewBuilder private func content(for tab: AppTab) -> some View {
        switch tab {
        case .threads:
            NavigationStack(path: $threadPath) {
                ConversationsView()
                    .navigationDestination(for: Int.self) { ThreadView(conversationID: $0) }
            }
        case .headsup: stacked(tab) { HeadsupView() }
        case .tasks: stacked(tab) { TasksView() }
        case .study: stacked(tab) { StudyView() }
        case .schedules: stacked(tab) { SchedulesView() }
        case .projects: stacked(tab) { ProjectsView() }
        case .files: stacked(tab) { FilesView() }
        case .inbox: stacked(tab) { InboxView() }
        case .knowledge: stacked(tab) { KnowledgeView() }
        case .clients: stacked(tab) { ClientsView() }
        case .search:
            stacked(tab) {
                SearchView(openThread: { id in
                    self.tab = .threads
                    threadPath = [id]
                })
            }
        case .meetings: stacked(tab) { MeetingsView() }
        case .builds: stacked(tab) { BuildsView() }
        case .activity: stacked(tab) { ActivityView() }
        case .settings: stacked(tab) { SettingsView() }
        }
    }
}
