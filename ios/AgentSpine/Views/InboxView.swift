//
//  InboxView.swift
//  AgentSpine
//
//  Shared by the iPhone and Mac targets.
//

import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AVFoundation
import Observation
#endif

/// Add anything you want to remember: files, screenshots, scans, a pasted chat, a note. Each is read on this
/// Mac, kept private and searchable at once; a suggested project is shown and never applied for you.
struct InboxView: View {
    @Environment(AppState.self) private var state
    @State private var items: [InboxItem] = []
    @State private var status: InboxStatus?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var busy = false
    @State private var choosingFiles = false
    @State private var pasting = false
    @State private var pasteText = ""
    @State private var pasteTitle = ""
    @State private var pasteAsNote = false
    @State private var dictatingNote = false
    @State private var deleting: InboxItem?
    @State private var searchText = ""
    @State private var searching = false
    @State private var hits: [KnowledgeHit]?
    @State private var extractingID: Int?
    @State private var extractNotes: [Int: String] = [:]

    var body: some View {
        List {
            if let loadError {
                ErrorNotice(message: loadError) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            if let status, !status.ocr {
                Text("Screenshots and scanned PDFs cannot be read on this machine, so they are kept and marked \"Not read yet\".")
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(Spine.Palette.textDim)
                    .listRowBackground(Color.clear)
            }
            Section("Search everything") {
                HStack {
                    TextField("A name, a ticket number, a phrase in quotes, or a question", text: $searchText)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .onSubmit { Task { await search() } }
                    // Borderless, or a tap anywhere in the row would run the search.
                    Button("Search") { Task { await search() } }
                        .buttonStyle(.borderless)
                        .disabled(searching)
                }
                if hits?.isEmpty == true {
                    Text("Nothing found.")
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(Spine.Palette.textDim)
                }
                ForEach(hits ?? []) { hit in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(hit.path) · found by \(hit.via.joined(separator: " and "))")
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textFaint)
                        Text(String(hit.text.prefix(280)))
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .textSelection(.enabled)
                    }
                }
            }
            if items.isEmpty && loadError == nil {
                EmptyNotice(
                    symbol: "tray.and.arrow.down",
                    title: loaded ? "Nothing added yet" : "Loading…",
                    detail: "Tap + to add files, or paste a chat, an email or a note."
                )
                .listRowBackground(Color.clear)
            }
            ForEach(items) { item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.name).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
                    Text(meta(item))
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                    Text(item.statusText + (item.note.map { ": \($0)" } ?? ""))
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(item.isReady ? Spine.Palette.textDim : Spine.Palette.danger)
                    if item.projectID == nil, let suggested = item.suggestedProject {
                        Button("Looks like \(item.suggestedProjectName ?? "a project"). File it there") {
                            Task { await file(item, under: suggested) }
                        }
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                        .buttonStyle(.borderless)
                    } else if let id = item.projectID, let project = state.projects.first(where: { $0.id == id }) {
                        Label(project.name, systemImage: "folder")
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                    // Shown, never applied: a name or word match is a hint, and only the tap adds anything.
                    if let people = item.suggestedPeople, !people.isEmpty {
                        Text("May mention \(people.joined(separator: ", ")).")
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                    if !item.tagsToOffer.isEmpty {
                        Text("Tags in use that fit: \(item.tagsToOffer.joined(separator: ", ")).")
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textDim)
                        Button(item.tagsToOffer.count == 1 ? "Add this tag" : "Add these tags") {
                            Task { await addSuggestedTags(item) }
                        }
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                        .buttonStyle(.borderless)
                        .disabled(busy)
                    }
                    if item.isReady {
                        // Only on request: extraction is several calls to the model host.
                        Button(extractingID == item.id ? "Reading…" : "Find decisions and commitments") {
                            Task { await extract(item) }
                        }
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                        .buttonStyle(.borderless)
                        .disabled(extractingID != nil)
                    }
                    if let note = extractNotes[item.id] {
                        Text(note)
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                }
                .contextMenu {
                    Menu("File under project") {
                        Button("Not filed") { Task { await file(item, under: nil) } }
                        ForEach(state.projects) { project in
                            Button(project.name) { Task { await file(item, under: project.id) } }
                        }
                    }
                    if item.canRetry { Button("Try reading again") { Task { await retry(item) } } }
                    Button("Delete", role: .destructive) { deleting = item }
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { deleting = item } label: { Label("Delete", systemImage: "trash") }
                }
            }
        }
        .navigationTitle("Inbox")
        .refreshable { await load() }
        .task { await load() }
        .toolbar {
            ToolbarItem(placement: .spineTrailing) {
                Menu {
                    Button("Add files…") { choosingFiles = true }
                    Button("Paste text…") { pasting = true }
                    Button("Dictate a note…") { dictatingNote = true }
                } label: { Image(systemName: "plus") }
                    .disabled(busy)
                    .accessibilityLabel("Add to inbox")
            }
        }
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await add(urls) } }
        }
        .sheet(isPresented: $pasting) { pasteSheet }
        .sheet(isPresented: $dictatingNote) { DictatedNoteSheet { await load() } }
        .confirmationDialog(
            "Delete \"\(deleting?.name ?? "")\"?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { item in
            Button("Delete", role: .destructive) { Task { await remove(item) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Its original, its text and its search index are removed.")
        }
        .alert(
            "That didn't work",
            isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
    }

    private var pasteSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title (optional)", text: $pasteTitle)
                    TextEditor(text: $pasteText).frame(minHeight: 180)
                } footer: {
                    Text("A chat or email thread keeps who said what and when. A plain note is stored as written.")
                }
                Section {
                    Toggle("Store as a plain note", isOn: $pasteAsNote)
                }
            }
            .navigationTitle("Paste text")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { pasting = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await addPaste() } }
                        .disabled(pasteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                }
            }
        }
    }

    private func meta(_ item: InboxItem) -> String {
        var parts = [item.kind]
        if let when = SpineDate.parse(item.ingested) { parts.append(when.formatted(date: .abbreviated, time: .shortened)) }
        if !item.speakers.isEmpty { parts.append(item.speakers.joined(separator: ", ")) }
        else if let author = item.author { parts.append(author) }
        if let via = item.via { parts.append("via \(via)") }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        do {
            async let list = APIClient.shared.inboxItems()
            async let st = try? APIClient.shared.inboxStatus()
            items = try await list
            status = await st
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }

    private func search() async {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= 2 else { hits = nil; return }
        guard !searching else { return }
        searching = true
        defer { searching = false }
        do {
            hits = try await APIClient.shared.searchKnowledge(query)
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func add(_ urls: [URL]) async {
        busy = true
        defer { busy = false }
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                _ = try await APIClient.shared.inboxAddFile(data: try Data(contentsOf: url), name: url.lastPathComponent)
            } catch {
                actionError = "\(url.lastPathComponent): \(error.localizedDescription)"
            }
        }
        await load()
    }

    private func addPaste() async {
        busy = true
        defer { busy = false }
        do {
            _ = try await APIClient.shared.inboxPaste(text: pasteText, kind: pasteAsNote ? "note" : "paste", name: pasteTitle)
            pasteText = ""
            pasteTitle = ""
            pasting = false
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func file(_ item: InboxItem, under projectID: Int?) async {
        do {
            try await APIClient.shared.inboxFile(item.id, under: projectID)
            await load()
        } catch { actionError = error.localizedDescription }
    }

    private func extract(_ item: InboxItem) async {
        guard extractingID == nil else { return }
        extractingID = item.id
        defer { extractingID = nil }
        do {
            extractNotes[item.id] = try await APIClient.shared.inboxExtract(item.id).summary
        } catch { actionError = error.localizedDescription }
    }

    private func retry(_ item: InboxItem) async {
        do {
            try await APIClient.shared.inboxReprocess(item.id)
            await load()
        } catch { actionError = error.localizedDescription }
    }

    private func addSuggestedTags(_ item: InboxItem) async {
        busy = true
        defer { busy = false }
        do {
            try await APIClient.shared.inboxSetTags(item.id, to: (item.tags ?? []) + item.tagsToOffer)
            await load()
        } catch { actionError = error.localizedDescription }
    }

    private func remove(_ item: InboxItem) async {
        do {
            try await APIClient.shared.inboxDelete(item.id)
            await load()
        } catch { actionError = error.localizedDescription }
    }
}

/// Speak a note, read what was heard, then add it. Nothing is stored until Add: Whisper mishears names, and a saved
/// note becomes a searchable source. The state lives here so closing the sheet drops a take that was still in flight.
private struct DictatedNoteSheet: View {
    let onAdded: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var dictation = Dictation()
    @State private var title = ""
    @State private var text = ""
    @State private var problem: String?
    @State private var saving = false

    private var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button { Task { await toggle() } } label: {
                        switch dictation.phase {
                        case .idle: Label(isEmpty ? "Start dictating" : "Dictate more", systemImage: "mic")
                        case .recording: Label("Stop and transcribe", systemImage: "stop.circle")
                        case .transcribing: Label("Transcribing…", systemImage: "waveform")
                        }
                    }
                    .disabled(dictation.phase == .transcribing || saving)
                    if dictation.phase == .recording {
                        HStack {
                            level
                            Text(Duration.seconds(Int(dictation.elapsed)).formatted(.time(pattern: .minuteSecond)))
                                .monospacedDigit()
                        }
                        Button("Discard this take", role: .destructive) { dictation.cancel() }
                    }
                    if let problem {
                        Text(problem).foregroundStyle(.red)
                    }
                }
                Section {
                    TextField("Title (optional)", text: $title)
                    TextEditor(text: $text)
                        .frame(minHeight: 160)
                        .accessibilityLabel("Dictated note")
                } footer: {
                    Text("Read it through before adding: names are the words speech recognition most often gets wrong.")
                }
            }
            .navigationTitle("Dictate a note")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await add() } }
                        .disabled(isEmpty || saving || dictation.phase != .idle)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 460)
        #endif
        .onChange(of: dictation.atLimit) { _, hit in
            if hit { Task { await toggle() } }
        }
        .onDisappear { dictation.cancel() }
    }

    @ViewBuilder private var level: some View {
        #if os(iOS)
        DictationWaveform(levels: dictation.levels).frame(height: 24)
        #else
        ProgressView(value: Double(dictation.levels.last ?? 0)).accessibilityHidden(true)
        #endif
    }

    private func toggle() async {
        problem = nil
        switch dictation.phase {
        case .idle:
            problem = await dictation.start()
        case .recording:
            do {
                let heard = try await dictation.finish().trimmingCharacters(in: .whitespacesAndNewlines)
                if heard.isEmpty {
                    problem = "Nothing was heard."
                } else {
                    text += text.isEmpty || text.last?.isWhitespace == true ? heard : " \(heard)"
                }
            } catch { problem = error.localizedDescription }
        case .transcribing:
            break
        }
    }

    private func add() async {
        saving = true
        defer { saving = false }
        do {
            _ = try await APIClient.shared.inboxPaste(text: text, kind: "note", name: title, via: "dictation")
            await onAdded()
            dismiss()
        } catch { problem = error.localizedDescription }
    }
}

