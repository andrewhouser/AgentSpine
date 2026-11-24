import SwiftUI

/// The one Stop control for a live recording, on iPhone and Mac, drawn to match the web's
/// `.stop` button in MeetingsView.module.css: danger-soft fill, danger-line border, danger text
/// and a pulsing dot. A plain `Button(role: .destructive)` rendered as faint red text on the
/// Mac (and as a list row on iPhone), easy to miss on the one control you must find while
/// someone is talking; the web's was the one people could actually spot.
struct StopRecordingButton: View {
    var stopping: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spine.Space.sm) {
                RecordingDot()
                Text(stopping ? "Stopping…" : "Stop recording")
            }
        }
        .buttonStyle(StopRecordingStyle())
        .disabled(stopping)
        .accessibilityLabel(stopping ? "Stopping recording" : "Stop recording")
    }
}

/// The pulsing red dot. Still when Reduce Motion is on, as the web's is.
struct RecordingDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(Spine.Palette.danger)
            .frame(width: 8, height: 8)
            .opacity(dim ? 0.25 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                // 1.4 s full cycle on the web, so 0.7 s each way here.
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

private struct StopRecordingStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Spine.Radius.sm, style: .continuous)
        configuration.label
            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
            .foregroundStyle(Spine.Palette.danger)
            .padding(.horizontal, Spine.Space.lg)
            .padding(.vertical, Spine.Space.sm)
            .background(Spine.Palette.dangerSoft, in: shape)
            .overlay(shape.strokeBorder(Spine.Palette.dangerLine, lineWidth: 1))
            .contentShape(shape)
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.45)
    }
}
