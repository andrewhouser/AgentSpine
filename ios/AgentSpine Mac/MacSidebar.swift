import SwiftUI

/// What a sidebar row selects: one of the sections, or one thread. Threads live in the sidebar
/// under the sections, as in the design, so a single selection covers both.
enum MacSidebarItem: Hashable {
    case section(MacSection)
    case thread(Int)
}

/// The Mac sidebar from `docs/archive/PLAN-native-apps-and-ui-refresh.md` ("Mac layout"): a new-thread
/// button, search, the sections, recent threads, and the connection status at the foot.
struct MacSidebar: View {
    @Binding var selection: MacSidebarItem?
    let newThread: () -> Void
    let search: () -> Void

    @Environment(AppState.self) private var state
    @Environment(Settings.self) private var settings
    @Environment(\.openWindow) private var openWindow
    @AppStorage("sidebarMoreExpanded") private var moreExpanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var prompt: ThreadPrompt?
    @State private var newTitle = ""

    /// Rename and delete share one alert: two alert modifiers on one view do not both fire reliably.
    private enum ThreadPrompt: Identifiable {
        case delete(Conversation)
        case rename(Conversation)

        var conversation: Conversation {
            switch self {
            case .delete(let c), .rename(let c): return c
            }
        }

        var id: String {
            switch self {
            case .delete(let c): return "delete-\(c.id)"
            case .rename(let c): return "rename-\(c.id)"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            List(selection: $selection) {
                Section {
                    ForEach(MacSection.primary, id: \.self) { sectionRow($0) }
                    DisclosureGroup(isExpanded: $moreExpanded) {
                        ForEach(MacSection.more, id: \.self) { sectionRow($0) }
                    } label: {
                        // The whole word toggles, not just the chevron: a plain string label
                        // only answers to the arrow (seen in the running app).
                        Text("More")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                            .onTapGesture { withAnimation(reduceMotion ? nil : .default) { moreExpanded.toggle() } }
                            .accessibilityAddTraits(.isButton)
                    }
                }
                Section("Threads") { threadRows }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            // The Delete key on the selected thread asks first, like the menu item.
            .onDeleteCommand {
                if case .thread(let id) = selection, let c = state.conversations.first(where: { $0.id == id }) {
                    prompt = .delete(c)
                }
            }
            ConnectionFooter()
        }
        .background(Spine.Palette.bgSidebar)
        .alert(
            alertTitle,
            isPresented: Binding(get: { prompt != nil }, set: { if !$0 { prompt = nil } }),
            presenting: prompt
        ) { prompt in
            switch prompt {
            case .delete(let conversation):
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) {
                    Task {
                        try? await APIClient.shared.delete(conversation: conversation.id)
                        if selection == .thread(conversation.id) { selection = nil }
                        await state.refresh()
                    }
                }
            case .rename(let conversation):
                TextField("Title", text: $newTitle)
                Button("Cancel", role: .cancel) {}
                Button("Save") {
                    let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !title.isEmpty else { return }
                    Task {
                        try? await APIClient.shared.rename(conversation.id, to: title)
                        await state.refresh()
                    }
                }
            }
        } message: { prompt in
            switch prompt {
            case .delete:
                Text("The turns, the tool calls and any photographs you sent are removed from the server. This cannot be undone. Archiving keeps all of it.")
            case .rename:
                Text("The auto-titler names a thread from its first turn. This replaces it.")
            }
        }
    }

