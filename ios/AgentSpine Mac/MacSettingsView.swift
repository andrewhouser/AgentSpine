import SwiftUI

/// ⌘, : two tabs. Server is the address and the token; Assistant is the same list of screens the
/// phone's Settings has (recipes, auto-approval proposals, agents, Heads-up, memory, policy), so
/// nothing about the assistant can only be changed from a browser or a phone.
struct MacSettingsRoot: View {
    var body: some View {
        TabView {
            MacSettingsView()
                .tabItem { Label("Server", systemImage: "network") }
            MacAssistantSettings()
                .tabItem { Label("Assistant", systemImage: "sparkles") }
        }
    }
}

/// The shared phone screens, pushed inside the settings window. They are the same views the
/// iPhone uses, so a change to one lands on both.
struct MacAssistantSettings: View {
    var body: some View {
        NavigationStack {
            List {
                NavigationLink("Recipes") { RecipesView() }
                NavigationLink("Styles") { StylesView() }
                NavigationLink("Auto-approval proposals") { ProposalsView() }
                NavigationLink("Agents") { AgentsView() }
                NavigationLink("Heads-up") { HeadsupPrefsView() }
                NavigationLink("Memory") { MemoryView() }
                NavigationLink("Weekly review") { WeeklyReviewView() }
                NavigationLink("Cloud usage") { CloudUsageView() }
                NavigationLink("Policy") { PolicyView() }
            }
            .navigationTitle("Assistant")
        }
        .frame(width: 560, height: 520)
    }
}

/// The server address and the dashboard token. The address is a preference in
/// `UserDefaults`; the token goes to the Keychain through `Settings`, as on the phone.
///
/// The fields edit a draft. "Test connection" only tests the draft; "Connect" is what saves
/// it, and it closes the window once the server has answered. Editing the saved settings
/// directly made Test look like a harmless check while it was in fact connecting the app.
struct MacSettingsView: View {
    @Environment(Settings.self) private var settings
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    @State private var address = ""
    @State private var token = ""
    @State private var loaded = false
    @State private var probe: String?
    @State private var probeFailed = false
    @State private var busy = false

    /// The draft run through the same repair as the saved address.
    private var draftURL: URL? { Settings.normalizedURL(address) }

    private var draftReady: Bool { draftURL != nil && !token.isEmpty }

    var body: some View {
        Form {
            Section {
                TextField("Address", text: $address, prompt: Text("http://mini.tail1234.ts.net:8787"))
                    .autocorrectionDisabled()
                SecureField("Dashboard token", text: $token)
            } header: {
                Text("Server")
            } footer: {
                Text("The token is stored in your Keychain, not in the app's preferences.")
            }

            Section {
                HStack {
                    Button("Test connection") { Task { await run(connect: false) } }
                        .disabled(busy || !draftReady)
                    Button("Connect") { Task { await run(connect: true) } }
                        .keyboardShortcut(.defaultAction)
                        .disabled(busy || !draftReady)
                    if busy { ProgressView().controlSize(.small) }
                }
                if let probe {
                    Text(probe)
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(probeFailed ? Spine.Palette.text : Spine.Palette.textDim)
                }
            } footer: {
                Text("Test checks the address and token without saving them. Connect saves them and closes this window.")
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear {
            guard !loaded else { return }
            loaded = true
            address = settings.rawBaseURL
            token = settings.token
        }
    }

    private func run(connect: Bool) async {
        guard let url = draftURL else { return }
        busy = true
        defer { busy = false }
        do {
            let status = try await APIClient.shared.probe(baseURL: url, token: token)
            probeFailed = false
            probe = "Reached the server. \(status.schedules ?? 0) schedule(s), \(status.queue?.depth ?? 0) run(s) queued."
            if connect {
                settings.rawBaseURL = address
                settings.token = token
                await state.refresh()
                dismiss()
            }
        } catch {
            probeFailed = true
            probe = error.localizedDescription
        }
    }
}
