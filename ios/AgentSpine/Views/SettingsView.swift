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
                    Text(probe).font(.footnote).foregroundStyle(.secondary)
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
                    Text(PushManager.environment).foregroundStyle(.secondary).monospaced()
                }

                HStack {
                    Text("Device token")
                    Spacer()
                    Text(push.deviceToken.map { "…" + $0.suffix(8) } ?? "not issued")
                        .foregroundStyle(.secondary)
                        .monospaced()
                }

                if let note = push.registrationNote {
                    Text(note).font(.footnote).foregroundStyle(.secondary)
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
                    Text(pushResult).font(.footnote).foregroundStyle(.secondary)
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
                NavigationLink("Auto-approval proposals") { ProposalsView() }
                NavigationLink("Agents") { AgentsView() }
                NavigationLink("Memory") { MemoryView() }
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
                            .font(.caption).foregroundStyle(.secondary).monospaced()
                        if let disabled = device.disabled {
                            Text("Disabled: \(device.detail ?? disabled)")
                                .font(.caption).foregroundStyle(.orange)
                        }
                    }
                    .swipeActions {
                        Button("Forget", role: .destructive) {
                            Task { await forget(device) }
                        }
                    }
                }
                if let devicesError {
                    Text(devicesError).font(.footnote).foregroundStyle(.secondary)
                } else if devices.isEmpty {
                    Text("No devices registered").font(.footnote).foregroundStyle(.secondary)
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
                if let loaded = state.lastLoaded {
                    HStack {
                        Text("Last loaded")
                        Spacer()
                        Text(SpineDate.relative(ISO8601DateFormatter().string(from: loaded)))
                            .foregroundStyle(.secondary)
                    }
                }
                Button("Reload everything") {
                    Task { await state.refresh() }
                }
            }
        }
        .navigationTitle("Settings")
        .task(id: settings.isConfigured) { await loadDevices() }
        .onChange(of: settings.isConfigured) { _, configured in
            // Entering a working server for the first time is the moment to register for push
            // — the token may already have been issued and discarded for want of somewhere to
            // send it.
            guard configured else { return }
            push.registerIfAuthorized()
            Task { await state.refresh() }
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
        case .authorized: return .green
        case .denied: return .red
        default: return .orange
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
            // A working connection is also the first chance to hand over a push token.
            push.registerIfAuthorized()
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
