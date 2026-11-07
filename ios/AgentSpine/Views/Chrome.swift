import SwiftUI

/// Small shared pieces, kept together so the screens stay about their own job.

/// The broker's verdict, as a badge. The same five states the dashboard shows, in the same
/// words, because the point is that this decision is legible wherever you see the call.
struct VerdictBadge: View {
    let status: BrokerStatus?

    var body: some View {
        if let status {
            Label(status.label, systemImage: status.symbol)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(tint.opacity(0.15), in: Capsule())
                .foregroundStyle(tint)
        } else {
            Label("running", systemImage: "circle.dotted")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Color.secondary.opacity(0.12), in: Capsule())
                .foregroundStyle(.secondary)
        }
    }

    private var tint: Color {
        switch status {
        case .executed: return .green
        case .denied: return .red
        case .queued: return .orange
        case .dryRun: return .blue
        case .error: return .red
        case nil: return .secondary
        }
    }
}

/// An error that says what to go and check, rather than a toast that vanishes.
struct ErrorNotice: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Can't load", systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let retry {
                Button("Try again", action: retry)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal)
    }
}

struct EmptyNotice: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 34))
                .foregroundStyle(.tertiary)
            Text(title).font(.headline)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity)
    }
}

/// A tool call's arguments, pretty-printed.
///
/// The server stores them as the JSON string the model produced, which on one line is
/// unreadable on a phone. Re-encoding with sorted keys and indentation is the difference
/// between "I can see what it was about to do" and "there is some JSON here".
enum PrettyJSON {
    static func format(_ raw: String) -> String {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(
                  withJSONObject: object,
                  options: [.prettyPrinted, .sortedKeys]
              ),
              let text = String(data: pretty, encoding: .utf8)
        else { return raw }
        return text
    }
}
