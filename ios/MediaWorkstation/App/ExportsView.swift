import SwiftUI
import UIKit
import Photos
import AVKit

/// What came out. Save it to the camera roll, or share it straight to the app
/// that is going to post it.
struct ExportsView: View {
    @EnvironmentObject private var state: AppState
    @State private var sharing: URL?
    @State private var playing: URL?

    var body: some View {
        NavigationStack {
            Group {
                if state.finished.isEmpty {
                    ContentUnavailableView {
                        Label("Nothing yet", systemImage: "square.and.arrow.down")
                    } description: {
                        Text("Anything you export lands here.")
                    }
                } else {
                    List {
                        ForEach(state.finished) { file in
                            VStack(alignment: .leading, spacing: 10) {
                                Text(file.name).font(.system(size: 15, weight: .medium)).lineLimit(2)
                                Text(file.at.formatted(date: .omitted, time: .shortened))
                                    .font(.system(size: 12)).foregroundStyle(.secondary)
                                HStack(spacing: 10) {
                                    Button { playing = file.url } label: {
                                        Label("Watch", systemImage: "play.circle")
                                    }
                                    Button { Task { await saveToPhotos(file.url) } } label: {
                                        Label("Save to camera roll", systemImage: "square.and.arrow.down")
                                    }
                                    Button { sharing = file.url } label: {
                                        Label("Share", systemImage: "square.and.arrow.up")
                                    }
                                }
                                .buttonStyle(.bordered)
                                .font(.system(size: 13))
                                .labelStyle(.iconOnly)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                    .scrollContentBackground(.hidden)
                }
            }
            .background(Theme.bg)
            .navigationTitle("Finished")
            .sheet(item: Binding(get: { sharing.map(IdentifiedURL.init) }, set: { sharing = $0?.url })) { item in
                ShareSheet(items: [item.url])
            }
            .sheet(item: Binding(get: { playing.map(IdentifiedURL.init) }, set: { playing = $0?.url })) { item in
                VideoPlayer(player: AVPlayer(url: item.url)).ignoresSafeArea()
            }
        }
    }

    private func saveToPhotos(_ url: URL) async {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            state.say("Allow photo access in Settings to save clips to your camera roll.")
            return
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
            }
            state.say("✅ Saved to your camera roll.")
        } catch {
            state.say("Could not save it: \(error.localizedDescription)")
        }
    }
}

private struct IdentifiedURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
    init(_ url: URL) { self.url = url }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
