/// `--snapshot` mode: fetch census+health once through the same
/// AppState/BrokerClient path the menubar uses (so custody and auth are
/// exercised), render the menu content view offscreen with ImageRenderer
/// at scale 2, write a PNG, print {"snapshot":"<path>","souls":N} on
/// stdout and exit 0. On any failure the PNG still shows what the UI
/// would show (unpaired or unreachable header), the error goes to stderr,
/// and the exit code is 1. Activation stays .accessory with no visible
/// window; Dudle animations render paused (eyes open) for a stable frame.
import Foundation
import GeniusBarLib
import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

@MainActor
func runSnapshotMode(snapshotPath: String, detailAgentId: String?) async {
    let state = AppState(store: makeStore())

    // The credential loads asynchronously in init. A binary the keychain item
    // does not yet trust blocks on the owner's Allow prompt, so wait long
    // enough for a human to answer it.
    let deadline = Date().addingTimeInterval(120)
    while state.isLoadingCredential, Date() < deadline {
        try? await Task.sleep(for: .milliseconds(50))
    }

    var failure: String?
    if state.isLoadingCredential {
        failure = "timed out waiting for the principal credential to load (unanswered keychain prompt?)"
    } else if state.isUnpaired {
        failure = state.lastError ?? unpairedMessage
    } else {
        await state.refreshOnce()
        if state.brokerUnreachable {
            failure = state.lastError ?? "cannot reach the broker"
        }
    }

    // With --snapshot-detail, the PNG shows the menu content with the
    // requested soul's detail panel beneath it, exactly the panel the
    // menu sheet would open for that row.
    var detailSoul: Soul?
    if let detailAgentId, !detailAgentId.isEmpty {
        if let soul = findSoul(in: state.forest, agentId: detailAgentId) {
            detailSoul = soul
        } else if failure == nil {
            failure = "no soul with agent ID '\(detailAgentId)'"
        }
    }

    #if canImport(AppKit)
    let content = ContentView(state: state, isStatic: true)
    let png: Data?
    if let detailSoul {
        let roster = allSouls(in: state.forest)
        png = renderSnapshotPNG(
            of: snapshotBackdrop(content: snapshotComposite(content: content, detail: detailSoul, roster: roster)))
    } else {
        png = renderSnapshotPNG(of: snapshotBackdrop(content: content))
    }
    guard let png else {
        writeStderr("snapshot failed: the renderer produced no image in this environment\n")
        exit(1)
    }
    do {
        let parent = (snapshotPath as NSString).deletingLastPathComponent
        if !parent.isEmpty {
            try FileManager.default.createDirectory(
                atPath: parent, withIntermediateDirectories: true, attributes: nil)
        }
        try png.write(to: URL(fileURLWithPath: snapshotPath), options: .atomic)
    } catch {
        writeStderr("snapshot failed: cannot write \(snapshotPath): \(error)\n")
        exit(1)
    }
    #else
    writeStderr("snapshot failed: AppKit rendering is unavailable on this platform\n")
    exit(1)
    #endif

    let souls = countSouls(in: state.forest)
    writeStdout("{\"snapshot\":\(jsonString(snapshotPath)),\"souls\":\(souls)}\n")
    if let failure {
        writeStderr("snapshot: \(failure)\n")
        exit(1)
    }
    exit(0)
}

#if canImport(AppKit)
/// Menu content on top, requested detail panel below: one PNG showing both
/// what the menu lists and what the row's sheet would open.
private func snapshotComposite(content: ContentView, detail soul: Soul, roster: [Soul]) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        content
        Divider()
        SoulDetailView(soul: soul, isPaused: true, roster: roster, isStatic: true)
    }
    .padding(12)
    .frame(width: 360)
}
#endif

private func writeStdout(_ string: String) {
    FileHandle.standardOutput.write(Data(string.utf8))
}

private func writeStderr(_ string: String) {
    FileHandle.standardError.write(Data(string.utf8))
}

/// Minimal JSON string escaping for the snapshot path in stdout.
private func jsonString(_ raw: String) -> String {
    "\"" + raw.flatMap { char -> String in
        switch char {
        case "\"": return "\\\""
        case "\\": return "\\\\"
        case "\n": return "\\n"
        case "\r": return "\\r"
        case "\t": return "\\t"
        default:
            if char.isASCII, let scalar = char.unicodeScalars.first, scalar.value < 0x20 {
                return String(format: "\\u%04x", scalar.value)
            }
            return String(char)
        }
    }.joined() + "\""
}
