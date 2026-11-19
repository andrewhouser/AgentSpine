import SwiftUI

/// The amber of "this is waiting on you" — the dot on a thread row and the edge of an inline
/// approval card. Its own token rather than the accent, so it reads as a signal.
extension Color {
    static let attention = Spine.Palette.attention
}

/// The blue dot on a thread that has a question waiting on you.
struct AttentionDot: View {
    var body: some View {
        // Hollow, like the spine's waiting node: a shape difference as well as a colour one.
        Circle()
            .strokeBorder(Color.attention, lineWidth: 2)
            .frame(width: 10, height: 10)
            .accessibilityLabel("Waiting on you")
    }
}

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
    /// Called after the server accepted the answer, so the thread can reload.
    let onDecided: () async -> Void

    @Environment(AppState.self) private var state
    @State private var busy = false
    @State private var rejecting = false
    @State private var reason = ""
    @State private var error: String?
    @State private var showArgs = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                AttentionDot()
                Text("Waiting on you")
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                    .foregroundStyle(Color.attention)
                Text(confirmation.tool)
                    .font(SpineFont.mono(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                    .foregroundStyle(Spine.Palette.textDim)
                Spacer()
                Text("#\(confirmation.id)")
                    .font(SpineFont.mono(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                    .foregroundStyle(Spine.Palette.textFaint)
            }

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

            HStack(spacing: 10) {
                Button(role: .destructive) {
                    reason = ""
                    rejecting = true
                } label: {
                    Text("Reject").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(Spine.Palette.danger)

                Button {
                    Task { await decide(approve: true) }
                } label: {
                    Group {
                        if busy { ProgressView() } else { Text("Approve") }
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.attention)
            }
            .disabled(busy)
        }
        .padding(Spine.Space.lg)
        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.lg).strokeBorder(Spine.Palette.attentionLine, lineWidth: 1))
        .sheet(isPresented: $rejecting) {
            RejectSheet(confirmation: confirmation, reason: $reason) { text in
                await decide(approve: false, reason: text)
                rejecting = false
            }
        }
    }

    private func decide(approve: Bool, reason: String = "") async {
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

/// Where you pressed Approve or Reject, in the thread's timeline — the resumed turn's
/// "message", drawn as the record of an answer rather than as something you typed.
struct DecisionNote: View {
    let text: String

    private struct Decision: Identifiable {
        let id: Int
        let approved: Bool
        let headline: String
        var detail: [String]
    }

    /// Split the server's message (see decisionMessage in src/confirmations.ts).
    private var decisions: [Decision] {
        var out: [Decision] = []
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("✓ ") || line.hasPrefix("✗ ") || line.hasPrefix("• ") {
                out.append(Decision(id: out.count, approved: line.hasPrefix("✓"), headline: String(line.dropFirst(2)), detail: []))
            } else if line.hasPrefix("  "), !out.isEmpty {
                out[out.count - 1].detail.append(line.trimmingCharacters(in: .whitespaces))
            }
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(decisions) { d in
                VStack(alignment: .leading, spacing: 2) {
                    Label(d.headline, systemImage: d.approved ? "checkmark.circle.fill" : "xmark.circle")
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.medium))
                        .foregroundStyle(d.approved ? Spine.Palette.ok : Spine.Palette.textDim)
                    if !d.detail.isEmpty {
                        Text(d.detail.joined(separator: "\n"))
                            .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                            .foregroundStyle(Spine.Palette.textDim)
                            .lineLimit(4)
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                .foregroundStyle(Spine.Palette.textFaint)
        )
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
