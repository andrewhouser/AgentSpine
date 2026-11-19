import PhotosUI
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
    /// The thread failing to arrive, shown at the top of an empty scroll.
    @State private var loadError: String?
    /// A send or an upload failing, shown just above the composer — the thread is fine and
    /// full of content, and a notice at the top of it would scroll away unseen while you
    /// sit at the bottom wondering why nothing happened.
    @State private var composerError: String?
    @State private var isSending = false
    @State private var liveTask: String?
    @State private var picked: [PhotosPickerItem] = []
    /// Uploaded and waiting to be sent with the next message. Uploading happens when the
    /// photo is chosen, not on send, so picking three and then writing a question does not
    /// end in a wait.
    @State private var staged: [Attachment] = []
    @State private var uploading = 0
    @State private var dictation = Dictation()
    @State private var handsFree = HandsFree()
    @Environment(ReadAloud.self) private var reader
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    // Only a *load* failure belongs here: the thread is empty behind it, so
                    // the top of the scroll is where you are looking. A send or upload
                    // failure goes above the composer instead — see `composer`.
                    if let error = loadError {
                        ErrorNotice(message: error) { Task { await load() } }
                    }

                    ForEach(ledgerTurns) { turn in
                        TurnView(turn: turn, projectID: thread?.conversation.projectID)
                            .id("turn-\(turn.id)")
                        // The buttons go under the turn that asked, where you are reading.
                        ForEach(turn.confirmations) { confirmation in
                            ApprovalCard(confirmation: confirmation) { await afterDecision() }
                                .id("confirmation-\(confirmation.id)")
                        }
                    }

                    if showsLiveTurn {
                        LiveTurnView(task: liveTask ?? "", isDecision: liveIsDecision, stream: stream)
                            .id("live")
                        ForEach(liveConfirmations) { confirmation in
                            ApprovalCard(confirmation: confirmation) { await afterDecision() }
                                .id("confirmation-\(confirmation.id)")
                        }
                    }

                    // Questions no turn here raised — the inbox's: a meeting's work items, a
                    // learner's proposal. At the end, where the newest thing in a thread goes.
                    ForEach(thread?.confirmations ?? []) { confirmation in
                        ApprovalCard(confirmation: confirmation) { await afterDecision() }
                            .id("confirmation-\(confirmation.id)")
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
            .onChange(of: openQuestionCount) { old, new in
                if new > old { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
        }
        .navigationTitle(thread?.conversation.displayTitle ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { tierMenu }
            ToolbarItem(placement: .topBarTrailing) { handsFreeButton }
        }
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
                    await state.refreshConversations()
                    if handsFree.phase == .busy { await speakReplyThenResume() }
                }
            default:
                break
            }
        }
        // The live turn just asked something: fetch the thread so its buttons appear now,
        // under the turn, rather than when the turn ends.
        .onChange(of: stream.pendingConfirmationIDs) { _, ids in
            guard !ids.isEmpty else { return }
            Task { await load() }
        }
        // A question here was asked or answered somewhere else — a helper of this turn, the
        // lock screen, the dashboard. The list knows first; follow it.
        // Back from the lock screen with this thread open: whatever finished meanwhile is now
        // being read.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await load() } }
        }
        .onChange(of: listedAttention) { _, _ in
            guard !stream.isLive else { return }
            Task { await load() }
        }
        .onDisappear {
            stream.stop()
            handsFree.stop()
            reader.stop()
        }
        .onAppear {
            handsFree.onCommand = { text in
                draft = text
                Task { await send(spoken: true) }
            }
        }
    }

    /// Whether the turn in flight is being drawn from the stream.
    private var showsLiveTurn: Bool { stream.isLive || stream.transportNote != nil }

    /// The live run's own row in the ledger, once a reload has fetched it.
    private var liveLedgerTurn: Turn? {
        guard let live = stream.runID else { return nil }
        return thread?.turns.first { $0.id == live }
    }

    /// Open questions the live turn has raised so far.
    private var liveConfirmations: [Confirmation] { liveLedgerTurn?.confirmations ?? [] }

    /// Whether the live turn is the one an Approve/Reject resumed.
    private var liveIsDecision: Bool { liveLedgerTurn?.isDecision ?? false }

    private var openQuestionCount: Int {
        (thread?.turns.reduce(0) { $0 + $1.confirmations.count } ?? 0) + (thread?.confirmations?.count ?? 0)
    }

    /// This thread's count of waiting questions, as the thread list last saw it.
    private var listedAttention: Int {
        state.conversations.first { $0.id == conversationID }?.attention ?? 0
    }

    /// After Approve or Reject: the server may have resumed this conversation with the result.
    /// Reloading picks that turn up as running (see `load`) and streams it.
    private func afterDecision() async {
        await load()
    }

    /// The finished turns, minus the one the live view is already drawing.
    ///
    /// The ledger carries a run from the moment it is created, not from the moment it ends, so
    /// any reload that happens while a run is in flight returns that run as a turn — which is
    /// every time a thread is opened on a run started elsewhere, the first message of a new
    /// thread included. Without this the message would be drawn twice: once as a finished-looking
    /// turn, once above the live step counter.
    private var ledgerTurns: [Turn] {
        let turns = thread?.turns ?? []
        guard showsLiveTurn, let live = stream.runID else { return turns }
        return turns.filter { $0.id != live }
    }

    private var handsFreeButton: some View {
        Button {
            if handsFree.isActive {
                handsFree.stop()
            } else {
                Task {
                    await handsFree.start()
                    if let note = handsFree.note { composerError = note }
                }
            }
        } label: {
            Image(systemName: handsFree.isActive ? "waveform.circle.fill" : "waveform.circle")
                .foregroundStyle(handsFree.phase == .hearing || handsFree.phase == .awake ? Spine.Palette.danger : Spine.Palette.accent)
        }
        .accessibilityLabel(handsFree.isActive ? "Stop hands-free" : "Start hands-free")
    }

    /// After a spoken command: read the answer out, then go back to listening.
    private func speakReplyThenResume() async {
        defer { handsFree.resume() }
        guard let summary = thread?.turns.last?.summary, !summary.isEmpty else { return }
        reader.toggle(summary)
        // `speaking` flips on synchronously in toggle; wait for it to end.
        while reader.speaking && handsFree.isActive { try? await Task.sleep(for: .milliseconds(250)) }
    }

    /// An image with no words is a real message — "what is this?" is very often the
    /// photograph itself — so a staged attachment alone is enough to send. What is not
    /// allowed is sending mid-upload: the id does not exist yet, and the image would be
    /// silently dropped by a turn that then answered as though nothing had been attached.
    private var canSend: Bool {
        let hasText = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return (hasText || !staged.isEmpty) && !isSending && uploading == 0
    }

    /// Pin the thread to one model. Sizing is a regex and cannot tell that *this* question
    /// is hard, so "use the good model for this whole conversation" has to be sayable.
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
            Image(systemName: pinned == nil ? "cpu" : "cpu.fill")
        }
        .disabled(thread == nil || stream.isLive)
        .accessibilityLabel("Model tier")
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
        } catch {
            composerError = error.localizedDescription
        }
    }

    private var dictationButton: some View {
        Button {
            Task { await toggleDictation() }
        } label: {
            switch dictation.phase {
            case .idle:
                Image(systemName: "mic").font(.system(size: 22))
            case .recording:
                HStack(spacing: 4) {
                    Image(systemName: "stop.circle.fill").font(.system(size: 22))
                    Text(Duration.seconds(Int(dictation.elapsed)).formatted(.time(pattern: .minuteSecond)))
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).monospacedDigit())
                }
                .foregroundStyle(Spine.Palette.danger)
            case .transcribing:
                ProgressView()
            }
        }
        .disabled(dictation.phase == .transcribing)
        .accessibilityLabel(dictation.phase == .recording ? "Stop dictation" : "Dictate")
        .onChange(of: dictation.atLimit) { _, hit in
            if hit { Task { await toggleDictation() } }
        }
        .onDisappear { dictation.cancel() }
    }

    private func toggleDictation() async {
        switch dictation.phase {
        case .idle:
            if let problem = await dictation.start() { composerError = problem }
        case .recording:
            do {
                let text = try await dictation.finish().trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty {
                    composerError = "Nothing was heard."
                } else {
                    draft = draft.isEmpty ? text : draft + " " + text
                }
            } catch {
                composerError = error.localizedDescription
            }
        case .transcribing:
            break
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if let composerError {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    Text(composerError)
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button {
                        self.composerError = nil
                    } label: {
                        Image(systemName: "xmark").font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                    }
                    .accessibilityLabel("Dismiss this error")
                }
                .foregroundStyle(Spine.Palette.warn)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal)
            }

            if !staged.isEmpty || uploading > 0 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(staged) { attachment in
                            AttachmentImage(attachment: attachment, size: 64, openable: false)
                                .overlay(alignment: .topTrailing) {
                                    Button {
                                        staged.removeAll { $0.id == attachment.id }
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                            .symbolRenderingMode(.palette)
                                            .foregroundStyle(.white, .black.opacity(0.5))
                                    }
                                    .padding(3)
                                    .accessibilityLabel("Remove this image")
                                }
                        }
                        // Materialised: ForEach over a live `0..<n` range is the one SwiftUI
                        // explicitly warns about, since the range is not constant data.
                        ForEach(Array(0..<uploading), id: \.self) { _ in
                            ProgressView()
                                .controlSize(.small)
                                .frame(width: 64, height: 64)
                                .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    .padding(.horizontal)
                }
                .frame(height: 64)
            }

            HStack(alignment: .bottom, spacing: 10) {
                PhotosPicker(selection: $picked, maxSelectionCount: 4, matching: .images) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.system(size: 22))
                }
                .accessibilityLabel("Attach photos")

                dictationButton

                TextField("Reply", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: 20))
                    .lineLimit(1...5)

                Button {
                    Task { await send() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 8)
        .background(.bar)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await upload(items) }
        }
    }

    /// Send each picked image up and keep its id.
    ///
    /// `uploading` is a count rather than a flag so three photos show three placeholders.
    /// A failure names the file and leaves the rest alone — one unreadable image should not
    /// discard the two that travelled fine.
    private func upload(_ items: [PhotosPickerItem]) async {
        uploading += items.count
        for item in items {
            defer { uploading -= 1 }
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    composerError = "That image could not be read off the phone."
                    continue
                }
                let mime = Self.mime(for: data)
                let uploaded = try await APIClient.shared.uploadAttachment(
                    conversationID: conversationID,
                    data: data,
                    mime: mime,
                    name: item.itemIdentifier
                )
                staged.append(uploaded)
                composerError = nil
            } catch {
                composerError = error.localizedDescription
            }
        }
    }

    /// The format, from the bytes themselves.
    ///
    /// `PhotosPickerItem` does not reliably say, and the server sniffs the content anyway
    /// and refuses anything that is not one of four raster formats — so this only has to be
    /// right enough to not be contradicted. HEIC is what an iPhone camera produces by
    /// default and is the case worth getting right.
    private static func mime(for data: Data) -> String {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if bytes.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if bytes.count >= 12, Array(bytes[4..<8]) == Array("ftyp".utf8) {
            let brand = String(decoding: bytes[8..<12], as: UTF8.self)
            if brand.hasPrefix("hei") || brand.hasPrefix("mif") { return "image/heic" }
        }
        if bytes.count >= 12,
           Array(bytes[0..<4]) == Array("RIFF".utf8),
           Array(bytes[8..<12]) == Array("WEBP".utf8) { return "image/webp" }
        return "application/octet-stream"
    }

    private func load() async {
        do {
            let fresh = try await APIClient.shared.thread(conversationID)
            thread = fresh
            loadError = nil
            // On screen, so read — this is what clears the thread's unread dot everywhere.
            if scenePhase == .active {
                try? await APIClient.shared.markRead(conversationID)
                await state.refreshConversations()
            }
            // A turn still running when the thread loaded — because the task was started from
            // another device, or the app was killed mid-cycle — gets picked up and streamed.
            // Without this, reopening the app during a long run shows a thread that looks stuck.
            if !stream.isLive, let running = fresh.turns.last, running.isRunning {
                liveTask = running.task
                stream.start(runID: running.id)
            }
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func send(spoken: Bool = false) async {
        let task = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else {
            if spoken { handsFree.resume() }
            return
        }
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
            // The server answers an image with no words as "What is this?", so the live
            // turn should say that rather than show an empty bubble.
            liveTask = task.isEmpty ? "What is this?" : task
            stream.start(runID: started.runID)
            composerError = nil
        } catch {
            composerError = error.localizedDescription
            if spoken { handsFree.resume() }
        }
    }
}

