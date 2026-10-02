import SwiftUI

/// Pick a look, then fix any word the recogniser misheard. The preview draws
/// with the SAME renderer the export uses, so what is chosen here is what lands
/// in the file.
struct CaptionEditorView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    let clipIndex: Int

    var body: some View {
        NavigationStack {
            List {
                Section("Look") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(CaptionStyle.all) { style in
                                StyleChip(style: style, selected: style.id == state.settings.captionStyle)
                                    .onTapGesture { state.settings.captionStyle = style.id }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    Picker("Font", selection: $state.settings.captionFont) {
                        ForEach(CaptionFont.names, id: \.self) { Text($0).tag($0) }
                    }
                    Picker("Size", selection: $state.settings.captionSize) {
                        ForEach(CaptionSize.allCases) { Text($0.label).tag($0) }
                    }
                    Picker("Position", selection: $state.settings.captionPosition) {
                        ForEach(CaptionPosition.allCases) { Text($0.label).tag($0) }
                    }
                }

                Section("Words") {
                    if clip.captions.isEmpty {
                        Text("No captions yet — tap the speech bubble on the clip to listen to it.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(Array(clip.captions.enumerated()), id: \.element.id) { index, event in
                        HStack(spacing: 10) {
                            Text(Format.time(event.start))
                                .font(.system(size: 11).monospacedDigit())
                                .foregroundStyle(.secondary)
                                .frame(width: 44, alignment: .leading)
                            TextField("", text: Binding(
                                get: { event.text },
                                set: { state.clips[clipIndex].captions[index].text = $0 }
                            ))
                        }
                    }
                }

                Section {
                    Button("Remove these captions", role: .destructive) {
                        state.clips[clipIndex].captions = []
                        dismiss()
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Captions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private var clip: Clip {
        state.clips.indices.contains(clipIndex) ? state.clips[clipIndex] : Clip(start: 0, end: 0, label: "")
    }
}

/// Each look drawn AS ITSELF, so it is picked with the eye rather than from a
/// description like "white + outline" that tells you nothing.
private struct StyleChip: View {
    let style: CaptionStyle
    let selected: Bool

    var body: some View {
        Text(style.name)
            .font(.system(size: 15, weight: .heavy))
            .foregroundStyle(Color(red: style.color.r, green: style.color.g, blue: style.color.b))
            .shadow(color: style.kind == .shadow ? .black : .clear, radius: 3, y: 2)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(
                style.kind == .box
                    ? Color(red: style.outline.r, green: style.outline.g, blue: style.outline.b)
                    : Color(red: 0.08, green: 0.09, blue: 0.12)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(selected ? Theme.brandLight : Theme.line, lineWidth: selected ? 2 : 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
