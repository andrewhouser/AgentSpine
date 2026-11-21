//
//  InboxView.swift
//  AgentSpine
//
//  Shared by the iPhone and Mac targets.
//

import SwiftUI
import UniformTypeIdentifiers

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
    @State private var deleting: InboxItem?

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
                } label: { Image(systemName: "plus") }
                    .disabled(busy)
                    .accessibilityLabel("Add to inbox")
            }
        }
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await add(urls) } }
        }
        .sheet(isPresented: $pasting) { pasteSheet }
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

    private func retry(_ item: InboxItem) async {
        do {
            try await APIClient.shared.inboxReprocess(item.id)
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
