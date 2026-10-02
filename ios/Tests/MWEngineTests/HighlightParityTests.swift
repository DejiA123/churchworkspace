import XCTest
#if canImport(MWEngine)
@testable import MWEngine
#else
@testable import MediaWorkstation
#endif

/*
 * The Swift analyser must agree with the JavaScript one.
 *
 * The iPhone app re-implements src/main/highlights.js. Two copies of an
 * algorithm drift, and when they drift here the symptom is not a crash — it is
 * a phone quietly choosing different moments out of the same sermon than the PC
 * does, which nobody notices until someone compares two exports side by side.
 *
 * Fixtures/highlight-parity.json is captured from the REAL JavaScript engine
 * (ios/Tools/make-parity-fixture.js) and holds the loudness envelope it worked
 * from plus the clips it chose. Feeding the Swift engine that same envelope
 * isolates the analysis: a decoder difference cannot cause or hide a failure.
 *
 * Regenerate the fixture after any deliberate change to the JS engine:
 *
 *     node ios/Tools/make-parity-fixture.js
 */
final class HighlightParityTests: XCTestCase {

    struct Fixture: Decodable {
        struct FixtureClip: Decodable {
            let start: Double
            let end: Double
            let durationSec: Double
            let rank: Int
            let virality: Int
            let reasons: [String]
        }
        struct Options: Decodable {
            let minLen: Double
            let maxLen: Double
            let idealLen: Double
            let maxClips: Int
            let autoLen: Bool
        }
        struct Case: Decodable {
            let name: String
            let options: Options
            let clips: [FixtureClip]
        }
        let hopSeconds: Double
        let db: [Double]
        let loudRegions: [[Double]]
        let cases: [Case]
    }

    private var fixture: Fixture!

    /// `swift test` finds resources through Bundle.module; the Xcode test
    /// target has no such bundle and looks in its own.
    private var resourceBundle: Bundle {
        #if SWIFT_PACKAGE
        return Bundle.module
        #else
        return Bundle(for: Self.self)
        #endif
    }

