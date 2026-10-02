import Foundation
import SwiftUI
import AVFoundation
import Security

/*
 * The one object every screen reads from.
 *
 * It also holds the switch that makes this app unusual: WHERE the work happens.
 * In `.onDevice` mode the Engine folder does everything — analysis, tracking,
 * captions, export — and the app is useful on a plane. In `.workstation` mode
 * the very same buttons drive the PC over the church wifi and the export takes
 * seconds instead of minutes. Nothing above this line knows which is which.
 */

enum WorkMode: String, CaseIterable, Codable, Identifiable {
    case onDevice, workstation
    var id: String { rawValue }
    var label: String { self == .onDevice ? "On this phone" : "Use my PC" }
}

struct RunningJob: Identifiable {
    let id = UUID()
    var label: String
    var progress: Double
    var remoteJobId: String?
    var cancel: () -> Void
}

struct FinishedFile: Identifiable, Hashable {
    var id = UUID()
    var url: URL
    var name: String
    var at: Date
    /// Set when the file is still on the PC and has not been pulled down yet.
    var remotePath: String?
}

@MainActor
final class AppState: ObservableObject {

    // What is loaded
    @Published var sourceURL: URL?
    @Published var sourceName: String = ""
    @Published var duration: Double = 0
    @Published var sourceSize: CGSize = .zero
    /// The stretch of the recording being worked on.
    @Published var rangeStart: Double = 0
    @Published var rangeEnd: Double = 0

    @Published var clips: [Clip] = []
    @Published var finished: [FinishedFile] = []

    // Settings
    @Published var settings = ExportSettings() { didSet { persist() } }
    @Published var targetLength: Double? = nil  { didSet { persist() } }  // nil = ✨ Auto
    @Published var removePauses = true          { didSet { persist() } }
    @Published var mode: WorkMode = .onDevice   { didSet { persist() } }

    // Remote
    @Published var remoteHost: String = ""      { didSet { persist() } }
    @Published var remotePaired = false
    @Published var discovered: [String] = []
    private(set) var remote: RemoteClient?

    // Work in flight
    @Published var job: RunningJob?
    @Published var toast: String?

    private var cancelFlag = false
    private let transcriber = Transcriber()

    // MARK: - lifecycle

    init() { restore() }

    var isLoaded: Bool { sourceURL != nil && duration > 0 }
    var wholeVideoSelected: Bool { rangeStart <= 0.01 && rangeEnd >= duration - 0.01 }

    func say(_ message: String) {
        toast = message
        Task { try? await Task.sleep(nanoseconds: 4_500_000_000); if toast == message { toast = nil } }
    }

    // MARK: - opening a recording

    func open(url: URL) async {
        do {
            let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
            let dur = try await asset.load(.duration).seconds
            let track = try await asset.loadTracks(withMediaType: .video).first
            let natural = try await track?.load(.naturalSize) ?? .zero
            let transform = try await track?.load(.preferredTransform) ?? .identity
            let oriented = natural.applying(transform)

            sourceURL = url
            sourceName = url.lastPathComponent
            duration = dur
            sourceSize = CGSize(width: abs(oriented.width), height: abs(oriented.height))
            rangeStart = 0
            rangeEnd = dur
            clips = []
            say("\(url.lastPathComponent) — \(Format.time(dur))")
        } catch {
            say("Could not open that video: \(error.localizedDescription)")
        }
    }

    func openRemote(path: String, name: String) async {
        guard let remote else { return }
        do {
            struct Info: Decodable { let durationSec: Double; let width: Int; let height: Int }
            let info: Info = try await remote.call("video:info", ["input": path], as: Info.self)
            sourceURL = remote.mediaURL(for: path)
            sourceName = name
            remoteSourcePath = path
            duration = info.durationSec
            sourceSize = CGSize(width: info.width, height: info.height)
            rangeStart = 0
            rangeEnd = info.durationSec
            clips = []
            say("\(name) — \(Format.time(info.durationSec))")
        } catch {
            say(error.localizedDescription)
        }
    }

    /// The PC-side path of what is loaded, when working in workstation mode.
    @Published var remoteSourcePath: String?

    // MARK: - jobs

    private func run<T>(_ label: String, _ work: (@escaping (Double) -> Void) async throws -> T) async -> T? {
        cancelFlag = false
        job = RunningJob(label: label, progress: 0, cancel: { [weak self] in self?.cancelFlag = true })
        defer { job = nil }
        do {
            return try await work { [weak self] p in
                Task { @MainActor in self?.job?.progress = min(1, max(0, p)) }
            }
        } catch is CancellationError {
            return nil
        } catch {
            say(error.localizedDescription)
            return nil
        }
    }

