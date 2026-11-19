import AppKit
import SwiftUI

/// Start a meeting recorded from this Mac's microphone. The sheet says in plain words what the
/// microphone prompt is about before macOS shows it, because a bare system prompt from an app
/// that has not explained itself is the one people refuse.
struct MacRecordSheet: View {
    let onStarted: () async -> Void
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var projectID: Int?
    @State private var error: String?
    @State private var starting = false
    private let recorder = MacRecorder.shared

    var body: some View {
        NavigationStack {
            Form {
                if let error {
                    Text(error)
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(Spine.Palette.danger)
                }
                Section {
                    switch recorder.micAccess {
                    case .granted:
                        Text("Records this Mac's microphone and sends the audio to your AgentSpine server, which transcribes it. It does not leave your network.")
                    case .undetermined:
                        Text("AgentSpine needs to hear the meeting. macOS will ask you to allow microphone access. The audio goes only to your own AgentSpine server, which transcribes it on your network.")
                    case .denied:
                        VStack(alignment: .leading, spacing: Spine.Space.sm) {
                            Text("Microphone access is turned off for AgentSpine. Turn it on in System Settings, Privacy & Security, Microphone, then come back.")
                            Button("Open System Settings") {
                                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                                    NSWorkspace.shared.open(url)
                                }
                            }
                        }
                    }
                }
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)

                Section("Title (optional)") { TextField("Title", text: $title) }
                Section("Project (optional)") {
                    Picker("Project", selection: $projectID) {
                        Text("None").tag(Int?.none)
                        ForEach(state.projects) { Text($0.name).tag(Int?.some($0.id)) }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Record from this Mac")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(recorder.micAccess == .undetermined ? "Allow and start" : "Start") {
                        Task { await start() }
                    }
                    .disabled(starting || recorder.micAccess == .denied)
                }
            }
        }
        .frame(minWidth: 440, minHeight: 380)
    }

    private func start() async {
        starting = true
        defer { starting = false }
        do {
            try await recorder.start(projectID: projectID, title: title)
            await onStarted()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
