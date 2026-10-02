import Foundation

/*
 * SERMON → SHORTS, on the phone.
 *
 * A direct port of the audio-driven analyser in src/main/highlights.js. Every
 * constant, weight and threshold below is the SAME NUMBER as the desktop's,
 * because the whole point is that a phone and a PC pick the same moments out of
 * the same sermon. Tests/MWEngineTests/HighlightParityTests.swift feeds this a
 * loudness envelope captured from the real JavaScript engine and checks the
 * clips come back the same, so the two cannot drift apart unnoticed.
 *
 * How it works, in one paragraph: build a loudness envelope, find the threshold
 * that separates room tone from speech, cut the recording into speech segments
 * at the real pauses, score every contiguous run of segments that lands inside
 * the requested length band (loudness above the speaker's own baseline, peak,
 * how well it fits the length asked for, how much of it is actually talking,
 * how expressive the delivery is, how strongly it opens), then pick the best
 * non-overlapping ones with a bucket per section so no part of the service is
 * skipped — and finally nudge each cut into a real silence so it never chops a
 * word.
 *
 * NOT ported: the "deep" content-aware pass, where the desktop transcribes the
 * best candidates and re-scores them on what was actually said. On iOS the
 * transcript comes from Speech.framework instead of whisper.cpp, and the phone
 * app runs that as a separate refinement (see Transcriber + ClipRefiner) rather
 * than pretending it is the same code path.
 */

struct HighlightOptions {
    var minLen: Double = 15
    var maxLen: Double = 60
    var idealLen: Double = 30
    var maxClips: Int = 8
    /// "✨ Auto" — relax the pull toward one length so clips settle at their
    /// natural pause-bounded lengths.
    var autoLen: Bool = false
    /// Only this stretch of the recording is searched. Local time inside the
    /// engine is `sourceTime - startSec`; the returned clips are put back on the
    /// source's clock.
    var startSec: Double = 0
    var endSec: Double?
    /// Narrower still: the exact pieces left on the timeline.
    var ranges: [TimeRangeSec] = []

    static func forTargetLength(_ seconds: Double?) -> HighlightOptions {
        var o = HighlightOptions()
        guard let s = seconds else {
            o.minLen = 45; o.idealLen = 90; o.maxLen = 150; o.autoLen = true
            return o
        }
        o.minLen = (s * 0.6).rounded()
        o.idealLen = s
        o.maxLen = (s * 1.6).rounded()
        o.autoLen = false
        return o
    }
}

struct HighlightMeta {
    var durationSec: Double
    var searchedFrom: Double
    var searchedTo: Double
    var segments: Int
    var thresholdDb: Double
    var baselineDb: Double
}

struct HighlightResult {
    var clips: [Clip]
    var meta: HighlightMeta
}

enum HighlightError: LocalizedError {
    case noSpeech(trimmed: Bool)
    var errorDescription: String? {
        switch self {
        case .noSpeech(let trimmed):
            return trimmed
                ? "Could not hear any speech in the part you kept — widen the trim to cover the preaching."
                : "Could not detect any speech in this video."
        }
    }
}

enum HighlightEngine {

    // MARK: - entry points

    /// Analyse a file: decode the envelope, then run the analysis on it.
    static func analyze(
        url: URL,
        options: HighlightOptions,
        progress: ((Double) -> Void)? = nil,
        isCancelled: (() -> Bool)? = nil
    ) async throws -> HighlightResult {
        let env = try await AudioEnvelope.build(
            url: url,
            from: options.startSec,
            to: options.endSec,
            progress: { progress?($0 * 0.7) },
            isCancelled: isCancelled
        )
        let result = try analyze(envelope: env, options: options)
        progress?(1)
        return result
    }