    override func setUpWithError() throws {
        let url = try XCTUnwrap(
            resourceBundle.url(forResource: "highlight-parity", withExtension: "json", subdirectory: "Fixtures")
                ?? resourceBundle.url(forResource: "highlight-parity", withExtension: "json"),
            "highlight-parity.json is missing — run `node ios/Tools/make-parity-fixture.js`"
        )
        fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    // MARK: - the parity test proper

    func testSwiftEngineChoosesTheSameClipsAsJavaScript() throws {
        let envelope = LoudnessEnvelope(db: fixture.db, hopSeconds: fixture.hopSeconds)

        for testCase in fixture.cases {
            var options = HighlightOptions()
            options.minLen = testCase.options.minLen
            options.maxLen = testCase.options.maxLen
            options.idealLen = testCase.options.idealLen
            options.maxClips = testCase.options.maxClips
            options.autoLen = testCase.options.autoLen

            let result = try HighlightEngine.analyze(envelope: envelope, options: options)

            XCTAssertEqual(result.clips.count, testCase.clips.count,
                           "\(testCase.name): different NUMBER of clips than the desktop chose")
            guard result.clips.count == testCase.clips.count else { continue }

            for (swift, js) in zip(result.clips, testCase.clips) {
                // A tenth of a second is the resolution the JS engine rounds its
                // own output to, so anything inside that is the same decision.
                XCTAssertEqual(swift.start, js.start, accuracy: 0.11,
                               "\(testCase.name): clip start differs")
                XCTAssertEqual(swift.end, js.end, accuracy: 0.11,
                               "\(testCase.name): clip end differs")
                // The badge ranks clips against each other; more than a point of
                // drift would mean the scoring diverged.
                XCTAssertLessThanOrEqual(abs(swift.virality - js.virality), 1,
                                         "\(testCase.name): viral score differs (\(swift.virality) vs \(js.virality))")
                XCTAssertEqual(swift.reasons, js.reasons,
                               "\(testCase.name): the reasons shown on the card differ")
            }
        }
    }

    /// Independent of the fixture: the clips must actually cover the moments
    /// that were planted in the synthetic sermon. This is what stops both
    /// engines being wrong together.
    func testClipsLandOnThePlantedLoudMoments() throws {
        let envelope = LoudnessEnvelope(db: fixture.db, hopSeconds: fixture.hopSeconds)
        var options = HighlightOptions()
        options.minLen = 18; options.idealLen = 30; options.maxLen = 48; options.maxClips = 5

        let result = try HighlightEngine.analyze(envelope: envelope, options: options)
        for region in fixture.loudRegions {
            let a = region[0], b = region[1]
            let covered = result.clips.contains { $0.start < b && $0.end > a }
            XCTAssertTrue(covered, "no clip covers the loud stretch at \(a)–\(b)s")
        }
    }

    // MARK: - the pieces the analyser is built from

    func testPercentileMatchesTheJavaScriptIndexing() {
        // The JS uses round((p/100) * (n-1)), which is not the textbook
        // definition — matching it exactly matters because the speech threshold
        // is derived from the 15th and 95th percentiles.
        let sorted = (0..<101).map(Double.init)
        XCTAssertEqual(HighlightEngine.percentile(sorted, 0), 0)
        XCTAssertEqual(HighlightEngine.percentile(sorted, 50), 50)
        XCTAssertEqual(HighlightEngine.percentile(sorted, 100), 100)
        XCTAssertEqual(HighlightEngine.percentile(sorted, 15), 15)
        XCTAssertEqual(HighlightEngine.percentile([], 50), 0)
    }

    func testSmoothIsACentredMovingAverageThatShrinksAtTheEdges() {
        let out = HighlightEngine.smooth([0, 10, 20, 30, 40], radius: 2)
        XCTAssertEqual(out[0], 10, accuracy: 1e-9)   // (0+10+20)/3
        XCTAssertEqual(out[2], 20, accuracy: 1e-9)   // (0+10+20+30+40)/5
        XCTAssertEqual(out[4], 30, accuracy: 1e-9)   // (20+30+40)/3
    }

    func testSnapperMovesACutIntoRealSilenceRatherThanOntoAWord() {
        // 10 s at 20 hops/s: loud everywhere except a clear pause at 4.0–4.6 s.
        var db = [Double](repeating: -12, count: 200)
        for hop in 80..<92 { db[hop] = -60 }
        let snapper = Snapper(dbS: db, hop: 0.05, threshold: -40, totalDur: 10)

        // A cut proposed mid-pause stays in the pause.
        let start = snapper.snapStart(4.3, back: 0.6, fwd: 0.5, lead: 0.25)
        XCTAssertGreaterThan(start, 4.0)
        XCTAssertLessThan(start, 4.6)

        // A cut proposed just before the pause is pulled into it, not left on
        // the last word.
        let end = snapper.snapEnd(3.9, back: 0.5, fwd: 0.9, tail: 0.35)
        XCTAssertGreaterThanOrEqual(end, 4.0)
        XCTAssertLessThanOrEqual(end, 4.6)

        XCTAssertTrue(snapper.startOk(4.3))
        XCTAssertFalse(snapper.startOk(8.5), "there is no pause anywhere near 8.5 s")
    }

    func testCoverageSelectionSpreadsClipsAcrossTheWholeRecording() {
        // Ten candidates. The three highest-scoring are all bunched in the first
        // minute; a naive top-N would return only those and the operator would
        // say "it skipped the whole sermon".
        var candidates: [HighlightEngine.Candidate] = []
        for i in 0..<10 {
            let start = Double(i) * 60
            let score = i < 3 ? 10.0 - Double(i) * 0.1 : 1.0
            candidates.append(HighlightEngine.Candidate(
                start: start, end: start + 30, score: score, expr: 0, hookZ: 0, pauseBonus: 0))
        }
        let picked = HighlightEngine.selectWithCoverage(candidates, maxClips: 4, minGap: 8, totalDur: 600)
        XCTAssertEqual(picked.count, 4)
        XCTAssertTrue(picked.contains { $0.start >= 400 },
                      "coverage buckets should reach the end of the recording")
        XCTAssertEqual(picked.map(\.start), picked.map(\.start).sorted(),
                       "clips come back in timeline order")
    }
}
