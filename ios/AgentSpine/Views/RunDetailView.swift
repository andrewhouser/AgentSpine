import SwiftUI

/// One run, in full.
///
/// The Activity tab lists what ran; this is where you find out what it *did*. Most of what
/// AgentSpine does has no thread — a watcher firing every few minutes, a 6am brief — so for
/// those runs this screen is the only account of them that exists anywhere on the phone.
///
/// The trace is behind a disclosure and is deliberately ugly. It is the raw message array
/// the model saw, including the standing context injected before the run: the profile and
/// the recalled memories. That is the first thing worth reading when a run behaves oddly,
/// because it shows what the assistant thought it knew going in — and a prettier rendering
/// would be a paraphrase of the one thing here that must not be paraphrased.
struct RunDetailView: View {
    let runID: Int

    @State private var detail: RunDetail?
    @State private var error: String?
    @State private var showTrace = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if let error {
                    ErrorNotice(message: error) { Task { await load() } }
                }

                if let detail {
                    header(detail.run)

                    if detail.actions.isEmpty {
                        Text("No tool calls — this run answered from what it already knew.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(detail.actions) { action in
                            ToolCallRow(
                                tool: action.tool,
                                target: action.target,
                                args: action.args,
                                output: action.output,
                                status: action.status
                            )
                        }
                    }

                    if let note = detail.run.note, !note.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("SUMMARY")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.tertiary)
                            MarkdownText(note)
                        }
                    }

                    trace(detail.trace)
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
        }
        .navigationTitle("Run #\(runID)")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder private func header(_ run: Run) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(run.task ?? "(no task recorded)")
                .font(.body.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                Text(run.kind)
                Text("·")
                Text(run.status)
                Text("·")
                Text(SpineDate.relative(run.started))
                if let elapsed = elapsed(run) {
                    Text("·")
                    Text(elapsed)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            // A failed run's note is the reason it failed, which belongs at the top rather
            // than at the bottom under the summary heading.
            if run.status == "failed", let note = run.note, !note.isEmpty {
                Label(note, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func trace(_ messages: [TraceMessage]) -> some View {
        if !messages.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { showTrace.toggle() }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: showTrace ? "chevron.down" : "chevron.right")
                            .font(.caption2)
                        Text("Raw trace — \(messages.count) message\(messages.count == 1 ? "" : "s")")
                            .font(.caption.weight(.medium))
                        Spacer()
                    }
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)

                if showTrace {
                    Text("What the model actually saw, in order: the standing context, then the turn.")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)

                    ForEach(messages) { message in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(message.role.uppercased())
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.tertiary)
                            Text(message.text)
                                .font(.caption2.monospaced())
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(9)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
            .padding(.top, 4)
        }
    }

    /// How long the run took, when it finished. Omitted rather than guessed for one still
    /// running — "0s" on a run that is three minutes in would be a lie.
    private func elapsed(_ run: Run) -> String? {
        guard let start = SpineDate.parse(run.started),
              let end = SpineDate.parse(run.finished)
        else { return nil }
        let seconds = Int(end.timeIntervalSince(start).rounded())
        if seconds < 60 { return "\(seconds)s" }
        return "\(seconds / 60)m \(seconds % 60)s"
    }

    private func load() async {
        do {
            detail = try await APIClient.shared.run(runID)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
