import SwiftUI

/// What the assistant has learned, with a way to make it forget.
///
/// Deleting is the human-facing correction for a wrong or stale fact; the agent has no tool
/// that reaches it, so this list is where a bad memory gets retracted.
struct MemoryView: View {
    @State private var memories: [Memory] = []
    @State private var query = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            ForEach(memories) { memory in
                VStack(alignment: .leading, spacing: 4) {
                    Text(memory.text)
                    HStack(spacing: 6) {
                        Text(memory.kind)
                        Text("·")
                        Text(SpineDate.relative(memory.ts))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .swipeActions {
                    Button("Forget", role: .destructive) { Task { await forget(memory) } }
                }
            }
            if memories.isEmpty && !loading && error == nil {
                Text(query.isEmpty ? "Nothing remembered yet." : "No matches.")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Memory")
        .searchable(text: $query)
        .onSubmit(of: .search) { Task { await load() } }
        .onChange(of: query) { _, new in
            if new.isEmpty { Task { await load() } }
        }
        .refreshable { await load() }
        .task { await load() }
        .overlay { if loading && memories.isEmpty { ProgressView() } }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            memories = try await APIClient.shared.memories(query: query)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func forget(_ memory: Memory) async {
        do {
            try await APIClient.shared.forgetMemory(memory.id)
            memories.removeAll { $0.id == memory.id }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// `policy.json`, read-only. Editing it stays a text-editor job on the Mac on purpose.
struct PolicyView: View {
    @State private var text: String?
    @State private var error: String?

    var body: some View {
        ScrollView {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }.padding()
            } else if let text {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            } else {
                ProgressView().padding()
            }
        }
        .navigationTitle("Policy")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            text = try await APIClient.shared.policyText()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
