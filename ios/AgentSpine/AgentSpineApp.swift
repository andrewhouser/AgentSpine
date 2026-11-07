import SwiftUI

@main
struct AgentSpineApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var state = AppState()

    init() {
        // Categories before permission, so a notification arriving in the same second as the
        // grant already knows which buttons it has.
        PushManager.shared.configure()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(state)
                .environment(Settings.shared)
                .environment(PushManager.shared)
        }
    }
}
