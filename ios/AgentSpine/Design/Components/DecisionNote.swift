import SwiftUI

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
