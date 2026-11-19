import SwiftUI

struct LiveTurnView: View {
    let task: String
    var isDecision = false
    let stream: RunStream

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !task.isEmpty, isDecision {
                DecisionNote(text: task)
            } else if !task.isEmpty {
                ThreadBubble(text: task)
            }

            phaseLine

            ForEach(stream.calls) { call in
                ToolCallRow(
                    tool: call.tool,
                    target: call.target,
                    args: nil,
                    output: call.output,
                    status: call.status
                )
            }


            if case .finished(let summary) = stream.phase, let summary, !summary.isEmpty {
                MarkdownText(summary)
            }
            if case .failed(let message) = stream.phase {
                Text(message).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.danger)
            }
            if let note = stream.transportNote {
                Label(note, systemImage: "wifi.exclamationmark")
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textDim)
            }
        }
    }

    @ViewBuilder private var phaseLine: some View {
        switch stream.phase {
        case .queued(let behind):
            // Agent cycles are serialised on the server, so this run may genuinely be waiting
            // behind a scheduled job. Saying so beats a spinner that looks like a hang.
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text(behind > 0 ? "Queued behind \(behind) run\(behind == 1 ? "" : "s")" : "Starting…")
            }
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
            .foregroundStyle(Spine.Palette.textDim)
        case .running(let step):
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text("Step \(step)")
            }
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
            .foregroundStyle(Spine.Palette.textDim)
        case .failed, .finished, .idle:
            EmptyView()
        }
    }
}
