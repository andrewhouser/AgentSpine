import SwiftUI

/// One thread, read-only for now: your messages, each turn's tool calls with the broker's
/// verdict, and the reply. The composer, live streaming and the inline approval card are the
/// next piece of phase 3; until then a question waiting on you is shown but answered on the
/// phone or the web.
struct MacThreadDetail: View {
    let conversationID: Int

    @State private var thread: Thread?
    @State private var loadError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spine.Space.lg) {
                if let loadError {
                    ErrorNotice(message: loadError) { Task { await load() } }
                } else if let thread {
                    ForEach(thread.turns) { turn in
                        TurnBlock(turn: turn)
                    }
                    let waiting = (thread.confirmations ?? []) + thread.turns.flatMap(\.confirmations).filter(\.isPending)
                    ForEach(waiting) { confirmation in
                        HStack(spacing: Spine.Space.sm) {
                            AttentionDot()
                            Text("Waiting on you: \(confirmation.summary)")
                                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                                .foregroundStyle(Spine.Palette.attention)
                        }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, Spine.Space.xxl)
                }
            }
            .padding(Spine.Space.xl)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Spine.Palette.bg)
        .navigationTitle(thread?.conversation.displayTitle ?? "Thread")
        .task { await load() }
    }

    private func load() async {
        do {
            thread = try await APIClient.shared.thread(conversationID)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

/// One turn: what you asked, what the agent did, what it said.
private struct TurnBlock: View {
    let turn: Turn

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm + 2) {
            if let task = turn.task, !task.isEmpty, !turn.isDecision {
                ThreadBubble(text: task)
            }

            ForEach(turn.actions) { action in
                ToolCallRow(
                    tool: action.tool,
                    target: action.target,
                    args: action.args,
                    output: action.output,
                    status: action.status
                )
            }

            if let summary = turn.summary, !summary.isEmpty {
                MarkdownText(summary)
            } else if turn.status == "failed" {
                Label("This turn failed.", systemImage: "exclamationmark.triangle")
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(Spine.Palette.danger)
            }
        }
    }
}
