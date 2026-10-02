import Foundation
import AVFoundation
import CoreImage

/*
 * RENDERING A SHORT.
 *
 * The desktop does this as a chain of ffmpeg passes: cut, reframe, burn
 * captions, mix music, append the outro — each one re-encoding the last one's
 * output. On iOS that would be both slower and worse (every pass is another
 * generation of compression), so this does the whole thing in ONE pass:
 *
 *   AVMutableComposition   the kept pieces, back to back, plus the outro
 *   + a CIImage pipeline   crop / blur-fill / letterbox, the moving reframe
 *                          window, captions, fade in and out
 *   + AVMutableAudioMix    the music bed under the voice, with its own fades
 *   → AVAssetExportSession hardware H.264 through VideoToolbox
 *
 * One decode, one encode. That is why a phone can do this at all.
 */

enum ExportError: LocalizedError {
    case noVideoTrack
    case sessionRefused
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .noVideoTrack: return "That file has no picture in it."
        case .sessionRefused: return "This device could not start an export — try closing other apps."
        case .failed(let why): return why
        }
    }
}

struct ExportRequest {
    var sourceURL: URL
    /// The stretches of the source to keep, in order. With pauses removed this
    /// is several pieces; otherwise one.
    var pieces: [TimeRangeSec]
    var settings: ExportSettings
    /// Captions in FINISHED-CLIP time (0 = the first frame of the export).
    var captions: [CaptionEvent] = []
    /// The reframe path, in finished-clip time. Empty = a centred crop.
    var keyframes: [CropKeyframe] = []
    var outputName: String = "short"
}

enum Exporter {

    /// Shorts are capped at 30 fps, like the desktop's — a 60 fps vertical clip
    /// is twice the file for something every platform re-encodes anyway.
    static let maxFrameRate: Int32 = 30

    static func export(
        _ request: ExportRequest,
        progress: ((Double) -> Void)? = nil,
        isCancelled: (() -> Bool)? = nil
    ) async throws -> URL {
        let asset = AVURLAsset(url: request.sourceURL, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let sourceVideo = try await asset.loadTracks(withMediaType: .video).first else {
            throw ExportError.noVideoTrack
        }
        let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first

        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw ExportError.failed("could not build the timeline")
        }
        let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)

        // 1. The kept pieces, back to back. Dropping the pauses is just an
        //    absence here — no intermediate file, no second encode.
        var cursor = CMTime.zero
        for piece in request.pieces where piece.duration > 0.02 {
            let range = CMTimeRange(
                start: CMTime(seconds: piece.start, preferredTimescale: 600),
                duration: CMTime(seconds: piece.duration, preferredTimescale: 600)
            )
            try videoTrack.insertTimeRange(range, of: sourceVideo, at: cursor)
            if let sourceAudio, let audioTrack {
                try? audioTrack.insertTimeRange(range, of: sourceAudio, at: cursor)
            }
            cursor = cursor + range.duration
        }
        let bodyDuration = cursor

        // 2. The outro, if there is one. Appended to the same tracks so it comes
        //    out of the single encode below rather than a concatenation pass.
        var outroStart: CMTime?
        if let outroURL = request.settings.outroURL {
            let outro = AVURLAsset(url: outroURL)
            let outroVideo = (try? await outro.loadTracks(withMediaType: .video))?.first
            if let outroVideo, let dur = try? await outro.load(.duration), dur.seconds > 0.05 {
                let range = CMTimeRange(start: .zero, duration: dur)
                outroStart = cursor
                try? videoTrack.insertTimeRange(range, of: outroVideo, at: cursor)
                if let outroAudio = (try? await outro.loadTracks(withMediaType: .audio))?.first, let audioTrack {
                    try? audioTrack.insertTimeRange(range, of: outroAudio, at: cursor)
                }
                cursor = cursor + dur
            }
        }
        let totalDuration = cursor
        let totalSeconds = totalDuration.seconds

        // 3. What shape are we rendering into?
        let naturalSize = try await sourceVideo.load(.naturalSize)
        let preferred = try await sourceVideo.load(.preferredTransform)
        let orientedSize = naturalSize.applying(preferred).absoluteSize
        let renderSize = request.settings.preset.size.map { even($0) } ?? even(orientedSize)

        // 4. The picture pipeline. A CIImage handler rather than layer
        //    instructions, because a blurred-background fill and burned captions
        //    are both compositing work that transform ramps cannot express — and
        //    doing them here keeps everything in the one pass.
        let captionTrack = CaptionTrack(events: request.captions, frameSize: renderSize, settings: request.settings)
        let keyframes = request.keyframes
        let settings = request.settings
        let fadeIn = settings.fadeIn
        let fadeOut = settings.fadeOut

