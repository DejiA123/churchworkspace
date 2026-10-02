import Foundation
import AVFoundation
import Vision
import CoreImage

/*
 * AUTO-REFRAME — follow the speaker into a vertical frame.
 *
 * Same shape as the desktop: sample frames across the clip, find where the
 * person is in each, then build a smooth camera path that a 9:16 crop follows.
 * The detector differs (Vision instead of MediaPipe — both run on-device, and
 * Vision has the Neural Engine to itself here), but the CAMERA is a faithful
 * port of src/renderer/facetrack.js, constant for constant, because that is
 * where all the hard-won behaviour lives:
 *
 *   • spike rejection that still lets a genuine fast move through,
 *   • interpolation across short detection dropouts (a frozen camera during a
 *     dropout is exactly when the speaker walks out of frame),
 *   • zero-lag smoothing (forward EMA then backward — offline, so no trailing),
 *   • a rolling baseline that averages out rocking and gesticulation so the
 *     camera does not swing left-right with the preacher's body,
 *   • hold/pursue segmentation so the camera PARKS when the speaker is standing
 *     still and RIDES when they actually walk,
 *   • and a hard leash against the real detected position, which is the
 *     guarantee that they never leave the frame however smooth the pursuit is.
 *
 * The 6 samples/second is not arbitrary either: church footage cuts between
 * cameras in bursts, and at 4fps a cut can land a quarter-second from the
 * nearest sample, which shows up as the speaker jammed against an edge for a
 * few frames after every angle change.
 */

/// Where the person is in one sampled frame, normalised 0…1 across the frame.
struct FaceSample {
    var t: Double
    var cx: Double?
    var cy: Double?
    /// Body position from the pose request, when it found one.
    var poseCx: Double?
    var poseCy: Double?
    /// Mean luma of the frame, used to spot camera cuts without ffmpeg.
    var luma: Double = 0
}

/// One point on the crop path. `x`/`y` are the CENTRE of the crop window in
/// source pixels, which is what the exporter's transform ramps consume.
struct CropKeyframe: Hashable {
    var t: Double
    var x: Double
    var y: Double
}

enum FaceTracker {

    static let samplesPerSecond: Double = 6
    /// The person must stay inside this fraction of the crop window. Swept
    /// against real sermon footage on the desktop: 0.50 left visible off-centre
    /// stretches during walks, 0.44 removed them AND made the camera calmer,
    /// and below ~0.36 the leash binds on natural rocking and the camera starts
    /// chasing body language — the failure this pipeline exists to avoid.
    static let safeFraction: Double = 0.44

    // MARK: - detection

    /// Sample the clip and find the speaker in each frame.
    static func detect(
        url: URL,
        pieces: [TimeRangeSec],
        progress: ((Double) -> Void)? = nil,
        isCancelled: (() -> Bool)? = nil
    ) async throws -> [FaceSample] {
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        // Detection does not need full resolution, and a smaller frame is a
        // large speed win on a phone.
        generator.maximumSize = CGSize(width: 640, height: 640)

        // The tracker's clock is the FINISHED clip's clock: with pauses removed
        // the kept pieces are played back-to-back, so sampling has to walk the
        // pieces and accumulate local time — otherwise the crop path is offset
        // from the picture by however much was cut.
        var requests: [(source: Double, local: Double)] = []
        var local: Double = 0
        for piece in pieces {
            var t = piece.start
            while t < piece.end {
                requests.append((t, local + (t - piece.start)))
                t += 1 / samplesPerSecond
            }
            local += piece.duration
        }
        guard !requests.isEmpty else { return [] }

        var samples: [FaceSample] = []
        samples.reserveCapacity(requests.count)
        let ciContext = CIContext(options: [.useSoftwareRenderer: false])

        for (i, req) in requests.enumerated() {
            if isCancelled?() == true { throw CancellationError() }
            let time = CMTime(seconds: req.source, preferredTimescale: 600)
            guard let cg = try? await generator.image(at: time).image else {
                samples.append(FaceSample(t: req.local, cx: nil, cy: nil))
                continue
            }
            var sample = FaceSample(t: req.local, cx: nil, cy: nil)
            sample.luma = meanLuma(cg, context: ciContext)

            let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
            let faceRequest = VNDetectFaceRectanglesRequest()
            let poseRequest = VNDetectHumanBodyPoseRequest()
            try? handler.perform([faceRequest, poseRequest])

            if let pose = poseRequest.results?.first {
                let head = poseHead(pose)
                sample.poseCx = head?.cx
                sample.poseCy = head?.cy
            }
            if let faces = faceRequest.results, !faces.isEmpty {
                // Biggest confident face wins — the same rule the desktop uses
                // before its pose arbitration.
                let best = faces.max { a, b in
                    (a.boundingBox.width * a.boundingBox.height) < (b.boundingBox.width * b.boundingBox.height)
                }
                if let f = best {
                    let box = f.boundingBox
                    sample.cx = Double(box.midX)
                    // Vision's origin is bottom-left; the crop path is top-left.
                    sample.cy = 1 - Double(box.midY)
                }
            }
            samples.append(sample)
            progress?(Double(i + 1) / Double(requests.count))
        }

        return arbitrate(samples)
    }

