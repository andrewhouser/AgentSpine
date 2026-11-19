import SwiftUI

@main
struct AgentSpineApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var state = AppState()
    @State private var reader = ReadAloud()

    init() {
        SpineFont.registerBundled()
        // Categories before permission, so a notification arriving in the same second as the
        // grant already knows which buttons it has.
        PushManager.shared.configure()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .tint(Spine.Palette.accent)
                .environment(state)
                .environment(Settings.shared)
                .environment(PushManager.shared)
                .environment(reader)
        }
    }
}