        let videoComposition = AVMutableVideoComposition.videoComposition(with: composition) { filterRequest in
            let t = filterRequest.compositionTime.seconds
            let source = filterRequest.sourceImage
            var output = fit(source, into: renderSize, mode: settings.fill,
                             centre: centre(of: keyframes, at: t, sourceExtent: source.extent))

            if let caption = captionTrack.image(at: t) {
                output = caption.composited(over: output)
            }
            if fadeIn > 0 && t < fadeIn {
                output = darken(output, by: 1 - t / fadeIn, size: renderSize)
            }
            if fadeOut > 0 && t > totalSeconds - fadeOut {
                output = darken(output, by: 1 - max(0, (totalSeconds - t) / fadeOut), size: renderSize)
            }
            filterRequest.finish(with: output.cropped(to: CGRect(origin: .zero, size: renderSize)), context: nil)
        }
        videoComposition.renderSize = renderSize
        let sourceFPS = (try? await sourceVideo.load(.nominalFrameRate)) ?? 30
        let fps = max(1, min(maxFrameRate, Int32(sourceFPS.rounded())))
        videoComposition.frameDuration = CMTime(value: 1, timescale: fps)

        // 5. Audio: the voice, and a music bed under it.
        let audioMix = AVMutableAudioMix()
        var params: [AVMutableAudioMixInputParameters] = []
        if let audioTrack {
            let p = AVMutableAudioMixInputParameters(track: audioTrack)
            p.setVolume(1, at: .zero)
            if fadeIn > 0 {
                p.setVolumeRamp(fromStartVolume: 0, toEndVolume: 1,
                                timeRange: CMTimeRange(start: .zero, duration: CMTime(seconds: fadeIn, preferredTimescale: 600)))
            }
            if fadeOut > 0 {
                let start = CMTime(seconds: max(0, totalSeconds - fadeOut), preferredTimescale: 600)
                p.setVolumeRamp(fromStartVolume: 1, toEndVolume: 0,
                                timeRange: CMTimeRange(start: start, duration: CMTime(seconds: fadeOut, preferredTimescale: 600)))
            }
            params.append(p)
        }
        if let musicURL = settings.musicURL,
           let musicTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            let music = AVURLAsset(url: musicURL)
            if let mt = try? await music.loadTracks(withMediaType: .audio).first, let mt {
                let musicDuration = try await music.load(.duration)
                // Loop the bed to fill the clip, the way the desktop's
                // `-stream_loop` does.
                var at = CMTime.zero
                while at < bodyDuration && musicDuration.seconds > 0.1 {
                    let take = min(musicDuration, bodyDuration - at)
                    try? musicTrack.insertTimeRange(CMTimeRange(start: .zero, duration: take), of: mt, at: at)
                    at = at + take
                }
                let p = AVMutableAudioMixInputParameters(track: musicTrack)
                let vol = Float(max(0, min(1, settings.musicVolume)))
                p.setVolume(vol, at: .zero)
                // Fade the bed out under the outro rather than letting two pieces
                // of music collide.
                if let outroStart {
                    p.setVolumeRamp(fromStartVolume: vol, toEndVolume: 0,
                                    timeRange: CMTimeRange(start: max(.zero, outroStart - CMTime(seconds: 1, preferredTimescale: 600)),
                                                           duration: CMTime(seconds: 1, preferredTimescale: 600)))
                }
                params.append(p)
            }
        }
        audioMix.inputParameters = params

        // 6. One encode, hardware, through VideoToolbox.
        guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
            throw ExportError.sessionRefused
        }
        session.videoComposition = videoComposition
        if !params.isEmpty { session.audioMix = audioMix }
        session.shouldOptimizeForNetworkUse = true

        let output = outputURL(named: request.outputName)
        let watcher = Task {
            while !Task.isCancelled {
                progress?(Double(session.progress))
                if isCancelled?() == true { session.cancelExport(); return }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
        defer { watcher.cancel() }

        try await session.runExport(to: output, fileType: .mp4)
        progress?(1)
        return output
    }

    // MARK: - picture maths

    /// The crop centre at time `t`, interpolated between keyframes exactly as
    /// the desktop's piecewise-linear ffmpeg crop expression does. No keyframes
    /// means a centred crop.
    static func centre(of keyframes: [CropKeyframe], at t: Double, sourceExtent: CGRect) -> CGPoint {
        guard !keyframes.isEmpty else { return CGPoint(x: sourceExtent.midX, y: sourceExtent.midY) }
        if t <= keyframes[0].t { return flip(keyframes[0], in: sourceExtent) }
        if let last = keyframes.last, t >= last.t { return flip(last, in: sourceExtent) }
        var lo = 0, hi = keyframes.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if keyframes[mid].t <= t { lo = mid } else { hi = mid }
        }
        let a = keyframes[lo], b = keyframes[hi]
        let span = max(1e-6, b.t - a.t)
        let r = (t - a.t) / span
        let x = a.x + (b.x - a.x) * r
        let y = a.y + (b.y - a.y) * r
        return flip(CropKeyframe(t: t, x: x, y: y), in: sourceExtent)
    }

    /// Keyframes are top-left (the tracker's world, and ffmpeg's); Core Image is
    /// bottom-left.
    private static func flip(_ k: CropKeyframe, in extent: CGRect) -> CGPoint {
        CGPoint(x: extent.minX + CGFloat(k.x), y: extent.maxY - CGFloat(k.y))
    }

    /// Put a source frame into the output frame: cropped in, letterboxed, or
    /// filled with a blurred copy of itself.
    static func fit(_ source: CIImage, into size: CGSize, mode: FillMode, centre: CGPoint) -> CIImage {
        let src = source.extent
        guard src.width > 0, src.height > 0 else { return source }

        /// Scale the source and place it so that `focus` (a point in SOURCE
        /// coordinates) lands at `target` in the output frame, without ever
        /// letting an edge of the picture come inside the frame.
        func place(scale: CGFloat, focus: CGPoint, clampToFrame: Bool) -> CIImage {
            var dx = size.width / 2 - focus.x * scale
            var dy = size.height / 2 - focus.y * scale
            if clampToFrame {
                let originLoX = size.width - src.width * scale - src.minX * scale
                let originHiX = -src.minX * scale
                let originLoY = size.height - src.height * scale - src.minY * scale
                let originHiY = -src.minY * scale
                dx = min(originHiX, max(originLoX, dx))
                dy = min(originHiY, max(originLoY, dy))
            }
            return source.transformed(by: CGAffineTransform(scaleX: scale, y: scale)
                .concatenating(CGAffineTransform(translationX: dx, y: dy)))
        }

        let coverScale = max(size.width / src.width, size.height / src.height)
        let fitScale = min(size.width / src.width, size.height / src.height)
        let middle = CGPoint(x: src.midX, y: src.midY)

        switch mode {
        case .crop:
            // Cover the frame, then slide the picture so the tracked centre sits
            // in the middle — clamped so a crop near an edge shows picture, not
            // background.
            return place(scale: coverScale, focus: centre, clampToFrame: true)

        case .bars:
            return place(scale: fitScale, focus: middle, clampToFrame: false)
                .composited(over: black(size))

        case .blur:
            // A background made only of the edges of a wide picture looks washed
            // out, so it gets a little saturation back, and is dimmed so the
            // foreground still reads — the same two adjustments the desktop's
            // blur fill makes.
            let background = place(scale: coverScale, focus: middle, clampToFrame: false)
                .clampedToExtent()
                .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: size.width * 0.045])
                .cropped(to: CGRect(origin: .zero, size: size))
                .applyingFilter("CIColorControls", parameters: [
                    kCIInputSaturationKey: 1.15,
                    kCIInputBrightnessKey: -0.18,
                ])
            return place(scale: fitScale, focus: middle, clampToFrame: false)
                .composited(over: background)
        }
    }

    private static func black(_ size: CGSize) -> CIImage {
        CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 1))
            .cropped(to: CGRect(origin: .zero, size: size))
    }

    /// Mix `amount` of black over the frame — the fade.
    private static func darken(_ image: CIImage, by amount: Double, size: CGSize) -> CIImage {
        let a = CGFloat(max(0, min(1, amount)))
        guard a > 0.001 else { return image }
        let veil = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: a))
            .cropped(to: CGRect(origin: .zero, size: size))
        return veil.composited(over: image)
    }

    /// H.264 wants even dimensions.
    private static func even(_ s: CGSize) -> CGSize {
        CGSize(width: max(2, (s.width / 2).rounded() * 2), height: max(2, (s.height / 2).rounded() * 2))
    }

    static func outputURL(named name: String) -> URL {
        let safe = name.replacingOccurrences(of: "[^A-Za-z0-9._-]+", with: "_", options: .regularExpression)
            .prefix(40)
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "")
            .replacingOccurrences(of: "-", with: "")
        return AppFolders.exports.appendingPathComponent("short-\(safe)-\(stamp).mp4")
    }
}

private extension CGSize {
    /// A size that has been through a preferredTransform can come out negative.
    var absoluteSize: CGSize { CGSize(width: abs(width), height: abs(height)) }
}

/// Where the app keeps things.
enum AppFolders {
    static var documents: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
    static var exports: URL {
        let url = documents.appendingPathComponent("Exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    static var imported: URL {
        let url = documents.appendingPathComponent("Imported", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    static var media: URL {
        let url = documents.appendingPathComponent("Media", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
