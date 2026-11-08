import AVFoundation
import Observation

/// Records one take from the phone's microphone to a temporary AAC file.
///
/// The server hands the bytes to ffmpeg, so any container it can decode will do; m4a is what
/// `AVAudioRecorder` produces cheaply and it is small enough for cellular.
///
/// Abandoning a take deliberately does not call `POST /api/dictate/cancel`. That route stops
/// the *server's* microphone session, which a phone recording never starts, so calling it
/// could only ever kill someone else's take.
@MainActor
@Observable
final class Dictation {
    enum Phase: Equatable { case idle, recording, transcribing }

    private(set) var phase: Phase = .idle
    private(set) var elapsed: TimeInterval = 0
    /// Seconds the server will accept, from `GET /api/dictate`; recording stops itself here.
    private var maxSeconds: Int = 120
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var fileURL: URL?

    /// Start recording. Returns nil on success, or a sentence explaining why not.
    func start() async -> String? {
        do {
            let status = try await APIClient.shared.dictationStatus()
            guard status.modelReady else {
                return "The server's speech model is missing, so nothing can transcribe this."
            }
            maxSeconds = status.maxSeconds
        } catch {
            return error.localizedDescription
        }

        guard await AVAudioApplication.requestRecordPermission() else {
            return "Microphone access is off. Allow it in iOS Settings → AgentSpine."
        }

        let session = AVAudioSession.sharedInstance()
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("dictation-\(UUID().uuidString).m4a")
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
            let recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
            ])
            guard recorder.record() else { return "The microphone could not start." }
            self.recorder = recorder
            fileURL = url
        } catch {
            return error.localizedDescription
        }

        elapsed = 0
        phase = .recording
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let recorder = self.recorder else { return }
                self.elapsed = recorder.currentTime
            }
        }
        return nil
    }

    /// Stop, upload, and return the transcript. Throws on upload or transcription failure.
    func finish() async throws -> String {
        let url = stopRecording()
        guard let url else { return "" }
        defer { try? FileManager.default.removeItem(at: url) }
        phase = .transcribing
        defer { phase = .idle }
        let data = try Data(contentsOf: url)
        return try await APIClient.shared.dictate(audio: data, mime: "audio/mp4")
    }

    func cancel() {
        if let url = stopRecording() { try? FileManager.default.removeItem(at: url) }
        phase = .idle
    }

    /// True once the take has hit the server's limit and should be finished.
    var atLimit: Bool { phase == .recording && Int(elapsed) >= maxSeconds - 1 }

    private func stopRecording() -> URL? {
        timer?.invalidate()
        timer = nil
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        defer { fileURL = nil }
        return fileURL
    }
}
