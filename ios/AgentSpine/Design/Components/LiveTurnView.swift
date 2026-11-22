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

            let recovered = RecoveredCalls.flags(stream.calls.map { $0.status?.rawValue }, turnFailed: turnFailed)
            ForEach(Array(stream.calls.enumerated()), id: \.element.id) { index, call in
                ToolCallRow(
                    tool: call.tool,
                    target: call.target,
                    args: nil,
                    output: call.output,
                    status: call.status,
                    recovered: recovered[index]
                )
            }

            if stream.isLive { PlanCardView(steps: stream.plan) }

            if case .finished(let summary) = stream.phase, let summary, !summary.isEmpty {
                if let card = WeatherCard.of(calls: stream.calls.map { ($0.tool, $0.output, $0.status == .executed) }) {
                    WeatherCardView(card: card)
                }
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

    /// A turn that has itself failed keeps every error as it was (see `RecoveredCalls`).
    private var turnFailed: Bool {
        if case .failed = stream.phase { return true }
        return false
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


/// The steps a running turn is working through, each waiting, in progress or done.
///
/// The server owns every status: `src/plan.ts` folds the run's own tool calls and publishes a
/// `plan` event with the whole list each time it changes, so this only draws the newest one
/// (web: `PlanCard.tsx`). Shown while the turn runs; once it ends, the tool-call rows are the
/// record and the card would only repeat them. Shared by the iPhone and Mac targets.
struct PlanCardView: View {
    let steps: [PlanStep]

    var body: some View {
        if !steps.isEmpty {
            VStack(alignment: .leading, spacing: Spine.Space.sm) {
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    row(step)
                }
            }
            .padding(.horizontal, Spine.Space.md + 2)
            .padding(.vertical, Spine.Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
            .overlay(RoundedRectangle(cornerRadius: Spine.Radius.md).strokeBorder(Spine.Palette.border))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Plan")
        }
    }

    private func row(_ step: PlanStep) -> some View {
        HStack(spacing: 10) {
            PlanMark(status: step.status)
            (Text(step.label).foregroundStyle(labelColor(step.status))
                + Text(step.count > 1 ? " ×\(step.count)" : "").foregroundStyle(Spine.Palette.textFaint))
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(accessibilityStatus(step.status))
    }

    private func labelColor(_ status: PlanStep.Status) -> Color {
        switch status {
        case .active: return Spine.Palette.text
        case .failed: return Spine.Palette.danger
        case .waiting: return Spine.Palette.warn
        case .done, .pending: return Spine.Palette.textDim
        }
    }

    private func accessibilityStatus(_ status: PlanStep.Status) -> String {
        switch status {
        case .active: return "in progress"
        case .done: return "done"
        case .failed: return "failed"
        case .pending: return "waiting"
        case .waiting: return "waiting on your approval"
        }
    }
}

/// Pending: a dashed ring. Active: a turning ring with a gap. Done: a green check disc.
/// Failed: a red disc. Waiting on approval: a hollow amber ring, as on the spine.
private struct PlanMark: View {
    let status: PlanStep.Status
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var turning = false

    private let size: CGFloat = 14

    var body: some View {
        Group {
            switch status {
            case .pending:
                Circle().strokeBorder(Spine.Palette.textFaint, style: StrokeStyle(lineWidth: 1.5, dash: [2.5, 2]))
            case .active:
                Circle()
                    .trim(from: 0, to: 0.75)
                    .stroke(Spine.Palette.textFaint, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .padding(0.75)
                    .rotationEffect(.degrees(turning ? 360 : 0))
                    .onAppear {
                        guard !reduceMotion else { return }
                        withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { turning = true }
                    }
            case .done:
                Circle().fill(Spine.Palette.ok)
                    .overlay(Image(systemName: "checkmark").font(.system(size: 7.5, weight: .bold)).foregroundStyle(Spine.Palette.bgElevated))
            case .failed:
                Circle().fill(Spine.Palette.danger)
                    .overlay(Image(systemName: "xmark").font(.system(size: 6.5, weight: .bold)).foregroundStyle(Spine.Palette.bgElevated))
            case .waiting:
                Circle().strokeBorder(Spine.Palette.warn, lineWidth: 1.5)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
