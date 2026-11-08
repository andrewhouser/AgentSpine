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

                    ForEach(thread?.turns ?? []) { turn in
                        TurnView(turn: turn, projectID: thread?.conversation.projectID)
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
                    await state.refreshApprovals()
                    if handsFree.phase == .busy { await speakReplyThenResume() }
                }
            default:
                break
            }
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
                .foregroundStyle(handsFree.phase == .hearing || handsFree.phase == .awake ? .red : .accentColor)
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
                        .font(.caption.monospacedDigit())
                }
                .foregroundStyle(.red)
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
                        .font(.caption)
                    Text(composerError)
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button {
                        self.composerError = nil
                    } label: {
                        Image(systemName: "xmark").font(.caption2)
                    }
                    .accessibilityLabel("Dismiss this error")
                }
                .foregroundStyle(.orange)
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
                                            .font(.caption)
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
                                .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
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
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
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
                MarkdownText(summary)
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
            .font(.caption2)
            .foregroundStyle(.tertiary)

            if let notice {
                Text(notice).font(.caption).foregroundStyle(.secondary)
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
                List(turn.contextUsed ?? [], id: \.self) { Text($0).font(.footnote) }
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
                    MarkdownText(summary, compact: true).foregroundStyle(.secondary)
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
                MarkdownText(summary)
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