// MARK: - A finished turn

struct TurnView: View {
    let turn: Turn
    /// The thread's project, so "Save to file" lands in its folder.
    var projectID: Int?
    @Environment(ReadAloud.self) private var reader
    @State private var starred: Bool?
    @State private var saving = false
    @State private var fileName = ""
    @State private var notice: String?
    @State private var showContext = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Images first: they were part of the message, and they read as attached to it
            // rather than to the answer below.
            if !turn.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(turn.attachments) { AttachmentImage(attachment: $0) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }

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

            ForEach(turn.children) { child in
                DelegationRow(child: child)
            }

            if let summary = turn.summary, !summary.isEmpty {
                MarkdownText(summary)
            } else if turn.status == "failed" {
                Label("This turn failed.", systemImage: "exclamationmark.triangle")
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(Spine.Palette.danger)
            }

            HStack(spacing: 6) {
                Text(SpineDate.timeOfDay(turn.started))
                if let tier = turn.tier { Text("·"); Text(tier) }
                if !turn.actions.isEmpty {
                    Text("·")
                    Text("\(turn.actions.count) tool call\(turn.actions.count == 1 ? "" : "s")")
                }
                if let summary = turn.summary, !summary.isEmpty {
                    Spacer()
                    Menu {
                        Button {
                            let next = !(starred ?? turn.starred ?? false)
                            starred = next
                            Task { try? await APIClient.shared.star(runID: turn.id, starred: next) }
                        } label: {
                            Label((starred ?? turn.starred ?? false) ? "Unstar" : "Star", systemImage: (starred ?? turn.starred ?? false) ? "star.slash" : "star")
                        }
                        Button {
                            fileName = "reply-\(turn.id).md"
                            saving = true
                        } label: {
                            Label("Save to file…", systemImage: "square.and.arrow.down")
                        }
                        if let used = turn.contextUsed, !used.isEmpty {
                            Button { showContext = true } label: {
                                Label("Context used (\(used.count))", systemImage: "brain")
                            }
                        }
                    } label: {
                        Image(systemName: (starred ?? turn.starred ?? false) ? "star.fill" : "ellipsis.circle")
                    }
                    .accessibilityLabel("Reply actions")
                    Button {
                        if reader.speaking && reader.current != summary { reader.stop() }
                        reader.toggle(summary)
                    } label: {
                        Image(systemName: reader.current == summary && reader.speaking ? "stop.circle" : "speaker.wave.2")
                    }
                    .accessibilityLabel(reader.current == summary && reader.speaking ? "Stop reading" : "Read aloud")
                }
            }
            .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
            .foregroundStyle(Spine.Palette.textFaint)

