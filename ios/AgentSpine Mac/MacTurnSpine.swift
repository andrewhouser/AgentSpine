import SwiftUI

/// The agent's side of a turn, hung on the spine as the UI Directions draw it: a node per tool
/// call (solid in the verdict's colour once decided), the reply beside the line, and a hollow
/// amber node where a question is waiting on you.
///
/// One view serves a finished turn (from the ledger) and the live one (from the stream), which
/// is the point: the same turn must not look different the moment it finishes streaming. It
/// takes plain values rather than a `Turn` or a `RunStream` so neither has to be faked.
struct MacTurnSpine: View {
    struct Call: Identifiable {
        let id: String
        let tool: String
        let target: String?
        let args: String?
        let output: String?
        let status: BrokerStatus?

        init(_ action: Action) {
            id = "action-\(action.id)"
            tool = action.tool
            target = action.target
            args = action.args
            output = action.output
            status = action.status
        }

        /// A call still in flight has no arguments yet and, until the broker answers, no status.
        init(_ call: RunStream.LiveCall) {
            id = "live-\(call.callID)"
            tool = call.tool
            target = call.target
            args = nil
            output = call.output
            status = call.status
        }
    }

    var calls: [Call] = []
    /// The run's own progress line while it streams; `.idle` for a finished turn.
    var phase: RunStream.Phase = .idle
    var summary: String?
    /// Shown in the danger colour: a failed turn, or the stream's failure message.
    var failure: String?
    /// The stream could not be held open. Not the same as the run failing.
    var note: String?
    var confirmations: [Confirmation] = []
    var onDecided: () async -> Void = {}

    private enum Row: Identifiable {
        case call(Call)
        case progress(String)
        case text(String)
        case failure(String)
        case note(String)
        case waiting(Confirmation)

        var id: String {
            switch self {
            case .call(let call): return call.id
            case .progress: return "progress"
            case .text: return "text"
            case .failure: return "failure"
            case .note: return "note"
            case .waiting(let confirmation): return "waiting-\(confirmation.id)"
            }
        }
    }

    private var rows: [Row] {
        var rows = calls.map(Row.call)
        switch phase {
        case .queued(let behind):
            // Agent cycles are serialised on the server, so this run may genuinely be waiting
            // behind a scheduled job. Saying so beats a spinner that looks like a hang.
            rows.append(.progress(behind > 0 ? "Queued behind \(behind) run\(behind == 1 ? "" : "s")" : "Starting…"))
        case .running(let step):
            rows.append(.progress("Step \(step)"))
        case .finished, .failed, .idle:
            break
        }
        if let summary, !summary.isEmpty { rows.append(.text(summary)) }
        if let failure, !failure.isEmpty { rows.append(.failure(failure)) }
        if let note, !note.isEmpty { rows.append(.note(note)) }
        rows += confirmations.map(Row.waiting)
        return rows
    }

    var body: some View {
        let rows = rows
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                spineRow(row, isFirst: index == 0, isLast: index == rows.count - 1)
            }
        }
    }

    /// `SpineRow.Node` is nested in a generic type, so each node is written where its row is
    /// built rather than returned from a helper.
    @ViewBuilder private func spineRow(_ row: Row, isFirst: Bool, isLast: Bool) -> some View {
        switch row {
        case .call(let call):
            SpineRow(node: .verdict(call.status), isFirst: isFirst, isLast: isLast) { content(for: row) }
        case .failure:
            SpineRow(node: .verdict(.error), isFirst: isFirst, isLast: isLast) { content(for: row) }
        case .waiting:
            SpineRow(node: .waiting, isFirst: isFirst, isLast: isLast) { content(for: row) }
        case .progress, .text, .note:
            SpineRow(node: .plain, isFirst: isFirst, isLast: isLast) { content(for: row) }
        }
    }

    @ViewBuilder private func content(for row: Row) -> some View {
        switch row {
        case .call(let call):
            ToolCallRow(tool: call.tool, target: call.target, args: call.args, output: call.output, status: call.status, flat: true)
        case .progress(let text):
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text(text)
            }
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
            .foregroundStyle(Spine.Palette.textDim)
        case .text(let text):
            MarkdownText(text)
        case .failure(let text):
            Label(text, systemImage: "exclamationmark.triangle")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.danger)
        case .note(let text):
            Label(text, systemImage: "wifi.exclamationmark")
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
        case .waiting(let confirmation):
            MacApprovalCard(confirmation: confirmation) { await onDecided() }
        }
    }
}
