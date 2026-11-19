import SwiftUI

/// ⌘N: the first message of a new thread. Sending creates the conversation and starts the run
/// (`AppState.startThread`), then the window switches to it and streams from there.
struct MacNewThread: View {
    let started: (Int) -> Void

    @Environment(AppState.self) private var state
    @State private var draft = ""
    @State private var isSending = false
    @State private var error: String?
    @State private var staged: [Attachment] = []
    @State private var uploading = 0
    /// Created when the first image is attached. The server only binds an upload to a turn in
    /// the same conversation, so the thread has to exist before the picture can go up.
    @State private var conversationID: Int?

    var body: some View {
        VStack(spacing: 0) {
            EmptyNotice(
                symbol: "square.and.pencil",
                title: "New thread",
                detail: "Ask for something. Anything that needs your approval will wait in the thread."
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            MacComposer(
                draft: $draft,
                placeholder: "What do you need?",
                isBusy: isSending,
                error: error,
                staged: staged,
                uploading: uploading,
                attach: { urls in Task { await upload(urls) } },
                removeStaged: { gone in staged.removeAll { $0.id == gone.id } },
                send: { Task { await send() } }
            )
        }
        .background(Spine.Palette.bg)
        .navigationTitle("New thread")
    }

    /// Uploaded with no conversation yet; the first message adopts them.
    private func upload(_ urls: [URL]) async {
        uploading += urls.count
        for url in urls {
            defer { uploading -= 1 }
            do {
                let id = try await ensureConversation()
                staged.append(try await MacImageUpload.upload(url, conversationID: id))
                error = nil
            } catch let failure {
                error = failure.localizedDescription
            }
        }
    }

    private func ensureConversation() async throws -> Int {
        if let conversationID { return conversationID }
        let made = try await APIClient.shared.createConversation(projectID: nil)
        conversationID = made.id
        return made.id
    }

    private func send() async {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty || !staged.isEmpty, !isSending, uploading == 0 else { return }
        // The server answers an image with no words as "What is this?".
        let task = typed.isEmpty ? "What is this?" : typed
        isSending = true
        defer { isSending = false }
        if let existing = conversationID {
            // Made for the first attachment; the message goes into it.
            do {
                _ = try await APIClient.shared.send(message: task, to: existing, attachmentIDs: staged.map(\.id))
                await state.refresh()
                draft = ""
                staged = []
                conversationID = nil
                error = nil
                started(existing)
            } catch {
                self.error = error.localizedDescription
            }
        } else if let id = await state.startThread(task: task) {
            draft = ""
            error = nil
            started(id)
        } else {
            error = state.loadError ?? "Could not start the thread."
        }
    }
}
