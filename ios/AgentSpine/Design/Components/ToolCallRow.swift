import SwiftUI

/// One tool call, with the broker's verdict on it.
///
/// Collapsed it is a line; expanded it is the exact arguments and the exact output. That
/// split is the same one the dashboard makes, and for the same reason: the badge is the claim
/// ("code decided this, not the model") and the expansion is the evidence. A row you cannot
/// open is a row asking to be trusted.
struct ToolCallRow: View {
    let tool: String
    let target: String?
    let args: String?
    let output: String?
    let status: BrokerStatus?

    @State private var expanded = false

    private var hasDetail: Bool {
        (args?.isEmpty == false) || (output?.isEmpty == false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                guard hasDetail else { return }
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "wrench.and.screwdriver.fill")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(tool)
                            .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                        if let target, !target.isEmpty {
                            Text(target)
                                .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                                .foregroundStyle(Spine.Palette.textDim)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }

                    Spacer(minLength: 6)
                    VerdictBadge(status: status)

                    if hasDetail {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                            .foregroundStyle(Spine.Palette.textFaint)
                    }
                }
            }
            .buttonStyle(.plain)

            if expanded {
                if let args, !args.isEmpty {
                    DetailBlock(label: "Arguments", text: PrettyJSON.format(args))
                }
                if let output, !output.isEmpty {
                    DetailBlock(label: "Output", text: output)
                }
            }
        }
        .padding(10)
        .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
    }
}

private struct DetailBlock: View {
    let label: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(.semibold))
                .foregroundStyle(Spine.Palette.textFaint)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(SpineFont.mono(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // A tool output can be thousands of lines; the thread must stay scrollable.
            .frame(maxHeight: 260)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: 8))
    }
}
