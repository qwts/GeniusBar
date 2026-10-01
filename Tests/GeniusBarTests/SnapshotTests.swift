import Foundation
import Testing
@testable import GeniusBarLib
#if canImport(AppKit)
import AppKit
#endif

@Suite("Launch options")
struct LaunchOptionsTests {
    @Test("No flags means a normal menubar launch")
    func defaults() {
        #expect(parseLaunchOptions([]) == LaunchOptions())
        #expect(parseLaunchOptions(["GeniusBar"]) == LaunchOptions())
    }

    @Test("Unknown arguments are ignored")
    func ignoresUnknown() {
        let options = parseLaunchOptions(["GeniusBar", "-ApplePersistenceIgnoreState", "NO", "--foo"])
        #expect(options == LaunchOptions())
    }

    @Test("Snapshot takes the following path")
    func snapshotPath() {
        #expect(parseLaunchOptions(["--snapshot", "/tmp/menu.png"]).snapshotPath == "/tmp/menu.png")
        #expect(parseLaunchOptions(["--snapshot=/tmp/menu.png"]).snapshotPath == "/tmp/menu.png")
    }

    @Test("Snapshot without a value leaves the path unset")
    func snapshotMissingValue() {
        #expect(parseLaunchOptions(["--snapshot"]).snapshotPath == nil)
        #expect(parseLaunchOptions(["--snapshot", "--window"]) == LaunchOptions(showWindow: true))
    }

    @Test("Snapshot detail takes the following agent ID")
    func snapshotDetail() {
        let options = parseLaunchOptions(["--snapshot", "/tmp/menu.png", "--snapshot-detail", "agent_1"])
        #expect(options.snapshotPath == "/tmp/menu.png")
        #expect(options.snapshotDetailAgentId == "agent_1")
        #expect(
            parseLaunchOptions(["--snapshot-detail=agent_9"]).snapshotDetailAgentId == "agent_9")
    }

    @Test("Window flag requests a regular titled window")
    func windowFlag() {
        #expect(parseLaunchOptions(["--window"]).showWindow)
        #expect(!parseLaunchOptions([]).showWindow)
    }

    @Test("Flags combine and order does not matter")
    func combined() {
        let options = parseLaunchOptions(["--window", "--snapshot", "/tmp/m.png"])
        #expect(options == LaunchOptions(snapshotPath: "/tmp/m.png", showWindow: true))
    }

    @Test("Soul lookup accepts bare and roster-key IDs, and counts the forest")
    func soulHelpers() {
        let souls = [
            Soul(account: "user", agentId: "agent_p", name: "p", presence: .joined),
            Soul(account: "user", agentId: "agent_c", name: "c", parent: "agent_p", presence: .left),
        ]
        let forest = buildSoulForest(souls)
        #expect(countSouls(in: forest) == 2)
        #expect(findSoul(in: forest, agentId: "agent_c")?.presence == .left)
        #expect(findSoul(in: forest, agentId: "user/agent_c")?.agentId == "agent_c")
        #expect(findSoul(in: forest, agentId: "agent_gone") == nil)
        #expect(countSouls(in: []) == 0)
    }
}

@Suite("Snapshot rendering")
struct SnapshotRenderTests {
    #if canImport(AppKit)
    private func pngDims(_ data: Data) -> (w: Int, h: Int)? {
        guard let rep = NSBitmapImageRep(data: data) else { return nil }
        return (rep.pixelsWide, rep.pixelsHigh)
    }
    #endif

    @Test("Fixed fake forest and health render to a nonzero PNG")
    @MainActor
    func rendersPNG() throws {
        #if canImport(AppKit)
        let souls = [
            Soul(
                account: "user", agentId: "agent_p", name: "luna", harness: "codex",
                presence: .joined, unacked: 0, lastWake: "2026-01-01T00:00:01Z"),
            Soul(
                account: "user", agentId: "agent_c", harness: nil, parent: "agent_p",
                presence: .watching, unacked: 3),
            Soul(account: "user", agentId: "agent_gone", name: "old", presence: .left),
        ]
        let state = AppState(store: InMemoryCredentialStore())
        state.forest = buildSoulForest(souls)
        state.health = BrokerHealth(
            ok: true, uptimeMs: 12_000, eventLogBytes: 512,
            pairings: BrokerHealth.PairingCounts(accounts: 1, principals: 2), watches: 3)
        state.isLoadingCredential = false
        guard let png = renderSnapshotPNG(of: snapshotBackdrop(content: ContentView(state: state, isStatic: true))) else {
            print("SKIP: ImageRenderer produced no image in this test environment")
            return
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("geniusbar-snapshot-test-\(UUID().uuidString).png")
        try png.write(to: url, options: .atomic)
        let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        #expect(size > 0)
        // The rows must actually draw: a populated roster renders taller
        // than the same header with an empty roster (this caught the
        // ScrollView measuring empty offscreen).
        let emptyState = AppState(store: InMemoryCredentialStore())
        emptyState.health = state.health
        emptyState.isLoadingCredential = false
        guard
            let emptyPNG = renderSnapshotPNG(
                of: snapshotBackdrop(content: ContentView(state: emptyState, isStatic: true))),
            let fullDims = pngDims(png),
            let emptyDims = pngDims(emptyPNG)
        else {
            print("SKIP: ImageRenderer produced no image in this test environment")
            return
        }
        #expect(fullDims.h > emptyDims.h)
        #else
        print("SKIP: AppKit rendering is unavailable, snapshot PNG test skipped")
        #endif
    }
}
