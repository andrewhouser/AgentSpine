import SwiftUI

@main
struct AgentSpine_MacApp: App {
    @State private var state = AppState()

    init() { SpineFont.registerBundled() }

    var body: some Scene {
        WindowGroup {
            MacRootView()
                .environment(state)
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
