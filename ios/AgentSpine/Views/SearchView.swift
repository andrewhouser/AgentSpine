import SwiftUI

/// Search every thread — what you asked and what it answered.
struct SearchView: View {
    /// Switch to the Threads tab and open this conversation.
    let openThread: (Int) -> Void

    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var searched = false
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await run() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            if searched && hits.isEmpty && error == nil {
                EmptyNotice(symbol: "magnifyingglass", title: "No matches", detail: "Try fewer or different words.")
                    .listRowBackground(Color.clear)
            }

            ForEach(hits) { hit in
                Button {
                    if let id = hit.conversationId { openThread(id) }
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(hit.conversationTitle ?? "Untitled conversation").font(.body.weight(.semibold))
                        Text("asked: \(hit.task)").font(.caption).foregroundStyle(.tertiary).lineLimit(1)
                        Text(hit.snippet).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.plain)
        .navigationTitle("Search")
        .searchable(text: $query, prompt: "Search conversations")
        // `.task(id:)` cancels the previous search when the text changes, and the sleep makes
        // that a debounce: only a pause in typing reaches the server.
        .task(id: query) {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await run()
        }
    }

    private func run() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else {
            hits = []
            searched = false
            return
        }
        do {
            hits = try await APIClient.shared.search(q)
            error = nil
        } catch {
            if !(error is CancellationError) { self.error = error.localizedDescription }
        }
        searched = true
    }
}
