import AVFoundation
import Observation
import UIKit

/// Hands-free voice: say the wake word, speak a command, hear the reply.
///
/// **Foreground only.** The phone detects speech by level, cuts an utterance at about a second
/// of silence, and uploads it to `/api/voice/listen`, where the server decides whether it was
/// the wake word and transcribes it. Doing the detection here keeps silence off the network.
/// While active the screen is kept awake, because iOS suspends a recording app the moment it
/// locks unless it holds a background audio mode, and that is a larger commitment than this.
@MainActor
@Observable
final class HandsFree {
    enum Phase: Equatable {
        case off
        /// Waiting for the wake word.
        case idle
        /// The wake word was heard on its own; the next utterance is the command.
        case awake
        case hearing
        /// A command has been handed over; paused until `resume()`.
        case busy
    }

    private(set) var phase: Phase = .off
    private(set) var heard = ""
    private(set) var note: String?
    /// Called with each recognised command. The owner sends it and later calls `resume()`.
    var onCommand: ((String) -> Void)?

    private var loop: Task<Void, Never>?
    private var status: APIClient.VoiceStatus?

    private static let speechThreshold: Float = -38   // dB; above this is "someone talking"
    private static let silenceToEnd = 1.0              // seconds
    private static let minSpeech = 0.4                 // seconds; shorter is a click
    private static let maxUtterance = 20.0

    var isActive: Bool { phase != .off }

    func start() async {
        guard !isActive else { return }
        do {
            let status = try await APIClient.shared.voiceStatus()
            guard status.listenReady else {
                note = status.listenReason.isEmpty ? "Listening is not available." : status.listenReason
                return
            }
            self.status = status
        } catch {
            note = error.localizedDescription
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            note = "Microphone access is off. Allow it in iOS Settings → AgentSpine."
            return
        }
        note = nil
        heard = ""
        phase = .idle
        UIApplication.shared.isIdleTimerDisabled = true
        loop = Task { await run() }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        phase = .off
        UIApplication.shared.isIdleTimerDisabled = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Back to waiting for the wake word, after a command has been dealt with.
    func resume() {
        if phase == .busy { phase = .idle }
    }

    // MARK: - The loop

    private func run() async {
        guard let defaults = status?.defaults else { return }
        while !Task.isCancelled {
            if phase == .busy {
                try? await Task.sleep(for: .milliseconds(250))
                continue
            }
            let awake = phase == .awake
            // Idle waits as long as it takes; after a bare wake word the command has to follow
            // within the server's configured window.
            let patience = awake ? Double(defaults.timeoutSeconds) : 600
            guard let audio = await capture(noSpeechTimeout: patience) else {
                if phase != .busy { phase = .idle }
                continue
            }
            if phase == .busy || Task.isCancelled { continue }
            phase = awake ? .awake : .idle
            do {
                let result = try await APIClient.shared.listen(
                    audio: audio, mime: "audio/mp4", turn: awake,
                    wake: defaults.wakeWord, aliases: defaults.aliases, sounds: defaults.soundsAlike
                )
                if let heardText = result.heard, !heardText.isEmpty { heard = heardText }
                if awake {
                    deliver(result.text ?? "")
                } else if result.woke == true {
                    if let command = result.command, !command.isEmpty {
                        deliver(command)
                    } else {
                        phase = .awake
                    }
                }
                note = nil
            } catch {
                note = error.localizedDescription
                // Do not spin on a dead connection.
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private func deliver(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            phase = .idle
            return
        }
        phase = .busy
        onCommand?(trimmed)
    }

    /// Record until one utterance has been spoken and followed by silence. Nil if nobody
    /// spoke within `noSpeechTimeout` or the take was too short to be speech.
    private func capture(noSpeechTimeout: Double) async -> Data? {
        let session = AVAudioSession.sharedInstance()
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("handsfree-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: url) }
        let recorder: AVAudioRecorder
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
            recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
            ])
            recorder.isMeteringEnabled = true
            guard recorder.record() else { return nil }
        } catch {
            note = error.localizedDescription
            try? await Task.sleep(for: .seconds(2))
            return nil
        }

        var spokeAt: Double?
        var lastLoud: Double = 0
        var elapsed: Double = 0
        // The recorder is rolled over every half minute while idle so an hour of silence
        // is not one growing file.
        let rollover = min(noSpeechTimeout, 30)
        while !Task.isCancelled && phase != .busy {
            try? await Task.sleep(for: .milliseconds(100))
            elapsed = recorder.currentTime
            recorder.updateMeters()
            let loud = recorder.averagePower(forChannel: 0) > Self.speechThreshold
            if loud {
                lastLoud = elapsed
                if spokeAt == nil { spokeAt = elapsed; phase = phase == .awake ? .awake : .hearing }
            }
            if let start = spokeAt {
                if elapsed - lastLoud >= Self.silenceToEnd || elapsed - start >= Self.maxUtterance {
                    break
                }
            } else if elapsed >= rollover {
                recorder.stop()
                return nil
            }
        }
        recorder.stop()
        guard let start = spokeAt, lastLoud - start >= Self.minSpeech else { return nil }
        return try? Data(contentsOf: url)
    }
}
