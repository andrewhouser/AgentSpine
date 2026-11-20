import AVFoundation
import Foundation
import Observation

// Recording a meeting from the iPhone's own microphone, so you can walk into a room without the
// Mac Mini's microphone. The same path as the Mac app (`MacRecorder`): microphone -> 16 kHz mono
// s16le chunks spooled to disk every three seconds -> POST to the server, oldest first, deleting
// each file once the server has it. The server half is docs/SPEC.md section 15 ("Audio sent by a
// client"); nothing there changed for the phone, it is just another named remote source.
//
// The disk is the buffer on purpose. A phone loses its connection constantly (a lift, a basement
// meeting room, switching between Wi-Fi and cellular), and audio already captured must survive
// that. Capture continues with the screen locked: Info.plist declares the `audio` background mode.

#if os(iOS)

@MainActor
@Observable
final class PhoneRecorder {
    static let shared = PhoneRecorder()
    /// The name this phone sends as its source. It must be listed in `policy.audio.remoteSources`
    /// in policy.json on the server, which only you can edit.
    static let source = "iphone"

    enum Phase { case idle, starting, recording, finishing }
    enum Link: Equatable {
        case sending
        /// The server can't be reached (or refused a chunk); audio is being kept on this phone.
        case buffering(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var link: Link = .sending
    private(set) var meetingID: Int?
    private(set) var startedAt: Date?
    /// Chunks captured and not yet accepted by the server.
    private(set) var unsentChunks = 0
    /// Why the last recording stopped early, or what to know about audio left on this phone.
    private(set) var notice: String?

    var isRecording: Bool { phase == .recording || phase == .finishing }
    var unsentSeconds: Int { unsentChunks * 3 }

    /// The microphone's level for a meter. Not observable: a meter reads it on a timer, so the
    /// whole screen does not re-render ten times a second.
    func inputLevel() -> Float { spooler?.level ?? 0 }

    private var engine: AVAudioEngine?
    private var spooler: PCMSpooler?
    private var dir: URL?
    private var sender: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []

    enum StartError: LocalizedError {
        case micDenied
        var errorDescription: String? {
            "AgentSpine can't use the microphone. Turn it on in iOS Settings, AgentSpine, Microphone."
        }
    }

    // MARK: Start

    func start(projectID: Int?, title: String?) async throws {
        guard phase == .idle else { return }
        guard await AVAudioApplication.requestRecordPermission() else { throw StartError.micDenied }
        phase = .starting
        notice = nil
        // The server first: a policy denial or a recording already running should be the
        // answer, rather than a microphone that opened and has nowhere to send.
        let started: RemoteMeetingStart
        do {
            started = try await APIClient.shared.startRemoteMeeting(source: Self.source, projectID: projectID, title: title)
        } catch {
            phase = .idle
            throw error
        }

        do {
            let session = AVAudioSession.sharedInstance()
            // The built-in microphone unless headphones with one are connected; Bluetooth is
            // allowed so AirPods work, but nothing here selects it over the phone's own.
            try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP, .defaultToSpeaker])
            try session.setActive(true)
            let folder = try Self.spoolFolder(for: started.meetingID)
            let spooler = PCMSpooler(dir: folder, startSeq: started.nextSeq)
            let engine = AVAudioEngine()
            try spooler.attach(to: engine)
            engine.prepare()
            try engine.start()
            self.dir = folder
            self.spooler = spooler
            self.engine = engine
        } catch {
            // Don't leave the server recording silence.
            try? await APIClient.shared.stopMeeting()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            phase = .idle
            throw error
        }

        meetingID = started.meetingID
        startedAt = .now
        link = .sending
        unsentChunks = 0
        phase = .recording
        observe()
        sender = Task { [weak self] in await self?.runSender(meetingID: started.meetingID) }
    }

