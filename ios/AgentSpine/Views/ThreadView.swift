import SwiftUI

/// One thread: the turns so far, the live turn if there is one, and a composer.
///
/// The live turn is the part worth the effort. A cycle on the local model takes minutes, and
/// what happens during those minutes — each tool call and the broker's verdict on it — is the
/// thing this project is actually about. So a turn in flight renders from the SSE stream, and
/// the finished turns render from the thread reload, and the two look the same.
struct ThreadView: View {
    let conversationID: Int

    @Environment(AppState.self) private var state
    @State private var thread: Thread?
    @State private var stream = RunStream()
    @State private var draft = ""
    @State private var error: String?
    @State private var isSending = false
    @State private var liveTask: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if let error {
                        ErrorNotice(message: error) { Task { await load() } }
                    }

                    ForEach(thread?.turns ?? []) { turn in
                        TurnView(turn: turn)
                            .id("turn-\(turn.id)")
                    }

                    if stream.isLive || stream.transportNote != nil {
                        LiveTurnView(task: liveTask ?? "", stream: stream)
                            .id("live")
                    }

                    // Anchors the scroll so a new event keeps the newest content in view.
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal)
                .padding(.top, 12)
            }
            .onChange(of: stream.calls.count) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: thread?.turns.count) { _, _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
        .navigationTitle(thread?.conversation.displayTitle ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { composer }
        .refreshable { await load() }
        .task { await load() }
        .onChange(of: stream.phase) { _, phase in
            // The turn is over: reload so it is rendered from the ledger rather than from a
            // stream that is about to be discarded. The reload is also what picks up anything
            // the stream does not carry — the tier it was sized to, the child runs.
            switch phase {
            case .failed, .finished:
                Task {
                    await load()
                    liveTask = nil
                    await state.refreshApprovals()
                }
            default:
                break
            }
        }
        .onDisappear { stream.stop() }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Reply", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                .lineLimit(1...5)

            Button {
                Task { await send() }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func load() async {
        do {
            let fresh = try await APIClient.shared.thread(conversationID)
            thread = fresh
            error = nil
            // A turn still running when the thread loaded — because the task was started from
            // another device, or the app was killed mid-cycle — gets picked up and streamed.
            // Without this, reopening the app during a long run shows a thread that looks stuck.
            if !stream.isLive, let running = fresh.turns.last, running.isRunning {
                liveTask = running.task
                stream.start(runID: running.id)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func send() async {
        let task = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty else { return }
        isSending = true
        defer { isSending = false }
        do {
            let started = try await APIClient.shared.send(message: task, to: conversationID)
            draft = ""
            liveTask = task
            stream.start(runID: started.runID)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - A finished turn

struct TurnView: View {
    let turn: Turn

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let task = turn.task, !task.isEmpty {
                Text(task)
                    .font(.body)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 16))
                    .frame(maxWidth: .infinity, alignment: .trailing)
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

            ForEach(turn.children) { child in
                DelegationRow(child: child)
            }

            if let summary = turn.summary, !summary.isEmpty {
                Text(summary)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if turn.status == "failed" {
                Label("This turn failed.", systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            HStack(spacing: 6) {
                Text(SpineDate.timeOfDay(turn.started))
                if let tier = turn.tier { Text("·"); Text(tier) }
                if !turn.actions.isEmpty {
                    Text("·")
                    Text("\(turn.actions.count) tool call\(turn.actions.count == 1 ? "" : "s")")
                }
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
    }
}

/// A unit this turn delegated to. Collapsed by default: a Dispatch subagent can make a dozen
/// calls of its own and inlining them would bury the turn that asked for the work.
struct DelegationRow: View {
    let child: ChildRun
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.triangle.branch")
                        .foregroundStyle(.purple)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(child.agent ?? "subagent")
                            .font(.caption.weight(.semibold))
                        if let task = child.task {
                            Text(task).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    Spacer()
                    Text("\(child.actions.count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)

            if expanded {
                ForEach(child.actions) { action in
                    ToolCallRow(
                        tool: action.tool,
                        target: action.target,
                        args: action.args,
                        output: action.output,
                        status: action.status
                    )
                }
                if let summary = child.summary, !summary.isEmpty {
                    Text(summary).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - The turn in flight

struct LiveTurnView: View {
    let task: String
    let stream: RunStream

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !task.isEmpty {
                Text(task)
                    .font(.body)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 16))
                    .frame(maxWidth: .infinity, alignment: .trailing)
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

            if !stream.pendingConfirmationIDs.isEmpty {
                Label(
                    "Waiting for your approval — see the Approvals tab.",
                    systemImage: "checkmark.shield"
                )
                .font(.footnote.weight(.medium))
                .foregroundStyle(.orange)
            }

            if case .finished(let summary) = stream.phase, let summary, !summary.isEmpty {
                Text(summary).font(.body).textSelection(.enabled)
            }
            if case .failed(let message) = stream.phase {
                Text(message).font(.footnote).foregroundStyle(.red)
            }
            if let note = stream.transportNote {
                Label(note, systemImage: "wifi.exclamationmark")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
            .font(.caption)
            .foregroundStyle(.secondary)
        case .running(let step):
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text("Step \(step)")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        case .failed, .finished, .idle:
            EmptyView()
        }
    }
}
