import SwiftUI

/// ⌘N: the first message of a new thread. Sending creates the conversation and starts the run
/// (`AppState.startThread`), then the window switches to it and streams from there.
struct MacNewThread: View {
    let started: (Int) -> Void

    @Environment(AppState.self) private var state
    @State private var draft = ""
    @State private var isSending = false
    @State private var error: String?

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
                send: { Task { await send() } }
            )
        }
        .background(Spine.Palette.bg)
        .navigationTitle("New thread")
    }

    private func send() async {
        let task = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty, !isSending else { return }
        isSending = true
        defer { isSending = false }
        if let id = await state.startThread(task: task) {
            draft = ""
            error = nil
            started(id)
        } else {
            error = state.loadError ?? "Could not start the thread."
        }
    }
}
