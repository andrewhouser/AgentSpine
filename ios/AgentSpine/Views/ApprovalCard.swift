import SwiftUI

/// An irreversible action, asked about in the thread that wanted it.
///
/// The way a chat assistant asks: the buttons appear in the conversation, under the turn that
/// raised them, and answering picks the conversation back up — the server starts a turn
/// carrying the result, which the thread then streams. There is no separate queue to visit.
///
/// One deliberate choice, carried over from the dashboard: **the whole proposed action is
/// shown, not a preview.** For a draft the summary is the draft. The arguments are one tap
/// away for anything else. A one-line preview makes approving a rubber stamp.
struct ApprovalCard: View {
    let confirmation: Confirmation
    /// False when this question came from the phone's saved copy. It may already have been answered or changed, so it
    /// cannot be answered from here even if the network has come back: only a fresh load of the thread makes it live.
    var answerable = true
    /// Called after the server accepted the answer, so the thread can reload.
    let onDecided: () async -> Void

    @Environment(AppState.self) private var state
    @State private var busy = false
    @State private var rejecting = false
    @State private var reason = ""
    @State private var error: String?
    @State private var showArgs = false
    /// The four facts (section 15, R2), loaded beside the card. Approve waits for them.
    @State private var card: DecisionCard?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                AttentionDot()
                Text(answerable ? "Waiting on you" : "Was waiting when saved")
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                    .foregroundStyle(Color.attention)
                Text(confirmation.tool)
                    .font(SpineFont.mono(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                    .foregroundStyle(Spine.Palette.textDim)
                Spacer()
                if let card, !DecisionWords.positionLine(card.position).isEmpty {
                    Text(DecisionWords.positionLine(card.position))
                        .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                        .foregroundStyle(Spine.Palette.textFaint)
                }
                Text("#\(confirmation.id)")
                    .font(SpineFont.mono(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                    .foregroundStyle(Spine.Palette.textFaint)
            }

            if let card { DecisionFactsView(card: card) }

            Text(confirmation.summary)
                .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .callout))
                .foregroundStyle(Spine.Palette.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            DisclosureGroup("Details", isExpanded: $showArgs) {
                Text(PrettyJSON.format(confirmation.args))
                    .font(SpineFont.mono(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Spine.Space.sm + 1)
                    .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: Spine.Radius.sm + 2))
            }
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
            .tint(Spine.Palette.textDim)

            if let error {
                Text(error).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.danger)
            }

            if answerable {
                HStack(spacing: 10) {
                    Button(role: .destructive) {
                        reason = ""
                        rejecting = true
                    } label: {
                        Text("Reject").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(Spine.Palette.danger)

                    HoldToApprove(busy: busy || card == nil) {
                        Task { await decide(approve: true) }
                    }
                }
                .disabled(busy)
                if let offer = card?.alwaysAllow { AlwaysAllowRow(offer: offer) }
            } else {
                Text("This can only be answered once you reconnect and the thread reloads. It may already have been answered.")
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(Spine.Palette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Spine.Space.lg)
        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.lg).strokeBorder(Spine.Palette.attentionLine, lineWidth: 1))
        .task(id: confirmation.id) { card = try? await APIClient.shared.decisionCard(confirmation.id) }
        .sheet(isPresented: $rejecting) {
            RejectSheet(confirmation: confirmation, reason: $reason) { text in
                await decide(approve: false, reason: text)
                rejecting = false
            }
        }
    }

    private func decide(approve: Bool, reason: String = "") async {
        // The reject sheet can still be open when a reload swaps this card to a saved copy.
        guard answerable else { return }
        busy = true
        defer { busy = false }
        do {
            try await state.answer(confirmation, approve: approve, reason: reason)
            error = nil
            await onDecided()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Rejecting asks why, because the answer is worth something.
///
/// A reason becomes a `preference` memory on the server that gets recalled before similar
/// work, and it is handed back to the conversation so the assistant can carry on another way.
/// Skipping is allowed — a bare "no" just ends the matter.
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
                        .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .callout))
                }
                Section {
                    TextField("Why not? (optional)", text: $reason, axis: .vertical)
                        .frame(minHeight: 70, alignment: .topLeading)
                        .focused($focused)
                } footer: {
                    Text("A reason is remembered as a preference, and the assistant carries on "
                         + "from it. Leave it empty to just say no.")
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
        .presentationDetents([.medium])
    }
}

