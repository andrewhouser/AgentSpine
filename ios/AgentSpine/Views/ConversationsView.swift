import SwiftUI

/// The thread list, and the compose button that is the reason to open this app on the move.
struct ConversationsView: View {
    @Environment(AppState.self) private var state
    @Environment(Settings.self) private var settings

    @State private var isComposing = false
    @State private var draft = ""
    @State private var isSending = false
    @State private var openThread: Int?
    @State private var newTitle = ""
    @State private var prompt: Prompt?

    /// Rename and delete share one `.alert`, for the same reason the schedules screen shares
    /// one `.sheet`: two presentation modifiers of the same kind on one view silently do not
    /// both work — the later one wins and the earlier never fires.
    private enum Prompt: Identifiable {
        case delete(Conversation)
        case rename(Conversation)

        var conversation: Conversation {
            switch self {
            case .delete(let c), .rename(let c): return c
            }
        }

        var id: String {
            switch self {
            case .delete(let c): return "delete-\(c.id)"
            case .rename(let c): return "rename-\(c.id)"
            }
        }

        var title: String {
            switch self {
            case .delete: return "Delete this thread?"
            case .rename: return "Rename thread"
            }
        }
    }

    var body: some View {
        List {
            if let error = state.loadError {
                Section {
                    ErrorNotice(message: error) { Task { await state.refresh() } }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }

            if state.conversations.isEmpty && state.loadError == nil {
                Section {
                    EmptyNotice(
                        symbol: "bubble.left.and.text.bubble.right",
                        title: state.lastLoaded == nil ? "Loading…" : "No threads yet",
                        detail: "Tap the pencil to give AgentSpine something to do."
                    )
                    .listRowBackground(Color.clear)
                }
            }

            ForEach(state.conversations) { conversation in
                NavigationLink(value: conversation.id) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(conversation.displayTitle)
                            .font(.body)
                            .lineLimit(2)
                        HStack(spacing: 6) {
                            Text(SpineDate.relative(conversation.updated))
                            if let tier = conversation.tier {
                                Text("·")
                                Text(tier).textCase(.lowercase)
                            }
                            // A thread in a project reads that project's indexed sources,
                            // which changes what its answers are based on. Now that a
                            // thread can be filed into one from this app, the list has to
                            // say which — otherwise the picker sets something invisible.
                            if let id = conversation.projectID, let name = state.projectNames[id] {
                                Text("·")
                                Label(name, systemImage: "folder")
                                    .labelStyle(.titleAndIcon)
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
                .swipeActions(edge: .trailing) {
                    // Archive, not delete, as the swipe's main verb. Archiving is also what
                    // folds the thread into cross-conversation memory on the server, so it
                    // is the useful one; a destructive swipe on a phone in a pocket is the
                    // wrong default. Delete is here too, but behind a confirmation — it
                    // takes the thread's photographs off the server's disk with it.
                    Button {
                        Task {
                            try? await APIClient.shared.archive(conversation.id)
                            await state.refresh()
                        }
                    } label: {
                        Label("Archive", systemImage: "archivebox")
                    }
                    .tint(.indigo)

                    Button(role: .destructive) {
                        prompt = .delete(conversation)
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
                .swipeActions(edge: .leading) {
                    // The auto-titler names a thread from its first turn and sometimes names
                    // it badly; a thread you cannot rename is one you learn to scroll past.
                    Button {
                        newTitle = conversation.title ?? ""
                        prompt = .rename(conversation)
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    .tint(.gray)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("AgentSpine")
        .refreshable { await state.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    draft = ""
                    isComposing = true
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .disabled(!settings.isConfigured)
                .accessibilityLabel("New task")
            }
        }
        .sheet(isPresented: $isComposing) {
            NewTaskSheet(draft: $draft, isSending: $isSending) { task, projectID in
                if let id = await state.startThread(task: task, projectID: projectID) {
                    isComposing = false
                    openThread = id
                }
            }
        }
        .navigationDestination(item: $openThread) { id in
            ThreadView(conversationID: id)
        }
        .alert(
            prompt?.title ?? "",
            isPresented: Binding(get: { prompt != nil }, set: { if !$0 { prompt = nil } }),
            presenting: prompt
        ) { prompt in
            switch prompt {
            case .delete(let conversation):
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) {
                    Task {
                        try? await APIClient.shared.delete(conversation: conversation.id)
                        await state.refresh()
                    }
                }
            case .rename(let conversation):
                TextField("Title", text: $newTitle)
                Button("Cancel", role: .cancel) {}
                Button("Save") {
                    let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !title.isEmpty else { return }
                    Task {
                        try? await APIClient.shared.rename(conversation.id, to: title)
                        await state.refresh()
                    }
                }
            }
        } message: { prompt in
            switch prompt {
            case .delete:
                Text("The turns, the tool calls and any photographs you sent are removed "
                     + "from the server. This cannot be undone — archiving keeps all of it.")
            case .rename:
                Text("The auto-titler names a thread from its first turn. This replaces it.")
            }
        }
    }
}

/// Compose a task.
///
/// Deliberately a sheet with one large field and one button. The thing being typed becomes an
/// instruction to something that can call tools, and the composer that invites a careless
/// one-liner is the composer that gets one.
struct NewTaskSheet: View {
    @Binding var draft: String
    @Binding var isSending: Bool
    let send: (String, Int?) async -> Void

    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var projectID: Int?

    private var projects: [Project] { state.projects }

    private var trimmed: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                TextField("What should AgentSpine do?", text: $draft, axis: .vertical)
                    .font(.body)
                    .focused($focused)
                    .frame(minHeight: 120, alignment: .topLeading)

                // Only once there is something to pick. A picker reading "None" on a server
                // with no projects is a control that explains nothing and costs a tap.
                if !projects.isEmpty {
                    Picker("Project", selection: $projectID) {
                        Text("No project").tag(nil as Int?)
                        ForEach(projects) { Text($0.name).tag($0.id as Int?) }
                    }
                    .pickerStyle(.menu)

                    Text("A thread in a project can read that project's indexed sources.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Label(
                    "You'll get a notification when it finishes, so you can close the app.",
                    systemImage: "bell.badge"
                )
                .font(.caption)
                .foregroundStyle(.secondary)

                Spacer()
            }
            .padding()
            .navigationTitle("New task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSending {
                        ProgressView()
                    } else {
                        Button("Send") {
                            Task {
                                isSending = true
                                await send(trimmed, projectID)
                                isSending = false
                            }
                        }
                        .disabled(trimmed.isEmpty)
                        .fontWeight(.semibold)
                    }
                }
            }
            .onAppear { focused = true }
        }
    }
}
