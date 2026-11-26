import SwiftUI

/// ⌘, : two panes. Server is the address and the token; Assistant is the same list of screens the
/// phone's Settings has (recipes, auto-approval proposals, agents, Heads-up, memory, policy), so
/// nothing about the assistant can only be changed from a browser or a phone.
///
/// A segmented control rather than a `TabView`: the settings window puts tabs in its toolbar, and a
/// navigation push inside one fought them for it. Opening Recipes highlighted Server, and Back landed
/// on Server with no way to the Assistant list.
struct MacSettingsRoot: View {
    private enum Pane: String, CaseIterable {
        case server = "Server"
        case assistant = "Assistant"

        var symbol: String { self == .server ? "network" : "sparkles" }
    }

    @State private var pane: Pane = .server

    var body: some View {
        VStack(spacing: 0) {
            Picker("Settings", selection: $pane) {
                ForEach(Pane.allCases, id: \.self) { item in
                    Label(item.rawValue, systemImage: item.symbol).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .padding(.vertical, Spine.Space.md)
            Divider()
            switch pane {
            case .server: MacSettingsView()
            case .assistant: MacAssistantSettings()
            }
        }
    }
}

/// The shared phone screens, beside a sidebar that stays visible, so the way to another screen is
/// always on show. They are the same views the iPhone uses, so a change to one lands on both.
struct MacAssistantSettings: View {
    private enum Screen: String, CaseIterable, Identifiable {
        // Section 15, R3: what it may do comes first.
        case dials = "What it may do"
        case recipes = "Recipes"
        case styles = "Styles"
        case proposals = "Auto-approval proposals"
        case agents = "Agents"
        case headsup = "Heads-up"
        case memory = "Memory"
        case weeklyReview = "Weekly review"
        case cloudUsage = "Cloud usage"
        case policy = "Policy"
        case sidebarMenu = "Sidebar menu"

        var id: Self { self }

        var symbol: String {
            switch self {
            case .dials: "dial.medium"
            case .recipes: "list.bullet.rectangle"
            case .styles: "textformat"
            case .proposals: "checkmark.shield"
            case .agents: "person.2"
            case .headsup: "sparkles"
            case .memory: "brain"
            case .weeklyReview: "calendar"
            case .cloudUsage: "cloud"
            case .policy: "lock.shield"
            case .sidebarMenu: "sidebar.left"
            }
        }
    }

    @State private var selection: Screen? = .dials

    var body: some View {
        HStack(spacing: 0) {
            List(Screen.allCases, selection: $selection) { screen in
                Label(screen.rawValue, systemImage: screen.symbol).tag(screen)
            }
            .listStyle(.sidebar)
            .frame(width: 230)
            Divider()
            // A new identity per screen, so a page opened inside one doesn't stay open under the next.
            NavigationStack { detail(selection ?? .dials) }
                .id(selection)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 800, height: 560)
    }

    @ViewBuilder private func detail(_ screen: Screen) -> some View {
        switch screen {
        case .dials: DialsView()
        case .recipes: RecipesView()
        case .styles: StylesView()
        case .proposals: ProposalsView()
        case .agents: AgentsView()
        case .headsup: HeadsupPrefsView()
        case .memory: MemoryView()
        case .weeklyReview: WeeklyReviewView()
        case .cloudUsage: CloudUsageView()
        case .policy: PolicyView()
        case .sidebarMenu: MacMenuSettingsView()
        }
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
                // Stay open: closing here would report success for a token that dies at next launch.
                if let status = settings.tokenSaveError {
                    probeFailed = true
                    probe = "Connected, but the Keychain would not save the token (error \(status)). You'll need to enter it again next launch."
                    return
                }
                dismiss()
            }
        } catch {
            probeFailed = true
            probe = error.localizedDescription
        }
    }
}
