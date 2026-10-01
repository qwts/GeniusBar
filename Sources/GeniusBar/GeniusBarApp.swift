import GeniusBarLib
import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

/// GeniusBar: macOS menubar listing of souls on this machine. Menu bar
/// only: no Dock icon.
///
/// Two launch flags expose the menu content to automation and CI (parsed
/// here; a normal launch with neither flag is unchanged):
/// `--snapshot <path.png> [--snapshot-detail <agentId>]` renders the menu
/// content offscreen to a PNG and exits, and `--window` additionally shows
/// it in a regular titled window.
@main
struct GeniusBarApp: App {
    private let options: LaunchOptions
    @StateObject private var state = AppState(store: makeStore())

    init() {
        let options = parseLaunchOptions(CommandLine.arguments)
        self.options = options
        #if canImport(AppKit)
        if options.showWindow {
            NSApplication.shared.setActivationPolicy(.regular)
            Task { @MainActor in
                await showWindowMode()
            }
        } else {
            // A SwiftPM executable has no Info.plist, so opt out of the Dock
            // here instead of via LSUIElement. Snapshot mode keeps this too:
            // ImageRenderer draws offscreen with no visible window.
            NSApplication.shared.setActivationPolicy(.accessory)
        }
        #endif
        if let snapshotPath = options.snapshotPath {
            let detailAgentId = options.snapshotDetailAgentId
            Task { @MainActor in
                await runSnapshotMode(snapshotPath: snapshotPath, detailAgentId: detailAgentId)
            }
        }
    }

    var body: some Scene {
        MenuBarExtra("GeniusBar", systemImage: "person.2.circle") {
            ContentView(state: state)
        }
        .menuBarExtraStyle(.window)
    }
}

func makeStore() -> any CredentialStore {
    #if canImport(Security)
    return KeychainCredentialStore()
    #else
    return InMemoryCredentialStore()
    #endif
}
