import XCTest
#if canImport(MWEngine)
@testable import MWEngine
#else
@testable import MediaWorkstation
#endif

/*
 * The caption text rule, held to the desktop's.
 *
 * Every expectation here is what veditor.js `cleanCapText` / `transformCase` /
 * `groupWords` produce for the same input — the rule is shared by the Windows
 * app, the Phone Studio web page, and this. If one of them starts drawing full
 * stops, a short captioned on a phone stops matching one captioned at the PC.
 */
final class CaptionBuilderTests: XCTestCase {

    // MARK: - the punctuation rule

    func testFullStopsAndCommasAreNeverDrawn() {
        XCTAssertEqual(CaptionBuilder.clean("THE END GOAL."), "THE END GOAL")
        XCTAssertEqual(CaptionBuilder.clean("well, then, we go"), "well then we go")
    }

    func testADecimalPointBetweenDigitsSurvives() {
        // "3.5" is a number, not a sentence — the one exception in the rule.
        XCTAssertEqual(CaptionBuilder.clean("in 3.5 years"), "in 3.5 years")
        XCTAssertEqual(CaptionBuilder.clean("2,500 people"), "2,500 people")
    }

    func testQuotesAndQuestionMarksGo() {
        XCTAssertEqual(CaptionBuilder.clean("he said \u{201C}come\u{201D}"), "he said come")
        XCTAssertEqual(CaptionBuilder.clean("do you believe?"), "do you believe")
    }

    func testACurlyApostropheBecomesAStraightOneRatherThanVanishing() {
        // It is part of the WORD; dropping it turns "don't" into "dont".
        XCTAssertEqual(CaptionBuilder.clean("don\u{2019}t stop"), "don't stop")
    }

    func testAnEllipsisReadsAsAPause() {
        XCTAssertEqual(CaptionBuilder.clean("wait\u{2026}for it"), "wait for it")
    }

    // MARK: - case

    func testCaseTransforms() {
        XCTAssertEqual(CaptionBuilder.transform("god is good", .upper), "GOD IS GOOD")
        XCTAssertEqual(CaptionBuilder.transform("GOD IS GOOD", .lower), "god is good")
        XCTAssertEqual(CaptionBuilder.transform("god IS good", .title), "God Is Good")
        XCTAssertEqual(CaptionBuilder.transform("god IS good", .none), "god IS good")
    }

    // MARK: - grouping

    private func words(_ text: String) -> [TimedWord] {
        text.split(separator: " ").enumerated().map { i, w in
            TimedWord(start: Double(i) * 0.5, end: Double(i) * 0.5 + 0.5, text: String(w))
        }
    }

    func testFixedWordsPerLine() {
        let events = CaptionBuilder.build(words: words("one two three four five six seven"),
                                          wordsPerLine: .three, textCase: .none)
        XCTAssertEqual(events.map(\.text), ["one two three", "four five six", "seven"])
        XCTAssertEqual(events[0].start, 0, accuracy: 1e-9)
        XCTAssertEqual(events[0].end, 1.5, accuracy: 1e-9)
        XCTAssertEqual(events[1].start, 1.5, accuracy: 1e-9)
    }

    func testAutoBreaksOnPunctuationOrAtSixWords() {
        let events = CaptionBuilder.build(words: words("but he said, and then it kept going on and on"),
                                          wordsPerLine: .auto, textCase: .none)
        // Breaks after the comma, then every six words.
        XCTAssertEqual(events.first?.text, "but he said")
        XCTAssertTrue(events.dropFirst().allSatisfy { $0.text.split(separator: " ").count <= 6 })
    }

    func testALineThatCleansAwayToNothingIsDropped() {
        // A caption of nothing but a comma must not become an empty flash on the
        // video.
        let events = CaptionBuilder.build(words: words(", ."), wordsPerLine: .one, textCase: .none)
        XCTAssertTrue(events.isEmpty)
    }

    func testTimingSpansTheWholeGroup() {
        let events = CaptionBuilder.build(words: words("a b c d"), wordsPerLine: .two, textCase: .upper)
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[0].text, "A B")
        XCTAssertEqual(events[1].start, 1.0, accuracy: 1e-9)
        XCTAssertEqual(events[1].end, 2.0, accuracy: 1e-9)
    }
}

/// The pause detector that "remove pauses" is built on.
final class SilenceDetectorTests: XCTestCase {

    /// Twelve seconds at 20 hops/s, loud except for a clear 3.0–5.0 s pause and
    /// a 0.3 s breath at 8 s that must NOT be cut (cutting punctuation-length
    /// gaps is what makes speech sound clipped).
    private func envelope() -> LoudnessEnvelope {
        var db = [Double](repeating: -10, count: 240)
        for hop in 60..<100 { db[hop] = -55 }
        for hop in 160..<166 { db[hop] = -55 }
        return LoudnessEnvelope(db: db, hopSeconds: 0.05)
    }

    func testFindsTheRealPauseAndIgnoresTheBreath() {
        let result = SilenceDetector.detect(envelope: envelope(), offset: 0, endSec: 12)
        XCTAssertEqual(result.silences.count, 1)
        let pause = try? XCTUnwrap(result.silences.first)
        XCTAssertEqual(pause?.start ?? 0, 3.0 + SilenceDetector.defaultPad, accuracy: 0.12)
        XCTAssertEqual(pause?.end ?? 0, 5.0 - SilenceDetector.defaultPad, accuracy: 0.12)
    }

    func testTheCutIsPaddedInwardsSoTheBreathIsNotClipped() {
        let result = SilenceDetector.detect(envelope: envelope(), offset: 0, endSec: 12)
        let pause = result.silences[0]
        XCTAssertGreaterThan(pause.start, 3.0, "the cut must start INSIDE the silence")
        XCTAssertLessThan(pause.end, 5.0, "and end inside it")
    }

    func testKeptPiecesAreWhatSurvivesTheCuts() {
        var clip = Clip(start: 10, end: 40, label: "test")
        clip.cuts = [TimeRangeSec(start: 18, end: 22), TimeRangeSec(start: 30, end: 33)]
        let pieces = clip.keptPieces
        XCTAssertEqual(pieces.count, 3)
        XCTAssertEqual(pieces[0].start, 10); XCTAssertEqual(pieces[0].end, 18)
        XCTAssertEqual(pieces[1].start, 22); XCTAssertEqual(pieces[1].end, 30)
        XCTAssertEqual(pieces[2].start, 33); XCTAssertEqual(pieces[2].end, 40)
        XCTAssertEqual(clip.removedSeconds, 7, accuracy: 1e-9)
        XCTAssertEqual(pieces.reduce(0) { $0 + $1.duration }, 23, accuracy: 1e-9)
    }

    func testAClipWithNoCutsIsOnePiece() {
        let clip = Clip(start: 5, end: 15, label: "test")
        XCTAssertEqual(clip.keptPieces.count, 1)
        XCTAssertEqual(clip.keptPieces[0].duration, 10, accuracy: 1e-9)
    }
}
