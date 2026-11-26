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
    @State private var nearBottom = true
    /// The run has ended and its saved turn is still loading. The stream keeps drawing it until
    /// then, because dropping it first collapses the scroll height and moves the reader.
    @State private var isSettling = false
    @State private var liveTask: String?
    /// When the live message was sent, for the time under it before the ledger row has loaded.
    @State private var liveSentAt: Date?
    /// Bumped by "Edit and resend" to put the cursor in the composer.
    @State private var focusRequest = 0
    @State private var draft = ""
    @State private var isSending = false
    /// A stop was asked for and the turn has not ended yet.
    @State private var isStopping = false
    @State private var composerError: String?
    @State private var staged: [Attachment] = []
    @State private var uploading = 0
    @State private var reader = ReadAloud()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Kept across threads and launches: you either want the panel or you do not.
    @AppStorage("mac.threadInspector") private var showInspector = false
    /// Chat (the reply and its step checklist) or Trace (every tool call, expandable), as on the
    /// web. Per window and not kept: Trace is somewhere you look, not somewhere you live.
    @State private var tab: MacTurnSpine.Mode = .chat

    var body: some View {
        VStack(spacing: 0) {
            Picker("View", selection: $tab) {
                Text("Chat").tag(MacTurnSpine.Mode.chat)
                Text("Trace").tag(MacTurnSpine.Mode.trace)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Spine.Space.xl)
            .padding(.top, Spine.Space.sm)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: Spine.Space.lg) {
                        if thread?.conversation.isLocalOnly == true { LocalOnlyNotice() }
                        if let loadError {
                            ErrorNotice(message: loadError) { Task { await load() } }
                        } else if thread != nil, tab == .trace {
                            MacTraceList(turns: ledgerTurns, live: showsLiveTurn ? (liveTask, stream) : nil)
                        } else if let thread {
                            ForEach(ledgerTurns) { turn in
                                TurnBlock(
                                    turn: turn,
                                    onDecided: decided,
                                    onEdit: editAction(for: turn),
                                    onRetry: retryAction(for: turn)
                                )
                            }
                            // Questions no turn here raised (the inbox thread's), on a spine of their own.
                            if let open = thread.confirmations, !open.isEmpty {
                                MacTurnSpine(confirmations: open, onDecided: decided)
                            }
                            if showsLiveTurn {
                                liveTurn
                            }
                        } else {
                            ProgressView().frame(maxWidth: .infinity).padding(.top, Spine.Space.xxl)
                        }
                        Color.clear.frame(height: 1).id("bottom").tracksNearScrollBottom($nearBottom)
                    }
                    .padding(Spine.Space.xl)
                    .frame(maxWidth: 760, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: stream.calls.count) { _, _ in
                    guard nearBottom else { return }
                    withAnimation(reduceMotion ? nil : .default) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                // A new turn is the reader's own action, so it goes to the end wherever they were.
                .onChange(of: stream.runID) { _, id in
                    if id != nil { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onChange(of: stream.answerText) { _, text in
                    if nearBottom, !text.isEmpty { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                // The first load opens at the end. After that a finished turn must not pull a reader
                // who scrolled up back down (measured on web, 2026-11-23).
                .onChange(of: thread?.turns.count) { old, _ in
                    if old == nil || nearBottom { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }

            Divider()
            MacComposer(
                draft: $draft,
                isBusy: isSending,
                isDisabled: thread == nil || stream.isLive,
                error: composerError,
                staged: staged,
                uploading: uploading,
                attach: { urls in Task { await upload(urls) } },
                removeStaged: { gone in staged.removeAll { $0.id == gone.id } },
                focusRequest: focusRequest,
                stop: stream.isLive ? { Task { await stopTurn() } } : nil,
                isStopping: isStopping,
                send: { Task { await send() } }
            )
        }
        .background(Spine.Palette.bg)
        .navigationTitle(state.conversations.first { $0.id == conversationID }?.displayTitle ?? thread?.conversation.displayTitle ?? "Thread")
        .toolbar { toolbarItems }
        // The system inspector column: it slides in from the right and remembers its width.
        .inspector(isPresented: $showInspector) {
            Group {
                if let thread {
                    ThreadInspectorView(thread: thread)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .inspectorColumnWidth(min: 240, ideal: 280, max: 360)
        }
        .task { await load() }
        .onDisappear {
            stream.stop()
            reader.stop()
        }
        .onChange(of: stream.phase) { _, phase in
            // The turn is over: reload so it is drawn from the ledger, which also picks up what
            // the stream does not carry (the tier it ran at, child runs).
            if !stream.isLive { isStopping = false }
            switch phase {
            case .failed, .finished:
                isSettling = true
                Task {
                    await load()
                    isSettling = false
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
    /// "Local only": no turn here went to the cloud, and the tier it is pinned to cannot. It
    /// describes what has happened, not a promise about the next Auto turn, which may be sized up
    /// to Cloud (the thread reloads when a turn ends, so the pill drops then). It says nothing
    /// about sensitivity, which the server enforces on its own.
    @ViewBuilder private var localOnlyPill: some View {
        if let thread, staysLocal(thread) {
            Text("Local only")
                .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(.medium))
                .foregroundStyle(Spine.Palette.accent)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Spine.Palette.accent.opacity(0.14), in: Capsule())
                .help("No turn in this thread has used the Cloud tier")
        }
    }

    /// Nothing has left the machine, and nothing about to. Each turn's own record of what served
    /// it wins; a turn from before that was kept falls back to the tier it asked for. A thread
    /// pinned to Cloud is not local-only unless the server has no Cloud tier to send it to.
    private func staysLocal(_ thread: Thread) -> Bool {
        let left = thread.turns.contains { $0.served?.cloud ?? ($0.tier == "deep") }
        if left { return false }
        if thread.conversation.tier == "deep" { return state.cloud?.configured == false }
        return true
    }

    /// On macOS 26 a toolbar item is drawn on its own glass plate, which put a second capsule
    /// around the pill (seen in the running app). The plate is turned off for it.
    @ToolbarContentBuilder private var toolbarItems: some ToolbarContent {
        if #available(macOS 26, *) {
            ToolbarItem(placement: .principal) { localOnlyPill }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .principal) { localOnlyPill }
        }
        ToolbarItem { speakButton }
        ToolbarItem { tierMenu }
        ToolbarItem {
            Button { showInspector.toggle() } label: {
                Label("Inspector", systemImage: "sidebar.right")
            }
            .help(showInspector ? "Hide the inspector" : "Show tiers, tool calls and child runs")
        }
    }

    /// Reads the latest reply aloud in the server's voice (the same `ReadAloud` the phone uses).
    /// Press again to stop. The server's voice service may be off; its error is shown on the
    /// button's tooltip rather than as an alert, since a missing voice is not a thread failure.
    private var speakButton: some View {
        let reply = thread?.turns.last(where: { !($0.summary ?? "").isEmpty })?.summary
        return Button {
            if let reply { reader.toggle(reply) }
        } label: {
            Label(reader.speaking ? "Stop reading" : "Read aloud", systemImage: reader.speaking ? "speaker.wave.2.fill" : "speaker.wave.2")
        }
        .disabled(reply == nil && !reader.speaking)
        .help(reader.error ?? (reader.speaking ? "Stop reading" : "Read the latest reply aloud"))
    }

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

    /// An approval or rejection landed: reload this thread and tell the other windows on it.
    private func decided() async {
        await load()
        hub.nudge(conversationID, from: viewID)
    }

    /// The turn in flight: what you asked, then the same spine a finished turn gets, fed from the
    /// stream. A run that has just finished still shows here until the reload replaces it.
    @ViewBuilder private var liveTurn: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm + 2) {
            if let task = liveTask, !task.isEmpty {
                if liveIsDecision {
                    DecisionNote(text: task)
                } else {
                    ThreadBubble(text: task, sentAt: liveLedgerTurn.flatMap { SpineDate.parse($0.started) } ?? liveSentAt)
                }
            }
            MacTurnSpine(
                calls: stream.calls.map { MacTurnSpine.Call($0) },
                phase: stream.phase,
                plan: stream.isLive ? stream.plan : [],
                summary: liveSummary,
                failure: liveFailure,
                note: stream.transportNote,
                confirmations: liveConfirmations,
                onDecided: decided
            )
        }
    }

    private var liveSummary: String? {
        if case .finished(let summary) = stream.phase { return summary }
        return stream.isLive && !stream.answerText.isEmpty ? stream.answerText : nil
    }

    private var liveFailure: String? {
        if case .failed(let message) = stream.phase { return message }
        return nil
    }

    private var showsLiveTurn: Bool { stream.isLive || isSettling || stream.transportNote != nil }

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

    /// Upload each chosen or dropped image and keep its id, so it goes with the next message.
    /// A failure names the file and leaves the rest alone.
    private func upload(_ urls: [URL]) async {
        uploading += urls.count
        for url in urls {
            defer { uploading -= 1 }
            do {
                staged.append(try await MacImageUpload.upload(url, conversationID: conversationID))
                composerError = nil
            } catch {
                composerError = error.localizedDescription
            }
        }
    }

    // MARK: - Retry and Edit on your own message

    /// Whether a past message can be sent again. Not while a turn is running, not for the turn an
    /// Approve resumed (it is not a message you wrote), not for an empty one, and never for a
    /// message that carried images: an image binds to one run only once, so a retry would drop it
    /// and answer a different question.
    private func resendable(_ turn: Turn) -> Bool {
        !stream.isLive && !isSending && !turn.isDecision && turn.attachments.isEmpty
            && !(turn.task ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The hover actions for a turn, or nil where they cannot work. Built here rather than inline
    /// in the view body, where the ternary closures were too much for the type checker.
    private func editAction(for turn: Turn) -> (() -> Void)? {
        guard resendable(turn) else { return nil }
        return { edit(turn) }
    }

    private func retryAction(for turn: Turn) -> (() -> Void)? {
        guard resendable(turn) else { return nil }
        return {
            Task { await resend(turn) }
        }
    }

    /// Put the message back in the box to change it. It does not overwrite what you have typed.
    private func edit(_ turn: Turn) {
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            composerError = "Clear the message box first, then choose Edit and resend."
            return
        }
        draft = turn.task ?? ""
        focusRequest += 1
    }

    /// Ask the server to end the running turn; the stream then ends with status "stopped" and
    /// the thread reloads as it does after any turn.
    private func stopTurn() async {
        guard let runID = stream.runID, !isStopping else { return }
        isStopping = true
        do {
            try await APIClient.shared.stopRun(runID)
        } catch {
            isStopping = false
            composerError = error.localizedDescription
        }
    }

    /// Send the same text again as a NEW turn. The earlier reply and its tool calls stay, since
    /// the ledger is append-only. It goes straight to the server without touching the draft or
    /// any staged images.
    private func resend(_ turn: Turn) async {
        let task = (turn.task ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty, !isSending, !stream.isLive else { return }
        isSending = true
        defer { isSending = false }
        do {
            let started = try await APIClient.shared.send(message: task, to: conversationID, attachmentIDs: [])
            liveTask = task
            liveSentAt = Date()
            stream.start(runID: started.runID)
            composerError = nil
            hub.nudge(conversationID, from: viewID)
        } catch {
            composerError = error.localizedDescription
        }
    }

    private func send() async {
        let task = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty || !staged.isEmpty, !isSending, !stream.isLive, uploading == 0 else { return }
        isSending = true
        defer { isSending = false }
        do {
            let started = try await APIClient.shared.send(
                message: task,
                to: conversationID,
                attachmentIDs: staged.map(\.id)
            )
            draft = ""
            staged = []
            // The server answers an image with no words as "What is this?", so the live turn
            // says that rather than show an empty bubble.
            liveTask = task.isEmpty ? "What is this?" : task
            liveSentAt = Date()
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
    let onDecided: () async -> Void
    /// Hover actions on your message; nil where they cannot work (see `resendable`).
    var onEdit: (() -> Void)?
    var onRetry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm + 2) {
            // Images first: they were part of the message, and read as attached to it.
            if !turn.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Spine.Space.sm) {
                        ForEach(turn.attachments) { MacAttachmentImage(attachment: $0) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }

            if let task = turn.task, !task.isEmpty {
                if turn.isDecision {
                    DecisionNote(text: task)
                } else {
                    ThreadBubble(text: task, sentAt: SpineDate.parse(turn.started), onEdit: onEdit, onRetry: onRetry)
                }
            }

            // What a knowledge answer rested on (section 15, R5), above the reply it supports.
            if let sources = turn.sources { TurnSourcesView(sources: sources) }

            MacTurnSpine(
                calls: turn.actions.map { MacTurnSpine.Call($0) },
                plan: turn.plan ?? [],
                summary: turn.summary,
                failure: (turn.summary ?? "").isEmpty && turn.status == "failed" ? "This turn failed." : nil,
                confirmations: turn.confirmations,
                onDecided: onDecided
            )
        }
    }
}

/// The Trace tab: each turn's message, then every tool call it made, each expanding to its
/// exact arguments and output (web: TraceView). Approvals are answered in Chat, not here.
private struct MacTraceList: View {
    let turns: [Turn]
    /// The turn in flight, drawn from the stream until the ledger has it.
    let live: (task: String?, stream: RunStream)?

    var body: some View {
        if turns.allSatisfy({ $0.actions.isEmpty }) && (live?.stream.calls.isEmpty ?? true) {
            Text("No tool calls in this chat yet.")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)
        }
        ForEach(turns) { turn in
            if !turn.actions.isEmpty {
                section(task: turn.task, calls: turn.actions.map { MacTurnSpine.Call($0) }, failed: turn.status == "failed", running: false)
            }
        }
        if let live, !live.stream.calls.isEmpty {
            section(task: live.task, calls: live.stream.calls.map { MacTurnSpine.Call($0) }, failed: false, running: live.stream.isLive)
        }
    }

    private func section(task: String?, calls: [MacTurnSpine.Call], failed: Bool, running: Bool) -> some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            HStack(spacing: 8) {
                Text(task?.isEmpty == false ? task! : "Turn")
                    .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.medium))
                    .lineLimit(2)
                if running { ProgressView().controlSize(.small) }
            }
            MacTurnSpine(mode: .trace, calls: calls, failure: failed ? "failed" : nil)
        }
    }
}
