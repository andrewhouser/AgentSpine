import SwiftUI

/// Everything waiting, on the tab the app opens on (PLAN-open-work section 14, U1 and U2).
///
/// The rows are `TodaySections` (Design/Components/Notices.swift), shared with the Mac. What is
/// the phone's own is how a row opens: a thread or a run is pushed onto this tab's stack, so
/// Back returns here, and an approval opens as a sheet holding the same `ApprovalCard` a
/// thread shows, with the whole proposed action above the buttons.
///
/// A swipe on an approval shows Review and Later and never approves: Approve exists only in
/// that card. When the screen is the saved offline copy the card has no buttons at all, the
/// same rule as a saved thread, because a stale approval is a security problem.
struct TodayView: View {
    /// Switch to another tab, for the rows that belong to one (Tasks, Heads-up, Schedules).
    let openTab: (AppTab) -> Void

    @Environment(AppState.self) private var state
    @Environment(ReadAloud.self) private var reader
    @Environment(\.scenePhase) private var scenePhase
    @State private var path: [TodayTarget] = []
    @State private var reviewing: TodayApproval?

    private var store: TodayStore { TodayStore.shared }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let error = store.error {
                    ErrorNotice(message: error) { Task { await store.load() } }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
                if let cachedAt = store.cachedAt {
                    CachedNotice(savedAt: cachedAt) { Task { await store.load() } }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
                if let failed = reader.error, reader.failedText != nil {
                    Text(failed)
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.danger)
                }
                if !store.loaded {
                    EmptyNotice(symbol: "sun.max", title: "Loading…", detail: "Reading what is waiting on you.")
                        .listRowBackground(Color.clear)
                }
                TodaySections(store: store, open: open, readAloud: { reader.toggle($0) }, speaking: reader.speaking)
            }
            .navigationTitle("Today")
            // The ask bar (section 15, R1): what you type, and nothing from the rows above, starts a thread.
            .safeAreaInset(edge: .bottom) {
                AskBar(placeholder: "Ask about your day…") { id in path.append(.thread(id)) }
                    .background(Spine.Palette.bg)
            }
            .navigationDestination(for: TodayTarget.self) { target in
                switch target {
                case .thread(let id): ThreadView(conversationID: id)
                case .run(let id): RunDetailView(runID: id)
                default: EmptyView()
                }
            }
            .task { await store.load() }
            .refreshable { await store.load() }
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming forward is when this is most likely stale: something was probably just
            // answered from a notification. It also puts the icon's badge right.
            if phase == .active { Task { await store.load() } }
        }
        .sheet(item: $reviewing) { approval in
            NavigationStack {
                ScrollView {
                    ApprovalCard(confirmation: approval.confirmation, answerable: store.cachedAt == nil) {
                        reviewing = nil
                        await store.load()
                    }
                    .padding()
                }
                .navigationTitle("Review")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { reviewing = nil } }
                    if let id = approval.conversationId {
                        ToolbarItem(placement: .primaryAction) {
                            Button("Thread") {
                                reviewing = nil
                                path = [.thread(id)]
                            }
                        }
                    }
                }
                .spineScreen()
            }
            .environment(state)
            .presentationDetents([.medium, .large])
        }
    }

    private func open(_ target: TodayTarget) {
        switch target {
        case .approval(let a): reviewing = a
        case .thread, .run: path.append(target)
        case .tasks: openTab(.tasks)
        case .headsup: openTab(.headsup)
        case .schedules: openTab(.schedules)
        }
    }
}
