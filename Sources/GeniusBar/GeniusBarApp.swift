import GeniusBarLib
import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

/// GeniusBar: macOS menubar listing of souls on this machine. Menu bar
/// only: no Dock icon.
@main
struct GeniusBarApp: App {
    @StateObject private var state = AppState(store: makeStore())

    init() {
        // A SwiftPM executable has no Info.plist, so opt out of the Dock
        // here instead of via LSUIElement.
        #if canImport(AppKit)
        NSApplication.shared.setActivationPolicy(.accessory)
        #endif
    }

    var body: some Scene {
        MenuBarExtra("GeniusBar", systemImage: "person.2.circle") {
            ContentView(state: state)
        }
        .menuBarExtraStyle(.window)
    }
}

private func makeStore() -> any CredentialStore {
    #if canImport(Security)
    return KeychainCredentialStore()
    #else
    return InMemoryCredentialStore()
    #endif
}
