import SwiftUI

/// The thread list, and the compose button that is the reason to open this app on the move.
struct ConversationsView: View {
    @Environment(AppState.self) private var state
    @Environment(Settings.self) private var settings

    @State private var isComposing = false
    @State private var draft = ""
    @State private var isSending = false
    @State private var openThread: Int?

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
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
                .swipeActions(edge: .trailing) {
                    // Archive, not delete. Archiving is also what folds the thread into
                    // cross-conversation memory on the server, so it is the useful verb; a
                    // destructive swipe on a phone in a pocket is the wrong default.
                    Button {
                        Task {
                            try? await APIClient.shared.archive(conversation.id)
                            await state.refresh()
                        }
                    } label: {
                        Label("Archive", systemImage: "archivebox")
                    }
                    .tint(.indigo)
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
            }
        }
        .sheet(isPresented: $isComposing) {
            NewTaskSheet(draft: $draft, isSending: $isSending) { task in
                if let id = await state.startThread(task: task) {
                    isComposing = false
                    openThread = id
                }
            }
        }
        .navigationDestination(item: $openThread) { id in
            ThreadView(conversationID: id)
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
    let send: (String) async -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

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
                                await send(trimmed)
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
