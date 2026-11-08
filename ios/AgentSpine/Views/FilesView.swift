import SwiftUI

/// Everything the assistant has written for you — the answer to "where did it put that?".
struct FilesView: View {
    @State private var files: [SavedFile] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var opened: SavedFile?

    var body: some View {
        List {
            if let loadError {
                ErrorNotice(message: loadError) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            if files.isEmpty && loadError == nil {
                EmptyNotice(
                    symbol: "doc.text",
                    title: loaded ? "Nothing saved yet" : "Loading…",
                    detail: "Ask in a thread — \"save that as plan.md\" — or use Save to file under any reply."
                )
                .listRowBackground(Color.clear)
            }

            ForEach(files) { file in
                Button {
                    if file.exists { opened = file }
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(file.name)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(file.exists ? .primary : .secondary)
                        Text(file.path)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                        Text(
                            "\(ByteCountFormatter.string(fromByteCount: Int64(file.bytes), countStyle: .file)) · "
                                + "\(file.action) \(SpineDate.relative(file.ts))"
                                + (file.exists ? "" : " · no longer on disk")
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.plain)
        .navigationTitle("Files")
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $opened) { FilePreview(file: $0) }
    }

    private func load() async {
        do {
            files = try await APIClient.shared.savedFiles()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }
}

private struct FilePreview: View {
    @Environment(\.dismiss) private var dismiss
    let file: SavedFile
    @State private var content: FileContent?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                if let content {
                    VStack(alignment: .leading, spacing: 8) {
                        if file.name.lowercased().hasSuffix(".md") {
                            MarkdownText(content.text)
                        } else {
                            Text(content.text).font(.footnote.monospaced())
                        }
                        if content.truncated {
                            Text("Preview truncated.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                } else if let error {
                    Text(error).font(.footnote).foregroundStyle(.red).padding()
                } else {
                    ProgressView().padding()
                }
            }
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if let content {
                    ToolbarItem(placement: .topBarLeading) { ShareLink(item: content.text) }
                }
            }
        }
        .task {
            do { content = try await APIClient.shared.fileContent(file.path) } catch { self.error = error.localizedDescription }
        }
    }
}