#if os(macOS)
/// The Mac's take on the phone's `Dictation` (`Core/Dictation.swift`, which needs `AVAudioSession` and so is iPhone
/// only). Same phases and same upload, so the sheet above is one view on both. It uses the microphone permission the
/// meeting recorder already declares.
@MainActor
@Observable
final class Dictation {
    enum Phase: Equatable { case idle, recording, transcribing }

    private(set) var phase: Phase = .idle
    private(set) var elapsed: TimeInterval = 0
    private(set) var levels: [Float] = []
    private static let levelCount = 40
    private var maxSeconds = 120
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var fileURL: URL?

    var atLimit: Bool { phase == .recording && Int(elapsed) >= maxSeconds - 1 }

    func start() async -> String? {
        do {
            let status = try await APIClient.shared.dictationStatus()
            guard status.modelReady else { return "The server's speech model is missing, so nothing can transcribe this." }
            maxSeconds = status.maxSeconds
        } catch { return error.localizedDescription }
        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            return "Microphone access is off. Allow it in System Settings → Privacy & Security → Microphone."
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-\(UUID().uuidString).m4a")
        do {
            let recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
            ])
            recorder.isMeteringEnabled = true
            guard recorder.record() else { return "The microphone could not start." }
            self.recorder = recorder
            fileURL = url
        } catch { return error.localizedDescription }
        elapsed = 0
        levels = Array(repeating: 0, count: Self.levelCount)
        phase = .recording
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let recorder = self.recorder else { return }
                self.elapsed = recorder.currentTime
                recorder.updateMeters()
                let level = MicLevel.normalized(decibels: recorder.averagePower(forChannel: 0))
                self.levels = MicLevel.push(level, onto: self.levels, count: Self.levelCount)
            }
        }
        return nil
    }

    func finish() async throws -> String {
        guard let url = stopRecording() else { return "" }
        defer { try? FileManager.default.removeItem(at: url) }
        phase = .transcribing
        defer { phase = .idle }
        return try await APIClient.shared.dictate(audio: Data(contentsOf: url), mime: "audio/mp4")
    }

    func cancel() {
        if let url = stopRecording() { try? FileManager.default.removeItem(at: url) }
        if phase == .recording { phase = .idle }
    }

    private func stopRecording() -> URL? {
        timer?.invalidate()
        timer = nil
        recorder?.stop()
        recorder = nil
        levels = []
        defer { fileURL = nil }
        return fileURL
    }
}
#endif
