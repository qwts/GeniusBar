/// `--window` mode: show the same menu content in a regular titled
/// NSWindow (activation policy .regular is set by the app for this mode)
/// so desktop automation can target it. A SceneBuilder cannot conditionally
/// add a Window scene, so the window is hosted imperatively with an
/// NSHostingView around the same ContentView the menu shows; clicking a
/// row opens the read-only detail sheet exactly as in the menu.
import Foundation
import GeniusBarLib
import SwiftUI
#if canImport(AppKit)
import AppKit

/// Presents the menu content in a titled window once the app has finished
/// launching (windows ordered before launch can sit behind other apps, so
/// this waits for didFinishLaunching first).
@MainActor
func showWindowMode() async {
    if !NSApplication.shared.isRunning {
        let launches = NotificationCenter.default.notifications(
            named: NSApplication.didFinishLaunchingNotification)
        for await _ in launches { break }
    }
    WindowModeController.shared.show()
}

@MainActor
final class WindowModeController {
    static let shared = WindowModeController()

    private var window: NSWindow?
    private var state: AppState?

    func show() {
        if window == nil {
            let state = AppState(store: makeStore())
            self.state = state
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 384, height: 560),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false)
            window.title = "GeniusBar"
            window.contentView = NSHostingView(rootView: ContentView(state: state))
            window.center()
            self.window = window
            state.start()
        }
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate()
    }
}
#endif
