/// Offscreen snapshot rendering shared by `--snapshot` and its test.
/// Both go through SwiftUI `ImageRenderer` at scale 2 over the real menu
/// content view, so the PNG shows what the menu would show.
import SwiftUI

#if canImport(AppKit)
import AppKit

/// Render a SwiftUI view to PNG bytes at the given scale. Returns nil when
/// the environment cannot produce an image (headless test hosts); callers
/// treat that as a graceful skip or a snapshot failure, never a crash.
@MainActor
public func renderSnapshotPNG<V: View>(of view: V, scale: CGFloat = 2) -> Data? {
    let renderer = ImageRenderer(content: view)
    renderer.scale = scale
    guard let image = renderer.nsImage,
        let tiff = image.tiffRepresentation,
        let rep = NSBitmapImageRep(data: tiff),
        let png = rep.representation(using: .png, properties: [:])
    else {
        return nil
    }
    return png
}
#endif

/// Opaque backdrop for snapshot renders. The menu normally draws over its
/// window's material; offscreen there is no window, so the default text
/// colors would sit on transparency (illegible on a dark viewer). A fixed
/// light scheme on white keeps the PNG legible everywhere.
public func snapshotBackdrop<V: View>(content: V) -> some View {
    content
        .preferredColorScheme(.light)
        .background(Color.white)
}

/// Find one soul in a forest by agent ID (accepting either the bare agent
/// ID or the "account/agentId" roster key).
public func findSoul(in forest: [SoulNode], agentId: String) -> Soul? {
    var stack = forest
    while let node = stack.popLast() {
        if node.soul.agentId == agentId || node.soul.id == agentId {
            return node.soul
        }
        stack.append(contentsOf: node.children)
    }
    return nil
}

/// Census soul count behind a forest (every node holds exactly one soul).
public func countSouls(in forest: [SoulNode]) -> Int {
    forest.reduce(0) { $0 + 1 + countSouls(in: $1.children) }
}
