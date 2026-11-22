import SwiftUI

/// The live microphone level while dictating: a row of bars, newest on the right, so speaking
/// shows up at once. Before this there was only a red timer, and a take spoken into a muted or
/// misrouted mic looked exactly like a good one until the transcript came back empty.
struct DictationWaveform: View {
    /// 0...1 per bar, oldest first (`Dictation.levels`).
    let levels: [Float]
    var color: Color = Spine.Palette.accent

    var body: some View {
        GeometryReader { geo in
            let count = max(levels.count, 1)
            let gap: CGFloat = 2
            let width = max(1.5, (geo.size.width - gap * CGFloat(count - 1)) / CGFloat(count))
            HStack(alignment: .center, spacing: gap) {
                ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                    Capsule()
                        .fill(color)
                        // A floor of 3pt keeps silence visible as a line rather than a gap.
                        .frame(width: width, height: max(3, CGFloat(level) * geo.size.height))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .trailing)
            .animation(.linear(duration: 0.05), value: levels)
        }
        .accessibilityHidden(true)
    }
}
