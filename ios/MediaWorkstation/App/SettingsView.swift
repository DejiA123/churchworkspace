import SwiftUI
import UniformTypeIdentifiers

/// Framing, sound, captions — and the switch that decides whether this phone or
/// the church PC does the work.
struct SettingsView: View {
    @EnvironmentObject private var state: AppState
    @State private var pin = ""
    @State private var manualHost = ""
    @State private var scanning = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Do the work", selection: $state.mode) {
                        ForEach(WorkMode.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .disabled(!state.remotePaired)

                    if state.remotePaired {
                        Label("Paired with \(state.remoteHost)", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(Theme.good)
                        Button("Unpair", role: .destructive) { state.unpair() }
                    } else {
                        Text("Pair with the workstation and the same buttons drive your PC instead — it encodes in seconds and hands the clip back. Unpaired, everything still works here on the phone.")
                            .font(.system(size: 12)).foregroundStyle(.secondary)

                        Button {
                            Task { scanning = true; await state.scanForWorkstations(); scanning = false }
                        } label: {
                            HStack {
                                Text("Find my PC on this wifi")
                                if scanning { Spacer(); ProgressView() }
                            }
                        }
                        ForEach(state.discovered, id: \.self) { host in
                            Button(host) { manualHost = host }
                        }
                        TextField("Address shown on the PC (e.g. 192.168.1.20:7380)", text: $manualHost)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Pairing PIN", text: $pin)
                            .keyboardType(.numberPad)
                        Button("Pair") {
                            Task { await state.connect(host: manualHost, pin: pin); pin = "" }
                        }
                        .disabled(manualHost.isEmpty || pin.count < 4)
                    }
                } header: {
                    Text("Where the work happens")
                }

                Section("How shorts are framed") {
                    Picker("Fill the frame", selection: $state.settings.fill) {
                        ForEach(FillMode.allCases) { Text($0.label).tag($0) }
                    }
                    Toggle("Follow the speaker", isOn: $state.settings.followSpeaker)
                        .disabled(state.settings.fill != .crop)
                    if state.settings.fill != .crop {
                        Text("A letterboxed or blurred export shows the whole picture, so there is nothing to pan.")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    Stepper("Fade in: \(state.settings.fadeIn, specifier: "%.1f")s",
                            value: $state.settings.fadeIn, in: 0...5, step: 0.5)
                    Stepper("Fade out: \(state.settings.fadeOut, specifier: "%.1f")s",
                            value: $state.settings.fadeOut, in: 0...5, step: 0.5)
                }

                Section("Captions") {
                    Toggle("Caption every short", isOn: $state.settings.captionsOnEveryShort)
                    Picker("Words per line", selection: $state.settings.wordsPerLine) {
                        ForEach(WordsPerLine.allCases) { Text($0.label).tag($0) }
                    }
                    Picker("Case", selection: $state.settings.textCase) {
                        ForEach(TextCase.allCases) { Text($0.label).tag($0) }
                    }
                    Label(
                        Transcriber.isAvailable
                            ? "Speech recognition: ready, on this device"
                            : "Speech recognition: not available in this language offline",
                        systemImage: Transcriber.isAvailable ? "waveform" : "exclamationmark.triangle"
                    )
                    .font(.system(size: 12))
                    .foregroundStyle(Transcriber.isAvailable ? Theme.good : .secondary)
                }

                Section("Music & outro") {
                    MediaPickerRow(title: "Music bed", url: $state.settings.musicURL, kind: .audio)
                    if state.settings.musicURL != nil {
                        HStack {
                            Text("Volume")
                            Slider(value: $state.settings.musicVolume, in: 0...1)
                        }
                    }
                    MediaPickerRow(title: "Outro clip", url: $state.settings.outroURL, kind: .video)
                }

                Section {
                    Text("Church Work Space for iPhone")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Settings")
            .tint(Theme.brandLight)
        }
    }
}

/// Pick a music bed or an outro out of Files, copied into the app so it survives.
private struct MediaPickerRow: View {
    enum Kind { case audio, video }
    let title: String
    @Binding var url: URL?
    let kind: Kind
    @State private var picking = false

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            Button(url?.lastPathComponent ?? "None") { picking = true }
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if url != nil {
                Button { url = nil } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: kind == .audio ? [.audio] : [.movie]) { result in
            guard case .success(let picked) = result else { return }
            let scoped = picked.startAccessingSecurityScopedResource()
            defer { if scoped { picked.stopAccessingSecurityScopedResource() } }
            let dest = AppFolders.media.appendingPathComponent(picked.lastPathComponent)
            try? FileManager.default.removeItem(at: dest)
            if (try? FileManager.default.copyItem(at: picked, to: dest)) != nil { url = dest }
        }
    }
}
