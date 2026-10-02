import SwiftUI

struct RootView: View {
    @EnvironmentObject private var state: AppState
    @State private var tab = 1

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            TabView(selection: $tab) {
                LibraryView().tabItem { Label("Videos", systemImage: "folder") }.tag(0)
                EditorView().tabItem { Label("Edit", systemImage: "scissors") }.tag(1)
                ShortsView().tabItem { Label("Shorts", systemImage: "sparkles") }
                    .badge(state.clips.count)
                    .tag(2)
                ExportsView().tabItem { Label("Finished", systemImage: "square.and.arrow.down") }.tag(3)
                SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }.tag(4)
            }
            .tint(Theme.brandLight)

            if let job = state.job { ProgressOverlay(job: job) }

            if let toast = state.toast {
                VStack {
                    Spacer()
                    Text(toast)
                        .font(.system(size: 14))
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .background(Theme.surfaceHigh)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .padding(.horizontal, 16)
                        .padding(.bottom, 76)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                .allowsHitTesting(false)
            }
        }
        .animation(.easeOut(duration: 0.2), value: state.toast)
        .onChange(of: state.clips.count) { _, count in if count > 0 { tab = 2 } }
    }
}

struct ProgressOverlay: View {
    let job: RunningJob

    var body: some View {
        ZStack {
            Color.black.opacity(0.82).ignoresSafeArea()
            VStack(spacing: 16) {
                Text(job.label)
                    .font(.system(size: 15))
                    .multilineTextAlignment(.center)
                ProgressView(value: job.progress)
                    .tint(Theme.brandLight)
                Text("\(Int(job.progress * 100))%")
                    .font(.system(size: 13).monospacedDigit())
                    .foregroundStyle(.secondary)
                Button("Cancel") { job.cancel() }
                    .buttonStyle(GhostButtonStyle())
            }
            .padding(24)
            .frame(maxWidth: 340)
            .background(Theme.surface)
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Theme.line))
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .padding(24)
        }
        .transition(.opacity)
    }
}
