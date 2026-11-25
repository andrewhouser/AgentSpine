import SwiftUI

/// Everything the assistant has written for you — the answer to "where did it put that?".
struct FilesView: View {
    @State private var files: [SavedFile] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var opened: SavedFile?
    @State private var cachedAt: Date?
    @State private var showAll = false
    @State private var query = ""
    @State private var collapsed: Set<String> = []

    private var shown: [SavedFile] { FileGroup.filter(files, query) }

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

            if !files.isEmpty {
                Picker("View", selection: $showAll) {
                    Text("Folders").tag(false)
                    Text("All").tag(true)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
            }

            if showAll {
                ForEach(shown) { row($0) }
            } else {
                // A search opens every folder that has a match.
                ForEach(FileGroup.group(shown)) { group in
                    let open = !query.isEmpty || !collapsed.contains(group.id)
                    Button {
                        if collapsed.contains(group.id) { collapsed.remove(group.id) } else { collapsed.insert(group.id) }
                    } label: {
                        HStack {
                            Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption)
                            Image(systemName: "folder")
                            Text(group.name).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
                            Spacer()
                            Text("\(group.files.count)").foregroundStyle(Spine.Palette.textDim)
                        }
                        .foregroundStyle(Spine.Palette.text)
                    }
                    .buttonStyle(.plain)
                    if open { ForEach(group.files) { row($0).padding(.leading, 18) } }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Files")
        .searchable(text: $query, prompt: "Name, folder or project")
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $opened) { FilePreview(file: $0) }
    }

    private func row(_ file: SavedFile) -> some View {
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