    /// The whole analysis, as a pure function of the envelope. Everything that
    /// makes a decision lives here, which is what makes the parity test possible.
    static func analyze(envelope env: LoudnessEnvelope, options o: HighlightOptions) throws -> HighlightResult {
        let hop = env.hopSeconds
        let db = env.db
        let hops = db.count
        let offset = max(0, o.startSec)
        let trimmed = offset > 0 || o.endSec != nil

        guard hops > 4 else { throw HighlightError.noSpeech(trimmed: trimmed) }

        // ~150 ms smoothing before anything is thresholded.
        let dbS = smooth(db, radius: 2)

        // Adaptive speech threshold from the loudness distribution.
        let sortedAll = dbS.sorted()
        let floorDb = percentile(sortedAll, 15)   // room tone
        let topDb = percentile(sortedAll, 95)     // loudest speech
        let threshold = floorDb + max(6, (topDb - floorDb) * 0.28)

        // Classify hops, bridge gaps shorter than a breath, keep runs long
        // enough to be speech rather than a cough.
        var isSpeech = [Bool](repeating: false, count: hops)
        for h in 0..<hops { isSpeech[h] = dbS[h] > threshold }

        let bridgeHops = Int((0.25 / hop).rounded())
        var h = 0
        while h < hops {
            if !isSpeech[h] {
                var j = h
                while j < hops && !isSpeech[j] { j += 1 }
                if j - h <= bridgeHops && h > 0 && j < hops {
                    for k in h..<j { isSpeech[k] = true }
                }
                h = j
            } else { h += 1 }
        }

        let minSegHops = Int((0.3 / hop).rounded())
        var segs: [Segment] = []
        h = 0
        while h < hops {
            if isSpeech[h] {
                var j = h
                while j < hops && isSpeech[j] { j += 1 }
                if j - h >= minSegHops {
                    var sum = 0.0, sum2 = 0.0, mx = -999.0
                    for k in h..<j { sum += db[k]; sum2 += db[k] * db[k]; if db[k] > mx { mx = db[k] } }
                    let headEnd = min(j, h + Int((5 / hop).rounded()))
                    var headSum = 0.0
                    for k in h..<headEnd { headSum += db[k] }
                    segs.append(Segment(
                        s: Double(h) * hop, e: Double(j) * hop,
                        meanDb: sum / Double(j - h), maxDb: mx,
                        sumDb: sum, sumDb2: sum2, hopCount: j - h,
                        headDb: headSum / Double(max(1, headEnd - h))
                    ))
                }
                h = j
            } else { h += 1 }
        }

        guard !segs.isEmpty else { throw HighlightError.noSpeech(trimmed: trimmed) }

        // The speaker's own baseline — emphasis is relative to how THIS person
        // normally talks, not to an absolute level.
        var speechDb: [Double] = []
        for h in 0..<hops where isSpeech[h] { speechDb.append(db[h]) }
        speechDb.sort()
        let med = percentile(speechDb, 50)
        let spread = max(2, percentile(speechDb, 85) - percentile(speechDb, 50))
        let totalDur = Double(hops) * hop
        let snapper = Snapper(dbS: dbS, hop: hop, threshold: threshold, totalDur: totalDur)

        let keep = o.ranges.map { TimeRangeSec(start: $0.start - offset, end: $0.end - offset) }
        func inKeep(_ a: Double, _ b: Double) -> Bool {
            keep.isEmpty || keep.contains { a >= $0.start - 0.05 && b <= $0.end + 0.05 }
        }

        // Candidate windows: contiguous runs of segments inside the length band,
        // opening and closing on a pause long enough to be a real boundary. The
        // bound relaxes for fast talkers who rarely leave a long gap.
        func beforePause(_ k: Int) -> Double { k > 0 ? segs[k].s - segs[k - 1].e : min(1, segs[k].s) }
        func afterPause(_ k: Int) -> Double { k < segs.count - 1 ? segs[k + 1].s - segs[k].e : min(1, totalDur - segs[k].e) }

        func generate(minBound: Double) -> [Candidate] {
            var out: [Candidate] = []
            for i in 0..<segs.count {
                if beforePause(i) < minBound { continue }
                var best: Candidate?
                for j in i..<segs.count {
                    let start = segs[i].s, end = segs[j].e
                    let dur = end - start
                    if dur > o.maxLen { break }
                    if dur < o.minLen { continue }
                    if !inKeep(start, end) { continue }
                    let bp = beforePause(i), ap = afterPause(j)
                    if ap < minBound { continue }

                    var wSum = 0.0, wDur = 0.0, peak = -999.0, hSum = 0.0, hSum2 = 0.0, hCount = 0
                    for k in i...j {
                        let d = segs[k].e - segs[k].s
                        wSum += segs[k].meanDb * d
                        wDur += d
                        if segs[k].maxDb > peak { peak = segs[k].maxDb }
                        hSum += segs[k].sumDb; hSum2 += segs[k].sumDb2; hCount += segs[k].hopCount
                    }
                    let meanDb = wSum / wDur
                    let speechRatio = wDur / dur

                    let energyZ = (meanDb - med) / spread
                    let peakZ = (peak - med) / spread
                    let fitBand = o.autoLen ? o.idealLen : max(6, o.maxLen - o.idealLen)
                    let durFit = clamp(1 - abs(dur - o.idealLen) / fitBand, -1, 1)
                    let pauseBonus = clamp((bp + ap) / 2, 0, 1)

                    let hMean = hSum / Double(hCount)
                    let exprStd = max(0, hSum2 / Double(hCount) - hMean * hMean).squareRoot()
                    let expr = clamp((exprStd - 3) / 5, 0, 1)
                    let hookZ = clamp((segs[i].headDb - med) / spread, -1, 1.5)
                    // Avoid the very start of the RECORDING (greetings and
                    // announcements) — but not when the operator has already
                    // trimmed past it, because then the opening seconds of what
                    // they kept are the sermon's first line.
                    let posAdj = (offset < 1 && start < totalDur * 0.04) ? -0.3 : 0.0

                    let durW = o.autoLen ? 0.25 : 0.9
                    let score = 1.0 * energyZ + 0.5 * peakZ + durW * durFit + 0.5 * speechRatio
                        + 0.3 * pauseBonus + 0.35 * expr + 0.3 * hookZ + posAdj

                    if best == nil || score > best!.score {
                        best = Candidate(start: start, end: end, score: score,
                                         expr: expr, hookZ: hookZ, pauseBonus: pauseBonus)
                    }
                }
                if let b = best { out.append(b) }
            }
            return out
        }

        var candidates: [Candidate] = []
        for bound in [0.7, 0.5, 0.35, 0.2, 0.0] {
            candidates = generate(minBound: bound)
            if candidates.count >= o.maxClips * 2 { break }
        }

        var picked = selectWithCoverage(candidates, maxClips: o.maxClips, minGap: 8, totalDur: totalDur)

        // Window edges sit exactly ON the threshold crossing — the first and last
        // word. Snap each into the adjacent pause: a beat of lead-in before the
        // voice starts, and room for the last word to ring out.
        for i in picked.indices {
            picked[i].start = snapper.snapStart(picked[i].start, back: 0.4, fwd: 0.3, lead: 0.2)
            picked[i].end = snapper.snapEnd(picked[i].end, back: 0.3, fwd: 0.4, tail: 0.28)
            picked[i].start = clamp(picked[i].start, 0, totalDur)
            picked[i].end = clamp(picked[i].end, picked[i].start + 0.5, totalDur)
        }

        let aTop = max(0.001, picked.map(\.score).max() ?? 0.001)
        let clips: [Clip] = picked.enumerated().map { idx, c in
            let vr = viralityAndReasons(c, aTop: aTop)
            return Clip(
                start: ((c.start + offset) * 10).rounded() / 10,
                end: ((c.end + offset) * 10).rounded() / 10,
                label: "Key moment \(idx + 1)",
                rank: idx + 1,
                virality: vr.virality,
                reasons: vr.reasons,
                quote: nil,
                cleanCut: false
            )
        }

        return HighlightResult(clips: clips, meta: HighlightMeta(
            durationSec: totalDur.rounded(),
            searchedFrom: (offset * 10).rounded() / 10,
            searchedTo: ((offset + totalDur) * 10).rounded() / 10,
            segments: segs.count,
            thresholdDb: (threshold * 10).rounded() / 10,
            baselineDb: (med * 10).rounded() / 10
        ))
    }

