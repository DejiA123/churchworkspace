import Foundation
import CoreGraphics
import CoreText
import CoreImage

/*
 * Drawing a caption line.
 *
 * The desktop hands libass a styled .ass file. There is no libass here, so the
 * words are drawn directly with Core Text into a transparent image the size of
 * the output frame, which the exporter then composites over the picture. That
 * turns out to be the better arrangement: what is drawn here is exactly what
 * lands in the file, with no subtitle renderer in between to disagree with.
 *
 * The three looks map onto the three things libass can do, with the same
 * geometry the desktop's writeAss() computes:
 *
 *   shadow  — no outline, a soft drop shadow at 6% of the font size
 *   outline — a stroke at 9% of the font size (times the look's scale), with a
 *             half-thickness shadow under it
 *   box     — a solid band behind the words, padded by 25% of the font size
 */
enum CaptionRenderer {

    /// One line, drawn into a transparent frame-sized image.
    static func image(
        for text: String,
        frameSize: CGSize,
        style: CaptionStyle,
        font family: String,
        size: CaptionSize,
        position: CaptionPosition
    ) -> CGImage? {
        let width = Int(frameSize.width.rounded())
        let height = Int(frameSize.height.rounded())
        guard width > 0, height > 0, !text.isEmpty else { return nil }

        let fontSize = (frameSize.height * size.fraction).rounded()
        let ctFont = CTFontCreateWithName(CaptionFont.postScriptName(for: family) as CFString, fontSize, nil)

        let outlinePx: CGFloat
        let shadowPx: CGFloat
        switch style.kind {
        case .box:
            // libass's boxed style spends its "outline" on the band's padding
            // rather than on a stroke around the glyphs, so the words stay crisp
            // against the band. Same here: the padding below is that 25%.
            outlinePx = 0
            shadowPx = 0
        case .outline:
            outlinePx = max(2, (fontSize * 0.09 * style.outlineScale).rounded())
            shadowPx = max(0, (outlinePx / 2).rounded())
        case .shadow:
            outlinePx = 0
            shadowPx = max(2, (fontSize * 0.06).rounded())
        }

        // A caption never runs edge to edge — 88% of the frame, wrapped, which is
        // what keeps a long line readable on a phone held at arm's length.
        let maxWidth = frameSize.width * 0.88
        let lines = wrap(text, font: ctFont, maxWidth: maxWidth)
        let lineHeight = fontSize * 1.18
        let blockHeight = lineHeight * CGFloat(lines.count)

        // Vertical placement, in the same places the desktop offers.
        let marginV = frameSize.height * 0.07
        let blockTop: CGFloat
        switch position {
        case .bottom: blockTop = frameSize.height - marginV - blockHeight
        case .center: blockTop = (frameSize.height - blockHeight) / 2
        case .top: blockTop = marginV
        }

        guard let ctx = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }

        ctx.setAllowsAntialiasing(true)
        ctx.setShouldSmoothFonts(true)
        // Core Graphics is bottom-left; everything above is measured from the top.
        ctx.translateBy(x: 0, y: CGFloat(height))
        ctx.scaleBy(x: 1, y: -1)

        for (i, line) in lines.enumerated() {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: ctFont,
                .foregroundColor: style.color.cgColor,
            ]
            let attributed = NSAttributedString(string: line, attributes: attrs)
            let ctLine = CTLineCreateWithAttributedString(attributed)
            let bounds = CTLineGetBoundsWithOptions(ctLine, .useOpticalBounds)
            let x = (frameSize.width - bounds.width) / 2 - bounds.origin.x
            let baseline = blockTop + CGFloat(i) * lineHeight + fontSize

            if style.kind == .box {
                let padX = fontSize * 0.25, padY = fontSize * 0.16
                let band = CGRect(
                    x: x + bounds.origin.x - padX,
                    y: baseline - fontSize * 0.82 - padY,
                    width: bounds.width + padX * 2,
                    height: fontSize * 1.06 + padY * 2
                )
                ctx.saveGState()
                ctx.setFillColor(style.outline.cgColor)
                let path = CGPath(roundedRect: band, cornerWidth: fontSize * 0.12, cornerHeight: fontSize * 0.12, transform: nil)
                ctx.addPath(path)
                ctx.fillPath()
                ctx.restoreGState()
            }

