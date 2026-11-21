import AVFoundation
import Foundation
import Observation

// Recording a meeting from this Mac's own microphone (docs/archive/PLAN-native-apps-and-ui-refresh.md,
// phase 5; the server half is SPEC 15, "Audio sent by a client").
//
// The path is: microphone -> AVAudioEngine tap -> 16 kHz mono s16le -> a file on disk every
// three seconds -> POST to the server, oldest first, deleting each file once the server has it.
//
// The disk is the buffer on purpose. Writing every chunk before sending it means a dropped
// Tailscale connection, a sleeping laptop or a crashed app cannot lose audio that has already
// been captured, and the sender has one job: send the lowest-numbered file, and keep trying.

/// One recording from this Mac at a time, shared so the Meetings screen and the menu bar see the
/// same state. The server allows only one recording anyway.
@MainActor
@Observable
final class MacRecorder {
    static let shared = MacRecorder()
    /// The name this Mac sends as its source. It must be listed in `policy.audio.remoteSources`.
    static let source = "mac"

    enum Phase { case idle, starting, recording, finishing }
    enum Link: Equatable {
        case sending
        /// The server can't be reached (or refused a chunk); audio is being kept on this Mac.
        case buffering(String)
    }
    enum MicAccess { case granted, denied, undetermined }

    private(set) var phase: Phase = .idle
    private(set) var link: Link = .sending
    private(set) var meetingID: Int?
    private(set) var startedAt: Date?
    /// Whether the other side of a call is being captured too.
    private(set) var callAudio = false
    /// Chunks captured and not yet accepted by the server.
    private(set) var unsentChunks = 0
    /// Why the last recording stopped early, or what to know about audio left on this Mac.
    private(set) var notice: String?

    var micAccess: MicAccess {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .granted
        case .denied: .denied
        default: .undetermined
        }
    }

    var isRecording: Bool { phase == .recording || phase == .finishing }

    /// The microphone's level for a meter. Not observable: a meter reads it on a timer, so the
    /// whole screen does not re-render ten times a second.
    func inputLevel() -> Float { spooler?.level ?? 0 }
    func callLevel() -> Float { spooler?.callLevel ?? 0 }
    var unsentSeconds: Int { unsentChunks * 3 }

    private var engine: AVAudioEngine?
    private var spooler: PCMSpooler?
    private var callCapture: SystemAudioCapture?
    private var dir: URL?
    private var sender: Task<Void, Never>?
    private var configObserver: NSObjectProtocol?

    /// Show the system's microphone prompt (the first time only) and report the answer.
    func requestMicAccess() async -> Bool {
        if micAccess == .granted { return true }
        return await AVAudioApplication.requestRecordPermission()
    }

    // MARK: Start

    func start(projectID: Int?, title: String?, includeCallAudio: Bool = false) async throws {
        guard phase == .idle else { return }
        guard await requestMicAccess() else { throw StartError.micDenied }
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
            phase = .idle
            throw error
        }

        meetingID = started.meetingID
        startedAt = .now
        link = .sending
        if includeCallAudio { await startCallAudio() }
        unsentChunks = 0
        phase = .recording
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.inputChanged() }
        }
        sender = Task { [weak self] in await self?.runSender(meetingID: started.meetingID) }
    }

    /// Best effort. A missing permission or a failed stream costs the other side of the call,
    /// never the recording: the microphone is already running and the meeting already exists.
    private func startCallAudio() async {
        guard let spooler else { return }
        guard SystemAudioCapture.hasAccess else {
            SystemAudioCapture.requestAccess()
            notice = "Call audio needs Screen & System Audio Recording turned on for AgentSpine in System Settings, Privacy & Security. Recording the microphone only; you may need to reopen AgentSpine after allowing it."
            return
        }
        let capture = SystemAudioCapture(spooler: spooler)
        capture.onStopped = { [weak self] why in
            // Capture weakly in the Task itself: a `[weak self]` var captured from the outer
            // closure is a mutable capture, which Swift 6 rejects in concurrent code.
            Task { @MainActor [weak self] in
                self?.callAudio = false
                self?.notice = "Call audio stopped: \(why). The microphone is still recording."
            }
        }
        do {
            try await capture.start()
            callCapture = capture
            callAudio = true
        } catch {
            notice = "Call audio could not start (\(error.localizedDescription)). Recording the microphone only."
        }
    }

    enum StartError: LocalizedError {
        case micDenied
        var errorDescription: String? {
            "AgentSpine can't use the microphone. Turn it on in System Settings, Privacy & Security, Microphone."
        }
    }

    private static func spoolFolder(for meetingID: Int) throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let folder = base.appendingPathComponent("AgentSpine/spool/meeting-\(meetingID)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// The input changed under us (headphones, another default device). The engine has stopped
    /// itself; rebuild the tap for the new format and carry on. Chunks keep their numbers, so
    /// the server sees one unbroken recording.
    private func inputChanged() {
        // A running engine means this is the echo of our own restart, not a real change.
        // Without this guard a restart that posts another change restarts again, on the main
        // thread, for ever.
        guard phase == .recording, let engine, let spooler, !engine.isRunning else { return }
        do {
            try spooler.attach(to: engine)
            engine.prepare()
            try engine.start()
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
    /// unsent stays in this Mac's Application Support folder.
    func abandon() async {
        guard isRecording else { return }
        let left = unsentChunks
        sender?.cancel()
        haltCapture()
        try? await APIClient.shared.stopMeeting()
        if left > 0 {
            notice = "\(left * 3) seconds of audio were not sent. It is kept on this Mac in Application Support/AgentSpine/spool."
        }
        if let id = meetingID { reset(meetingID: id) }
    }

    private func haltCapture() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        if let capture = callCapture { Task { await capture.stop() } }
        callCapture = nil
        callAudio = false
        if let engine, let spooler {
            spooler.detach(from: engine)
            spooler.flush()
            if let failure = spooler.failure { notice = "Some audio could not be saved on this Mac: \(failure)" }
        }
        engine = nil
        spooler = nil
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
        notice = "\(reason) \(unsentChunks > 0 ? "\(unsentSeconds) seconds of audio are kept on this Mac." : "")"
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

    /// A 409 means the server and this Mac disagree about where we are. Ask the server, then
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
