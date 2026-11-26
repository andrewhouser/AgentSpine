import SwiftUI

/// Everything waiting, in the pane the window opens on (PLAN-open-work section 14, U1 and U2).
///
/// The Mac twin of the iPhone's `TodayView`: the rows are the shared `TodaySections`, and what
/// is the Mac's own is how a row opens. A thread, a run or a section changes the detail pane,
/// which `MacRootView` owns, so those go to `open`. An approval is reviewed here, in a sheet
/// holding the same `MacApprovalCard` a thread shows, with the whole proposed action above
/// the buttons. There is no Approve on a row.
struct MacTodayView: View {
    /// Open a thread, a run or another section in the window.
    let open: (TodayTarget) -> Void

    @Environment(AppState.self) private var state
    @State private var reviewing: TodayApproval?

    private var store: TodayStore { TodayStore.shared }

    var body: some View {
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
        .navigationTitle("Today")
        .toolbar {
            ToolbarItem {
                Button { Task { await store.load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .help("Reads again")
            }
        }
        .task { await store.load() }
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

    private func route(_ target: TodayTarget) {
        if case .approval(let approval) = target {
            reviewing = approval
        } else {
            open(target)
        }
    }
}
