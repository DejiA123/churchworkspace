import Foundation
import AVFoundation
import Speech

/*
 * Speech to text, on the phone.
 *
 * The desktop bundles whisper.cpp. iOS has a speech recogniser built in, and
 * with `requiresOnDeviceRecognition` it runs entirely on the Neural Engine —
 * nothing about the sermon leaves the device, which is the same promise the
 * desktop makes, and it is fast enough that captioning a 30-second short is
 * a few seconds rather than a wait.
 *
 * Two things this has to work around:
 *
 *  1. The recogniser refuses very long files. A whole service is therefore cut
 *     into overlapping windows, transcribed one at a time, and stitched — with
 *     the words' own timestamps shifted back onto the recording's clock.
 *  2. Word timings come from `SFTranscriptionSegment`, which is per-word when
 *     the recogniser feels like it and per-phrase when it doesn't. A phrase is
 *     split evenly across its words rather than dropped, so a caption line
 *     never ends up with no time of its own.
 */
enum TranscriptionError: LocalizedError {
    case notAuthorised
    case unavailable
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .notAuthorised:
            return "Speech recognition is switched off for this app. Turn it on in Settings › Privacy › Speech Recognition."
        case .unavailable:
            return "On-device speech recognition isn't available in this language on this device."
        case .failed(let why):
            return "Could not transcribe: \(why)"
        }
    }
}

actor Transcriber {

    /// The longest stretch handed to the recogniser in one go.
    private let windowSeconds: Double = 55
    /// Overlap between windows so a word straddling the seam is not lost.
    private let overlapSeconds: Double = 2

    static func requestAuthorisation() async -> Bool {
        await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status == .authorized)
            }
        }
    }

    static var isAvailable: Bool {
        guard let r = SFSpeechRecognizer() else { return false }
        return r.isAvailable && r.supportsOnDeviceRecognition
    }

    /// Transcribe a range of a recording. Word times come back RELATIVE to
    /// `startSec`, which is exactly what a clip's captions need — the same
    /// contract the desktop's ranged transcribe has.
    func words(
        url: URL,
        startSec: Double,
        endSec: Double,
        progress: ((Double) -> Void)? = nil,
        isCancelled: (() -> Bool)? = nil
    ) async throws -> [TimedWord] {
        guard await Transcriber.requestAuthorisation() else { throw TranscriptionError.notAuthorised }
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { throw TranscriptionError.unavailable }

        let span = max(0, endSec - startSec)
        guard span > 0.2 else { return [] }

        var out: [TimedWord] = []
        var windowStart: Double = 0
        while windowStart < span {
            if isCancelled?() == true { throw CancellationError() }
            let windowEnd = min(span, windowStart + windowSeconds)
            let slice = try await exportSlice(url: url, from: startSec + windowStart, to: startSec + windowEnd)
            defer { try? FileManager.default.removeItem(at: slice) }

            let words = try await recognise(recognizer: recognizer, file: slice)
            // A word already covered by the previous window's tail is a duplicate
            // of the overlap, not a second utterance.
            let cutoff = out.last?.end ?? -1
            for var w in words {
                w.start += windowStart
                w.end += windowStart
                if w.start < cutoff - 0.05 { continue }
                out.append(w)
            }
            progress?(min(1, windowEnd / span))
            if windowEnd >= span { break }
            windowStart = windowEnd - overlapSeconds
        }
        return out
    }

    /// Write the requested stretch out as an m4a the recogniser will accept.
    private func exportSlice(url: URL, from: Double, to: Double) async throws -> URL {
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            throw TranscriptionError.failed("audio could not be prepared")
        }
        let out = FileManager.default.temporaryDirectory
            .appendingPathComponent("mw-asr-\(UUID().uuidString).m4a")
        session.outputURL = out
        session.outputFileType = .m4a
        session.timeRange = CMTimeRange(
            start: CMTime(seconds: from, preferredTimescale: 600),
            duration: CMTime(seconds: max(0.1, to - from), preferredTimescale: 600)
        )
        try await session.runExport(to: out, fileType: .m4a)
        return out
    }

    private func recognise(recognizer: SFSpeechRecognizer, file: URL) async throws -> [TimedWord] {
        let request = SFSpeechURLRecognitionRequest(url: file)
        // On-device keeps the sermon on the phone and removes Apple's 1-minute
        // per-request server limit.
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request.shouldReportPartialResults = false
        if #available(iOS 16.0, macOS 13.0, *) { request.addsPunctuation = true }
        request.taskHint = .dictation

        return try await withCheckedThrowingContinuation { cont in
            var resumed = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !resumed else { return }
                if let error {
                    resumed = true
                    cont.resume(throwing: TranscriptionError.failed(error.localizedDescription))
                    return
                }
                guard let result, result.isFinal else { return }
                resumed = true
                cont.resume(returning: Transcriber.split(result.bestTranscription.segments))
            }
        }
    }

    /// Turn the recogniser's segments into one entry per WORD.
    static func split(_ segments: [SFTranscriptionSegment]) -> [TimedWord] {
        var out: [TimedWord] = []
        for seg in segments {
            let text = seg.substring.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            let parts = text.split(separator: " ").map(String.init)
            if parts.count <= 1 {
                out.append(TimedWord(start: seg.timestamp, end: seg.timestamp + seg.duration, text: text))
                continue
            }
            // A multi-word segment gets its time shared out evenly. Not perfect,
            // but a caption line of three words is on screen for a second and a
            // half — the error is far below what anyone can see.
            let each = seg.duration / Double(parts.count)
            for (i, p) in parts.enumerated() {
                let s = seg.timestamp + Double(i) * each
                out.append(TimedWord(start: s, end: s + each, text: p))
            }
        }
        return out
    }
}

extension AVAssetExportSession {
    /// One async call site for every export in the app. Deliberately NOT named
    /// `export(to:as:)` — that is Apple's own iOS 18 method, and shadowing it
    /// would make every call ambiguous the moment the project is built against
    /// a newer SDK.
    func runExport(to url: URL, fileType: AVFileType) async throws {
        outputURL = url
        outputFileType = fileType
        try? FileManager.default.removeItem(at: url)
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            exportAsynchronously { cont.resume() }
        }
        if status == .failed { throw ExportError.failed(error?.localizedDescription ?? "export failed") }
        if status == .cancelled { throw CancellationError() }
    }
}
