import SwiftUI

/// The threads, newest first as the server returns them. A dot marks one with a question
/// waiting on you or a reply you have not read, as on the phone.
struct MacThreadList: View {
    @Binding var selection: Int?

    @Environment(AppState.self) private var state
    @Environment(Settings.self) private var settings

    var body: some View {
        Group {
            if !settings.isConfigured {
                VStack(spacing: Spine.Space.md) {
                    EmptyNotice(
                        symbol: "network",
                        title: "Connect to your server",
                        detail: "Enter the server address and dashboard token in Settings."
                    )
                    SettingsLink { Text("Open Settings…") }
                }
            } else if let error = state.loadError, state.conversations.isEmpty {
                ErrorNotice(message: error) { Task { await state.refresh() } }
            } else if state.conversations.isEmpty && state.lastLoaded != nil {
                EmptyNotice(symbol: "tray", title: "No threads yet", detail: "Start one and it shows up here.")
            } else {
                List(state.conversations, selection: $selection) { conversation in
                    row(conversation).tag(conversation.id)
                }
                .scrollContentBackground(.hidden)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Spine.Palette.bgInset)
        .navigationTitle("Threads")
    }

    private func row(_ conversation: Conversation) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spine.Space.sm) {
            if conversation.needsYou {
                AttentionDot()
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.displayTitle)
                    .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(conversation.needsYou ? .semibold : .regular))
                    .lineLimit(2)
                    .foregroundStyle(Spine.Palette.text)
                HStack(spacing: 6) {
                    Text(SpineDate.relative(conversation.updated))
                    if let projectID = conversation.projectID, let name = state.projectNames[projectID] {
                        Text("·")
                        Text(name).lineLimit(1)
                    }
                }
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
