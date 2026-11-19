import SwiftUI

/// ⌘K: search every thread's titles, questions and answers, then jump to the one you pick.
/// The same /api/search the phone's SearchView uses — read-only, nothing new on the server.
struct MacSearchSheet: View {
    /// Called with the conversation to open.
    let open: (Int) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var isSearching = false
    @State private var failure: String?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Spine.Space.sm) {
                Image(systemName: "magnifyingglass").foregroundStyle(Spine.Palette.textDim)
                TextField("Search threads", text: $query)
                    .textFieldStyle(.plain)
                    .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body))
                    .focused($fieldFocused)
                    .onSubmit { if let first = hits.first(where: { $0.conversationId != nil }) { pick(first) } }
                if isSearching { ProgressView().controlSize(.small) }
            }
            .padding(Spine.Space.md)
            Divider()
            results
        }
        .frame(width: 560, height: 420)
        .background(Spine.Palette.bg)
        .onAppear { fieldFocused = true }
        .onExitCommand { dismiss() }
        // Restarts on every keystroke and cancels the previous one; the sleep is the debounce.
        .task(id: query) { await search() }
    }

    @ViewBuilder private var results: some View {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        if trimmed.count < 2 {
            EmptyNotice(symbol: "magnifyingglass", title: "Search your threads", detail: "Type at least two characters.")
        } else if let failure {
            ErrorNotice(message: failure) { Task { await search() } }
        } else if hits.isEmpty && !isSearching {
            EmptyNotice(symbol: "tray", title: "Nothing found", detail: "No thread mentions “\(trimmed)”.")
        } else {
            List(hits) { hit in
                Button { pick(hit) } label: { row(hit) }
                    .buttonStyle(.plain)
                    .disabled(hit.conversationId == nil)
            }
            .scrollContentBackground(.hidden)
        }
    }

    private func row(_ hit: SearchHit) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(hit.conversationTitle ?? "Untitled thread")
                .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.medium))
                .foregroundStyle(Spine.Palette.text)
                .lineLimit(1)
            Text(hit.snippet.isEmpty ? hit.task : hit.snippet)
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func pick(_ hit: SearchHit) {
        guard let id = hit.conversationId else { return }
        dismiss()
        open(id)
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else {
            hits = []
            failure = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        isSearching = true
        defer { isSearching = false }
        do {
            let found = try await APIClient.shared.search(q)
            guard !Task.isCancelled else { return }
            hits = found
            failure = nil
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }
}
