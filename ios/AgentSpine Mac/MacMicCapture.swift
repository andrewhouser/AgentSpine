import AVFoundation
import Foundation
import Observation

// Recording a meeting from this Mac's own microphone (docs/PLAN-native-apps-and-ui-refresh.md,
// phase 5; the server half is SPEC 15, "Audio sent by a client").
//
// The path is: microphone -> AVAudioEngine tap -> 16 kHz mono s16le -> a file on disk every
// three seconds -> POST to the server, oldest first, deleting each file once the server has it.
//
// The disk is the buffer on purpose. Writing every chunk before sending it means a dropped
// Tailscale connection, a sleeping laptop or a crashed app cannot lose audio that has already
// been captured, and the sender has one job: send the lowest-numbered file, and keep trying.

/// The audio-thread half. `nonisolated` matters: the project defaults every type to the main
/// actor, and a tap closure created in a main-actor context inherits that isolation, then traps
/// at runtime the moment the audio thread calls it.
nonisolated final class PCMSpooler: @unchecked Sendable {
    /// Three seconds of 16 kHz mono s16le. Short enough that a lost connection loses nothing
    /// that mattered, long enough that a chunk is not mostly HTTP.
    static let chunkBytes = 3 * 32_000

    private let dir: URL
    private let queue = DispatchQueue(label: "agentspine.spool")
    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private var converter: AVAudioConverter?
    private var sourceRate = 48_000.0
    // Below here is touched only on `queue`.
    private var pending = Data()
    private var seq: Int
    private var writeError: String?
    private let levelLock = NSLock()
    private var _level: Float = 0
    private var _callLevel: Float = 0
    /// Call audio waiting to be mixed with the microphone. Touched only on `queue`.
    private var callPending = Data()

    /// How loud the microphone is right now, 0 to 1 on a decibel scale (silence at 0, about
    /// -60 dB, full scale at 1), with a quick fall so a meter reads as a meter and not a flicker.
    var level: Float {
        levelLock.lock()
        defer { levelLock.unlock() }
        return _level
    }

    /// The same for the other side of a call.
    var callLevel: Float {
        levelLock.lock()
        defer { levelLock.unlock() }
        return _callLevel
    }

    init(dir: URL, startSeq: Int) {
        self.dir = dir
        self.seq = startSeq
    }

    /// Start hearing the input. Safe to call again after a route change (headphones in, an
    /// aggregate device), which changes the input's format and needs a new converter.
    func attach(to engine: AVAudioEngine) throws {
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              let converter = AVAudioConverter(from: format, to: outFormat)
        else { throw CaptureError.noInput }
        self.converter = converter
        self.sourceRate = format.sampleRate
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [self] buffer, _ in
            consume(buffer)
        }
    }

    func detach(from engine: AVAudioEngine) {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    /// Runs on the audio thread: convert and hand off. File I/O does not belong here.
    private func consume(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16_000 / sourceRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return }
        measure(samples, count: Int(out.frameLength), call: false)
        let bytes = Data(bytes: samples, count: Int(out.frameLength) * 2)
        queue.async { [self] in append(mixedWithCall(bytes)) }
    }

    /// Call audio, already 16 kHz mono s16le, from `SystemAudioCapture`. Held until the
    /// microphone's next samples, which set the pace.
    func addCall(_ bytes: Data) {
        bytes.withUnsafeBytes { raw in
            if let p = raw.bindMemory(to: Int16.self).baseAddress { measure(p, count: bytes.count / 2, call: true) }
        }
        queue.async { [self] in
            callPending.append(bytes)
            // A second of slack is plenty. More means the microphone stopped, and a backlog
            // mixed in later would put the other side's words in the wrong place.
            if callPending.count > 64_000 { callPending.removeFirst(callPending.count - 64_000) }
        }
    }

    /// The microphone is the clock: for each stretch of it, take that much call audio (silence
    /// if there is none yet) and add the two, clamped. Everything downstream hears one stream.
    private func mixedWithCall(_ mic: Data) -> Data {
        guard !callPending.isEmpty else { return mic }
        let take = min(callPending.count, mic.count)
        var out = mic
        out.withUnsafeMutableBytes { dst in
            callPending.withUnsafeBytes { src in
                let d = dst.bindMemory(to: Int16.self)
                let c = src.bindMemory(to: Int16.self)
                for i in 0..<(take / 2) {
                    d[i] = Int16(clamping: Int(d[i]) + Int(c[i]))
                }
            }
        }
        callPending.removeFirst(take)
        return out
    }

    private func measure(_ samples: UnsafePointer<Int16>, count: Int, call: Bool) {
        var sum = 0.0
        for i in 0..<count {
            let v = Double(samples[i]) / 32_768
            sum += v * v
        }
        let rms = (sum / Double(max(count, 1))).squareRoot()
        let db = 20 * log10(max(rms, 0.000_001))
        let now = Float(min(max((db + 60) / 60, 0), 1))
        levelLock.lock()
        if call { _callLevel = max(now, _callLevel * 0.82) } else { _level = max(now, _level * 0.82) }
        levelLock.unlock()
    }

    private func append(_ bytes: Data) {
        pending.append(bytes)
        while pending.count >= Self.chunkBytes {
            write(pending.prefix(Self.chunkBytes))
            pending.removeFirst(Self.chunkBytes)
        }
    }

    /// Whole file or nothing: written under a temporary name and renamed, so the sender never
    /// reads half a chunk.
    private func write(_ data: Data) {
        let name = String(format: "chunk-%08d.pcm", seq)
        let tmp = dir.appendingPathComponent(name + ".tmp")
        do {
            try data.write(to: tmp)
            try FileManager.default.moveItem(at: tmp, to: dir.appendingPathComponent(name))
            seq += 1
        } catch {
            writeError = error.localizedDescription
        }
    }

    /// Write whatever is left (under three seconds) as a last, shorter chunk.
    func flush() {
        queue.sync {
            let whole = pending.count & ~1
            if whole > 0 { write(pending.prefix(whole)) }
            pending.removeAll()
        }
    }

    /// Non-nil if a chunk could not be written (disk full, folder gone).
    var failure: String? { queue.sync { writeError } }

    /// Chunks waiting in `dir`, lowest number first.
    static func spooled(in dir: URL) -> [(seq: Int, url: URL)] {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.compactMap { url -> (Int, URL)? in
            let name = url.lastPathComponent
            guard name.hasPrefix("chunk-"), name.hasSuffix(".pcm"),
                  let n = Int(name.dropFirst(6).dropLast(4))
            else { return nil }
            return (n, url)
        }
        .sorted { $0.0 < $1.0 }
        .map { (seq: $0.0, url: $0.1) }
    }

    enum CaptureError: LocalizedError {
        case noInput
        var errorDescription: String? { "This Mac has no microphone input that AgentSpine can use." }
    }
}

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
