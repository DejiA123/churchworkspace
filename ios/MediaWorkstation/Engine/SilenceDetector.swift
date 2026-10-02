import Foundation
import AVFoundation

/*
 * "Remove pauses" — the dead air inside a clip.
 *
 * The desktop asks ffmpeg's `silencedetect` filter for this. There is no such
 * filter on iOS, so it is reimplemented on the loudness envelope the analyser
 * already knows how to build: a silence is a run of hops at or below the noise
 * threshold lasting at least `minSilence`, padded inward so the cut does not
 * clip the breath on either side.
 *
 * The parameters below are the ones the desktop's Long-to-shorts sweep passes
 * (noise −32 dB, minimum 0.7 s, 0.12 s of padding, and nothing under a quarter
 * of a second is treated as a pause at all — that is punctuation, and cutting
 * it makes the speech sound clipped).
 */
enum SilenceDetector {

    struct Result {
        var silences: [TimeRangeSec]
        var removedSeconds: Double
    }

    static let defaultNoiseDb: Double = -32
    static let defaultMinSilence: Double = 0.7
    static let defaultPad: Double = 0.12
    /// Anything shorter than this is punctuation, not a pause.
    static let minWorthCutting: Double = 0.25

    static func detect(
        url: URL,
        startSec: Double,
        endSec: Double,
        noiseDb: Double = defaultNoiseDb,
        minSilence: Double = defaultMinSilence,
        pad: Double = defaultPad,
        progress: ((Double) -> Void)? = nil,
        isCancelled: (() -> Bool)? = nil
    ) async throws -> Result {
        let env = try await AudioEnvelope.build(
            url: url, from: startSec, to: endSec,
            progress: { progress?($0 * 0.9) }, isCancelled: isCancelled
        )
        let out = detect(envelope: env, offset: startSec, endSec: endSec,
                         noiseDb: noiseDb, minSilence: minSilence, pad: pad)
        progress?(1)
        return out
    }

    /// Pure, so it can be tested without a file.
    static func detect(
        envelope env: LoudnessEnvelope,
        offset: Double,
        endSec: Double,
        noiseDb: Double = defaultNoiseDb,
        minSilence: Double = defaultMinSilence,
        pad: Double = defaultPad
    ) -> Result {
        // Smoothed exactly as the analyser does, so a pause found here is the
        // same pause the snapper would cut on.
        let dbS = HighlightEngine.smooth(env.db, radius: 2)
        let raw = Snapper.pauseWindows(dbS: dbS, hop: env.hopSeconds, threshold: noiseDb, minDur: minSilence)

        var silences: [TimeRangeSec] = []
        for p in raw {
            let a = offset + p.s + pad
            let b = offset + p.e - pad
            if b - a < minWorthCutting { continue }        // nothing useful left after padding
            let clipped = TimeRangeSec(start: max(offset, a), end: min(endSec, b))
            if clipped.duration >= minWorthCutting { silences.append(clipped) }
        }
        return Result(silences: silences, removedSeconds: silences.reduce(0) { $0 + $1.duration })
    }
}
