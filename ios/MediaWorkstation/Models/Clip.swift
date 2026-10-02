import Foundation
import CoreGraphics

/// One social clip cut out of a long recording.
///
/// `start`/`end` are seconds on the SOURCE recording's clock, exactly like the
/// desktop studio's segments — every export cuts from the original file, so a
/// clip never has to know about intermediates.
struct Clip: Identifiable, Codable, Hashable {
    var id = UUID()
    var start: Double
    var end: Double
    var label: String
    /// Rank in the analyser's output (1 = the analyser's own best pick).
    var rank: Int = 1
    /// 35–99 "viral potential" for the card badge.
    var virality: Int = 0
    /// Plain-English reasons behind the badge.
    var reasons: [String] = []
    /// The line the clip is built around, when the words were read.
    var quote: String?
    /// True when both cuts landed in real silence rather than mid-word.
    var cleanCut: Bool = false
    /// Pauses the user asked to remove, in source seconds.
    var cuts: [TimeRangeSec] = []
    /// Captions for this clip, in CLIP-relative seconds.
    var captions: [CaptionEvent] = []

    var duration: Double { max(0, end - start) }

    /// The stretches that survive once the pauses are dropped — the desktop's
    /// `keptPieces`, and the thing the exporter actually stitches.
    var keptPieces: [TimeRangeSec] {
        guard !cuts.isEmpty else { return [TimeRangeSec(start: start, end: end)] }
        var out: [TimeRangeSec] = []
        var t = start
        for cut in cuts.sorted(by: { $0.start < $1.start }) {
            let a = max(start, cut.start), b = min(end, cut.end)
            if b <= a { continue }
            if a > t { out.append(TimeRangeSec(start: t, end: a)) }
            t = max(t, b)
        }
        if t < end { out.append(TimeRangeSec(start: t, end: end)) }
        return out.isEmpty ? [TimeRangeSec(start: start, end: end)] : out
    }

    var removedSeconds: Double { cuts.reduce(0) { $0 + max(0, $1.end - $1.start) } }
}

struct TimeRangeSec: Codable, Hashable {
    var start: Double
    var end: Double
    var duration: Double { max(0, end - start) }
}

/// One line of burned-in caption. Times are relative to the clip it belongs to,
/// which is exactly what the speech recogniser returns for a ranged transcript.
struct CaptionEvent: Identifiable, Codable, Hashable {
    var id = UUID()
    var start: Double
    var end: Double
    var text: String
}

/// A word with its own timing, before it is grouped into caption lines.
struct TimedWord: Codable, Hashable {
    var start: Double
    var end: Double
    var text: String
}

/// The output shapes, matching the desktop's `video.PRESETS` so a clip cut on a
/// phone is the same size as one cut at the PC.
enum ExportPreset: String, CaseIterable, Codable, Identifiable {
    case reel9x16 = "reel-9x16"
    case square1x1 = "square-1x1"
    case portrait4x5 = "portrait-4x5"
    case wide16x9 = "wide-16x9"
    /// Keep the recording's own shape (used by "export just this trim").
    case source

    var id: String { rawValue }

    var label: String {
        switch self {
        case .reel9x16: return "Reel / TikTok / Short (9:16)"
        case .square1x1: return "Square feed (1:1)"
        case .portrait4x5: return "Portrait feed (4:5)"
        case .wide16x9: return "Landscape / YouTube (16:9)"
        case .source: return "Same shape as the recording"
        }
    }

    /// Render size, or nil for `.source` (which follows the input).
    var size: CGSize? {
        switch self {
        case .reel9x16: return CGSize(width: 1080, height: 1920)
        case .square1x1: return CGSize(width: 1080, height: 1080)
        case .portrait4x5: return CGSize(width: 1080, height: 1350)
        case .wide16x9: return CGSize(width: 1920, height: 1080)
        case .source: return nil
        }
    }

    var aspect: Double? {
        guard let s = size else { return nil }
        return s.width / s.height
    }
}

/// How the picture is fitted into a frame of a different shape. Mirrors the
/// desktop's FILL_MODES.
enum FillMode: String, CaseIterable, Codable, Identifiable {
    case crop, blur, bars
    var id: String { rawValue }
    var label: String {
        switch self {
        case .crop: return "Crop in (no bars)"
        case .blur: return "Blurred background"
        case .bars: return "Black bars"
        }
    }
}

/// Everything that is true of an export regardless of which clip it is.
struct ExportSettings: Codable, Hashable {
    var preset: ExportPreset = .reel9x16
    var fill: FillMode = .crop
    /// Follow the speaker. Only meaningful when the frame is being cropped —
    /// a letterboxed export shows the whole picture, so there is nothing to pan.
    var followSpeaker: Bool = true
    var fadeIn: Double = 0
    var fadeOut: Double = 0
    var musicURL: URL?
    var musicVolume: Double = 0.25
    var outroURL: URL?
    var captionsOnEveryShort: Bool = false
    var captionStyle: CaptionStyle.ID = "outline"
    var captionFont: String = "Bebas Neue"
    var captionSize: CaptionSize = .medium
    var captionPosition: CaptionPosition = .bottom
    var wordsPerLine: WordsPerLine = .three
    var textCase: TextCase = .upper

    var reframeActive: Bool { followSpeaker && fill == .crop }
}
