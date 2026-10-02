import SwiftUI
import PhotosUI
import AVFoundation
import UniformTypeIdentifiers

/// Where a recording comes from: the camera roll, a file, or — when the app is
/// paired — the folders on the workstation itself.
struct LibraryView: View {
    @EnvironmentObject private var state: AppState
    @State private var pickerItem: PhotosPickerItem?
    @State private var showingFileImporter = false
    @State private var remoteGroups: [RemoteVideoGroup] = []
    @State private var importing = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    PhotosPicker(selection: $pickerItem, matching: .videos) {
                        Label("Choose from my camera roll", systemImage: "photo.on.rectangle.angled")
                    }
                    Button {
                        showingFileImporter = true
                    } label: {
                        Label("Choose a file", systemImage: "folder")
                    }
                } header: {
                    Text("On this phone")
                }

                if !onDeviceFiles.isEmpty {
                    Section("Already imported") {
                        ForEach(onDeviceFiles, id: \.self) { url in
                            Button {
                                Task { await state.open(url: url); state.remoteSourcePath = nil }
                            } label: {
                                FileRow(name: url.lastPathComponent, subtitle: sizeText(url))
                            }
                        }
                    }
                }

                if state.remotePaired {
                    ForEach(remoteGroups) { group in
                        if !group.files.isEmpty {
                            Section("\(group.label) — on your PC") {
                                ForEach(group.files.prefix(40)) { file in
                                    Button {
                                        Task {
                                            state.mode = .workstation
                                            await state.openRemote(path: file.path, name: file.name)
                                        }
                                    } label: {
                                        FileRow(name: file.name, subtitle: byteText(file.size))
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Videos")
            .toolbar {
                Button { Task { await refreshRemote() } } label: { Image(systemName: "arrow.clockwise") }
            }
            .task { await refreshRemote() }
            .overlay { if importing { ProgressView("Copying in…").padding(24).background(.thinMaterial).clipShape(RoundedRectangle(cornerRadius: 14)) } }
        }
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            Task { await importFromPhotos(item) }
        }
        .fileImporter(isPresented: $showingFileImporter, allowedContentTypes: [.movie, .video, .mpeg4Movie]) { result in
            guard case .success(let url) = result else { return }
            Task { await importFile(url) }
        }
    }

    private func refreshRemote() async {
        guard let remote = state.remote else { remoteGroups = []; return }
        remoteGroups = (try? await remote.videos()) ?? []
    }

    private var onDeviceFiles: [URL] {
        ((try? FileManager.default.contentsOfDirectory(at: AppFolders.imported, includingPropertiesForKeys: [.fileSizeKey])) ?? [])
            .filter { ["mp4", "mov", "m4v"].contains($0.pathExtension.lowercased()) }
            .sorted { (mtime($0) ?? .distantPast) > (mtime($1) ?? .distantPast) }
    }

    private func mtime(_ url: URL) -> Date? {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    }
    private func sizeText(_ url: URL) -> String {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        return byteText(Int64(size))
    }
    private func byteText(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    /// The camera roll hands over a copy in a sandboxed temp location that can
    /// vanish, so it is moved into the app's own folder before anything opens it.
    private func importFromPhotos(_ item: PhotosPickerItem) async {
        importing = true
        defer { importing = false; pickerItem = nil }
        guard let movie = try? await item.loadTransferable(type: VideoFile.self) else {
            state.say("Could not read that video from your library.")
            return
        }
        await state.open(url: movie.url)
        state.remoteSourcePath = nil
    }

    private func importFile(_ url: URL) async {
        importing = true
        defer { importing = false }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let dest = AppFolders.imported.appendingPathComponent(url.lastPathComponent)
        try? FileManager.default.removeItem(at: dest)
        do {
            try FileManager.default.copyItem(at: url, to: dest)
            await state.open(url: dest)
            state.remoteSourcePath = nil
        } catch {
            state.say("Could not copy that file in: \(error.localizedDescription)")
        }
    }
}

private struct FileRow: View {
    let name: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(name).font(.system(size: 15, weight: .medium)).lineLimit(1)
            Text(subtitle).font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// PhotosPicker gives back a file URL that is only valid inside the transfer, so
/// this copies it somewhere the app owns on the way through.
struct VideoFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let dest = AppFolders.imported
                .appendingPathComponent("\(UUID().uuidString.prefix(8))-\(received.file.lastPathComponent)")
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.copyItem(at: received.file, to: dest)
            return VideoFile(url: dest)
        }
    }
}
