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
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(tool)
                            .font(.caption.weight(.semibold).monospaced())
                        if let target, !target.isEmpty {
                            Text(target)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }

                    Spacer(minLength: 6)
                    VerdictBadge(status: status)

                    if hasDetail {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
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
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct DetailBlock: View {
    let label: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.caption2.monospaced())
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // A tool output can be thousands of lines; the thread must stay scrollable.
            .frame(maxHeight: 260)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}