    private static func spoolFolder(for meetingID: Int) throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let folder = base.appendingPathComponent("AgentSpine/spool/meeting-\(meetingID)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    // MARK: Interruptions and route changes

    private func observe() {
        let center = NotificationCenter.default
        // The engine stops itself on a route change (headphones in or out) and on an
        // interruption (a phone call, Siri). Rebuild the tap for the new format and carry on;
        // chunks keep their numbers, so the server sees one unbroken recording.
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.resume() }
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            MainActor.assumeIsolated {
                guard let self else { return }
                if raw == AVAudioSession.InterruptionType.began.rawValue {
                    self.notice = "Recording paused: something else is using the microphone (a call, say)."
                } else if raw == AVAudioSession.InterruptionType.ended.rawValue {
                    try? AVAudioSession.sharedInstance().setActive(true)
                    self.resume()
                }
            }
        })
    }

    private func resume() {
        // A running engine means this is the echo of our own restart, not a real change.
        // Without this guard a restart that posts another change restarts again, for ever.
        guard phase == .recording, let engine, let spooler, !engine.isRunning else { return }
        do {
            try spooler.attach(to: engine)
            engine.prepare()
            try engine.start()
            notice = nil
        } catch {
            notice = "The microphone changed and recording could not follow it: \(error.localizedDescription)"
        }
    }

    // MARK: Stop

    /// End the recording. Capture stops at once; the server is told to stop only after it has
    /// every chunk, because it refuses audio once stopped. While the server is unreachable this
    /// waits (the phase is `.finishing` and `unsentChunks` says how much is kept); `abandon()`
    /// is the way out.
    func stop() async {
        guard phase == .recording, let meetingID else { return }
        phase = .finishing
        haltCapture()
        await sender?.value
        guard phase == .finishing else { return } // the sender ended it (see `end`)
        do {
            try await APIClient.shared.stopMeeting()
            if let dir { try? FileManager.default.removeItem(at: dir) }
            notice = nil
        } catch {
            notice = "The audio was sent, but the server did not confirm the stop: \(error.localizedDescription)"
        }
        reset(meetingID: meetingID)
    }

    /// Give up on sending. The server is told to stop with what it has, and anything still
    /// unsent stays in this app's Application Support folder.
    func abandon() async {
        guard isRecording else { return }
        let left = unsentChunks
        sender?.cancel()
        haltCapture()
        try? await APIClient.shared.stopMeeting()
        if left > 0 {
            notice = "\(left * 3) seconds of audio were not sent. They are kept on this phone."
        }
        if let id = meetingID { reset(meetingID: id) }
    }

    private func haltCapture() {
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers = []
        if let engine, let spooler {
            spooler.detach(from: engine)
            spooler.flush()
            if let failure = spooler.failure { notice = "Some audio could not be saved on this phone: \(failure)" }
        }
        engine = nil
        spooler = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func reset(meetingID: Int) {
        sender = nil
        dir = nil
        self.meetingID = nil
        startedAt = nil
        unsentChunks = 0
        link = .sending
        phase = .idle
    }

    /// The server ended the meeting (an idle limit, a restart) or refused us for good. Capture
    /// is pointless now; what was recorded and not sent stays on disk.
    private func end(_ reason: String) {
        sender?.cancel()
        haltCapture()
        notice = "\(reason) \(unsentChunks > 0 ? "\(unsentSeconds) seconds of audio are kept on this phone." : "")"
            .trimmingCharacters(in: .whitespaces)
        if let id = meetingID { reset(meetingID: id) }
    }

    // MARK: Sending

    private func runSender(meetingID: Int) async {
        guard let dir else { return }
        var wait = 1.0
        while !Task.isCancelled {
            let files = PCMSpooler.spooled(in: dir)
            unsentChunks = files.count
            guard let next = files.first else {
                if phase == .finishing { return }
                try? await Task.sleep(for: .milliseconds(500))
                continue
            }
            guard let pcm = try? Data(contentsOf: next.url), !pcm.isEmpty else {
                try? FileManager.default.removeItem(at: next.url)
                continue
            }
            do {
                _ = try await APIClient.shared.sendAudioChunk(meetingID: meetingID, seq: next.seq, pcm: pcm)
                try? FileManager.default.removeItem(at: next.url)
                link = .sending
                wait = 1
            } catch let error as APIError {
                switch error {
                case .server(409, _):
                    if await resync(meetingID: meetingID, next: next) == false { return }
                case .unauthorized, .notConfigured:
                    end(error.localizedDescription)
                    return
                default:
                    // Offline, or a server that is restarting: keep the audio and try again.
                    link = .buffering(error.localizedDescription)
                    try? await Task.sleep(for: .seconds(wait))
                    wait = min(wait * 2, 10)
                }
            } catch {
                link = .buffering(error.localizedDescription)
                try? await Task.sleep(for: .seconds(wait))
                wait = min(wait * 2, 10)
            }
        }
    }

    /// A 409 means the server and this phone disagree about where we are. Ask the server, then
    /// either skip a chunk it already has, or give up if it is no longer recording this meeting.
    /// Returns false when the sender should stop.
    private func resync(meetingID: Int, next: (seq: Int, url: URL)) async -> Bool {
        guard let live = try? await APIClient.shared.meetingLive() else {
            link = .buffering("Can't reach the server.")
            try? await Task.sleep(for: .seconds(2))
            return true
        }
        guard live.recording, live.meetingID == meetingID, let want = live.nextSeq else {
            end("The server is no longer recording this meeting (it ends one after ten quiet minutes).")
            return false
        }
        if next.seq < want {
            try? FileManager.default.removeItem(at: next.url) // it already has this one
            return true
        }
        end("The server is missing audio from earlier and cannot take the rest.")
        return false
    }
}

#else

/// The Mac has its own recorder (`MacRecorder`). This stub exists because `MeetingsView` is
/// shared and refers to the phone's recorder; on the Mac it never records.
@MainActor
@Observable
final class PhoneRecorder {
    static let shared = PhoneRecorder()
    static let source = "iphone"

    enum Link: Equatable {
        case sending
        case buffering(String)
    }

    var isRecording: Bool { false }
    var notice: String? { nil }
    var link: Link { .sending }
    var unsentSeconds: Int { 0 }

    func start(projectID: Int?, title: String?) async throws {}
    func stop() async {}
}

#endif
