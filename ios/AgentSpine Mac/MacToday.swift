import SwiftUI

/// Everything waiting, in the pane the window opens on (PLAN-open-work section 14, U1 and U2).
///
/// The Mac twin of the iPhone's `TodayView`: the rows are the shared `TodaySections`, and what
/// is the Mac's own is how a row opens. A thread, a run or a section changes the detail pane,
/// which `MacRootView` owns, so those go to `open`. An approval is reviewed here with the same
/// `MacApprovalCard` a thread shows, the whole proposed action above the buttons: in the
/// "Your decision" panel beside the line when the window is wide (the 2026-11-26 redesign,
/// as the web draws it at 1100 points), and in a sheet when it is not. There is no Approve on a row.
struct MacTodayView: View {
    /// Open a thread, a run or another section in the window.
    let open: (TodayTarget) -> Void

    @Environment(AppState.self) private var state
    @State private var reviewing: TodayApproval?
    /// The approval the panel shows; nil means the first one waiting.
    @State private var chosen: Int?
    @State private var wide = false
    /// A 1:1 on the line opens that person in a sheet here (section 15, R9).
    @State private var person: Int?

    private var store: TodayStore { TodayStore.shared }

    /// Matches the web's breakpoint, so the two clients agree on when the panel appears.
    private static let panelWidth: CGFloat = 1100

    private var panelApproval: TodayApproval? {
        let all = store.screen?.approvals ?? []
        return all.first { $0.id == chosen } ?? all.first
    }

    var body: some View {
        HStack(spacing: 0) {
            line
            if wide, let approval = panelApproval {
                Divider()
                decisionPanel(approval)
                    .frame(width: 420)
            }
        }
        .onGeometryChange(for: Bool.self) { $0.size.width >= Self.panelWidth } action: { wide = $0 }
    }

    private var line: some View {
        List {
            if let error = store.error {
                ErrorNotice(message: error) { Task { await store.load() } }
                    .listRowBackground(Color.clear)
            }
            if !store.loaded {
                EmptyNotice(symbol: "sun.max", title: "Loading…", detail: "Reading what is waiting on you.")
                    .listRowBackground(Color.clear)
            }
            TodaySections(store: store, open: route)
        }
        .scrollContentBackground(.hidden)
        .background(Spine.Palette.bg)
        // The ask bar (section 15, R1): what you type, and nothing from the rows above, starts a thread.
        .safeAreaInset(edge: .bottom) {
            AskBar(placeholder: "Ask about your day…") { id in open(.thread(id)) }
                .background(Spine.Palette.bg)
        }
        .navigationTitle("Today")
        .toolbar {
            ToolbarItem {
                Button { Task { await store.load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .help("Reads again")
            }
        }
        .task { await store.load() }
        .sheet(item: Binding(get: { person.map { PersonSheetID(id: $0) } }, set: { person = $0?.id })) { p in
            VStack(spacing: 0) {
                NavigationStack { PersonView(personID: p.id) }
                HStack {
                    Spacer()
                    Button("Close") { person = nil }.keyboardShortcut(.cancelAction)
                }
                .padding()
            }
            .frame(minWidth: 560, minHeight: 520)
            .environment(state)
        }
        .sheet(item: $reviewing) { approval in
            VStack(alignment: .leading, spacing: Spine.Space.md) {
                ScrollView {
                    MacApprovalCard(confirmation: approval.confirmation) {
                        reviewing = nil
                        await store.load()
                    }
                    .padding()
                }
                HStack {
                    if approval.conversationId != nil {
                        Button("Open the thread") {
                            reviewing = nil
                            open(.approval(approval))
                        }
                    }
                    Spacer()
                    Button("Close") { reviewing = nil }.keyboardShortcut(.cancelAction)
                }
                .padding([.horizontal, .bottom])
            }
            .frame(minWidth: 520, minHeight: 380)
            .background(Spine.Palette.bg)
            .environment(state)
        }
    }

    /// "Your decision": the card for one approval, with a way into its thread.
    private func decisionPanel(_ approval: TodayApproval) -> some View {
        VStack(alignment: .leading, spacing: Spine.Space.md) {
            Text("YOUR DECISION")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.bold))
                .tracking(2.2)
                .foregroundStyle(Spine.Palette.textDim)
            ScrollView {
                MacApprovalCard(confirmation: approval.confirmation) {
                    chosen = nil
                    await store.load()
                }
                .id(approval.id)
            }
            HStack {
                if approval.conversationId != nil {
                    Button("Open the thread") { open(.approval(approval)) }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Spine.Palette.accent)
                }
                Spacer()
                Text("Review the full message before sending.")
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textFaint)
            }
        }
        .padding(Spine.Space.lg)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Spine.Palette.bgElevated)
    }

    private func route(_ target: TodayTarget) {
        if case .approval(let approval) = target {
            if wide { chosen = approval.id } else { reviewing = approval }
        } else if case .person(let id) = target {
            person = id
        } else {
            open(target)
        }
    }
}

/// Identifies the person sheet; `Int` itself is not `Identifiable`.
private struct PersonSheetID: Identifiable {
    let id: Int
}
