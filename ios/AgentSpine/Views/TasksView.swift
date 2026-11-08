import SwiftUI

/// The assistant's own to-do list and follow-ups — the same list it reads and writes in chat.
///
/// Capture is the point: "remind me to call the dentist Friday" in a thread lands here with a
/// due time, and the Mac nudges you (a push) when it passes. This screen is for ticking things
/// off and adding one without opening a conversation.
struct TasksView: View {
    @State private var items: [TodoItem] = []
    @State private var showDone = false
    @State private var loaded = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var adding = false

    var body: some View {
        List {
            if let loadError {
                ErrorNotice(message: loadError) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            if items.isEmpty && loadError == nil {
                EmptyNotice(
                    symbol: "checklist",
                    title: loaded ? "Nothing on the list" : "Loading…",
                    detail: "Ask in a thread — \"remind me to call the dentist on Friday\" — or tap +."
                )
                .listRowBackground(Color.clear)
            }

            ForEach(items) { item in
                HStack(alignment: .top, spacing: 12) {
                    Button {
                        Task { await toggle(item) }
                    } label: {
                        Image(systemName: item.isDone ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(item.isDone ? .green : .secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.isDone ? "Mark not done" : "Mark done")

                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title)
                            .strikethrough(item.isDone)
                            .foregroundStyle(item.isDone ? .secondary : .primary)
                        HStack(spacing: 6) {
                            if item.isFollowUp, let who = item.waitingOn {
                                Label("waiting on \(who)", systemImage: "hourglass")
                            }
                            if let due = item.dueDate {
                                Text(item.isOverdue ? "overdue · " : "")
                                    + Text(due.formatted(date: .abbreviated, time: .shortened))
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(item.isOverdue ? Color.red : Color.secondary)
                        if let notes = item.notes, !notes.isEmpty {
                            Text(notes).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        Task { await remove(item) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Tasks")
        .refreshable { await load() }
        .task { await load() }
        .onChange(of: showDone) { Task { await load() } }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Toggle(isOn: $showDone) { Image(systemName: "checkmark.circle") }
                    .toggleStyle(.button)
                    .accessibilityLabel("Show completed")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { adding = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New task")
            }
        }
        .sheet(isPresented: $adding) {
            AddTodoSheet { title, due, waitingOn in
                try await APIClient.shared.addTodo(title: title, due: due, waitingOn: waitingOn)
                await load()
            }
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

    private func load() async {
        do {
            items = try await APIClient.shared.todos(status: showDone ? "all" : "open")
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }

    private func toggle(_ item: TodoItem) async {
        do {
            try await APIClient.shared.setTodoDone(item.id, done: !item.isDone)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func remove(_ item: TodoItem) async {
        do {
            try await APIClient.shared.deleteTodo(item.id)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }
}

private struct AddTodoSheet: View {
    @Environment(\.dismiss) private var dismiss
    let save: (String, String?, String?) async throws -> Void

    @State private var title = ""
    @State private var due = ""
    @State private var waitingOn = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What needs doing?", text: $title)
                    TextField("Due — e.g. friday 3pm", text: $due)
                        .textInputAutocapitalization(.never)
                }
                Section("Waiting on someone?") {
                    TextField("Who (makes it a follow-up)", text: $waitingOn)
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("New task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        Task {
                            saving = true
                            defer { saving = false }
                            do {
                                try await save(
                                    title.trimmingCharacters(in: .whitespaces),
                                    due.trimmingCharacters(in: .whitespaces),
                                    waitingOn.trimmingCharacters(in: .whitespaces)
                                )
                                dismiss()
                            } catch {
                                self.error = error.localizedDescription
                            }
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
        }
    }
}
