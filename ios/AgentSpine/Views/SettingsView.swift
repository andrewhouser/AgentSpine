import SwiftUI
import UIKit

/// Settings, and — more usefully — diagnostics.
///
/// Every way this setup fails is silent from the phone's side. A wrong key id, a device token
/// registered against the wrong APNs host, Time Sensitive never granted, Tailscale down on one
/// end: all of them look exactly like "AgentSpine has nothing to tell me". So this screen is
/// mostly answers to "why didn't it buzz", with the two settings at the top.
struct SettingsView: View {
    @Environment(Settings.self) private var settings
    @Environment(PushManager.self) private var push
    @Environment(AppState.self) private var state

    @State private var probe: String?
    @State private var probing = false
    @State private var pushResult: String?
    @State private var pushing = false
    @State private var devices: [RegisteredDevice] = []
    @State private var devicesError: String?
    @State private var offlineBytes = 0

    var body: some View {
        Form {
            Section {
                TextField("http://mini.tail1234.ts.net:8787", text: Binding(
                    get: { settings.rawBaseURL },
                    set: { settings.rawBaseURL = $0 }
                ))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)

                SecureField("Dashboard token", text: Binding(
                    get: { settings.token },
                    set: { settings.token = $0 }
                ))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            } header: {
                Text("Server")
            } footer: {
                Text("The Tailscale name of the machine running `npm run dashboard`, and "
                     + "DASHBOARD_TOKEN from its .env. The token is kept in the keychain.")
            }

            Section {
                Button {
                    Task { await probeConnection() }
                } label: {
                    HStack {
                        Text("Test connection")
                        Spacer()
                        if probing { ProgressView() }
                    }
                }
                .disabled(probing || !settings.isConfigured)

                if let probe {
                    Text(probe).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
                }
            } footer: {
                Text("Hits /api/status, which proves the address, the tunnel and the token at "
                     + "once.")
            }

            // MARK: Notifications

            Section {
                HStack {
                    Text("Permission")
                    Spacer()
                    Text(authorizationLabel)
                        .foregroundStyle(authorizationColor)
                }

                if push.authorization == .notDetermined {
                    Button("Allow notifications") {
                        Task { await push.requestAuthorization() }
                    }
                } else if push.authorization == .denied {
                    Button("Open iOS Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.open(url)
                        }
                    }
                }

                HStack {
                    Text("APNs host")
                    Spacer()
                    Text(PushManager.environment).foregroundStyle(Spine.Palette.textDim).monospaced()
                }

                HStack {
                    Text("Device token")
                    Spacer()
                    Text(push.deviceToken.map { "…" + $0.suffix(8) } ?? "not issued")
                        .foregroundStyle(Spine.Palette.textDim)
                        .monospaced()
                }

                if let note = push.registrationNote {
                    Text(note).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
                }

                Button {
                    Task { await sendTestPush() }
                } label: {
                    HStack {
                        Text("Send a test push")
                        Spacer()
                        if pushing { ProgressView() }
                    }
                }
                .disabled(pushing || !settings.isConfigured)

                if let pushResult {
                    Text(pushResult).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
                }
            } header: {
                Text("Notifications")
            } footer: {
                // The one step of this whole setup that cannot be done from code, so it is
                // spelled out rather than left to be discovered on a quiet afternoon.
                Text("For an approval to break through a Focus mode, also turn on Settings → "
                     + "Notifications → AgentSpine → Time Sensitive Notifications.")
            }

            Section {
                NavigationLink("Tab bar") { TabBarSettingsView() }
            } header: {
                Text("Appearance")
            } footer: {
                Text("Choose which sections sit in the bar and which fold under More.")
            }

