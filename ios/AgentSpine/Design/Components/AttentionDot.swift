import SwiftUI

/// The amber of "this is waiting on you" — the dot on a thread row and the edge of an inline
/// approval card. Its own token rather than the accent, so it reads as a signal.
extension Color {
    static let attention = Spine.Palette.attention
}

/// The blue dot on a thread that has a question waiting on you.
struct AttentionDot: View {
    var body: some View {
        // Hollow, like the spine's waiting node: a shape difference as well as a colour one.
        Circle()
            .strokeBorder(Color.attention, lineWidth: 2)
            .frame(width: 10, height: 10)
            .accessibilityLabel("Waiting on you")
    }
}
