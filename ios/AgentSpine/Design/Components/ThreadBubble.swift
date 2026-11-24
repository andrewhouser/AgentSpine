import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// What you said, as a bubble on the right of the thread.
///
/// The assistant's side is deliberately not a bubble: its turn hangs on the spine (`SpineRow`)
/// and reads as plain text, so the eye can tell your words from the agent's work at a glance.
/// Both `TurnView` and `LiveTurnView` draw this, so a finished turn and a streaming one cannot
/// drift apart.
///
/// ## Actions on your message
///
/// Copy, and, when the caller offers them, Edit and resend and Retry. On the Mac they appear in a
/// row under the bubble when the pointer is over the message, with the time it was sent; on the
/// phone, which has no hover, they are the long-press menu. Both are in the context menu on both
/// platforms, so the Mac has a right-click route too.
///
/// Retry and Edit both add a NEW turn: the earlier reply, its tool calls and its audit rows stay,
/// because the ledger is append-only. The caller withholds them when they cannot work, notably for
/// a message that carried images, since an image binds to one run only once.
struct ThreadBubble: View {
    let text: String
    /// When it was sent. Shown in the hover row on the Mac; the phone's turn footer carries the
    /// time already, so it is not repeated here.
    var sentAt: Date?
    /// Put the text back in the composer to change it. Nil hides the action.
    var onEdit: (() -> Void)?
    /// Send the same text again as a new turn. Nil hides the action.
    var onRetry: (() -> Void)?

    @State private var copied = false
    #if os(macOS)
    @State private var hovering = false
    #endif

    /// A bubble should not span a wide Mac window edge to edge; this keeps it a message.
    private var minLeading: CGFloat {
        #if os(iOS)
        return Spine.Space.xxl
        #else
        return 120
        #endif
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            HStack(spacing: 0) {
                Spacer(minLength: minLeading)
                Text(text)
                    .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body))
                    .foregroundStyle(Spine.Palette.text)
                    // Mac only. On the phone, selection also claims the long press, so the menu
                    // below never opened; its Copy covers the message there.
                    #if os(macOS)
                    .textSelection(.enabled)
                    #endif
                    .padding(.horizontal, Spine.Space.md + 2)
                    .padding(.vertical, Spine.Space.sm + 2)
                    .background(Spine.Palette.accentSoft, in: RoundedRectangle(cornerRadius: Spine.Radius.lg))
                    .overlay(
                        RoundedRectangle(cornerRadius: Spine.Radius.lg)
                            .strokeBorder(Spine.Palette.accentLine, lineWidth: 0.5)
                    )
                    .contextMenu { menu }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("You said: \(text)")

            #if os(macOS)
            actionRow
            #endif
        }
        #if os(macOS)
        .onHover { hovering = $0 }
        #endif
    }

    @ViewBuilder private var menu: some View {
        if let onEdit {
            Button { onEdit() } label: { Label("Edit and resend", systemImage: "pencil") }
        }
        if let onRetry {
            Button { onRetry() } label: { Label("Retry", systemImage: "arrow.counterclockwise") }
        }
        Button { copy() } label: { Label("Copy", systemImage: "doc.on.doc") }
    }

    #if os(macOS)
    /// Always laid out and only faded, so revealing it never nudges the reply below.
    private var actionRow: some View {
        HStack(spacing: 2) {
            if let sentAt {
                Text(MessageTime.label(from: sentAt))
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textFaint)
                    .padding(.trailing, 6)
            }
            if let onEdit { iconButton("pencil", label: "Edit and resend", action: onEdit) }
            if let onRetry { iconButton("arrow.counterclockwise", label: "Retry", action: onRetry) }
            iconButton(copied ? "checkmark" : "doc.on.doc", label: copied ? "Copied" : "Copy") {
                copy()
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    copied = false
                }
            }
        }
        .opacity(hovering ? 1 : 0)
        .frame(minHeight: 26)
    }

    private func iconButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Spine.Palette.textFaint)
        .help(label)
        .accessibilityLabel(label)
    }
    #endif

    private func copy() {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}