    private func cancelled() -> Bool { cancelFlag }

    // MARK: - long → short

    func findHighlights() async {
        guard isLoaded else { return }
        var options = HighlightOptions.forTargetLength(targetLength)
        options.startSec = wholeVideoSelected ? 0 : rangeStart
        options.endSec = wholeVideoSelected ? nil : rangeEnd

        let kept = rangeEnd - rangeStart
        // A short recording cannot hold 90-second clips, so ✨Auto scales its
        // band to the footage rather than coming back empty-handed. A fixed
        // length is left alone: "none fit" is the honest answer there.
        if options.autoLen && kept < options.minLen * 4 {
            let ideal = clamp((kept / 4).rounded(), 15, options.idealLen)
            options.minLen = max(8, (ideal * 0.55).rounded())
            options.idealLen = ideal
            options.maxLen = max(24, (ideal * 1.7).rounded())
        }
        let fit = Int(kept / (options.idealLen + 8))
        options.maxClips = Int(clamp(Double(min(16, fit)), 3, 20))

        let found: [Clip]?
        switch mode {
        case .onDevice:
            found = await run("🤖 Finding the best moments…") { report in
                let result = try await HighlightEngine.analyze(
                    url: self.sourceURL!, options: options,
                    progress: report, isCancelled: { self.cancelled() }
                )
                return result.clips
            }
        case .workstation:
            found = await run("🤖 Your PC is finding the best moments…") { _ in
                try await self.remoteAnalyze(options)
            }
        }

        guard let clips = found, !clips.isEmpty else {
            if !cancelFlag { say("No standout moments found in that stretch.") }
            return
        }
        self.clips = clips
        say("✨ Found \(clips.count) clip\(clips.count > 1 ? "s" : ""). Review, then export.")
        if removePauses { await removePausesInAllClips() }
    }

    private func remoteAnalyze(_ o: HighlightOptions) async throws -> [Clip] {
        guard let remote, let path = remoteSourcePath else { throw RemoteError.notPaired }
        struct RemoteClip: Decodable {
            let start: Double; let end: Double; let label: String?
            let rank: Int?; let virality: Int?; let reasons: [String]?
            let quote: String?; let cleanCut: Bool?
        }
        struct Reply: Decodable { let clips: [RemoteClip] }
        let reply: Reply = try await remote.call("sermon:analyze", [
            "input": path, "minLen": o.minLen, "maxLen": o.maxLen, "idealLen": o.idealLen,
            "autoLen": o.autoLen, "maxClips": o.maxClips, "deep": true,
            "startSec": o.startSec, "endSec": o.endSec ?? 0,
            "jobId": UUID().uuidString,
        ], as: Reply.self)
        return reply.clips.enumerated().map { i, c in
            Clip(start: c.start, end: c.end, label: c.label ?? "Key moment \(i + 1)",
                 rank: c.rank ?? (i + 1), virality: c.virality ?? 0,
                 reasons: c.reasons ?? [], quote: c.quote, cleanCut: c.cleanCut ?? false)
        }
    }

    // MARK: - pauses

    func removePausesInAllClips() async {
        var touched = 0
        var removed = 0.0
        for index in clips.indices {
            let clip = clips[index]
            let result: SilenceDetector.Result? = await run("🤫 Listening for pauses in “\(clip.label)”…") { report in
                switch self.mode {
                case .onDevice:
                    return try await SilenceDetector.detect(
                        url: self.sourceURL!, startSec: clip.start, endSec: clip.end,
                        progress: report, isCancelled: { self.cancelled() }
                    )
                case .workstation:
                    return try await self.remoteSilences(clip)
                }
            }
            guard let result, !result.silences.isEmpty else { continue }
            clips[index].cuts = result.silences
            touched += 1
            removed += result.removedSeconds
            if cancelFlag { break }
        }
        if touched > 0 {
            say(String(format: "🤫 Took %.1fs of dead air out of %d clip%@.", removed, touched, touched > 1 ? "s" : ""))
        }
    }

