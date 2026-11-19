import AVFoundation
import CoreGraphics
import ScreenCaptureKit

/// The other side of a call: whatever this Mac is playing, through ScreenCaptureKit.
///
/// Optional on purpose. It needs the Screen & System Audio Recording permission, which is a
/// bigger ask than the microphone, so the microphone alone must always be a complete way to
/// record. Only the sound is used: the stream asks for a 2x2 picture once a second, which is the
/// least ScreenCaptureKit will give, and discards it.
///
/// `nonisolated` for the same reason as `PCMSpooler`: the callbacks arrive on a queue of
/// ScreenCaptureKit's, and a main-actor-isolated closure would trap there.
nonisolated final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let spooler: PCMSpooler
    private let queue = DispatchQueue(label: "agentspine.callaudio")
    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private var converterInput: AVAudioFormat?
    /// Called (off the main actor) if the stream dies on its own, e.g. permission revoked.
    var onStopped: (@Sendable (String) -> Void)?

    init(spooler: PCMSpooler) { self.spooler = spooler }

    static var hasAccess: Bool { CGPreflightScreenCaptureAccess() }

    /// Ask macOS to show its prompt (the first time only). It answers false at once the first
    /// time; the person then has to allow it in System Settings, and macOS may want the app reopened.
    @discardableResult static func requestAccess() -> Bool { CGRequestScreenCaptureAccess() }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { throw CallAudioError.noDisplay }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true // not our own read-aloud
        config.sampleRate = 48_000
        config.channelCount = 1
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() async {
        try? await stream?.stopCapture()
        stream = nil
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, sampleBuffer.numSamples > 0,
              let desc = sampleBuffer.formatDescription
        else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: desc)
        if converter == nil || converterInput != format {
            converter = AVAudioConverter(from: format, to: outFormat)
            converterInput = format
        }
        guard let converter else { return }
        try? sampleBuffer.withAudioBufferList { list, _ in
            guard let input = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafePointer) else { return }
            input.frameLength = AVAudioFrameCount(sampleBuffer.numSamples)
            let capacity = AVAudioFrameCount(Double(input.frameLength) * 16_000 / format.sampleRate) + 64
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
                return input
            }
            guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return }
            spooler.addCall(Data(bytes: samples, count: Int(out.frameLength) * 2))
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStopped?(error.localizedDescription)
    }

    enum CallAudioError: LocalizedError {
        case noDisplay
        var errorDescription: String? { "There is no display to attach call audio to." }
    }
}
