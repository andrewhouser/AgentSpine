import SwiftUI

/// Everything the assistant has written for you — the answer to "where did it put that?".
struct FilesView: View {
    @State private var files: [SavedFile] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var opened: SavedFile?
    @State private var cachedAt: Date?

    var body: some View {
        List {
            if let loadError {
                ErrorNotice(message: loadError) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            if let cachedAt {
                CachedNotice(savedAt: cachedAt) { Task { await load() } }
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
                            .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
                            .foregroundStyle(file.exists ? Spine.Palette.text : Spine.Palette.textDim)
                        Text(file.path)
                            .font(SpineFont.mono(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                            .foregroundStyle(Spine.Palette.textFaint)
                            .lineLimit(2)
                        Text(
                            "\(ByteCountFormatter.string(fromByteCount: Int64(file.bytes), countStyle: .file)) · "
                                + "\(file.action) \(SpineDate.relative(file.ts))"
                                + (file.exists ? "" : " · no longer on disk")
                        )
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)
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
            let loaded = try await APIClient.shared.savedFilesKeepingCopy()
            files = loaded.value
            cachedAt = loaded.cachedAt
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
    @State private var cachedAt: Date?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                if let content {
                    VStack(alignment: .leading, spacing: 8) {
                        if let cachedAt { CachedNotice(savedAt: cachedAt).padding(.horizontal, -16) }
                        if file.name.lowercased().hasSuffix(".md") {
                            MarkdownText(content.text)
                        } else {
                            Text(content.text).font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                        }
                        if content.truncated {
                            Text("Preview truncated.").font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                } else if let error {
                    Text(error).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.danger).padding()
                } else {
                    ProgressView().padding()
                }
            }
            .navigationTitle(file.name)
            .spineInlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if let content {
                    ToolbarItem(placement: .spineLeading) { ShareLink(item: content.text) }
                }
            }
        }
        .task {
            do {
                let loaded = try await APIClient.shared.fileContentKeepingCopy(file.path)
                content = loaded.value
                cachedAt = loaded.cachedAt
            } catch { self.error = error.localizedDescription }
        }
    }
}