    private func remoteSilences(_ clip: Clip) async throws -> SilenceDetector.Result {
        guard let remote, let path = remoteSourcePath else { throw RemoteError.notPaired }
        struct Range: Decodable { let start: Double; let end: Double }
        struct Reply: Decodable { let silences: [Range] }
        let reply: Reply = try await remote.call("video:detectSilence", [
            "input": path, "startSec": clip.start, "endSec": clip.end,
            "noiseDb": -32, "minSilenceSec": 0.7, "padSec": 0.12,
            "jobId": UUID().uuidString,
        ], as: Reply.self)
        let keep = reply.silences
            .map { TimeRangeSec(start: $0.start, end: $0.end) }
            .filter { $0.duration >= SilenceDetector.minWorthCutting }
        return SilenceDetector.Result(silences: keep, removedSeconds: keep.reduce(0) { $0 + $1.duration })
    }

    // MARK: - captions

    func transcribe(clipAt index: Int) async {
        guard clips.indices.contains(index) else { return }
        let clip = clips[index]
        let words: [TimedWord]? = await run("💬 Listening to “\(clip.label)”…") { report in
            switch self.mode {
            case .onDevice:
                return try await self.transcriber.words(
                    url: self.sourceURL!, startSec: clip.start, endSec: clip.end,
                    progress: report, isCancelled: { self.cancelled() }
                )
            case .workstation:
                return try await self.remoteWords(clip)
            }
        }
        guard let words, !words.isEmpty else {
            if !cancelFlag { say("No speech found in that clip.") }
            return
        }
        clips[index].captions = CaptionBuilder.build(
            words: words, wordsPerLine: settings.wordsPerLine, textCase: settings.textCase
        )
    }

    private func remoteWords(_ clip: Clip) async throws -> [TimedWord] {
        guard let remote, let path = remoteSourcePath else { throw RemoteError.notPaired }
        struct Word: Decodable { let start: Double; let end: Double; let text: String }
        struct Reply: Decodable { let words: [Word]? }
        let reply: Reply = try await remote.call("captions:transcribe", [
            "input": path, "startSec": clip.start, "endSec": clip.end, "jobId": UUID().uuidString,
        ], as: Reply.self)
        return (reply.words ?? []).map { TimedWord(start: $0.start, end: $0.end, text: $0.text) }
    }

    // MARK: - export

    func export(clipAt index: Int) async {
        guard clips.indices.contains(index), sourceURL != nil else { return }
        let clip = clips[index]

        var keyframes: [CropKeyframe] = []
        if settings.reframeActive && mode == .onDevice {
            keyframes = await run("🎯 Tracking the speaker in “\(clip.label)”…") { report in
                let samples = try await FaceTracker.detect(
                    url: self.sourceURL!, pieces: clip.keptPieces,
                    progress: report, isCancelled: { self.cancelled() }
                )
                guard let aspect = self.settings.preset.aspect else { return [] }
                return FaceTracker.keyframes(from: samples, sourceSize: self.sourceSize, targetAspect: aspect)
            } ?? []
        }

        let produced: URL? = await run("Exporting “\(clip.label)”…") { report in
            switch self.mode {
            case .onDevice:
                let request = ExportRequest(
                    sourceURL: self.sourceURL!, pieces: clip.keptPieces, settings: self.settings,
                    captions: self.captionsForExport(clip), keyframes: keyframes, outputName: clip.label
                )
                return try await Exporter.export(request, progress: report, isCancelled: { self.cancelled() })
            case .workstation:
                return try await self.remoteExport(clip, progress: report)
            }
        }
        guard let produced else { return }
        finished.insert(FinishedFile(url: produced, name: produced.lastPathComponent, at: Date()), at: 0)
        say("✅ Exported. It's on the Finished tab.")
    }

    func exportAll() async {
        for index in clips.indices {
            await export(clipAt: index)
            if cancelFlag { break }
        }
    }

    private func captionsForExport(_ clip: Clip) -> [CaptionEvent] {
        guard !clip.captions.isEmpty else { return [] }
        // Captions are timed against the clip as SPOKEN; with pauses removed the
        // finished clip is shorter, so every line has to be pulled back by the
        // silence that was cut out before it. Without this the words drift later
        // and later through the short.
        guard !clip.cuts.isEmpty else { return clip.captions }
        let pieces = clip.keptPieces
        func mapped(_ t: Double) -> Double {
            let absolute = clip.start + t
            var elapsed = 0.0
            for piece in pieces {
                if absolute < piece.start { return elapsed }
                if absolute <= piece.end { return elapsed + (absolute - piece.start) }
                elapsed += piece.duration
            }
            return elapsed
        }
        return clip.captions.map { CaptionEvent(id: $0.id, start: mapped($0.start), end: mapped($0.end), text: $0.text) }
    }

