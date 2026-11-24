import SwiftUI

/// A level meter for the microphone: a row of small bars that fill from the left. Read on a
/// timer, ten times a second, straight from the recorder, so nothing else re-renders with it.
struct MacLevelMeter: View {
    var recorder = MacRecorder.shared
    /// Which source to show. The call's meter only means anything while call audio is on.
    var call = false
    private let bars = 14

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.1)) { _ in
            let level = Double(call ? recorder.callLevel() : recorder.inputLevel())
            HStack(spacing: 2) {
                ForEach(0..<bars, id: \.self) { i in
                    let lit = level * Double(bars) > Double(i)
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(lit ? (i >= bars - 2 ? Spine.Palette.warn : Spine.Palette.accent) : Spine.Palette.textFaint.opacity(0.35))
                        .frame(width: 4, height: 10)
                }
            }
            .accessibilityElement()
            .accessibilityLabel(call ? "Call audio level" : "Microphone level")
            .accessibilityValue("\(Int(level * 100)) percent")
        }
    }
}

enum MacClock {
    static func text(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        return s >= 3600
            ? String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
            : String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// The "Sources" row: each thing being heard, with its own meter.
struct MacSourcesRow: View {
    var recorder = MacRecorder.shared

    var body: some View {
        HStack(spacing: Spine.Space.md) {
            source("Mic", call: false)
            if recorder.callAudio { source("Call", call: true) }
        }
    }

    private func source(_ name: String, call: Bool) -> some View {
        HStack(spacing: 5) {
            Text(name)
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
            MacLevelMeter(recorder: recorder, call: call)
        }
    }
}

/// The menu bar's recording section: that it is on, for how long, how loud, whether the audio
/// is getting through, and a Stop that does not need the window.
struct MacRecordingPanel: View {
    var recorder = MacRecorder.shared
    @State private var stopping = false

    var body: some View {
        if recorder.isRecording, let started = recorder.startedAt {
            VStack(alignment: .leading, spacing: Spine.Space.sm) {
                HStack(spacing: Spine.Space.sm) {
                    Circle().fill(Spine.Palette.danger).frame(width: 8, height: 8)
                    Text("Recording from this Mac")
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.medium))
                    Spacer()
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(MacClock.text(context.date.timeIntervalSince(started)))
                            .font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                }
                HStack {
                    MacSourcesRow(recorder: recorder)
                    Spacer()
                    StopRecordingButton(stopping: stopping || recorder.phase == .finishing) {
                        stopping = true
                        Task {
                            await recorder.stop()
                            stopping = false
                        }
                    }
                }
                if case .buffering = recorder.link {
                    Text("Can't reach the server. \(recorder.unsentSeconds) s of audio is kept on this Mac and will be sent when it's back.")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.warn)
                }
            }
            Divider()
        }
    }
}
