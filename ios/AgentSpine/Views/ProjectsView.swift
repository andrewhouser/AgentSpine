import SwiftUI

/// Projects: list, detail, instructions, and reindexing.
///
/// Sources are filesystem paths on the Mac, so adding one from a phone is awkward but possible;
/// viewing, reindexing and editing instructions are the parts that earn their keep here.
struct ProjectsView: View {
    @State private var projects: [Project] = []
    @State private var error: String?
    @State private var loading = false
    @State private var newName = ""
    @State private var prompt: Prompt?

    /// Create, rename and delete share one `.alert`: two alert modifiers on one view do not
    /// both fire reliably (the same trap as the Conversations rename/delete pair).
    private enum Prompt: Identifiable {
        case create
        case delete(Project)
        case rename(Project)

        var id: String {
            switch self {
            case .create: return "create"
            case .delete(let p): return "delete-\(p.id)"
            case .rename(let p): return "rename-\(p.id)"
            }
        }

        var title: String {
            switch self {
            case .create: return "New project"
            case .delete: return "Delete this project?"
            case .rename: return "Rename project"
            }
        }
    }

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            ForEach(projects) { project in
                NavigationLink {
                    ProjectDetailView(projectID: project.id)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.name)
                        if let chunks = project.chunks {
                            Text("\(chunks) indexed chunk\(chunks == 1 ? "" : "s")")
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                        }
                    }
                }
                .swipeActions(edge: .trailing) {
                    Button("Delete", role: .destructive) { prompt = .delete(project) }
                }
                .swipeActions(edge: .leading) {
                    Button {
                        newName = project.name
                        prompt = .rename(project)
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    .tint(.gray)
                }
            }
            if projects.isEmpty && !loading && error == nil {
                Text("No projects yet.").foregroundStyle(Spine.Palette.textDim)
            }
        }
        .navigationTitle("Projects")
        .toolbar {
            ToolbarItem(placement: .spineTrailing) {
                Button { newName = ""; prompt = .create } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New project")
            }
        }
        .alert(
            prompt?.title ?? "",
            isPresented: Binding(get: { prompt != nil }, set: { if !$0 { prompt = nil } }),
            presenting: prompt
        ) { prompt in
            switch prompt {
            case .create:
                TextField("Name", text: $newName)
                Button("Create") { Task { await create() } }
                Button("Cancel", role: .cancel) {}
            case .rename(let project):
                TextField("Name", text: $newName)
                Button("Save") { Task { await rename(project) } }
                Button("Cancel", role: .cancel) {}
            case .delete(let project):
                Button("Delete", role: .destructive) { Task { await delete(project) } }
                Button("Cancel", role: .cancel) {}
            }
        } message: { prompt in
            switch prompt {
            case .delete(let project):
                Text("\(project.name) and its indexed sources are removed from the server.")
            case .rename:
                Text("Threads and indexed sources stay with the project.")
            case .create:
                EmptyView()
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .overlay { if loading && projects.isEmpty { ProgressView() } }
    }

    private func create() async {
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        do {
            _ = try await APIClient.shared.createProject(name: name, instructions: "")
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func rename(_ project: Project) async {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != project.name else { return }
        do {
            try await APIClient.shared.renameProject(project.id, to: name)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func delete(_ project: Project) async {
        do {
            try await APIClient.shared.deleteProject(project.id)
            projects.removeAll { $0.id == project.id }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            projects = try await APIClient.shared.projects()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct ProjectDetailView: View {
    let projectID: Int
    @State private var detail: ProjectDetail?
    @State private var error: String?
    @State private var name = ""
    @State private var instructions = ""
    @State private var workspaceFile = ""
    @State private var seeded = false
    @State private var saving = false
    @State private var busySource: Int?
    @State private var reindexingAll = false
    @State private var note: String?
    @State private var newPath = ""
    @State private var addingSource = false

    private var dirty: Bool {
        guard let project = detail?.project else { return false }
        return name != project.name || instructions != (project.instructions ?? "")
            || workspaceFile != (project.instructionsFile ?? "")
    }

    var body: some View {
        Form {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            Section("Name") {
                TextField("Name", text: $name)
            }
            Section {
                TextEditor(text: $instructions).frame(minHeight: 120)
            } header: {
                Text("Instructions")
            } footer: {
                Text("Given to the assistant on every turn in this project's threads.")
            }
            Section {
                TextField("/path/to/project/AGENTSPINE.md", text: $workspaceFile)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
            } header: {
                Text("Trusted workspace file")
            } footer: {
                Text("Optionally trust one file named AGENTSPINE.md as standing rules. It must sit inside one of this project's folders and outside any folder the assistant can write to. An indexed file of the same name stays untrusted. Leave empty for none.")
            }
            if dirty {
                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        HStack { Text("Save changes"); Spacer(); if saving { ProgressView() } }
                    }
                    .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            Section {
                ForEach(detail?.sources ?? []) { source in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(source.ref).font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                        HStack(spacing: 6) {
                            Text(source.kind)
                            Text("·")
                            Text("\(source.fileCount) files, \(source.chunkCount) chunks")
                            if let indexed = source.lastIndexed {
                                Text("·")
                                Text(SpineDate.relative(indexed))
                            }
                        }
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                        if let status = source.status, !status.isEmpty {
                            Text(status).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.warn)
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Remove", role: .destructive) { Task { await remove(source) } }
                    }
                    .swipeActions(edge: .leading) {
                        Button("Reindex") { Task { await reindex(source) } }.tint(Spine.Palette.accent)
                    }
                    .overlay(alignment: .trailing) {
                        if busySource == source.id { ProgressView() }
                    }
                }
                Button {
                    Task { await reindexAll() }
                } label: {
                    HStack { Text("Reindex all sources"); Spacer(); if reindexingAll { ProgressView() } }
                }
                .disabled(reindexingAll || (detail?.sources.isEmpty ?? true))
                if let note {
                    Text(note).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
                }
            } header: {
                Text("Sources")
            } footer: {
                Text("Swipe right to reindex one source, left to remove it. Paths are on the "
                     + "machine running the server.")
            }
            Section("Add a source") {
                TextField("/path/on/the/server", text: $newPath)
                    .spineNoAutocapitalization()
                    .autocorrectionDisabled()
                Button {
                    Task { await addSource() }
                } label: {
                    HStack { Text("Add and index"); Spacer(); if addingSource { ProgressView() } }
                }
                .disabled(addingSource || newPath.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            ProjectTasksSection(projectID: projectID)
            if let threads = detail?.conversations, !threads.isEmpty {
                Section("Threads") {
                    ForEach(threads) { thread in
                        NavigationLink(thread.displayTitle) {
                            #if os(macOS)
                            MacThreadDetail(conversationID: thread.id)
                            #else
                            ThreadView(conversationID: thread.id)
                            #endif
                        }
                    }
                }
            }
        }
        .navigationTitle(detail?.project.name ?? "Project")
        .spineInlineTitle()
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            let fresh = try await APIClient.shared.projectDetail(projectID)
            detail = fresh
            // Seed once: a refresh must not clobber what is being typed.
            if !seeded {
                name = fresh.project.name
                instructions = fresh.project.instructions ?? ""
                workspaceFile = fresh.project.instructionsFile ?? ""
                seeded = true
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await APIClient.shared.updateProject(
                projectID, name: name.trimmingCharacters(in: .whitespaces), instructions: instructions
            )
            let file = workspaceFile.trimmingCharacters(in: .whitespaces)
            if file != (detail?.project.instructionsFile ?? "") {
                try await APIClient.shared.setProjectWorkspaceFile(projectID, path: file.isEmpty ? nil : file)
            }
            seeded = false
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func reindex(_ source: ProjectSource) async {
        busySource = source.id
        defer { busySource = nil }
        do {
            note = try await APIClient.shared.reindexSource(
                projectID: projectID, sourceID: source.id
            ).summary
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func reindexAll() async {
        reindexingAll = true
        defer { reindexingAll = false }
        do {
            note = try await APIClient.shared.reindexProject(projectID).summary
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func remove(_ source: ProjectSource) async {
        do {
            try await APIClient.shared.removeSource(projectID: projectID, sourceID: source.id)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func addSource() async {
        addingSource = true
        defer { addingSource = false }
        do {
            note = try await APIClient.shared.addSource(
                projectID: projectID, path: newPath.trimmingCharacters(in: .whitespaces)
            ).summary
            newPath = ""
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The project's own task list: what meetings filed here, plus anything added by hand.
private struct ProjectTasksSection: View {
    let projectID: Int
    @State private var items: [TodoItem] = []
    @State private var newTitle = ""
    @State private var error: String?

    var body: some View {
        Section {
            ForEach(items) { item in
                HStack(alignment: .top, spacing: 10) {
                    Button {
                        Task { await toggle(item) }
                    } label: {
                        Image(systemName: item.isDone ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(item.isDone ? Spine.Palette.ok : Spine.Palette.textDim)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.isDone ? "Mark not done" : "Mark done")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .strikethrough(item.isDone)
                            .foregroundStyle(item.isDone ? Spine.Palette.textDim : Spine.Palette.text)
                        if let notes = item.notes, !notes.isEmpty {
                            Text(notes).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                        }
                    }
                }
                .swipeActions(edge: .trailing) {
                    Button("Delete", role: .destructive) { Task { await remove(item) } }
                }
            }
            if items.isEmpty { Text("No tasks yet.").foregroundStyle(Spine.Palette.textDim) }
            HStack {
                TextField("Add a task", text: $newTitle).onSubmit { Task { await add() } }
                Button("Add") { Task { await add() } }
                    .disabled(newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let error { Text(error).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.danger) }
        } header: {
            Text("Tasks")
        }
        .task { await load() }
    }

    private func load() async {
        do {
            items = try await APIClient.shared.todos(status: "all", projectID: projectID)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func add() async {
        let title = newTitle.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        do {
            try await APIClient.shared.addTodo(title: title, due: nil, waitingOn: nil, projectID: projectID)
            newTitle = ""
            error = nil
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggle(_ item: TodoItem) async {
        do {
            try await APIClient.shared.setTodoDone(item.id, done: !item.isDone)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func remove(_ item: TodoItem) async {
        do {
            try await APIClient.shared.deleteTodo(item.id)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}


// MARK: - Knowledge Inbox
//
// Lives here only because a new Swift file would need Target Membership ticked for the Mac target in Xcode
// (the project file is not edited by hand). Move it to its own Views/InboxView.swift and tick both
// targets when convenient.

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
