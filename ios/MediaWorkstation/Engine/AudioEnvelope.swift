import Foundation
import AVFoundation

/// A per-hop loudness envelope of a recording, in dBFS.
///
/// This is the one thing the highlight analyser actually looks at, and it is
/// deliberately tiny: 20 numbers per second of audio. A three-hour service
/// becomes ~216,000 doubles — under 2 MB — so the whole analysis fits in a
/// phone's memory with room to spare.
struct LoudnessEnvelope {
    /// Raw per-hop dBFS.
    let db: [Double]
    /// Seconds per hop.
    let hopSeconds: Double

    var hopCount: Int { db.count }
    var durationSec: Double { Double(db.count) * hopSeconds }
    func time(ofHop h: Int) -> Double { Double(h) * hopSeconds }
}

enum AudioEnvelopeError: LocalizedError {
    case noAudioTrack
    case readerFailed(String)

    var errorDescription: String? {
        switch self {
        case .noAudioTrack: return "That recording has no sound, so there is nothing to analyse."
        case .readerFailed(let why): return "Could not read the audio: \(why)"
        }
    }
}

/// Decodes audio to the same shape the desktop feeds its analyser.
///
/// The desktop runs `ffmpeg -ar 8000 -ac 1 -f s16le` and reads the raw samples.
/// AVAssetReader is handed exactly those settings — 8 kHz, mono, signed 16-bit,
/// little-endian — so the envelope this produces is the same signal, and the
/// analyser downstream is comparing like with like. 8 kHz is plenty: nothing
/// here cares about anything but how loud the room is, twenty times a second.
enum AudioEnvelope {
    static let sampleRate: Double = 8000
    static let hop: Double = 0.05
    static var hopSamples: Int { Int((sampleRate * hop).rounded()) } // 400

    static func build(
        url: URL,
        from: Double = 0,
        to: Double? = nil,
        progress: ((Double) -> Void)? = nil,
        isCancelled: (() -> Bool)? = nil
    ) async throws -> LoudnessEnvelope {
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        return try await build(asset: asset, from: from, to: to, progress: progress, isCancelled: isCancelled)
    }

    static func build(
        asset: AVAsset,
        from: Double = 0,
        to: Double? = nil,
        progress: ((Double) -> Void)? = nil,
        isCancelled: (() -> Bool)? = nil
    ) async throws -> LoudnessEnvelope {
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        guard let track = tracks.first else { throw AudioEnvelopeError.noAudioTrack }

        let assetDuration = try await asset.load(.duration).seconds
        let start = max(0, from)
        let end = min(to ?? assetDuration, assetDuration)
        guard end > start else { throw AudioEnvelopeError.readerFailed("the chosen stretch is empty") }
        let span = end - start

        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: start, preferredTimescale: 600),
            duration: CMTime(seconds: span, preferredTimescale: 600)
        )
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleavedKey: false,
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw AudioEnvelopeError.readerFailed("PCM conversion refused") }
        reader.add(output)
        guard reader.startReading() else {
            throw AudioEnvelopeError.readerFailed(reader.error?.localizedDescription ?? "unknown")
        }

        var db: [Double] = []
        db.reserveCapacity(Int(span / hop) + 8)

        // Samples never arrive on hop boundaries, so a carry buffer holds the
        // tail of one buffer until the next one completes the hop. Without it
        // every hop would silently lose the last few milliseconds and the
        // envelope would drift out of step with the desktop's.
        var carry: [Int16] = []
        carry.reserveCapacity(hopSamples * 2)

        func consume(_ samples: UnsafeBufferPointer<Int16>) {
            var i = 0
            if !carry.isEmpty {
                let need = hopSamples - carry.count
                let take = min(need, samples.count)
                carry.append(contentsOf: samples[0..<take])
                i = take
                if carry.count == hopSamples {
                    db.append(hopDb(carry))
                    carry.removeAll(keepingCapacity: true)
                }
            }
            while i + hopSamples <= samples.count {
                db.append(hopDb(UnsafeBufferPointer(rebasing: samples[i..<(i + hopSamples)])))
                i += hopSamples
            }
            if i < samples.count { carry.append(contentsOf: samples[i...]) }
        }

        while let buffer = output.copyNextSampleBuffer() {
            if isCancelled?() == true { reader.cancelReading(); throw CancellationError() }
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            var lengthAtOffset = 0, totalLength = 0
            var dataPointer: UnsafeMutablePointer<Int8>?
            let status = CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset,
                                                     totalLengthOut: &totalLength, dataPointerOut: &dataPointer)
            if status == kCMBlockBufferNoErr, let ptr = dataPointer, totalLength >= 2 {
                ptr.withMemoryRebound(to: Int16.self, capacity: totalLength / 2) { p in
                    consume(UnsafeBufferPointer(start: p, count: totalLength / 2))
                }
            }
            if let progress, span > 0 {
                progress(min(1, Double(db.count) * hop / span))
            }
        }

        if reader.status == .failed {
            throw AudioEnvelopeError.readerFailed(reader.error?.localizedDescription ?? "unknown")
        }
        // A trailing partial hop is dropped, matching the desktop's
        // `Math.floor(n / HOP_SAMPLES)`.
        progress?(1)
        return LoudnessEnvelope(db: db, hopSeconds: hop)
    }

    /// RMS of one hop, in dBFS. `+1e-9` keeps a fully silent hop finite, exactly
    /// as the JavaScript does.
    @inline(__always)
    private static func hopDb<C: Collection>(_ samples: C) -> Double where C.Element == Int16 {
        var sumSq = 0.0
        for s in samples { let v = Double(s); sumSq += v * v }
        let rms = (sumSq / Double(samples.count)).squareRoot()
        return 20 * log10(rms / 32768 + 1e-9)
    }
}