            // The whole glyph run is drawn into a path so the stroke and the fill
            // are the same shape — stroking text attributes directly gives a
            // centred stroke that eats into the letterforms.
            let path = glyphPath(ctLine)
            ctx.saveGState()
            ctx.translateBy(x: x, y: baseline)

            if shadowPx > 0 {
                ctx.setShadow(offset: CGSize(width: 0, height: -shadowPx * 0.6), blur: shadowPx,
                              color: CGColor(gray: 0, alpha: 0.75))
            }
            if outlinePx > 0 {
                ctx.addPath(path)
                ctx.setLineWidth(outlinePx * 2)     // half is hidden by the fill on top
                ctx.setLineJoin(.round)
                ctx.setStrokeColor(style.outline.cgColor)
                ctx.strokePath()
                ctx.setShadow(offset: .zero, blur: 0, color: nil)
            }
            ctx.addPath(path)
            ctx.setFillColor(style.color.cgColor)
            ctx.fillPath()
            ctx.restoreGState()
        }

        return ctx.makeImage()
    }

    /// The outlines of every glyph on a line, as one path with the line's own
    /// origin at (0, 0).
    private static func glyphPath(_ line: CTLine) -> CGPath {
        let out = CGMutablePath()
        guard let runs = CTLineGetGlyphRuns(line) as? [CTRun] else { return out }
        for run in runs {
            let count = CTRunGetGlyphCount(run)
            guard count > 0 else { continue }
            let attributes = CTRunGetAttributes(run) as NSDictionary
            guard let font = attributes[kCTFontAttributeName as String] else { continue }
            let ctFont = font as! CTFont
            var glyphs = [CGGlyph](repeating: 0, count: count)
            var positions = [CGPoint](repeating: .zero, count: count)
            CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
            CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
            for i in 0..<count {
                guard let g = CTFontCreatePathForGlyph(ctFont, glyphs[i], nil) else { continue }
                out.addPath(g, transform: CGAffineTransform(translationX: positions[i].x, y: positions[i].y))
            }
        }
        return out
    }

    /// Greedy word wrap against the real measured width.
    private static func wrap(_ text: String, font: CTFont, maxWidth: CGFloat) -> [String] {
        func measure(_ s: String) -> CGFloat {
            let a = NSAttributedString(string: s, attributes: [.font: font])
            return CTLineGetTypographicBounds(CTLineCreateWithAttributedString(a), nil, nil, nil)
        }
        var lines: [String] = []
        var current = ""
        for word in text.split(separator: " ") {
            let candidate = current.isEmpty ? String(word) : current + " " + word
            if measure(candidate) <= maxWidth || current.isEmpty {
                current = candidate
            } else {
                lines.append(current)
                current = String(word)
            }
        }
        if !current.isEmpty { lines.append(current) }
        return lines.isEmpty ? [text] : lines
    }
}

/// Pre-rendered caption images, looked up by the time they should be on screen.
/// Rendering happens once per line rather than once per frame — a 90-second
/// short is 2,700 frames and perhaps 60 lines.
final class CaptionTrack {
    private struct Entry {
        let start: Double
        let end: Double
        let image: CIImage
    }
    private var entries: [Entry] = []

    init(events: [CaptionEvent], frameSize: CGSize, settings: ExportSettings) {
        let style = CaptionStyle.named(settings.captionStyle)
        for e in events {
            guard let cg = CaptionRenderer.image(
                for: e.text, frameSize: frameSize, style: style,
                font: settings.captionFont, size: settings.captionSize, position: settings.captionPosition
            ) else { continue }
            entries.append(Entry(start: e.start, end: e.end, image: CIImage(cgImage: cg)))
        }
    }

    var isEmpty: Bool { entries.isEmpty }

    /// The line that should be showing at `t`, if any.
    func image(at t: Double) -> CIImage? {
        // Lines are in order and never overlap, so a scan from the front is
        // fine; the exporter walks time forwards anyway.
        for e in entries where t >= e.start && t < e.end { return e.image }
        return nil
    }
}
