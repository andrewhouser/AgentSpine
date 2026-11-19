import SwiftUI

/// One thread: the finished turns from the ledger, the turn in flight from the stream, any
/// question waiting on you with its buttons, and a composer.
///
/// The same rule as the phone: a turn in flight renders from the SSE stream, and when it ends
/// the thread reloads so the turn is drawn from the ledger instead. A reload while a run is in
/// flight returns that run as a turn too, so it is filtered out of the ledger list or the
/// message would be drawn twice.
struct MacThreadDetail: View {
    let conversationID: Int

    @Environment(AppState.self) private var state
    @Environment(MacThreadHub.self) private var hub

    /// Who is nudging, so a window ignores its own nudge.
    @State private var viewID = UUID()

    @State private var thread: Thread?
    @State private var loadError: String?
    @State private var stream = RunStream()
    @State private var liveTask: String?
    @State private var draft = ""
    @State private var isSending = false
    @State private var composerError: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: Spine.Space.lg) {
                        if let loadError {
                            ErrorNotice(message: loadError) { Task { await load() } }
                        } else if let thread {
                            ForEach(ledgerTurns) { turn in
                                TurnBlock(turn: turn)
                                ForEach(turn.confirmations) { confirmation in
                                    MacApprovalCard(confirmation: confirmation) {
                                        await load()
                                        hub.nudge(conversationID, from: viewID)
                                    }
                                }
                            }
                            ForEach(thread.confirmations ?? []) { confirmation in
                                MacApprovalCard(confirmation: confirmation) {
                                        await load()
                                        hub.nudge(conversationID, from: viewID)
                                    }
                            }
                            if showsLiveTurn {
                                LiveTurnView(task: liveTask ?? "", isDecision: liveIsDecision, stream: stream)
                                ForEach(liveConfirmations) { confirmation in
                                    MacApprovalCard(confirmation: confirmation) {
                                        await load()
                                        hub.nudge(conversationID, from: viewID)
                                    }
                                }
                            }
                        } else {
                            ProgressView().frame(maxWidth: .infinity).padding(.top, Spine.Space.xxl)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(Spine.Space.xl)
                    .frame(maxWidth: 760, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: stream.calls.count) { _, _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onChange(of: thread?.turns.count) { _, _ in
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }

            Divider()
            MacComposer(
                draft: $draft,
                isBusy: isSending,
                isDisabled: thread == nil || stream.isLive,
                error: composerError,
                send: { Task { await send() } }
            )
        }
        .background(Spine.Palette.bg)
        .navigationTitle(state.conversations.first { $0.id == conversationID }?.displayTitle ?? thread?.conversation.displayTitle ?? "Thread")
        .toolbar { ToolbarItem { tierMenu } }
        .task { await load() }
        .onDisappear { stream.stop() }
        .onChange(of: stream.phase) { _, phase in
            // The turn is over: reload so it is drawn from the ledger, which also picks up what
            // the stream does not carry (the tier it ran at, child runs).
            switch phase {
            case .failed, .finished:
                Task {
                    await load()
                    liveTask = nil
                    hub.nudge(conversationID, from: viewID)
                    await state.refreshConversations()
                    Task { await state.refreshUntilTitled(conversationID) }
                }
            default:
                break
            }
        }
        // The live turn just asked something: fetch now so its buttons appear under the turn
        // rather than when the turn ends.
        // Another window showing this thread did something: reload, which also attaches to a
        // turn it just started.
        .onChange(of: hub.tick) { _, _ in
            guard hub.lastConversation == conversationID, hub.lastSource != viewID else { return }
            Task { await load() }
        }
        .onChange(of: stream.pendingConfirmationIDs) { _, ids in
            guard !ids.isEmpty else { return }
            Task { await load() }
        }
    }

    // MARK: - Live turn bookkeeping

    /// Pin the thread to one model — the same menu as the phone's. Sizing is a regex and cannot
    /// tell that this question is hard, so "use the good model for this whole conversation" has
    /// to be sayable. Disabled while a turn streams, since the tier applies from the next one.
    private var tierMenu: some View {
        let pinned = thread?.conversation.tier
        return Menu {
            ForEach(Self.tierOptions, id: \.label) { option in
                Button {
                    Task { await setTier(option.value) }
                } label: {
                    if pinned == option.value {
                        Label("\(option.label) · \(option.hint)", systemImage: "checkmark")
                    } else {
                        Text("\(option.label) · \(option.hint)")
                    }
                }
            }
        } label: {
            Label("Model tier", systemImage: pinned == nil ? "cpu" : "cpu.fill")
        }
        .disabled(thread == nil || stream.isLive)
        .help("Model tier")
    }

    private static let tierOptions: [(hint: String, label: String, value: String?)] = [
        ("Size each turn automatically", "Auto", nil),
        ("Small local model", "Fast", "fast"),
        ("Main local model", "Local", "standard"),
        ("Cloud model, leaves your machine", "Cloud", "deep"),
    ]

    private func setTier(_ tier: String?) async {
        do {
            try await APIClient.shared.setTier(conversationID, to: tier)
            await load()
            hub.nudge(conversationID, from: viewID)
        } catch {
            composerError = error.localizedDescription
        }
    }

    private var showsLiveTurn: Bool { stream.isLive || stream.transportNote != nil }

    private var liveLedgerTurn: Turn? {
        guard let live = stream.runID else { return nil }
        return thread?.turns.first { $0.id == live }
    }

    private var liveConfirmations: [Confirmation] { liveLedgerTurn?.confirmations ?? [] }
    private var liveIsDecision: Bool { liveLedgerTurn?.isDecision ?? false }

    /// The finished turns, minus the one the live view is already drawing.
    private var ledgerTurns: [Turn] {
        let turns = thread?.turns ?? []
        guard showsLiveTurn, let live = stream.runID else { return turns }
        return turns.filter { $0.id != live }
    }

    // MARK: - Loading and sending

    private func load() async {
        do {
            let fresh = try await APIClient.shared.thread(conversationID)
            thread = fresh
            loadError = nil
            // A turn still running when the thread loaded (started on another device) gets
            // picked up and streamed.
            if !stream.isLive, let running = fresh.turns.last, running.isRunning {
                liveTask = running.task
                stream.start(runID: running.id)
            }
            try? await APIClient.shared.markRead(conversationID)
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func send() async {
        let task = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty, !isSending, !stream.isLive else { return }
        isSending = true
        defer { isSending = false }
        do {
            let started = try await APIClient.shared.send(message: task, to: conversationID)
            draft = ""
            liveTask = task
            stream.start(runID: started.runID)
            composerError = nil
            hub.nudge(conversationID, from: viewID)
        } catch {
            composerError = error.localizedDescription
        }
    }
}

/// One finished turn: what you asked, what the agent did, what it said.
private struct TurnBlock: View {
    let turn: Turn

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm + 2) {
            if let task = turn.task, !task.isEmpty {
                if turn.isDecision {
                    DecisionNote(text: task)
                } else {
                    ThreadBubble(text: task)
                }
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
