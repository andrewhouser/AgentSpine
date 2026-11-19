import SwiftUI

/// A question waiting on the user, with the answer inline. Presentational only: the thread uses
/// `ApprovalCard` (Views/), which owns the network call; it adopts this once the two are merged.
///
/// The card only reports the choice. Approving goes through the confirmation queue like every
/// other irreversible call; this view adds no write path. It shows the tool name and the exact
/// summary the server queued, because approving something you cannot read is not approving.
struct ApprovalPrompt: View {
    let tool: String
    let summary: String
    var detail: String?
    var isBusy = false
    let onApprove: () -> Void
    let onReject: () -> Void

    @State private var showDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.md) {
            HStack(spacing: Spine.Space.sm) {
                Image(systemName: "questionmark.circle.fill")
                    .foregroundStyle(Spine.Palette.attention)
                    .accessibilityHidden(true)
                Text(tool)
                    .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                    .foregroundStyle(Spine.Palette.text)
                Spacer(minLength: 0)
                VerdictBadge(status: .queued)
            }

            Text(summary)
                .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body))
                .foregroundStyle(Spine.Palette.text)
                .fixedSize(horizontal: false, vertical: true)

            if let detail, !detail.isEmpty {
                DisclosureGroup(isExpanded: $showDetail) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(detail)
                            .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textDim)
                            .textSelection(.enabled)
                            .padding(Spine.Space.sm)
                    }
                    .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: Spine.Radius.sm))
                } label: {
                    Text("Arguments")
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(Spine.Palette.textDim)
                }
            }

            HStack(spacing: Spine.Space.sm + 2) {
                Button(action: onApprove) {
                    Text("Approve").frame(maxWidth: .infinity, minHeight: touchHeight)
                }
                .buttonStyle(.borderedProminent)
                .tint(Spine.Palette.accent)

                Button(action: onReject) {
                    Text("Reject").frame(maxWidth: .infinity, minHeight: touchHeight)
                }
                .buttonStyle(.bordered)
                .tint(Spine.Palette.danger)
            }
            .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
            .disabled(isBusy)
        }
        .padding(Spine.Space.lg)
        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Spine.Radius.lg)
                .strokeBorder(Spine.Palette.attentionLine, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }

    /// Larger touch targets on iPhone; the Mac's pointer does not need them.
    private var touchHeight: CGFloat {
        #if os(iOS)
        return 36
        #else
        return 22
        #endif
    }
}
