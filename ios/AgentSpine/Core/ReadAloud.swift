import AVFoundation
import Observation

/// Reads a reply aloud using the server's voice: plan, then synthesise and play each piece
/// in order. The next piece is fetched while the current one plays, so there is no gap.
///
/// Foreground only. Wake-word, hands-free listening needs a background audio mode and overlaps
/// what Shortcuts can do, so it is deliberately not here.
@MainActor
@Observable
final class ReadAloud: NSObject, AVAudioPlayerDelegate {
    private(set) var speaking = false
    /// The text being read, so each reply's button can tell whether it is the one playing.
    private(set) var current: String?
    private(set) var error: String?
    private var task: Task<Void, Never>?
    private var player: AVAudioPlayer?
    private var finished: CheckedContinuation<Void, Never>?

    func toggle(_ text: String) {
        if speaking { stop() } else { start(text) }
    }

    func stop() {
        task?.cancel()
        task = nil
        player?.stop()
        player = nil
        finished?.resume()
        finished = nil
        speaking = false
        current = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func start(_ text: String) {
        error = nil
        speaking = true
        current = text
        task = Task {
            do {
                try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker])
                try AVAudioSession.sharedInstance().setActive(true)
                let chunks = try await APIClient.shared.planSpeech(text)
                guard !chunks.isEmpty else { throw APIError.server(422, "Nothing to read aloud.") }
                // Fetch one ahead of the one playing.
                var next: Task<Data, Error>? = Task { try await APIClient.shared.speak(chunks[0]) }
                for index in chunks.indices {
                    guard let current = next else { break }
                    let wav = try await current.value
                    next = index + 1 < chunks.count
                        ? Task { try await APIClient.shared.speak(chunks[index + 1]) }
                        : nil
                    try Task.checkCancellation()
                    await play(wav)
                    try Task.checkCancellation()
                }
            } catch is CancellationError {
            } catch {
                self.error = error.localizedDescription
            }
            if !Task.isCancelled { speaking = false; current = nil }
        }
    }

    private func play(_ wav: Data) async {
        guard let player = try? AVAudioPlayer(data: wav) else { return }
        player.delegate = self
        self.player = player
        await withCheckedContinuation { continuation in
            finished = continuation
            if !player.play() {
                finished = nil
                continuation.resume()
            }
        }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            finished?.resume()
            finished = nil
        }
    }
}