            Section {
                // Section 15, R3: what it may do comes first.
                NavigationLink("What it may do") { DialsView() }
                NavigationLink("Auto-approval proposals") { ProposalsView() }
                NavigationLink("Recipes") { RecipesView() }
                NavigationLink("Styles") { StylesView() }
                NavigationLink("Agents") { AgentsView() }
                NavigationLink("Heads-up") { HeadsupPrefsView() }
                // Projects and Memory were tabs until the 2026-11-27 menu review (section 15, R12).
                NavigationLink("Projects") { ProjectsView() }
                NavigationLink("Memory") { MemoryView() }
                NavigationLink("Weekly review") { WeeklyReviewView() }
                NavigationLink("Cloud usage") { CloudUsageView() }
                NavigationLink("Policy") { PolicyView() }
            } header: {
                Text("Assistant")
            }
            Section {
                ForEach(devices) { device in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(device.name ?? "Unnamed device")
                        Text("\(device.environment) · …\(device.token.suffix(8)) · seen "
                             + SpineDate.relative(device.seen))
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim).monospaced()
                        if let disabled = device.disabled {
                            Text("Disabled: \(device.detail ?? disabled)")
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.warn)
                        }
                    }
                    .swipeActions {
                        Button("Forget", role: .destructive) {
                            Task { await forget(device) }
                        }
                    }
                }
                if let devicesError {
                    Text(devicesError).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
                } else if devices.isEmpty {
                    Text("No devices registered").font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
                }
            } header: {
                Text("Registered devices")
            } footer: {
                Text("Swipe to forget. After a restore or reinstall the server keeps the old "
                     + "token until you clear it here.")
            }
            Section {
                TextField(UIDevice.current.name, text: Binding(
                    get: { settings.deviceName },
                    set: { settings.deviceName = $0 }
                ))
            } header: {
                Text("This device's name")
            } footer: {
                Text("How this phone appears in the server's device list. Re-register with "
                     + "the test button above after changing it.")
            }

            Section {
                HStack {
                    Text("Saved on this phone")
                    Spacer()
                    Text(ByteCountFormatter.string(fromByteCount: Int64(offlineBytes), countStyle: .file))
                        .foregroundStyle(Spine.Palette.textDim)
                }
                Button("Delete offline copy", role: .destructive) {
                    state.deleteOfflineCopy()
                    offlineBytes = OfflineCache.shared.totalBytes
                }
                .disabled(offlineBytes == 0)
            } header: {
                Text("Offline copy")
            } footer: {
                Text("Threads, tasks, files and runs you opened, for reading when the server can't be reached. "
                     + "Encrypted, locked with the phone, left out of backups, and removed after 14 days.")
            }
            .task { offlineBytes = OfflineCache.shared.totalBytes }

            Section {
                if let loaded = state.lastLoaded {
                    HStack {
                        Text("Last loaded")
                        Spacer()
                        Text(SpineDate.relative(ISO8601DateFormatter().string(from: loaded)))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                }
                Button("Reload everything") {
                    Task { await state.refresh() }
                }
            }
        }
        .navigationTitle("Settings")
        .task { await loadDevices() }
        .onChange(of: settings.isConfigured) { _, configured in
            // Nothing loads here when this turns true: that happens on the first typed character, so it sent a
            // one-character token to the server. A passing connection test does the loading instead.
            guard !configured else { return }
            // No server or token any more is this app's sign-out, so the private copy goes now, not at next launch.
            state.deleteOfflineCopy()
            offlineBytes = OfflineCache.shared.totalBytes
        }
    }

    private var authorizationLabel: String {
        switch push.authorization {
        case .authorized: return "allowed"
        case .denied: return "denied"
        case .provisional: return "quiet delivery"
        case .ephemeral: return "ephemeral"
        case .notDetermined: return "not asked"
        @unknown default: return "unknown"
        }
    }

    private var authorizationColor: Color {
        switch push.authorization {
        case .authorized: return Spine.Palette.ok
        case .denied: return Spine.Palette.danger
        default: return Spine.Palette.warn
        }
    }

    private func probeConnection() async {
        probing = true
        defer { probing = false }
        do {
            let status = try await APIClient.shared.status()
            let depth = status.queue?.depth ?? 0
            probe = "Connected. \(status.schedules ?? 0) schedule(s), "
                + "\(depth) run(s) queued."
            // A working connection is also the first chance to hand over a push token, which may already have been
            // issued and discarded for want of somewhere to send it.
            push.registerIfAuthorized()
            await state.refresh()
            await loadDevices()
            offlineBytes = OfflineCache.shared.totalBytes
        } catch {
            probe = error.localizedDescription
        }
    }

    private func loadDevices() async {
        guard settings.isConfigured else { return }
        do {
            devices = try await APIClient.shared.devices()
            devicesError = nil
        } catch {
            devicesError = error.localizedDescription
        }
    }

    private func forget(_ device: RegisteredDevice) async {
        do {
            try await APIClient.shared.forgetDevice(device.id)
            devices.removeAll { $0.id == device.id }
        } catch {
            devicesError = error.localizedDescription
        }
    }

    private func sendTestPush() async {
        pushing = true
        defer { pushing = false }
        do {
            let result = try await APIClient.shared.testPush()
            pushResult = result.detail
        } catch {
            pushResult = error.localizedDescription
        }
    }
}

/// `UIApplication.shared.open` needs a main-actor hop from a `Task`; wrapping it keeps the
/// call site readable.
private extension UIApplication {
    static func open(_ url: URL) {
        Task { @MainActor in UIApplication.shared.open(url) }
    }
}