    /// Body position from a pose observation: the nose if it is visible, else
    /// the shoulder midpoint nudged up to head height.
    private static func poseHead(_ obs: VNHumanBodyPoseObservation) -> (cx: Double, cy: Double)? {
        func pt(_ name: VNHumanBodyPoseObservation.JointName) -> VNRecognizedPoint? {
            guard let p = try? obs.recognizedPoint(name), p.confidence > 0.3 else { return nil }
            return p
        }
        // Vision's origin is bottom-left; the crop path is top-left, so y flips.
        if let nose = pt(.nose) {
            return (Double(nose.location.x), 1 - Double(nose.location.y))
        }
        if let l = pt(.leftShoulder), let r = pt(.rightShoulder) {
            let x = (Double(l.location.x) + Double(r.location.x)) / 2
            let y = 1 - (Double(l.location.y) + Double(r.location.y)) / 2
            return (x, y - 0.10)   // nudge up from the shoulders to head height
        }
        return nil
    }

    /*
     * Church stage backdrops love scripture art, murals and portraits — flat
     * patterns that detect as big, confident faces frame after frame while the
     * real speaker (small, under stage lighting) flickers in and out. A
     * face-first tracker locks onto WALLPAPER and the export crops scenery.
     *
     * Flat art cannot fool a whole-body pose model, so when the body signal is
     * present and continuous it becomes the arbiter: a face reading that
     * contradicts where the body is gets discarded before tracking. When pose
     * is spotty (crowd shots, several people trading the detector), face stays
     * in charge exactly as before.
     */
    static func arbitrate(_ samples: [FaceSample]) -> [FaceSample] {
        let withPose = samples.filter { $0.poseCx != nil }.count
        var pairs = 0, jumps = 0
        var prev: FaceSample?
        for s in samples {
            guard let pc = s.poseCx else { continue }
            if let p = prev, let ppc = p.poseCx, s.t - p.t <= 1.0 {
                pairs += 1
                if abs(pc - ppc) > 0.22 { jumps += 1 }
            }
            prev = s
        }
        let poseReliable = samples.count >= 8
            && Double(withPose) >= 0.6 * Double(samples.count)
            && pairs >= 6
            && jumps <= min(3, max(1, Int((0.06 * Double(pairs)).rounded())))

        guard poseReliable else { return samples }

        let agree = 0.15   // farther than this from the body is wallpaper or someone else
        var out = samples
        for i in out.indices {
            guard let face = out[i].cx else {
                // No face but a trustworthy body: use the body.
                if let pc = out[i].poseCx { out[i].cx = pc; out[i].cy = out[i].poseCy ?? 0.5 }
                continue
            }
            // Median body position over ±0.75 s, so one bad pose reading cannot
            // throw away a run of good faces.
            var near: [Double] = []
            var j = i
            while j >= 0 && out[i].t - out[j].t <= 0.75 { if let p = out[j].poseCx { near.append(p) }; j -= 1 }
            j = i + 1
            while j < out.count && out[j].t - out[i].t <= 0.75 { if let p = out[j].poseCx { near.append(p) }; j += 1 }
            guard !near.isEmpty else { continue }
            near.sort()
            let ref = near[near.count / 2]
            if abs(face - ref) > agree {
                out[i].cx = out[i].poseCx ?? ref
                out[i].cy = out[i].poseCy ?? out[i].cy
            }
        }
        return out
    }