    // MARK: - pieces

    struct Segment {
        var s: Double, e: Double
        var meanDb: Double, maxDb: Double
        var sumDb: Double, sumDb2: Double
        var hopCount: Int
        var headDb: Double
    }

    struct Candidate {
        var start: Double
        var end: Double
        var score: Double
        var expr: Double
        var hookZ: Double
        var pauseBonus: Double
    }

    /// Pick the best non-overlapping candidates with one bucket per clip across
    /// the recording, so a 55-minute service never returns eight clips that all
    /// came out of the same ten minutes.
    static func selectWithCoverage(_ cands: [Candidate], maxClips: Int, minGap: Double, totalDur: Double) -> [Candidate] {
        let sorted = cands.sorted { $0.score > $1.score }
        var picked: [Candidate] = []

        func nonClash(_ c: Candidate) -> Bool {
            picked.allSatisfy { (c.end + minGap <= $0.start) || (c.start - minGap >= $0.end) }
        }
        func alreadyPicked(_ c: Candidate) -> Bool {
            picked.contains { $0.start == c.start && $0.end == c.end }
        }

        let buckets = max(1, maxClips)
        for b in 0..<buckets {
            if picked.count >= maxClips { break }
            let lo = Double(b) * totalDur / Double(buckets)
            let hi = Double(b + 1) * totalDur / Double(buckets)
            if let cand = sorted.first(where: { c in
                !alreadyPicked(c) && ((c.start + c.end) / 2 >= lo) && ((c.start + c.end) / 2 < hi) && nonClash(c)
            }) { picked.append(cand) }
        }
        for c in sorted {
            if picked.count >= maxClips { break }
            if !alreadyPicked(c) && nonClash(c) { picked.append(c) }
        }
        picked.sort { $0.start < $1.start }
        return picked
    }

