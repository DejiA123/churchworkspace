import SwiftUI

@main
struct MediaWorkstationApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .preferredColorScheme(.dark)
                .task { await state.reconnectIfPossible() }
        }
    }
}

/// The palette, matching the desktop studio so the two read as one product.
enum Theme {
    static let bg = Color(red: 0.059, green: 0.067, blue: 0.090)
    static let surface = Color(red: 0.086, green: 0.098, blue: 0.137)
    static let surfaceHigh = Color(red: 0.114, green: 0.129, blue: 0.188)
    static let line = Color(red: 0.173, green: 0.196, blue: 0.263)
    static let brand = Color(red: 0.427, green: 0.157, blue: 0.851)
    static let brandLight = Color(red: 0.545, green: 0.361, blue: 0.965)
    static let accent = Color(red: 0.961, green: 0.651, blue: 0.137)
    static let good = Color(red: 0.180, green: 0.800, blue: 0.443)

    static var primaryGradient: LinearGradient {
        LinearGradient(colors: [brand, brandLight], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Theme.primaryGradient)
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

struct GhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .medium))
            .frame(maxWidth: .infinity, minHeight: 46)
            .background(Theme.surface)
            .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(Theme.line))
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

struct CardBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .background(Theme.surface)
            .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(Theme.line))
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    }
}

extension View {
    func card() -> some View { modifier(CardBackground()) }
}
