import SwiftUI

@main
struct AgentSpine_MacApp: App {
    @State private var state = AppState()
    @State private var hub = MacThreadHub()

    init() { SpineFont.registerBundled() }

    var body: some Scene {
        WindowGroup {
            MacRootView()
                .environment(state)
                .environment(hub)
                .environment(Settings.shared)
                .tint(Spine.Palette.accent)
                .frame(minWidth: 900, minHeight: 560)
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("Refresh") { Task { await state.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }

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
