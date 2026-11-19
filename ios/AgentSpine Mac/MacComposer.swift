import SwiftUI
import UniformTypeIdentifiers

/// The message box under a thread. Return sends, Shift-Return starts a new line, as in a chat.
struct MacComposer: View {
    @Binding var draft: String
    var placeholder = "Message"
    var isBusy = false
    var isDisabled = false
    var error: String?
    /// Images already uploaded and waiting to go with the next message.
    var staged: [Attachment] = []
    /// Uploads in flight, so three dropped files show three placeholders and Send waits.
    var uploading = 0
    /// Files chosen with the button or dropped on the box. The thread view uploads them.
    var attach: ([URL]) -> Void = { _ in }
    var removeStaged: (Attachment) -> Void = { _ in }
    let send: () -> Void

    @State private var choosing = false
    @State private var dropTargeted = false

    @FocusState private var focused: Bool

    private var canSend: Bool {
        let hasText = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return !isBusy && !isDisabled && uploading == 0 && (hasText || !staged.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            if let error {
                Text(error)
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.danger)
            }
            if !staged.isEmpty || uploading > 0 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Spine.Space.sm) {
                        ForEach(staged) { attachment in
                            MacAttachmentImage(attachment: attachment, size: 64)
                                .overlay(alignment: .topTrailing) {
                                    Button { removeStaged(attachment) } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .symbolRenderingMode(.palette)
                                            .foregroundStyle(.white, .black.opacity(0.6))
                                    }
                                    .buttonStyle(.plain)
                                    .padding(3)
                                    .accessibilityLabel("Remove image")
                                }
                        }
                        ForEach(0..<uploading, id: \.self) { _ in
                            ProgressView().controlSize(.small)
                                .frame(width: 64, height: 64)
                                .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: Spine.Space.sm) {
                Button { choosing = true } label: {
                    Image(systemName: "photo.on.rectangle.angled").font(.system(size: 20))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Spine.Palette.textDim)
                .disabled(isDisabled)
                .help("Attach images")
                .accessibilityLabel("Attach images")

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
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: Spine.Radius.lg)
                    .strokeBorder(Spine.Palette.accent, style: StrokeStyle(lineWidth: 2, dash: [6]))
                    .padding(4)
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard !isDisabled else { return false }
            attach(urls.filter(\.isFileURL))
            return true
        } isTargeted: { dropTargeted = $0 }
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { attach(urls) }
        }
        .onAppear { focused = true }
    }
}
