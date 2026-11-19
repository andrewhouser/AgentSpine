import AppKit
import SwiftUI

/// Pending approvals for the menu bar. The phone gets these from its thread; the menu bar has
/// no thread open, so it asks the confirmation queue directly. Approve and Reject go through
/// `AppState.answer`, the same path as the thread's card — nothing new can write.
@MainActor
@Observable
final class MacApprovalWatcher {
    private(set) var pending: [Confirmation] = []
    private var polling = false
    /// Approvals already seen, so a notification fires once per approval. The first answer after
    /// launch only seeds this: whatever was already waiting when the app opened is not news.
    private var seen: Set<Int> = []
    private var seeded = false

    func refresh() async {
        guard Settings.shared.isConfigured else {
            pending = []
            return
        }
        if let fresh = try? await APIClient.shared.confirmations(state: "pending") {
            let waiting = fresh.filter(\.isPending)
            let unseen = waiting.filter { !seen.contains($0.id) }
            seen.formUnion(waiting.map(\.id))
            pending = waiting
            if seeded {
                for confirmation in unseen { await MacNotifier.shared.approvalWaiting(confirmation) }
            }
            seeded = true
            await MacNotifier.shared.retire(keeping: Set(waiting.map(\.id)))
        }
    }

    /// Re-ask every 30 seconds while the app runs, so the count in the menu bar is not stale.
    /// One loop only, however many times the label appears.
    func startPolling(_ state: AppState) async {
        guard !polling else { return }
        polling = true
        defer { polling = false }
        while !Task.isCancelled {
            await refresh()
            await state.refreshConversations()
            try? await Task.sleep(for: .seconds(30))
        }
    }

    func drop(_ id: Int) { pending.removeAll { $0.id == id } }
}

/// The icon in the menu bar: the thread glyph, and a count when something is waiting on you.
struct MacMenuBarLabel: View {
    @Environment(AppState.self) private var state
    @Environment(MacApprovalWatcher.self) private var watcher

    private let recorder = MacRecorder.shared
    private var waiting: Int { max(state.waitingThreads, watcher.pending.count) }

    var body: some View {
        HStack(spacing: 3) {
            if recorder.isRecording {
                // Static on purpose. The menu bar draws this label as a status item, and a
                // TimelineView in it (a ticking clock) is a known way to hang the app. The
                // clock lives in the panel that opens from the icon. It is a template image
                // too, so colour would not show: a distinct glyph says "recording".
                Image(systemName: "record.circle.fill")
            } else {
                Image(systemName: waiting > 0 ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.and.text.bubble.right")
                if waiting > 0 { Text("\(waiting)") }
            }
        }
        .task { await watcher.startPolling(state) }
    }
}

/// What opens from the icon: a line to start a thread, the approvals waiting, and the threads
/// with something for you.
struct MacMenuBarContent: View {
    @Environment(AppState.self) private var state
    @Environment(Settings.self) private var settings
    @Environment(MacApprovalWatcher.self) private var watcher
    @Environment(MacThreadHub.self) private var hub
    @Environment(\.openWindow) private var openWindow

    @State private var draft = ""
    @State private var sending = false
    @State private var error: String?
    @State private var answering: Set<Int> = []
    @State private var viewID = UUID()

    private var waitingThreads: [Conversation] {
        let asking = Set(watcher.pending.compactMap(\.conversationID))
        return state.conversations.filter { $0.needsYou && !asking.contains($0.id) }.prefix(5).map { $0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.md) {
            if !settings.isConfigured {
                Text("Add the server address and token in Settings (⌘,).")
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(Spine.Palette.textDim)
            } else {
                MacRecordingPanel()
                capture
                if let error {
                    Text(error)
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.danger)
                }
                if !watcher.pending.isEmpty {
                    section("Approvals waiting") {
                        ForEach(watcher.pending) { approval in approvalRow(approval) }
                    }
                }
                if !waitingThreads.isEmpty {
                    section("Threads") {
                        ForEach(waitingThreads) { thread in
                            Button { open(thread.id) } label: {
                                HStack(spacing: Spine.Space.sm) {
                                    AttentionDot()
                                    Text(thread.displayTitle).lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if watcher.pending.isEmpty && waitingThreads.isEmpty {
                    Text("Nothing is waiting on you.")
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(Spine.Palette.textDim)
                }
            }
            Divider()
            HStack {
                Button("Open AgentSpine") { showMainWindow() }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
            .buttonStyle(.plain)
            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
            .foregroundStyle(Spine.Palette.textDim)
        }
        .padding(Spine.Space.md)
        .frame(width: 340)
        .task { await watcher.refresh() }
    }

    // MARK: - Pieces

    private var capture: some View {
        HStack(spacing: Spine.Space.sm) {
            TextField("Start a thread…", text: $draft)
                .textFieldStyle(.roundedBorder)
                .onSubmit { Task { await send() } }
                .disabled(sending)
            if sending { ProgressView().controlSize(.small) }
        }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            Text(title.uppercased())
                .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(.semibold))
                .foregroundStyle(Spine.Palette.textFaint)
            content()
        }
    }

    private func approvalRow(_ approval: Confirmation) -> some View {
        VStack(alignment: .leading, spacing: Spine.Space.xs) {
            Text(approval.summary)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.text)
                .lineLimit(3)
            HStack(spacing: Spine.Space.sm) {
                Text(approval.tool)
                    .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textDim)
                Spacer(minLength: 0)
                if let id = approval.conversationID {
                    Button("Open") { open(id) }.buttonStyle(.link)
                }
                Button("Reject") { Task { await decide(approval, approve: false) } }
                Button("Approve") { Task { await decide(approval, approve: true) } }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.small)
            .disabled(answering.contains(approval.id))
        }
        .padding(Spine.Space.sm)
        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
    }

    // MARK: - Actions

    private func send() async {
        let task = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty, !sending else { return }
        sending = true
        defer { sending = false }
        if let id = await state.startThread(task: task) {
            draft = ""
            error = nil
            open(id)
        } else {
            error = state.loadError ?? "Could not start the thread."
        }
    }

    private func decide(_ approval: Confirmation, approve: Bool) async {
        answering.insert(approval.id)
        defer { answering.remove(approval.id) }
        do {
            try await state.answer(approval, approve: approve)
            watcher.drop(approval.id)
            if let thread = approval.conversationID { hub.nudge(thread, from: viewID) }
            error = nil
            await watcher.refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// A thread opens in its own window, which brings the app forward.
    private func open(_ id: Int) {
        openWindow(id: "thread", value: id)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func showMainWindow() {
        openWindow(id: "main")
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