    /// 35–99 "viral potential" plus the plain-English reasons behind it. This is
    /// the audio-only branch of the desktop's `viralityAndReasons`.
    static func viralityAndReasons(_ c: Candidate, aTop: Double) -> (virality: Int, reasons: [String]) {
        let audio = clamp(c.score / aTop, 0, 1)
        var reasons: [String] = []
        let v = 40 + 44 * audio + 8 * clamp(c.expr, 0, 1) + 6 * clamp(c.hookZ, 0, 1)
        if c.hookZ > 0.5 { reasons.append("Strong opening") }
        if c.expr > 0.5 { reasons.append("Animated, expressive delivery") }
        if audio > 0.75 { reasons.append("High-energy delivery") }
        if c.pauseBonus > 0.7 { reasons.append("Cuts cleanly at natural pauses") }
        if reasons.isEmpty { reasons.append("Elevated delivery vs the rest of the sermon") }
        return (max(35, min(99, Int(v.rounded()))), Array(reasons.prefix(3)))
    }

    // MARK: - maths shared with the desktop

    static func percentile(_ sortedAsc: [Double], _ p: Double) -> Double {
        guard !sortedAsc.isEmpty else { return 0 }
        let i = min(sortedAsc.count - 1, max(0, Int(((p / 100) * Double(sortedAsc.count - 1)).rounded())))
        return sortedAsc[i]
    }

    static func smooth(_ arr: [Double], radius: Int) -> [Double] {
        var out = [Double](repeating: 0, count: arr.count)
        for i in arr.indices {
            var s = 0.0, c = 0
            for j in (i - radius)...(i + radius) where j >= 0 && j < arr.count { s += arr[j]; c += 1 }
            out[i] = s / Double(c)
        }
        return out
    }
}

