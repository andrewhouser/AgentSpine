import SwiftUI

/// The message box under a thread. Return sends, Shift-Return starts a new line, as in a chat.
struct MacComposer: View {
    @Binding var draft: String
    var placeholder = "Message"
    var isBusy = false
    var isDisabled = false
    var error: String?
    let send: () -> Void

    @FocusState private var focused: Bool

    private var canSend: Bool {
        !isBusy && !isDisabled && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            if let error {
                Text(error)
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.danger)
            }
            HStack(alignment: .bottom, spacing: Spine.Space.sm) {
                TextField(placeholder, text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body))
                    .focused($focused)
                    .onSubmit { if canSend { send() } }
                    .padding(.horizontal, Spine.Space.md)
                    .padding(.vertical, Spine.Space.sm + 2)
                    .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.lg))
                    .overlay(RoundedRectangle(cornerRadius: Spine.Radius.lg).strokeBorder(Spine.Palette.borderStrong, lineWidth: 0.5))

                Button(action: send) {
                    if isBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 26))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSend ? Spine.Palette.accent : Spine.Palette.textFaint)
                .disabled(!canSend)
                .help("Send (Return)")
                .accessibilityLabel("Send")
            }
        }
        .padding(Spine.Space.md)
        .background(Spine.Palette.bg)
        .onAppear { focused = true }
    }
}
