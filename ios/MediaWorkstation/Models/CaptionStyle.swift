import Foundation
import CoreGraphics

/// How a caption line is drawn.
///
/// The desktop burns captions through libass, which offers three primitives:
/// a drop shadow, an outline, or a solid band behind the words. These are the
/// same twelve looks the desktop and Phone Studio pickers offer, in the same
/// order and with the same colours, so a short captioned on an iPhone is
/// indistinguishable from one captioned at the PC.
struct CaptionStyle: Identifiable, Hashable {
    typealias ID = String

    enum Kind: String { case shadow, outline, box }

    let id: ID
    let name: String
    let kind: Kind
    /// The fill colour of the words.
    let color: RGB
    /// The outline colour — and, for `.box`, the colour of the band.
    let outline: RGB
    /// Multiplier on the outline thickness (Pop and friends are chunkier).
    let outlineScale: Double

    init(_ id: ID, _ name: String, _ kind: Kind, _ color: String, _ outline: String = "#000000", _ outlineScale: Double = 1) {
        self.id = id
        self.name = name
        self.kind = kind
        self.color = RGB(hex: color)
        self.outline = RGB(hex: outline)
        self.outlineScale = outlineScale
    }

    static let all: [CaptionStyle] = [
        CaptionStyle("clean", "Clean", .shadow, "#ffffff"),
        CaptionStyle("outline", "Outline", .outline, "#ffffff", "#000000"),
        CaptionStyle("pop", "Pop", .outline, "#ffffff", "#000000", 1.7),
        CaptionStyle("sunshine", "Sunshine", .outline, "#ffe14d", "#000000", 1.4),
        CaptionStyle("neon", "Neon", .outline, "#2ff3ff", "#062a33", 1.5),
        CaptionStyle("mint", "Mint", .outline, "#57ff9b", "#04331b", 1.4),
        CaptionStyle("candy", "Candy", .outline, "#ff77d4", "#2c0722", 1.4),
        CaptionStyle("fire", "Fire", .outline, "#ff8b34", "#2b0e00", 1.4),
        CaptionStyle("band", "Band", .box, "#ffffff", "#000000"),
        CaptionStyle("highlight", "Highlight", .box, "#000000", "#ffe14d"),
        CaptionStyle("royal", "Royal", .box, "#ffffff", "#7b3ff2"),
        CaptionStyle("preach", "Preach", .box, "#ffffff", "#c1121f"),
    ]

    static func named(_ id: ID) -> CaptionStyle {
        all.first { $0.id == id } ?? all[1]
    }
}

/// A colour that can cross a JSON boundary and become a CGColor.
struct RGB: Hashable {
    var r: Double, g: Double, b: Double

    init(r: Double, g: Double, b: Double) { self.r = r; self.g = g; self.b = b }

    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        let v = UInt32(s, radix: 16) ?? 0xFFFFFF
        r = Double((v >> 16) & 0xFF) / 255
        g = Double((v >> 8) & 0xFF) / 255
        b = Double(v & 0xFF) / 255
    }

    var cgColor: CGColor {
        CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: [r, g, b, 1])
            ?? CGColor(gray: 1, alpha: 1)
    }
}

/// Caption size as a fraction of the frame HEIGHT — the same four steps and the
/// same fractions the desktop's `SIZE_PCT` uses, so the words come out the same
/// size on the same output.
enum CaptionSize: String, CaseIterable, Codable, Identifiable {
    case small = "s", medium = "m", large = "l", extraLarge = "xl"
    var id: String { rawValue }
    var fraction: Double {
        switch self {
        case .small: return 0.045
        case .medium: return 0.058
        case .large: return 0.072
        case .extraLarge: return 0.088
        }
    }
    var label: String {
        switch self {
        case .small: return "Small"
        case .medium: return "Medium"
        case .large: return "Large"
        case .extraLarge: return "Extra large"
        }
    }
}

enum CaptionPosition: String, CaseIterable, Codable, Identifiable {
    case bottom, center, top
    var id: String { rawValue }
    var label: String {
        switch self {
        case .bottom: return "Bottom"
        case .center: return "Middle"
        case .top: return "Top"
        }
    }
}

enum WordsPerLine: String, CaseIterable, Codable, Identifiable {
    case auto, one = "1", two = "2", three = "3", four = "4"
    var id: String { rawValue }
    var label: String { self == .auto ? "Auto" : rawValue }
    var count: Int? { self == .auto ? nil : Int(rawValue) }
}

enum TextCase: String, CaseIterable, Codable, Identifiable {
    case none, upper, title, lower
    var id: String { rawValue }
    var label: String {
        switch self {
        case .none: return "As spoken"
        case .upper: return "UPPERCASE"
        case .title: return "Title Case"
        case .lower: return "lowercase"
        }
    }
}

/// The typefaces the desktop bundles for captions. On iOS the first four are
/// shipped in the app bundle (see BUILD-IOS.md); Helvetica always exists.
enum CaptionFont {
    static let names = ["Bebas Neue", "Anton", "Poppins", "Bangers", "Helvetica"]

    /// The PostScript name Core Text wants, for the family name a user picked.
    static func postScriptName(for family: String) -> String {
        switch family {
        case "Bebas Neue": return "BebasNeue-Regular"
        case "Anton": return "Anton-Regular"
        case "Poppins": return "Poppins-Bold"
        case "Bangers": return "Bangers-Regular"
        default: return "Helvetica-Bold"
        }
    }
}