    private var alertTitle: String {
        switch prompt {
        case .delete: return "Delete this thread?"
        case .rename: return "Rename thread"
        case nil: return ""
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: Spine.Space.sm) {
            HStack(spacing: Spine.Space.sm) {
                SpineMark()
                    .fill(Spine.Palette.accent)
                    .frame(width: 10, height: 26)
                    .accessibilityHidden(true)
                Text("AgentSpine")
                    .font(SpineFont.display(Spine.TypeSize.title3, relativeTo: .title3))
                    .foregroundStyle(Spine.Palette.text)
                Spacer(minLength: 0)
            }
            .padding(.bottom, Spine.Space.xs)

            Button(action: newThread) {
                HStack {
                    Label("New thread", systemImage: "plus")
                    Spacer()
                    Text("⌘N").font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption)).opacity(0.7)
                }
                .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
                // Accent ground, page-coloured text: readable in both themes, as in the design.
                .foregroundStyle(Spine.Palette.bg)
                .padding(.horizontal, Spine.Space.md)
                .padding(.vertical, Spine.Space.sm)
                .background(Spine.Palette.accent, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
            }
            .buttonStyle(.plain)
            .keyboardShortcut("n", modifiers: .command)
            .disabled(!settings.isConfigured)
            .help("New thread (⌘N)")

            Button(action: search) {
                HStack {
                    Label("Search threads", systemImage: "magnifyingglass")
                    Spacer()
                    Text("⌘K").font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                }
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)
                .padding(.horizontal, Spine.Space.md)
                .padding(.vertical, Spine.Space.sm)
                .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
                .overlay(RoundedRectangle(cornerRadius: Spine.Radius.md).strokeBorder(Spine.Palette.border))
            }
            .buttonStyle(.plain)
            .keyboardShortcut("k", modifiers: .command)
            .disabled(!settings.isConfigured)
            .help("Search threads (⌘K)")
        }
        .padding(.horizontal, Spine.Space.md)
        .padding(.top, Spine.Space.md)
        .padding(.bottom, Spine.Space.sm)
    }

    // MARK: Rows

    private func sectionRow(_ item: MacSection) -> some View {
        // `.tag` goes last. With `.badge` applied after it the List cannot see the tag, so the
        // row is not selectable and a click does nothing (reproduced in the running app).
        Label(item.title, systemImage: item.symbol)
            .badge(count(for: item))
            .tag(MacSidebarItem.section(item))
    }

    /// Zero hides a badge. Builds has none: "a build" is a view over the actions log with no
    /// cheap count that means anything.
    private func count(for item: MacSection) -> Int {
        switch item {
        case .headsup: return state.headsupWaiting
        case .tasks: return state.openTaskCount ?? 0
        case .schedules: return state.scheduleCount ?? 0
        default: return 0
        }
    }

    @ViewBuilder private var threadRows: some View {
        if !settings.isConfigured {
            Text("Add your server in Settings (⌘,).")
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
            SettingsLink { Text("Open Settings…") }
                .buttonStyle(.link)
        } else if let error = state.loadError, state.conversations.isEmpty {
            Text(error)
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
            Button("Try again") { Task { await state.refresh() } }
                .buttonStyle(.link)
        } else if state.conversations.isEmpty && state.lastLoaded != nil {
            Text("No threads yet. Start one and it shows up here.")
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
        } else {
            ForEach(state.conversations) { conversation in
                threadRow(conversation)
                    .tag(MacSidebarItem.thread(conversation.id))
                    .contextMenu {
                        Button("Open in New Window") { openWindow(id: "thread", value: conversation.id) }
                        Divider()
                        Button("Rename…") {
                            newTitle = conversation.title ?? ""
                            prompt = .rename(conversation)
                        }
                        Button("Archive") {
                            Task {
                                try? await APIClient.shared.archive(conversation.id)
                                if selection == .thread(conversation.id) { selection = nil }
                                await state.refresh()
                            }
                        }
                        Button("Delete…", role: .destructive) { prompt = .delete(conversation) }
                    }
            }
        }
    }

    private func threadRow(_ conversation: Conversation) -> some View {
        HStack(spacing: Spine.Space.sm) {
            // Hollow amber: a question is waiting on you. Solid accent: a reply you have not
            // read. A shape difference as well as a colour one, as on the phone.
            Group {
                if conversation.isWaiting {
                    AttentionDot()
                } else if conversation.isUnread {
                    Circle().fill(Spine.Palette.accent).frame(width: 8, height: 8)
                        .accessibilityLabel("Unread reply")
                } else {
                    Color.clear.frame(width: 8, height: 8)
                }
            }
            Text(conversation.displayTitle)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)
                    .weight(conversation.needsYou ? .semibold : .regular))
                .lineLimit(1)
                .foregroundStyle(Spine.Palette.text)
            Spacer(minLength: Spine.Space.xs)
            Text(SpineDate.relative(conversation.updated))
                .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textFaint)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The foot of the sidebar: whether the server answers, how long it took, and where it is.
///
/// The first line is the *server's* round trip (`/api/status`, the same cheapest authenticated
/// route the Settings test uses). Under it, the model host as the server sees it: `/api/status`
/// carries a cached probe of the host, so this app never talks to the model host itself.
private struct ConnectionFooter: View {
    @Environment(AppState.self) private var state
    @Environment(Settings.self) private var settings
    @Environment(\.scenePhase) private var scenePhase

    @State private var reachable: Bool?
    @State private var milliseconds: Int?
    @State private var modelHost: ModelHostStatus?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Circle().fill(dotColor).frame(width: 8, height: 8)
                Text(label)
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textDim)
                Spacer()
                if reachable == true, let milliseconds {
                    Text("\(milliseconds) ms")
                        .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                }
            }
            if reachable == true, let modelHost {
                HStack(spacing: 6) {
                    Circle().fill(modelHost.ok ? Spine.Palette.ok : Spine.Palette.attention).frame(width: 8, height: 8)
                    Text(modelHost.ok ? "Model host connected" : "Model host not answering")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)
                    Spacer()
                    if modelHost.ok, let ms = modelHost.ms {
                        Text("\(ms) ms")
                            .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textFaint)
                    }
                }
            }
            if let host = settings.baseURL?.host {
                Text(host)
                    .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textFaint)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.horizontal, Spine.Space.md)
        .padding(.vertical, Spine.Space.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .combine)
        // Restarts when the address, the token or the window's activity changes; it is cancelled
        // with the view, so a background window does not keep polling.
        .task(id: "\(settings.rawBaseURL)|\(settings.token)|\(scenePhase == .active)") {
            guard settings.isConfigured, scenePhase == .active else { reachable = nil; return }
            while !Task.isCancelled {
                await probe()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    private var label: String {
        switch reachable {
        case .some(true): return "Server connected"
        case .some(false): return "Can't reach server"
        case .none: return settings.isConfigured ? "Checking…" : "Not connected"
        }
    }

    private var dotColor: Color {
        switch reachable {
        case .some(true): return Spine.Palette.ok
        case .some(false): return Spine.Palette.attention
        case .none: return Spine.Palette.textFaint
        }
    }

    private func probe() async {
        let start = ContinuousClock.now
        do {
            let status = try await APIClient.shared.status()
            state.openTaskCount = status.tasks
            state.scheduleCount = status.schedules
            state.cloud = status.cloud
            modelHost = status.model
            let elapsed = start.duration(to: .now).components
            milliseconds = Int(elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000)
            reachable = true
        } catch {
            // URLSession reports a cancelled request as URLError, not CancellationError, so ask
            // the task: a window going inactive must not flash "Can't reach server".
            if Task.isCancelled { return }
            reachable = false
        }
    }
}
