import SwiftUI

/// What the build loop did to a repository, and the diff to prove it.
///
/// The one thing this screen has to answer at a glance is **did it work, and what changed**.
/// Everything else — which commands ran, how many commits, which files — is secondary and
/// sits in the subtitle.
///
/// `ok` is deliberately three-valued, and the view honours that. A run that only branched and
/// committed never ran a command, so it has no verdict; showing that as a red cross would be
/// a lie about the only thing the row exists to say.
struct BuildsView: View {
    @State private var builds: [Build] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var opened: Build?

    var body: some View {
        List {
            if let loadError {
                ErrorNotice(message: loadError) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            if builds.isEmpty && loadError == nil {
                EmptyNotice(
                    symbol: "hammer",
                    title: loaded ? "No builds yet" : "Loading…",
                    detail: "Declare commands for a repo under \"build\" in policy.json, then ask it to change something there."
                )
                .listRowBackground(Color.clear)
            }

            ForEach(builds) { build in
                Button {
                    if build.branch != nil { opened = build }
                } label: {
                    row(build)
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.plain)
        .navigationTitle("Builds")
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $opened) { DiffSheet(build: $0) }
    }

    @ViewBuilder
    private func row(_ build: Build) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: symbol(build))
                    .foregroundStyle(tint(build))
                Text(build.repoName)
                    .font(.body.weight(.semibold))
                Text(build.verdict)
                    .font(.caption)
                    .foregroundStyle(tint(build))
                Spacer(minLength: 0)
                if build.branch != nil {
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                }
            }

            Text(build.branch ?? "no branch")
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(1)

            if let task = build.task, !task.isEmpty {
                Text(task).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }

            Text(subtitle(build))
                .font(.caption)
                .foregroundStyle(.secondary)

            // The commands, in the order they happened, with the verdict the tool reported.
            // Scrolling horizontally rather than wrapping keeps a long loop from pushing every
            // other row off the screen.
            if !build.commands.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(build.commands.enumerated()), id: \.offset) { _, command in
                            Text("\(command.name): \(command.verdict)")
                                .font(.caption2)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(.quaternary, in: Capsule())
                        }
                    }
                }
            }
        }
    }

    private func symbol(_ build: Build) -> String {
        guard let ok = build.ok else { return "circle.dashed" }
        return ok ? "checkmark.circle.fill" : "xmark.circle.fill"
    }

    private func tint(_ build: Build) -> Color {
        guard let ok = build.ok else { return .secondary }
        return ok ? .green : .red
    }

    private func subtitle(_ build: Build) -> String {
        var parts = ["run #\(build.runID)", SpineDate.relative(build.started)]
        if build.commits > 0 { parts.append("\(build.commits) commit\(build.commits == 1 ? "" : "s")") }
        if !build.files.isEmpty { parts.append("\(build.files.count) file\(build.files.count == 1 ? "" : "s") written") }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        do {
            builds = try await APIClient.shared.builds()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }
}

/// The diff, as the branch against its merge-base with the default branch.
///
/// Committed and uncommitted changes are shown as separate sections rather than merged,
/// because the difference between them is most of what a reviewer is checking.
private struct DiffSheet: View {
    @Environment(\.dismiss) private var dismiss
    let build: Build
    @State private var diff: BuildDiff?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                if let diff {
                    VStack(alignment: .leading, spacing: 12) {
                        if let branch = diff.branch, let base = diff.base {
                            Text("\(branch) vs \(base)")
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }

                        if diff.stat.isEmpty && diff.patch.isEmpty {
                            Text("Nothing committed on this branch.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        } else {
                            if !diff.stat.isEmpty {
                                Text(diff.stat).font(.caption2.monospaced())
                            }
                            Text(diff.patch).font(.caption2.monospaced()).textSelection(.enabled)
                        }

                        if !diff.uncommitted.isEmpty {
                            Divider()
                            Text("Still uncommitted in \(diff.repo)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.orange)
                            Text(diff.uncommitted).font(.caption2.monospaced()).textSelection(.enabled)
                        }

                        // git diff cannot see these, so they would otherwise be invisible here
                        // while sitting in the working tree.
                        if !diff.untracked.isEmpty {
                            Divider()
                            Text("Not tracked by git at all (\(diff.untracked.count))")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.orange)
                            Text(diff.untracked.joined(separator: "\n"))
                                .font(.caption2.monospaced())
                                .textSelection(.enabled)
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
            .navigationTitle(build.repoName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                do {
                    diff = try await APIClient.shared.buildDiff(build.runID)
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
    }
}