    private func remoteExport(_ clip: Clip, progress: @escaping (Double) -> Void) async throws -> URL {
        guard let remote, let path = remoteSourcePath else { throw RemoteError.notPaired }
        let jobId = UUID().uuidString
        var args: [String: Any] = [
            "input": path, "startSec": clip.start, "endSec": clip.end,
            "preset": settings.preset.rawValue, "label": clip.label, "jobId": jobId,
            "fadeIn": settings.fadeIn, "fadeOut": settings.fadeOut,
        ]
        if settings.fill != .crop { args["fill"] = ["mode": settings.fill.rawValue] }
        if !clip.cuts.isEmpty {
            args["pieces"] = clip.keptPieces.map { ["start": $0.start, "end": $0.end] }
        }
        var remotePath = try await remote.callPath("sermon:exportShort", args)

        if !clip.captions.isEmpty {
            let events = captionsForExport(clip).map { ["start": $0.start, "end": $0.end, "text": $0.text] }
            let style = CaptionStyle.named(settings.captionStyle)
            remotePath = try await remote.callPath("captions:burn", [
                "input": remotePath, "events": events, "jobId": UUID().uuidString,
                "outName": clip.label, "deleteInput": true,
                "opts": [
                    "font": settings.captionFont, "sizeKey": settings.captionSize.rawValue,
                    "position": settings.captionPosition.rawValue, "style": style.kind.rawValue,
                    "outlineScale": style.outlineScale, "styleId": style.id,
                ],
            ])
        }
        progress(0.9)
        return try await remote.download(path: remotePath)
    }

    // MARK: - remote pairing

    func connect(host: String, pin: String) async {
        let client = RemoteClient(host: host)
        do {
            try await client.pair(pin: pin)
            remote = client
            remoteHost = host
            remotePaired = true
            mode = .workstation
            if let token = await client.token { Keychain.set(token, for: "mwRemoteToken") }
            say("Paired with your PC.")
        } catch {
            say(error.localizedDescription)
        }
    }

    func reconnectIfPossible() async {
        guard !remoteHost.isEmpty, let token = Keychain.get("mwRemoteToken") else { return }
        let client = RemoteClient(host: remoteHost, token: token)
        if let hello = try? await client.hello(), hello.paired {
            remote = client
            remotePaired = true
        }
    }

    func scanForWorkstations() async {
        discovered = await RemoteClient.discover()
        if discovered.isEmpty { say("No workstation answered on this network.") }
    }

    func unpair() {
        remote = nil
        remotePaired = false
        mode = .onDevice
        Keychain.delete("mwRemoteToken")
    }

    // MARK: - persistence

    private func persist() {
        let defaults = UserDefaults.standard
        if let data = try? JSONEncoder().encode(settings) { defaults.set(data, forKey: "settings") }
        defaults.set(targetLength ?? -1, forKey: "targetLength")
        defaults.set(removePauses, forKey: "removePauses")
        defaults.set(mode.rawValue, forKey: "mode")
        defaults.set(remoteHost, forKey: "remoteHost")
    }

    private func restore() {
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: "settings"),
           let s = try? JSONDecoder().decode(ExportSettings.self, from: data) { settings = s }
        let target = defaults.double(forKey: "targetLength")
        targetLength = target > 0 ? target : nil
        if defaults.object(forKey: "removePauses") != nil { removePauses = defaults.bool(forKey: "removePauses") }
        if let m = defaults.string(forKey: "mode"), let parsed = WorkMode(rawValue: m) { mode = parsed }
        remoteHost = defaults.string(forKey: "remoteHost") ?? ""
    }
}

enum Format {
    static func time(_ seconds: Double) -> String {
        let s = Int(max(0, seconds.rounded()))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, sec)
            : String(format: "%d:%02d", m, sec)
    }
}

/// The pairing token is a credential, so it belongs in the keychain rather than
/// UserDefaults — a backup of the phone should not carry it in the clear.
enum Keychain {
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "org.church.mediaworkstation",
         kSecAttrAccount as String: key]
    }
    static func set(_ value: String, for key: String) {
        delete(key)
        var q = query(key)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }
    static func get(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func delete(_ key: String) { SecItemDelete(query(key) as CFDictionary) }
}