            if let notice {
                Text(notice).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
            }
        }
        .alert("Save to file", isPresented: $saving) {
            TextField("File name", text: $fileName)
            Button("Save") {
                Task {
                    do {
                        let r = try await APIClient.shared.saveReply(runID: turn.id, name: fileName, projectID: projectID)
                        notice = "Saved to \(r.path)"
                    } catch {
                        notice = error.localizedDescription
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A bare name goes in the project's folder, or docs/ on the Mac.")
        }
        .sheet(isPresented: $showContext) {
            NavigationStack {
                List(turn.contextUsed ?? [], id: \.self) { Text($0).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)) }
                    .navigationTitle("Context used")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showContext = false } } }
            }
            .presentationDetents([.medium, .large])
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
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                        if let task = child.task {
                            Text(task).font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2)).foregroundStyle(Spine.Palette.textDim).lineLimit(1)
                        }
                    }
                    Spacer()
                    Text("\(child.actions.count)")
                        .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).monospacedDigit())
                        .foregroundStyle(Spine.Palette.textDim)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                        .foregroundStyle(Spine.Palette.textFaint)
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
                    MarkdownText(summary, compact: true).foregroundStyle(Spine.Palette.textDim)
                }
            }
        }
        .padding(10)
        .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: 12))
    }
}
