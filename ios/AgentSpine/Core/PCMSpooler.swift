import AVFoundation
import Foundation

// The audio-thread half of recording a meeting from this device's own microphone: shared by the
// Mac app (MacRecorder) and the iPhone app (PhoneRecorder). See docs/SPEC.md section 15, "Audio
// sent by a client", for the server half.
//
// Microphone -> AVAudioEngine tap -> 16 kHz mono s16le -> a file on disk every three seconds.
// The disk is the buffer on purpose: a dropped connection, a sleeping device or a crashed app
// cannot lose audio that has already been captured.

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
        var errorDescription: String? { "There is no microphone input that AgentSpine can use." }
    }
}
