import SwiftUI

/// Builds with room to breathe: the builds on the left, the selected one's diff on the right,
/// rather than the phone's list that opens a sheet. Same data, same verdict rules — `ok` is
/// three-valued, and a build that only branched and committed has no verdict to show.
struct MacBuildsView: View {
    @State private var builds: [Build] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var selection: Int?

    var body: some View {
        HSplitView {
            list
                .frame(minWidth: 280, idealWidth: 340, maxWidth: 480)
            Group {
                if let build = builds.first(where: { $0.id == selection }) {
                    MacBuildDetail(build: build).id(build.id)
                } else {
                    EmptyNotice(symbol: "hammer", title: "No build selected", detail: "Pick a build to read its diff.")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 420, maxWidth: .infinity)
        }
        .navigationTitle("Builds")
        .task { await load() }
        .toolbar {
            ToolbarItem {
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .help("Refresh builds")
            }
        }
    }

    @ViewBuilder private var list: some View {
        if let loadError, builds.isEmpty {
            ErrorNotice(message: loadError) { Task { await load() } }
        } else if builds.isEmpty {
            EmptyNotice(
                symbol: "hammer",
                title: loaded ? "No builds yet" : "Loading…",
                detail: "Declare commands for a repo under \"build\" in policy.json, then ask it to change something there."
            )
        } else {
            List(builds, selection: $selection) { build in
                row(build).tag(build.id)
            }
            .scrollContentBackground(.hidden)
        }
    }

    private func row(_ build: Build) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: MacBuildStyle.symbol(build)).foregroundStyle(MacBuildStyle.tint(build))
                    .accessibilityLabel(MacBuildStyle.label(build))
                Text(build.repoName)
                    .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
                Text(build.verdict)
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(MacBuildStyle.tint(build))
            }
            if let task = build.task, !task.isEmpty {
                Text(task)
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textDim)
                    .lineLimit(2)
            }
            Text(MacBuildStyle.subtitle(build))
                .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                .foregroundStyle(Spine.Palette.textFaint)
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        do {
            builds = try await APIClient.shared.builds()
            loadError = nil
            if selection == nil { selection = builds.first?.id }
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }
}

enum MacBuildStyle {
    static func symbol(_ build: Build) -> String {
        guard let ok = build.ok else { return "circle.dashed" }
        return ok ? "checkmark.circle.fill" : "xmark.circle.fill"
    }

    /// The symbol and colour are the only thing saying how a build ended, so VoiceOver gets words.
    static func label(_ build: Build) -> String {
        guard let ok = build.ok else { return "Not finished" }
        return ok ? "Passed" : "Failed"
    }

    static func tint(_ build: Build) -> Color {
        guard let ok = build.ok else { return Spine.Palette.textDim }
        return ok ? Spine.Palette.ok : Spine.Palette.danger
    }

    static func subtitle(_ build: Build) -> String {
        var parts = ["run #\(build.runID)", SpineDate.relative(build.started)]
        if build.commits > 0 { parts.append("\(build.commits) commit\(build.commits == 1 ? "" : "s")") }
        if !build.files.isEmpty { parts.append("\(build.files.count) file\(build.files.count == 1 ? "" : "s") written") }
        return parts.joined(separator: " · ")
    }
}

/// One build: what it was asked, which commands ran and how they ended, then the diff with its
/// added and removed lines coloured. Committed and uncommitted changes stay in separate
/// sections, because the difference between them is most of what a reviewer is checking.
private struct MacBuildDetail: View {
    let build: Build

    @State private var diff: BuildDiff?
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spine.Space.lg) {
                header
                if let diff {
                    diffBody(diff)
                } else if let error {
                    ErrorNotice(message: error) { Task { await load() } }
                } else if build.branch == nil {
                    Text("This run never made a branch, so there is no diff.")
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(Spine.Palette.textDim)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .padding(Spine.Space.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Spine.Palette.bg)
        .task { await load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            HStack(spacing: Spine.Space.sm) {
                Image(systemName: MacBuildStyle.symbol(build)).foregroundStyle(MacBuildStyle.tint(build))
                    .accessibilityLabel(MacBuildStyle.label(build))
                Text(build.repoName).font(SpineFont.display(Spine.TypeSize.title2, relativeTo: .title2))
                Text(build.verdict)
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(MacBuildStyle.tint(build))
            }
            if let task = build.task, !task.isEmpty {
                Text(task)
                    .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body))
                    .foregroundStyle(Spine.Palette.text)
            }
            Text(MacBuildStyle.subtitle(build))
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
            if !build.commands.isEmpty {
                HStack(spacing: 6) {
                    ForEach(Array(build.commands.enumerated()), id: \.offset) { _, command in
                        Text("\(command.name): \(command.verdict)")
                            .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(.quaternary, in: Capsule())
                    }
                }
            }
        }
    }

    @ViewBuilder private func diffBody(_ diff: BuildDiff) -> some View {
        if let branch = diff.branch, let base = diff.base {
            Text("\(branch) vs \(base)")
                .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
        }
        if diff.stat.isEmpty && diff.patch.isEmpty {
            Text("Nothing committed on this branch.")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)
        } else {
            if !diff.stat.isEmpty {
                Text(diff.stat)
                    .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                    .textSelection(.enabled)
            }
            MacPatchView(patch: diff.patch)
        }
        if !diff.uncommitted.isEmpty {
            Divider()
            Text("Still uncommitted in \(diff.repo)")
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                .foregroundStyle(Spine.Palette.warn)
            MacPatchView(patch: diff.uncommitted)
        }
        // git diff cannot see these, so they would otherwise be invisible here while sitting in
        // the working tree.
        if !diff.untracked.isEmpty {
            Divider()
            Text("Not tracked by git at all (\(diff.untracked.count))")
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                .foregroundStyle(Spine.Palette.warn)
            Text(diff.untracked.joined(separator: "\n"))
                .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                .textSelection(.enabled)
        }
    }

    private func load() async {
        guard build.branch != nil else { return }
        do {
            diff = try await APIClient.shared.buildDiff(build.runID)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// A unified diff, one line per row: additions green, removals red, hunk headers and file
/// headers dim. Colour is a hint, not the signal — the leading + and - stay in the text.
private struct MacPatchView: View {
    let patch: String

    private var lines: [(id: Int, text: String)] {
        patch.split(separator: "\n", omittingEmptySubsequences: false).enumerated().map { ($0.offset, String($0.element)) }
    }

    var body: some View {
        ScrollView(.horizontal) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(lines, id: \.id) { line in
                    Text(line.text.isEmpty ? " " : line.text)
                        .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(color(line.text))
                        .padding(.horizontal, Spine.Space.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(background(line.text))
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .textSelection(.enabled)
        }
        .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
    }

    private func color(_ line: String) -> Color {
        if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("diff ") || line.hasPrefix("index ") { return Spine.Palette.textDim }
        if line.hasPrefix("@@") { return Spine.Palette.accent }
        if line.hasPrefix("+") { return Spine.Palette.ok }
        if line.hasPrefix("-") { return Spine.Palette.danger }
        return Spine.Palette.text
    }

    private func background(_ line: String) -> Color {
        if line.hasPrefix("+++") || line.hasPrefix("---") { return .clear }
        if line.hasPrefix("+") { return Spine.Palette.ok.opacity(0.10) }
        if line.hasPrefix("-") { return Spine.Palette.danger.opacity(0.10) }
        return .clear
    }
}
