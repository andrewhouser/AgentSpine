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
struct ThreadBubble: View {
    let text: String

    /// A bubble should not span a wide Mac window edge to edge; this keeps it a message.
    private var minLeading: CGFloat {
        #if os(iOS)
        return Spine.Space.xxl
        #else
        return 120
        #endif
    }

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: minLeading)
            Text(text)
                .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body))
                .foregroundStyle(Spine.Palette.text)
                .textSelection(.enabled)
                .padding(.horizontal, Spine.Space.md + 2)
                .padding(.vertical, Spine.Space.sm + 2)
                .background(Spine.Palette.accentSoft, in: RoundedRectangle(cornerRadius: Spine.Radius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: Spine.Radius.lg)
                        .strokeBorder(Spine.Palette.accentLine, lineWidth: 0.5)
                )
                .contextMenu {
                    Button("Copy") { copy() }
                }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You said: \(text)")
    }

    private func copy() {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}
