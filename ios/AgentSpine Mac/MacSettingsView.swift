import SwiftUI

/// ⌘, : the server address and the dashboard token. The address is a preference in
/// `UserDefaults`; the token goes to the Keychain through `Settings`, as on the phone.
struct MacSettingsView: View {
    @Environment(Settings.self) private var settings
    @Environment(AppState.self) private var state

    @State private var probe: String?
    @State private var probing = false

    var body: some View {
        Form {
            Section {
                TextField("Address", text: Binding(
                    get: { settings.rawBaseURL },
                    set: { settings.rawBaseURL = $0 }
                ), prompt: Text("http://mini.tail1234.ts.net:8787"))
                .autocorrectionDisabled()

                SecureField("Dashboard token", text: Binding(
                    get: { settings.token },
                    set: { settings.token = $0 }
                ))
            } header: {
                Text("Server")
            } footer: {
                Text("The token is stored in your Keychain, not in the app's preferences.")
            }

            Section {
                HStack {
                    Button("Test connection") { Task { await probeConnection() } }
                        .disabled(probing || !settings.isConfigured)
                    if probing { ProgressView().controlSize(.small) }
                }
                if let probe {
                    Text(probe)
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(Spine.Palette.textDim)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func probeConnection() async {
        probing = true
        defer { probing = false }
        do {
            let status = try await APIClient.shared.status()
            probe = "Connected. \(status.schedules ?? 0) schedule(s), \(status.queue?.depth ?? 0) run(s) queued."
            await state.refresh()
        } catch {
            probe = error.localizedDescription
        }
    }
}
