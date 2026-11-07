import SwiftUI

/// The approval queue — the only screen here that represents work blocked on you.
///
/// One deliberate choice, carried over from the dashboard: **the full proposed action is shown,
/// not a summary.** For a draft that means the whole draft. A one-line preview makes approving
/// a rubber stamp, and this is the screen where the project's central claim either holds or
/// quietly stops holding. The lock-screen buttons are the convenience; this is the real thing.
struct ApprovalsView: View {
    @Environment(AppState.self) private var state

    @State private var rejecting: Confirmation?
    @State private var reason = ""

    var body: some View {
        List {
            if let error = state.loadError {
                ErrorNotice(message: error) { Task { await state.refresh() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            if state.pendingApprovals.isEmpty && state.loadError == nil {
                EmptyNotice(
                    symbol: "checkmark.shield",
                    title: "Nothing waiting",
                    detail: "Irreversible actions queue here for you to approve."
                )
                .listRowBackground(Color.clear)
            }

            ForEach(state.pendingApprovals) { confirmation in
                ApprovalCard(
                    confirmation: confirmation,
                    approve: { Task { await state.answer(confirmation, approve: true) } },
                    reject: {
                        reason = ""
                        rejecting = confirmation
                    }
                )
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .navigationTitle("Approvals")
        .refreshable { await state.refresh() }
        .sheet(item: $rejecting) { confirmation in
            RejectSheet(confirmation: confirmation, reason: $reason) { text in
                await state.answer(confirmation, approve: false, reason: text)
                rejecting = nil
            }
        }
    }
}

struct ApprovalCard: View {
    let confirmation: Confirmation
    let approve: () -> Void
    let reject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(confirmation.tool)
                    .font(.caption.weight(.semibold).monospaced())
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color.orange.opacity(0.15), in: Capsule())
                    .foregroundStyle(.orange)
                Spacer()
                Text("#\(confirmation.id) · \(SpineDate.relative(confirmation.ts))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Text(confirmation.summary)
                .font(.callout.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)

            // The whole thing, not a preview. See the note at the top of this file.
            Text(PrettyJSON.format(confirmation.args))
                .font(.caption2.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(9)
                .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))

            HStack(spacing: 10) {
                Button(role: .destructive, action: reject) {
                    Text("Reject").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Button(action: approve) {
                    Text("Approve").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }
}

/// Rejecting asks why, because the answer is worth something.
///
/// A reason becomes a `preference` memory on the server that gets recalled before similar
/// work, so "no, never email that address without asking" is a correction that only has to be
/// made once. Skipping is allowed — a rejection with no reason is still a rejection — but the
/// field is there, and prompted, because the version of this screen without it taught nothing.
struct RejectSheet: View {
    let confirmation: Confirmation
    @Binding var reason: String
    let submit: (String) async -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var isSending = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(confirmation.summary)
                        .font(.callout)
                }
                Section {
                    TextField("Why not? (optional)", text: $reason, axis: .vertical)
                        .frame(minHeight: 70, alignment: .topLeading)
                        .focused($focused)
                } footer: {
                    Text("A reason is remembered as a preference and recalled before similar "
                         + "work, so you only have to say it once.")
                }
            }
            .navigationTitle("Reject #\(confirmation.id)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSending {
                        ProgressView()
                    } else {
                        Button("Reject") {
                            Task {
                                isSending = true
                                await submit(reason.trimmingCharacters(in: .whitespacesAndNewlines))
                                isSending = false
                            }
                        }
                        .fontWeight(.semibold)
                    }
                }
            }
            .onAppear { focused = true }
        }
    }
}

/// `sheet(item:)` for an `Identifiable` optional binding — the standard shape, which SwiftUI
/// provides for `Binding<Item?>` only via this overload.
private extension View {
    func sheet<Item: Identifiable, Content: View>(
        item: Binding<Item?>,
        @ViewBuilder content: @escaping (Item) -> Content
    ) -> some View {
        sheet(isPresented: Binding(
            get: { item.wrappedValue != nil },
            set: { if !$0 { item.wrappedValue = nil } }
        )) {
            if let value = item.wrappedValue { content(value) }
        }
    }
}
