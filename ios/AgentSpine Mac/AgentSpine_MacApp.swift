import SwiftUI

@main
struct AgentSpine_MacApp: App {
    @State private var state = AppState()
    @State private var hub = MacThreadHub()
    @State private var watcher = MacApprovalWatcher()

    init() {
        SpineFont.registerBundled()
        MacNotifier.shared.install()
    }

    var body: some Scene {
        WindowGroup(id: "main") {
            MacRootView()
                .environment(state)
                .environment(hub)
                .environment(Settings.shared)
                .tint(Spine.Palette.accent)
                .frame(minWidth: 900, minHeight: 560)
        }
        // First launch only: after that macOS restores each window's own size and place, and
        // full screen works as for any window.
        .defaultSize(width: 1200, height: 780)
        .commands {
            MacGoCommands()
            CommandGroup(after: .newItem) {
                Button("Refresh") { Task { await state.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }

        // The menu bar: what is waiting on you, a line to start a thread, and Approve / Reject.
        MenuBarExtra {
            MacMenuBarContent()
                .environment(state)
                .environment(hub)
                .environment(watcher)
                .environment(Settings.shared)
                .tint(Spine.Palette.accent)
        } label: {
            MacMenuBarLabel()
                .environment(state)
                .environment(watcher)
        }
        .menuBarExtraStyle(.window)

        // A thread in a window of its own, opened from the list's context menu. Keyed by the
        // conversation id, so asking for the same thread again brings its window forward.
        WindowGroup("Thread", id: "thread", for: Int.self) { $id in
            if let id {
                MacThreadDetail(conversationID: id)
                    .environment(state)
                    .environment(hub)
                    .environment(Settings.shared)
                    .tint(Spine.Palette.accent)
                    .frame(minWidth: 480, minHeight: 420)
            }
        }
        .defaultSize(width: 720, height: 700)

        // Our own `Settings` class (the server address and token) shadows SwiftUI's scene of
        // the same name, so the scene is spelled out.
        SwiftUI.Settings {
            MacSettingsView()
                .environment(state)
                .environment(Settings.shared)
                .tint(Spine.Palette.accent)
        }
    }
}
