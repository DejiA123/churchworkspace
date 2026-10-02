import Foundation

/*
 * Words → caption lines.
 *
 * A byte-for-byte port of the grouping rule the desktop and Phone Studio both
 * use (veditor.js `groupWords` / `cleanCapText` / `transformCase`), so the same
 * transcript produces the same lines wherever it is captioned.
 *
 * The punctuation rule is the interesting one, and it is deliberate: a caption
 * line holds three or four words for about a second and a half, and the line
 * break IS the pause. A full stop hanging off "THE END GOAL." is pure visual
 * noise, and speech recognisers sprinkle commas and quotes liberally. So none
 * of them are ever drawn — except a decimal point between two digits, because
 * "3.5" is a number, not a sentence.
 */
enum CaptionBuilder {

    static func build(words: [TimedWord], wordsPerLine: WordsPerLine, textCase: TextCase) -> [CaptionEvent] {
        var events: [CaptionEvent] = []

        func push(_ group: [TimedWord]) {
            guard let first = group.first, let last = group.last else { return }
            let joined = group.map(\.text).joined(separator: " ")
            let text = clean(transform(joined, textCase))
            guard !text.isEmpty else { return }
            events.append(CaptionEvent(start: first.start, end: last.end, text: text))
        }

        if let n = wordsPerLine.count {
            var i = 0
            while i < words.count {
                push(Array(words[i..<min(i + n, words.count)]))
                i += n
            }
        } else {
            // Auto: break on punctuation, or at six words, whichever comes first.
            var cur: [TimedWord] = []
            for w in words {
                cur.append(w)
                if cur.count >= 6 || w.text.range(of: "[.?!,]$", options: .regularExpression) != nil {
                    push(cur); cur = []
                }
            }
            push(cur)
        }
        return events
    }

    static func transform(_ t: String, _ c: TextCase) -> String {
        switch c {
        case .upper: return t.uppercased()
        case .lower: return t.lowercased()
        case .none: return t
        case .title:
            return t.split(separator: " ", omittingEmptySubsequences: false).map { word -> String in
                guard let f = word.first else { return String(word) }
                return String(f).uppercased() + word.dropFirst().lowercased()
            }.joined(separator: " ")
        }
    }

    /// Strip the punctuation that earns nothing on screen.
    static func clean(_ input: String) -> String {
        var out = ""
        out.reserveCapacity(input.count)
        let chars = Array(input)

        // Quotes of every shape, question marks, and the ellipsis.
        let dropped: Set<Character> = ["\"", "\u{201C}", "\u{201D}", "\u{201E}", "\u{201F}",
                                       "«", "»", "‹", "›", "\u{2033}", "\u{FF02}", "\u{2018}",
                                       "?", "\u{FF1F}", "¿"]
        let spaced: Set<Character> = ["\u{2026}", "\u{22EF}"]        // … ⋯ read as a pause
        let stops: Set<Character> = [".", ",", "\u{3002}", "\u{FF0E}", "\u{FF0C}", "\u{3001}"]

        for (i, ch) in chars.enumerated() {
            if ch == "\u{2019}" || ch == "\u{02BC}" { out.append("'"); continue }  // curly apostrophe is part of the WORD
            if dropped.contains(ch) { continue }
            if spaced.contains(ch) { out.append(" "); continue }
            if stops.contains(ch) {
                // Keep it only between two digits: "3.5" survives, "goal." does not.
                let prev = i > 0 ? chars[i - 1] : " "
                let next = i + 1 < chars.count ? chars[i + 1] : " "
                if prev.isNumber && next.isNumber { out.append(ch) }
                continue
            }
            out.append(ch)
        }
        return out.split(separator: " ", omittingEmptySubsequences: true)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
