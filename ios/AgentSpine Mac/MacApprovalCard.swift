import SwiftUI

/// An irreversible action, asked about in the thread that wanted it. The Mac twin of the
/// iPhone card: the whole proposed action is shown, not a preview, and answering goes through
/// the same confirmation queue (`AppState.answer`), so there is no new write path.
struct MacApprovalCard: View {
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
        VStack(alignment: .leading, spacing: Spine.Space.md) {
            HStack(spacing: Spine.Space.sm) {
                AttentionDot()
                Text("Waiting on you")
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                    .foregroundStyle(Color.attention)
                Text(confirmation.tool)
                    .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textDim)
                Spacer()
                Text("#\(confirmation.id)")
                    .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textFaint)
            }

            Text(confirmation.summary)
                .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body))
                .foregroundStyle(Spine.Palette.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            DisclosureGroup("Details", isExpanded: $showArgs) {
                Text(PrettyJSON.format(confirmation.args))
                    .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Spine.Space.sm + 1)
                    .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: Spine.Radius.sm + 2))
            }
            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))

            if let error {
                Text(error)
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.danger)
            }

            HStack(spacing: Spine.Space.sm + 2) {
                Spacer()
                Button("Reject…") {
                    reason = ""
                    rejecting = true
                }
                .tint(Spine.Palette.danger)

                Button {
                    Task { await decide(approve: true) }
                } label: {
                    if busy { ProgressView().controlSize(.small) } else { Text("Approve") }
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.attention)
                .keyboardShortcut(.defaultAction)
            }
            .disabled(busy)
        }
        .padding(Spine.Space.lg)
        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.lg).strokeBorder(Spine.Palette.attentionLine, lineWidth: 1))
        .sheet(isPresented: $rejecting) { rejectSheet }
    }

    /// Rejecting asks why, because the answer is worth something: a reason becomes a
    /// `preference` memory the server recalls before similar work. Skipping is allowed.
    private var rejectSheet: some View {
        VStack(alignment: .leading, spacing: Spine.Space.md) {
            Text("Reject #\(confirmation.id)")
                .font(SpineFont.display(Spine.TypeSize.title3, relativeTo: .title3))
            Text(confirmation.summary)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)
                .lineLimit(4)
            TextField("Why not? (optional)", text: $reason, axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
            Text("A reason is remembered as a preference, and the assistant carries on from it. Leave it empty to just say no.")
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textFaint)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { rejecting = false }
                    .keyboardShortcut(.cancelAction)
                Button("Reject") {
                    Task {
                        await decide(approve: false, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines))
                        rejecting = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .tint(Spine.Palette.danger)
            }
        }
        .padding(Spine.Space.xl)
        .frame(width: 420)
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