@inline(__always)
func clamp(_ v: Double, _ a: Double, _ b: Double) -> Double { min(b, max(a, v)) }

/// Moves a proposed cut into the nearest real pause, so a cut never lands on a
/// voiced frame. This is what makes a short's start and finish feel deliberate
/// rather than arbitrary: open a beat before the voice comes in, close after the
/// last word has rung out.
struct Snapper {
    struct Pause { var s: Double; var e: Double }

    private let pauses: [Pause]
    private let totalDur: Double
    /// Envelope smoothing smears a pause's edges; stay this far inside it.
    private let edge = 0.1

    init(dbS: [Double], hop: Double, threshold: Double, totalDur: Double) {
        self.totalDur = totalDur
        self.pauses = Snapper.pauseWindows(dbS: dbS, hop: hop, threshold: threshold, minDur: 0.2)
    }

    /// Runs of the envelope at or below `threshold` lasting at least `minDur`.
    static func pauseWindows(dbS: [Double], hop: Double, threshold: Double, minDur: Double) -> [Pause] {
        let minHops = max(2, Int((minDur / hop).rounded()))
        var out: [Pause] = []
        var h = 0
        while h < dbS.count {
            if dbS[h] <= threshold {
                var j = h
                while j < dbS.count && dbS[j] <= threshold { j += 1 }
                if j - h >= minHops { out.append(Pause(s: Double(h) * hop, e: Double(j) * hop)) }
                h = j
            } else { h += 1 }
        }
        return out
    }

    private func nearest(_ t: Double, _ lo: Double, _ hi: Double, anchor: (Pause) -> Double) -> Pause? {
        var best: Pause?
        var bestD = Double.infinity
        for p in pauses {
            if p.e < lo { continue }
            if p.s > hi { break }
            let contains = p.s <= t && p.e >= t
            let a = anchor(p)
            if !contains && (a < lo || a > hi) { continue }
            let d = contains ? 0 : abs(a - t)
            if d < bestD { best = p; bestD = d }
        }
        return best
    }

    func snapStart(_ t: Double, back: Double = 0.6, fwd: Double = 0.5, lead: Double = 0.25) -> Double {
        if t <= 0.1 { return 0 }
        guard let p = nearest(t, t - back, t + fwd, anchor: { $0.e }) else { return max(0, t - 0.15) }
        // Long dead air ahead: stay put just inside the pause rather than
        // jumping forward into it.
        if p.e - t > 1.2 { return clamp(t, p.s + edge, p.e - edge) }
        return clamp(clamp(p.e - lead, p.s + edge, p.e - edge), 0, totalDur)
    }

    func snapEnd(_ t: Double, back: Double = 0.5, fwd: Double = 0.9, tail: Double = 0.35, hardMax: Double = .infinity) -> Double {
        if t >= totalDur - 0.1 { return totalDur }
        var p = nearest(t, t - back, t + fwd, anchor: { $0.s })
        // Laughter, applause, or a preacher barrelling through the sentence edge:
        // ride forward to the next real breath inside the length budget.
        if p == nil { p = nearest(t, t - 0.7, min(t + 3.0, hardMax), anchor: { $0.s }) }
        guard let found = p else { return min(totalDur, min(t + 0.3, hardMax)) }
        return clamp(clamp(found.s + tail, found.s + edge, found.e - edge), 0, min(totalDur, hardMax))
    }

    func startOk(_ t: Double, back: Double = 0.6, fwd: Double = 0.5) -> Bool {
        t <= 0.1 || nearest(t, t - back, t + fwd, anchor: { $0.e }) != nil
    }
    func endOk(_ t: Double, back: Double = 0.5, fwd: Double = 0.9) -> Bool {
        t >= totalDur - 0.1 || nearest(t, t - back, t + fwd, anchor: { $0.s }) != nil
    }
}
