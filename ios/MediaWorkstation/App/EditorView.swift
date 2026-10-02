import SwiftUI
import AVKit

/// The editing surface: watch it, trim it, and turn it into shorts.
struct EditorView: View {
    @EnvironmentObject private var state: AppState
    @State private var player = AVPlayer()
    @State private var playhead: Double = 0
    @State private var timeObserver: Any?

    var body: some View {
        NavigationStack {
            Group {
                if state.isLoaded {
                    ScrollView {
                        VStack(spacing: 0) {
                            VideoPlayer(player: player)
                                .frame(height: 240)
                                .background(.black)

                            TransportBar(player: player, playhead: playhead, duration: state.duration)

                            TrimStrip(
                                duration: state.duration,
                                start: $state.rangeStart,
                                end: $state.rangeEnd,
                                playhead: playhead,
                                onScrub: { seek(to: $0) }
                            )
                            .padding(.horizontal, 14)
                            .padding(.top, 12)

                            options
                        }
                    }
                } else {
                    ContentUnavailableView {
                        Label("Nothing open", systemImage: "film")
                    } description: {
                        Text("Pick a recording on the Videos tab — from this phone, or straight off your PC.")
                    }
                }
            }
            .background(Theme.bg)
            .navigationTitle(state.isLoaded ? state.sourceName : "Edit")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onChange(of: state.sourceURL) { _, url in load(url) }
        .onAppear { load(state.sourceURL) }
        .onDisappear { player.pause() }
    }

    private var options: some View {
        VStack(spacing: 14) {
            HStack {
                Text(state.wholeVideoSelected
                     ? "Working on the whole video"
                     : "Working on \(Format.time(state.rangeStart)) – \(Format.time(state.rangeEnd))")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Reset") {
                    state.rangeStart = 0
                    state.rangeEnd = state.duration
                }
                .font(.system(size: 12))
            }

            HStack(spacing: 10) {
                Picker("Clip length", selection: Binding(
                    get: { state.targetLength ?? -1 },
                    set: { state.targetLength = $0 < 0 ? nil : $0 }
                )) {
                    Text("✨ Auto (~1½ min)").tag(-1.0)
                    Text("~30s").tag(30.0)
                    Text("~1 min").tag(60.0)
                    Text("~1½ min").tag(90.0)
                    Text("~2 min").tag(120.0)
                }
                .pickerStyle(.menu)

                Picker("Shape", selection: $state.settings.preset) {
                    ForEach([ExportPreset.reel9x16, .square1x1, .portrait4x5, .wide16x9]) {
                        Text($0.label).tag($0)
                    }
                }
                .pickerStyle(.menu)
            }
            .tint(Theme.brandLight)

            Toggle("🤫 Remove pauses", isOn: $state.removePauses)
            Toggle("🎯 Follow the speaker", isOn: $state.settings.followSpeaker)
                .disabled(state.settings.fill != .crop)

            Button("✂️ Long to short clips") {
                Task { await state.findHighlights() }
            }
            .buttonStyle(PrimaryButtonStyle())

            Button("💾 Export just this trim") {
                Task { await exportTrim() }
            }
            .buttonStyle(GhostButtonStyle())

            if state.mode == .workstation {
                Label("Your PC is doing the work.", systemImage: "desktopcomputer")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.good)
            }
        }
        .padding(14)
        .tint(Theme.brandLight)
    }

    private func load(_ url: URL?) {
        guard let url else { return }
        if let timeObserver { player.removeTimeObserver(timeObserver); self.timeObserver = nil }
        player.replaceCurrentItem(with: AVPlayerItem(url: url))
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.1, preferredTimescale: 600), queue: .main
        ) { time in playhead = time.seconds }
    }

    private func seek(to t: Double) {
        player.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private func exportTrim() async {
        // "Export just this trim" keeps the recording's own shape — it is not a
        // social crop, and treating it like one is how a whole service ends up
        // cropped to 9:16 by accident.
        var settings = state.settings
        settings.preset = .source
        settings.followSpeaker = false
        let name = (state.sourceName as NSString).deletingPathExtension + "-edited"
        state.clips.append(Clip(start: state.rangeStart, end: state.rangeEnd, label: name))
        let index = state.clips.count - 1
        let saved = state.settings
        state.settings = settings
        await state.export(clipAt: index)
        state.settings = saved
        state.clips.remove(at: index)
    }
}

/// Play, skip, and the clock.
private struct TransportBar: View {
    let player: AVPlayer
    let playhead: Double
    let duration: Double
    @State private var playing = false

    var body: some View {
        HStack(spacing: 14) {
            Button { player.seek(to: CMTime(seconds: max(0, playhead - 10), preferredTimescale: 600)) } label: {
                Image(systemName: "gobackward.10")
            }
            Button {
                if playing { player.pause() } else { player.play() }
                playing.toggle()
            } label: {
                Image(systemName: playing ? "pause.fill" : "play.fill").font(.system(size: 20))
            }
            Button { player.seek(to: CMTime(seconds: min(duration, playhead + 10), preferredTimescale: 600)) } label: {
                Image(systemName: "goforward.10")
            }
            Text("\(Format.time(playhead)) / \(Format.time(duration))")
                .font(.system(size: 12).monospacedDigit())
                .foregroundStyle(.secondary)
            Spacer()
        }
        .font(.system(size: 17))
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Theme.surface)
    }
}

/// A scrub bar with two trim handles. Dragging the middle seeks; dragging near
/// an end moves that end — the same gesture the web Phone Studio uses, because
/// two separate controls on a phone is one control too many.
private struct TrimStrip: View {
    let duration: Double
    @Binding var start: Double
    @Binding var end: Double
    let playhead: Double
    let onScrub: (Double) -> Void

    @State private var dragging: Edge?
    private enum Edge { case left, right, scrub }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let x: (Double) -> CGFloat = { CGFloat(max(0, min(1, $0 / max(0.001, duration)))) * w }

            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 10).fill(Theme.surfaceHigh)

                Rectangle().fill(.black.opacity(0.62))
                    .frame(width: x(start))
                Rectangle().fill(.black.opacity(0.62))
                    .frame(width: max(0, w - x(end)))
                    .offset(x: x(end))

                Rectangle().fill(Theme.accent).frame(width: 5)
                    .offset(x: x(start) - 2.5)
                Rectangle().fill(Theme.accent).frame(width: 5)
                    .offset(x: x(end) - 2.5)

                Rectangle().fill(.white).frame(width: 2)
                    .offset(x: x(playhead) - 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let t = Double(max(0, min(w, value.location.x)) / w) * duration
                        if dragging == nil {
                            let dl = abs(value.location.x - x(start))
                            let dr = abs(value.location.x - x(end))
                            dragging = min(dl, dr) <= 26 ? (dl <= dr ? .left : .right) : .scrub
                        }
                        switch dragging {
                        case .left: start = min(t, end - 1); onScrub(start)
                        case .right: end = max(t, start + 1); onScrub(end)
                        default: onScrub(t)
                        }
                    }
                    .onEnded { _ in dragging = nil }
            )
        }
        .frame(height: 64)
    }
}
