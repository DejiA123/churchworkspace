import SwiftUI

/// The clips the analyser found: review, rename, caption, export.
struct ShortsView: View {
    @EnvironmentObject private var state: AppState
    @State private var renaming: Int?
    @State private var renameText = ""
    @State private var captioning: Int?

    var body: some View {
        NavigationStack {
            Group {
                if state.clips.isEmpty {
                    ContentUnavailableView {
                        Label("No clips yet", systemImage: "sparkles")
                    } description: {
                        Text("Open a recording and tap Long to short clips.")
                    }
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(Array(state.clips.enumerated()), id: \.element.id) { index, clip in
                                ClipCard(
                                    clip: clip,
                                    isTopPick: clip.id == topPick?.id,
                                    onRename: { renaming = index; renameText = clip.label },
                                    onCaption: { Task { await state.transcribe(clipAt: index); captioning = index } },
                                    onExport: { Task { await state.export(clipAt: index) } },
                                    onDelete: { state.clips.remove(at: index) }
                                )
                            }
                        }
                        .padding(14)
                    }
                }
            }
            .background(Theme.bg)
            .navigationTitle("Shorts")
            .toolbar {
                if !state.clips.isEmpty {
                    Button("Export all") { Task { await state.exportAll() } }
                }
            }
            .alert("Rename clip", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $renameText)
                Button("Save") {
                    if let i = renaming, state.clips.indices.contains(i), !renameText.isEmpty {
                        state.clips[i].label = renameText
                    }
                    renaming = nil
                }
                Button("Cancel", role: .cancel) { renaming = nil }
            }
            .sheet(isPresented: Binding(get: { captioning != nil }, set: { if !$0 { captioning = nil } })) {
                if let i = captioning, state.clips.indices.contains(i) {
                    CaptionEditorView(clipIndex: i)
                }
            }
        }
    }

    private var topPick: Clip? { state.clips.max { $0.virality < $1.virality } }
}

private struct ClipCard: View {
    let clip: Clip
    let isTopPick: Bool
    let onRename: () -> Void
    let onCaption: () -> Void
    let onExport: () -> Void
    let onDelete: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top) {
                    Text(clip.label).font(.system(size: 16, weight: .semibold))
                    Spacer()
                    Text("#\(clip.rank)").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Text("\(Format.time(clip.start)) – \(Format.time(clip.end))  ·  \(Format.time(clip.duration))")
                    .font(.system(size: 12)).foregroundStyle(.secondary)

                if let quote = clip.quote, !quote.isEmpty {
                    Text("“\(quote)”").font(.system(size: 13)).italic().foregroundStyle(.secondary)
                }

                FlowTags(tags: tags)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)

            Divider().overlay(Theme.line)

            HStack(spacing: 0) {
                actionButton("pencil", "Rename", onRename)
                actionButton("text.bubble", "Captions", onCaption)
                actionButton("square.and.arrow.down", "Export", onExport)
                actionButton("trash", "Delete", onDelete)
            }
        }
        .background(Theme.surface)
        .overlay(RoundedRectangle(cornerRadius: 15).stroke(isTopPick ? Theme.accent : Theme.line))
        .clipShape(RoundedRectangle(cornerRadius: 15))
    }

    private var tags: [(String, Color)] {
        var out: [(String, Color)] = []
        if isTopPick { out.append(("🔥 Top pick", Theme.accent)) }
        if clip.virality > 0 { out.append(("\(clip.virality)% viral score", .secondary)) }
        if !clip.cuts.isEmpty { out.append((String(format: "🤫 %.1fs cut", clip.removedSeconds), Theme.good)) }
        if !clip.captions.isEmpty { out.append(("💬 \(clip.captions.count) lines", Theme.brandLight)) }
        for reason in clip.reasons.prefix(2) { out.append((reason, .secondary)) }
        return out
    }

    private func actionButton(_ icon: String, _ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .frame(maxWidth: .infinity, minHeight: 46)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .background(Theme.surfaceHigh)
        .overlay(Rectangle().frame(width: 1).foregroundStyle(Theme.line), alignment: .trailing)
    }
}

/// Tags that wrap instead of overflowing — a clip can carry five reasons and a
/// phone is 375 points wide.
private struct FlowTags: View {
    let tags: [(String, Color)]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 90), spacing: 6)], alignment: .leading, spacing: 6) {
            ForEach(Array(tags.enumerated()), id: \.offset) { _, tag in
                Text(tag.0)
                    .font(.system(size: 11))
                    .lineLimit(1)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Theme.surfaceHigh)
                    .foregroundStyle(tag.1)
                    .clipShape(Capsule())
            }
        }
    }
}
