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

/// The sections of a project, one at a time; the same four as the web project screen.
private enum ProjectTab: String, CaseIterable, Identifiable {
    case conversations = "Conversations"
    case documents = "Documents"
    case tasks = "Tasks"
    case settings = "Settings"

    var id: String { rawValue }
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
    @State private var tab: ProjectTab = .conversations
    @State private var retentionDays = ""
    @State private var retentionSeeded = false
    @State private var retentionSaving = false
    @State private var rules: [RetentionRule] = []
    @State private var confirmDelete = false
    @Environment(\.dismiss) private var dismiss

    /// Empty means follow the global setting; otherwise a whole number of days from 0 to 3650.
    private var retentionValue: Int?? {
        let text = retentionDays.trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return .some(nil) }
        guard text.allSatisfy(\.isNumber), let n = Int(text), n <= 3650 else { return nil }
        return .some(n)
    }

    private var retentionDirty: Bool {
        guard let project = detail?.project else { return false }
        return retentionDays.trimmingCharacters(in: .whitespaces) != (project.transcriptRetentionDays.map(String.init) ?? "")
    }

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
            Section {
                Picker("Section", selection: $tab) {
                    ForEach(ProjectTab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            if tab == .settings {
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
            }
                Section {
                    TextField("Follow the global setting", text: $retentionDays)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                    Button {
                        Task { await saveRetention() }
                    } label: {
                        HStack { Text("Save retention"); Spacer(); if retentionSaving { ProgressView() } }
                    }
                    .disabled(retentionSaving || !retentionDirty || retentionValue == nil)
                    ForEach(rules, id: \.artifact) { rule in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(rule.artifact).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                            Text(rule.rule)
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textDim)
                        }
                    }
                } header: {
                    Text("Meeting transcript retention")
                } footer: {
                    Text(retentionValue == nil
                        ? "Enter a whole number of days from 0 to 3650, or leave it empty."
                        : "How long the raw transcripts of this project's meetings are kept. Leave empty to follow the global setting, enter 0 to keep them until the meeting is deleted, or a number of days. What you reviewed (decisions, commitments) is kept either way, with its cited words and a note that the original has aged out.")
                }
                Section {
                    Button("Delete project", role: .destructive) { confirmDelete = true }
                } header: {
                    Text("Danger zone")
                } footer: {
                    Text("Removes the project and everything indexed for it. Its conversations and their audit trail are kept: the record of what the assistant did is not something a tidy-up should erase.")
                }
            if tab == .documents {
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
            }
            if tab == .tasks {
                ProjectTasksSection(projectID: projectID)
            }
            if tab == .conversations {
                Section("Conversations") {
                    if (detail?.conversations ?? []).isEmpty {
                        Text("None yet.")
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textFaint)
                    }
                    ForEach(detail?.conversations ?? []) { thread in
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
        .confirmationDialog("Delete this project?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete project", role: .destructive) { Task { await deleteProject() } }
        } message: {
            Text("This removes the project and everything indexed for it. It cannot be undone.")
        }
        .navigationTitle(detail?.project.name ?? "Project")
        .spineInlineTitle()
        .refreshable { await load() }
        .task { await load() }
        .task { rules = (try? await APIClient.shared.retentionRules()) ?? [] }
    }

    private func saveRetention() async {
        guard case .some(let days) = retentionValue else { return }
        retentionSaving = true
        defer { retentionSaving = false }
        do {
            try await APIClient.shared.setProjectRetention(projectID, days: days)
            await load()
            retentionSeeded = false
            seedRetention()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func deleteProject() async {
        do {
            try await APIClient.shared.deleteProject(projectID)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func seedRetention() {
        guard !retentionSeeded, let project = detail?.project else { return }
        retentionDays = project.transcriptRetentionDays.map(String.init) ?? ""
        retentionSeeded = true
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
            seedRetention()
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