    private static func meanLuma(_ image: CGImage, context: CIContext) -> Double {
        let ci = CIImage(cgImage: image)
        guard let filter = CIFilter(name: "CIAreaAverage", parameters: [
            kCIInputImageKey: ci,
            kCIInputExtentKey: CIVector(cgRect: ci.extent),
        ]), let out = filter.outputImage else { return 0 }
        var pixel = [UInt8](repeating: 0, count: 4)
        context.render(out, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
                       format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        return (0.299 * Double(pixel[0]) + 0.587 * Double(pixel[1]) + 0.114 * Double(pixel[2])) / 255
    }

    // MARK: - camera path

    /// Turn detections into the crop path. `sourceSize` is the picture's own
    /// size; `targetAspect` is the shape being exported into.
    static func keyframes(
        from samples: [FaceSample],
        sourceSize: CGSize,
        targetAspect: Double
    ) -> [CropKeyframe] {
        let srcW = Double(sourceSize.width), srcH = Double(sourceSize.height)
        let centre = CropKeyframe(t: 0, x: srcW / 2, y: srcH / 2)
        guard !samples.isEmpty, srcW > 0, srcH > 0 else { return [centre] }

        let srcAR = srcW / srcH
        // Half the crop window, as a fraction of the source frame, per axis.
        // An axis that is not cropped has no constraint (0.5).
        let cropHalfX = srcAR > targetAspect ? 0.5 * (targetAspect / srcAR) : 0.5
        let cropHalfY = srcAR < targetAspect ? 0.5 * (srcAR / targetAspect) : 0.5
        let leashX = safeFraction * cropHalfX
        let leashY = safeFraction * cropHalfY

        // Shots: run the camera independently within each and SNAP between them.
        // A jump at a camera cut is invisible — the picture is already
        // discontinuous there — whereas gliding across one leaves the speaker
        // off-frame for the whole glide.
        let boundaries = shotBoundaries(samples, minJump: leashX)
        var path: [(t: Double, cx: Double, cy: Double)] = []
        var previousEnd: (cx: Double, cy: Double)?

        var lo = 0
        for bound in boundaries + [Double.infinity] {
            var hi = lo
            while hi < samples.count && samples[hi].t < bound { hi += 1 }
            let slice = Array(samples[lo..<hi])
            lo = hi
            guard !slice.isEmpty else { continue }

            let segment: [(t: Double, cx: Double, cy: Double)]
            if slice.allSatisfy({ $0.cx == nil }) {
                // Nobody detectable (a crowd cutaway, wide b-roll): hold through
                // a blip, otherwise frame the centre of the new shot.
                let segDur = slice.last!.t - slice.first!.t
                let cx = (previousEnd != nil && segDur < 2.5) ? previousEnd!.cx : 0.5
                let cy = (previousEnd != nil && segDur < 2.5) ? previousEnd!.cy : 0.5
                segment = slice.map { ($0.t, cx, cy) }
            } else {
                segment = camera(for: slice, leashX: leashX, leashY: leashY)
            }
            if let prev = previousEnd, let first = segment.first {
                path.append((max(0, first.t - 0.02), prev.cx, prev.cy))
            }
            path.append(contentsOf: segment)
            if let last = segment.last { previousEnd = (last.cx, last.cy) }
        }

        var kf = path.map {
            CropKeyframe(t: max(0, $0.t),
                         x: (clamp($0.cx, 0, 1) * srcW).rounded(),
                         y: (clamp($0.cy, 0, 1) * srcH).rounded())
        }
        if kf.isEmpty { return [centre] }
        if kf[0].t > 0.05 { kf.insert(CropKeyframe(t: 0, x: kf[0].x, y: kf[0].y), at: 0) }
        return kf
    }

    /// Camera cuts, from a jump in frame brightness (no ffmpeg scene filter on
    /// iOS) corroborated by the tracked position moving with it, plus the raw
    /// "the subject teleported" case.
    static func shotBoundaries(_ dets: [FaceSample], minJump: Double) -> [Double] {
        func medianNear(_ t: Double, _ dir: Int) -> Double? {
            let xs = dets.compactMap { d -> Double? in
                guard let cx = d.cx else { return nil }
                if dir < 0 { return (d.t < t && d.t >= t - 1.8) ? cx : nil }
                return (d.t > t && d.t <= t + 1.8) ? cx : nil
            }.sorted()
            return xs.isEmpty ? nil : xs[xs.count / 2]
        }

        var out: [Double] = []
        for i in 1..<max(1, dets.count) {
            let dl = abs(dets[i].luma - dets[i - 1].luma)
            if dl > 0.14 {
                let mid = (dets[i].t + dets[i - 1].t) / 2
                if let before = medianNear(mid, -1), let after = medianNear(mid, 1),
                   abs(after - before) > max(0.5 * minJump, 0.04) {
                    out.append(dets[i].t + 0.001)
                } else if dl > 0.30 {
                    out.append(dets[i].t + 0.001)
                }
            }
        }
        // The subject apparently teleporting across the frame is a cut too.
        var prev: FaceSample?
        for d in dets {
            guard let cx = d.cx else { continue }
            if let p = prev, let pcx = p.cx, d.t - p.t <= 1.2, abs(cx - pcx) > 0.28 {
                out.append((d.t + p.t) / 2)
            }
            prev = d
        }
        return Array(Set(out.map { ($0 * 1000).rounded() / 1000 })).sorted()
    }

    /// The virtual camera over one contiguous shot. A direct port of
    /// facetrack.js `camForSlice`.
    static func camera(for dets: [FaceSample], leashX: Double, leashY: Double) -> [(t: Double, cx: Double, cy: Double)] {
        guard !dets.isEmpty else { return [] }

        // 1. Spike rejection. A point is a false positive only when it jumps
        //    away from BOTH nearest valid neighbours AND those neighbours agree
        //    with each other (an up-then-down blip). A genuine pan is a ramp
        //    (neighbours differ) or a step (the next sample agrees), so it
        //    survives — otherwise a quick walk is eaten and the speaker drifts
        //    out of frame.
        let th = 0.16
        func nearestValid(_ from: Int, _ dir: Int) -> FaceSample? {
            var j = from + dir
            while j >= 0 && j < dets.count {
                if dets[j].cx != nil { return dets[j] }
                j += dir
            }
            return nil
        }
        var pruned = dets
        for i in dets.indices {
            guard let v = dets[i].cx else { continue }
            guard let prev = nearestValid(i, -1)?.cx, let next = nearestValid(i, 1)?.cx else { continue }
            if abs(v - prev) > th && abs(v - next) > th && abs(prev - next) < th * 0.6 {
                pruned[i].cx = nil
                pruned[i].cy = nil
            }
        }

        // 2. Gap-fill: INTERPOLATE across short dropouts (the speaker was
        //    probably still moving) and only HOLD through long ones.
        let firstKnown = pruned.first { $0.cx != nil }
        let fkx = firstKnown?.cx ?? 0.5
        let fky = firstKnown?.cy ?? 0.5
        var prevK = [Int](repeating: -1, count: pruned.count)
        var nextK = [Int](repeating: -1, count: pruned.count)
        var last = -1
        for i in pruned.indices { prevK[i] = last; if pruned[i].cx != nil { last = i } }
        var next = -1
        for i in stride(from: pruned.count - 1, through: 0, by: -1) { nextK[i] = next; if pruned[i].cx != nil { next = i } }

        let maxInterpGap = 1.5
        var filled: [(t: Double, cx: Double, cy: Double)] = []
        filled.reserveCapacity(pruned.count)
        for (i, d) in pruned.enumerated() {
            if let cx = d.cx { filled.append((d.t, cx, d.cy ?? 0.5)); continue }
            let p = prevK[i], n = nextK[i]
            if p >= 0, n >= 0, pruned[n].t - pruned[p].t <= maxInterpGap {
                let r = (d.t - pruned[p].t) / max(1e-3, pruned[n].t - pruned[p].t)
                let px = pruned[p].cx ?? 0.5, nx = pruned[n].cx ?? 0.5
                let py = pruned[p].cy ?? 0.5, ny = pruned[n].cy ?? 0.5
                filled.append((d.t, px + (nx - px) * r, py + (ny - py) * r))
            } else if p >= 0 {
                filled.append((d.t, pruned[p].cx ?? 0.5, pruned[p].cy ?? 0.5))
            } else if n >= 0 {
                filled.append((d.t, pruned[n].cx ?? 0.5, pruned[n].cy ?? 0.5))
            } else {
                filled.append((d.t, fkx, fky))
            }
        }

        // 3. Zero-lag smoothing: EMA forward then backward. Offline, so it can
        //    look ahead — noise goes without the camera trailing the subject.
        let a = 0.45
        var fwd: [(t: Double, cx: Double, cy: Double)] = []
        var sx = filled[0].cx, sy = filled[0].cy
        for p in filled { sx = a * p.cx + (1 - a) * sx; sy = a * p.cy + (1 - a) * sy; fwd.append((p.t, sx, sy)) }
        sx = fwd[fwd.count - 1].cx; sy = fwd[fwd.count - 1].cy
        var sm = fwd
        for i in stride(from: fwd.count - 1, through: 0, by: -1) {
            sx = a * fwd[i].cx + (1 - a) * sx
            sy = a * fwd[i].cy + (1 - a) * sy
            sm[i] = (fwd[i].t, sx, sy)
        }

        // 3b. Rolling baseline — where the person IS, with rocking averaged out.
        //     An energetic preacher sways constantly; a camera that re-anchors
        //     on every sway swings left-right non-stop. A centred mean is flat
        //     through rhythmic movement but shifts with no phase lag when the
        //     speaker actually relocates.
        func rollingWindow(_ half: Double) -> [(cx: Double, cy: Double)] {
            var out = [(cx: Double, cy: Double)](repeating: (0, 0), count: sm.count)
            var lo = 0, hi = 0, sumX = 0.0, sumY = 0.0, n = 0
            for i in sm.indices {
                while hi < sm.count && sm[hi].t <= sm[i].t + half { sumX += sm[hi].cx; sumY += sm[hi].cy; n += 1; hi += 1 }
                while lo < sm.count && sm[lo].t < sm[i].t - half { sumX -= sm[lo].cx; sumY -= sm[lo].cy; n -= 1; lo += 1 }
                out[i] = n > 0 ? (sumX / Double(n), sumY / Double(n)) : (sm[i].cx, sm[i].cy)
            }
            return out
        }
        let halfWin = 1.75
        // The PURSUIT target uses a much shorter window: a box mean attenuates
        // whatever it averages, and at ±1.75 s a camera aimed at the baseline
        // sits about a tenth of the frame behind a walk. ±0.6 s still erases
        // jitter and hand gestures but passes a real walk at full amplitude. It
        // is never used to DECIDE whether to move — that stays on the long
        // window, which is what keeps rocking from triggering a pan at all.
        let rollT = rollingWindow(0.6)
        var roll = rollingWindow(halfWin)
        // Freeze the baseline over the head and tail: a one-sided window sits
        // off the true mean by up to half the rocking amplitude, which nudges
        // the camera at clip edges for no reason.
        if !sm.isEmpty {
            let t0 = sm[0].t, tN = sm[sm.count - 1].t
            var head = 0
            while head < sm.count - 1 && sm[head].t < t0 + halfWin { head += 1 }
            var tail = sm.count - 1
            while tail > 0 && sm[tail].t > tN - halfWin { tail -= 1 }
            if tail < head { head = (head + tail) / 2; tail = head }
            for i in 0..<head { roll[i] = roll[head] }
            if tail < sm.count - 1 { for i in (tail + 1)..<sm.count { roll[i] = roll[tail] } }
        }

        // 4. Offline changepoint segmentation into HOLD stretches (the camera
        //    parks on the stretch's median, unbiased by where a sway happened to
        //    be when the clip started) and PURSUIT stretches (the camera rides
        //    the short-window baseline). An incremental state machine either sat
        //    still through half a pacing swing or, once moving, chased sways
        //    forever; seeing the whole clip at once removes the dilemma.
        let deadX = max(0.02, 0.5 * leashX)
        let deadY = max(0.02, 0.5 * leashY)
        let maxV = 0.30      // max pan speed, fraction of frame width per second
        let persist = 2.2    // s a small offset must last before a hold re-centres
        let pTrig = 0.022    // offset that counts as "off-centre"
        let minHold = 4.0    // s a corridor run must last to count as standing still

        func median(_ a: [Double]) -> Double {
            let s = a.sorted()
            return s.isEmpty ? 0 : s[s.count / 2]
        }

        func buildAnchor(_ value: (Int) -> Double, _ dead: Double) -> [Double?] {
            var anchor = [Double?](repeating: nil, count: sm.count)

            func paint(_ a: Int, _ b: Int, _ depth: Int) {
                guard b > a else { return }
                let med = median((a..<b).map(value))
                if depth < 6 && sm[b - 1].t - sm[a].t >= 2.0 {
                    var excursionStart = -1
                    for i in a..<b {
                        if abs(value(i) - med) > pTrig {
                            if excursionStart < 0 { excursionStart = i }
                        } else { excursionStart = -1 }
                        if excursionStart >= 0 && sm[i].t - sm[excursionStart].t > persist {
                            var cut = excursionStart
                            if excursionStart == a {
                                cut = i
                                while cut < b && abs(value(cut) - med) > pTrig { cut += 1 }
                                if cut >= b { break }
                            }
                            paint(a, cut, depth + 1)
                            paint(cut, b, depth + 1)
                            return
                        }
                    }
                }
                for i in a..<b { anchor[i] = med }
            }

            var s = 0
            var mn = value(0), mx = value(0)
            func closeRun(_ e: Int) { if e > s && sm[e - 1].t - sm[s].t >= minHold { paint(s, e, 0) } }
            for i in 1..<max(1, sm.count) {
                let v = value(i)
                mn = min(mn, v); mx = max(mx, v)
                if mx - mn > 1.8 * dead { closeRun(i); s = i; mn = v; mx = v }
            }
            closeRun(sm.count)
            return anchor
        }

        let aX = buildAnchor({ roll[$0].cx }, deadX)
        let aY = buildAnchor({ roll[$0].cy }, deadY)
        let tgtX = sm.indices.map { aX[$0] ?? rollT[$0].cx }
        let tgtY = sm.indices.map { aY[$0] ?? rollT[$0].cy }

        // How fast each target is itself moving, added as FEED-FORWARD. A purely
        // proportional pursuit always trails a moving target; matching its
        // velocity removes the lag and leaves the proportional term correcting
        // only the residual. Applied ONLY inside a pursuit stretch: within a
        // hold the target is constant and at a hold boundary it STEPS, and a
        // difference quotient across a step is a spike, not a speed.
        func velocity(_ arr: [Double], _ anchor: [Double?]) -> [Double] {
            arr.indices.map { i in
                let a = i - 1, b = i + 1
                guard a >= 0, b < arr.count else { return 0 }
                if anchor[i] != nil || anchor[a] != nil || anchor[b] != nil { return 0 }
                let dt = sm[b].t - sm[a].t
                return dt > 1e-3 ? (arr[b] - arr[a]) / dt : 0
            }
        }
        let tvX = velocity(tgtX, aX), tvY = velocity(tgtY, aY)

        var out: [(t: Double, cx: Double, cy: Double)] = []
        out.reserveCapacity(sm.count)
        // Seed at the opening target, leash-clamped to the first known position
        // in case the clip opens mid-walk.
        var camX = min(filled[0].cx + leashX, max(filled[0].cx - leashX, tgtX[0]))
        var camY = min(filled[0].cy + leashY, max(filled[0].cy - leashY, tgtY[0]))
        var velX = 0.0, velY = 0.0

        for i in sm.indices {
            let dt = i == 0 ? 0 : max(0.01, sm[i].t - sm[i - 1].t)
            if dt > 0 {
                func step(_ cam: Double, _ v: Double, _ tgt: Double, _ tv: Double) -> (Double, Double) {
                    let desired = max(-maxV, min(maxV, tv + (tgt - cam) * 2.2))
                    // Ease into motion gently, shed speed briskly: a camera
                    // coasting on leftover momentum sails PAST the speaker when
                    // they stop walking. Operators start slow and stop crisply.
                    let rate = abs(desired) < abs(v) ? 12.0 : 5.0
                    let nv = v + (desired - v) * min(1, rate * dt)
                    return (cam + nv * dt, nv)
                }
                (camX, velX) = step(camX, velX, tgtX[i], tvX[i])
                (camY, velY) = step(camY, velY, tgtY[i], tvY[i])

                // HARD LEASH against the real gap-filled position — the
                // anti-"walks out of frame" guarantee. Safety never waits for
                // the baseline.
                let fx = filled[i].cx, fy = filled[i].cy
                if camX < fx - leashX { camX = fx - leashX; if velX < 0 { velX = 0 } }
                else if camX > fx + leashX { camX = fx + leashX; if velX > 0 { velX = 0 } }
                if camY < fy - leashY { camY = fy - leashY; if velY < 0 { velY = 0 } }
                else if camY > fy + leashY { camY = fy + leashY; if velY > 0 { velY = 0 } }
            }
            out.append((sm[i].t, camX, camY))
        }
        return out
    }
}
