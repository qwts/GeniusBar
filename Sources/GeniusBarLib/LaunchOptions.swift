/// Launch flags for UI testability. The menubar app is invisible to
/// computer-use agents and CI (status items need Screen Recording
/// permission to capture), so two flags expose the same menu content:
/// `--snapshot` renders it offscreen to a PNG and `--window` shows it in
/// a regular titled window. Parsing is a pure function of the argument
/// list so unit tests cover it without launching the app.
import Foundation

/// Parsed launch flags. All nil/false means a normal menubar launch.
public struct LaunchOptions: Sendable, Equatable {
    /// PNG path from `--snapshot <path.png>`, if snapshotting.
    public var snapshotPath: String?
    /// Agent ID from `--snapshot-detail <agentId>`, if snapshotting one
    /// soul's detail panel alongside the menu content.
    public var snapshotDetailAgentId: String?
    /// True when `--window` was given: show the menu content in a regular
    /// titled window for desktop automation.
    public var showWindow: Bool

    public init(snapshotPath: String? = nil, snapshotDetailAgentId: String? = nil, showWindow: Bool = false) {
        self.snapshotPath = snapshotPath
        self.snapshotDetailAgentId = snapshotDetailAgentId
        self.showWindow = showWindow
    }
}

/// Parse launch flags out of an argument list (pass
/// `CommandLine.arguments`; the executable name never matches a flag, so
/// it needs no stripping). Unknown arguments are ignored. A flag missing
/// its value is ignored, leaving the corresponding option unset.
public func parseLaunchOptions(_ arguments: [String]) -> LaunchOptions {
    var options = LaunchOptions()
    var index = arguments.startIndex
    while index < arguments.endIndex {
        let arg = arguments[index]
        let next = arguments.index(after: index)
        let hasNext = next < arguments.endIndex
        if arg == "--snapshot", hasNext, !arguments[next].hasPrefix("--") {
            options.snapshotPath = arguments[next]
            index = arguments.index(after: next)
        } else if arg.hasPrefix("--snapshot=") {
            let value = String(arg.dropFirst("--snapshot=".count))
            if !value.isEmpty { options.snapshotPath = value }
            index = next
        } else if arg == "--snapshot-detail", hasNext, !arguments[next].hasPrefix("--") {
            options.snapshotDetailAgentId = arguments[next]
            index = arguments.index(after: next)
        } else if arg.hasPrefix("--snapshot-detail=") {
            let value = String(arg.dropFirst("--snapshot-detail=".count))
            if !value.isEmpty { options.snapshotDetailAgentId = value }
            index = next
        } else if arg == "--window" {
            options.showWindow = true
            index = next
        } else {
            index = next
        }
    }
    return options
}
