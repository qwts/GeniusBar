/// Broker census/health model. Field names match the agent-comms census wire
/// contract exactly: {"v":1,"op":"census","auth":{"principal","secret"}} ->
/// {"ok":true,"souls":[{"account","agentId","name","harness","parent",
/// "presence":"watching"|"joined"|"left","unacked":Int,
/// "lastWake":String|null}]}. name/harness/parent may be null.
/// Display only: this model carries no routing or authority.
import Foundation

/// Presence values reported by the broker census.
public enum Presence: String, Codable, Sendable, Hashable {
    case watching
    case joined
    case left
}

/// One soul listed by the census operation.
public struct Soul: Codable, Sendable, Hashable, Identifiable {
    public let account: String
    public let agentId: String
    public let name: String?
    public let harness: String?
    /// Agent ID of the parent soul, for subagents told to join. Nil for roots.
    public let parent: String?
    public let presence: Presence
    public let unacked: Int
    /// Opaque last-wake marker from the broker (a string) or null.
    public let lastWake: String?

    /// Roster key: account plus agent ID. Rows key by this, never by
    /// display name, so duplicate names cannot merge and identical agent
    /// IDs under different accounts stay distinct.
    public var id: String { account + "/" + agentId }

    public init(
        account: String,
        agentId: String,
        name: String? = nil,
        harness: String? = nil,
        parent: String? = nil,
        presence: Presence,
        unacked: Int = 0,
        lastWake: String? = nil
    ) {
        self.account = account
        self.agentId = agentId
        self.name = name
        self.harness = harness
        self.parent = parent
        self.presence = presence
        self.unacked = unacked
        self.lastWake = lastWake
    }

    /// First 8 characters of the agent ID, used when no name is set.
    public var shortAgentId: String { String(agentId.prefix(8)) }

    /// Short human label: display name when set, otherwise the short agent
    /// ID so unnamed souls still read clearly.
    public var displayName: String {
        if let name, !name.isEmpty { return name }
        return shortAgentId.isEmpty ? "unknown soul" : shortAgentId
    }

    /// Harness label with an explicit fallback instead of a bare dash.
    public var displayHarness: String {
        if let harness, !harness.isEmpty { return harness }
        return "unknown harness"
    }

    /// Text state for unavailable souls. Nil while the soul is available;
    /// 'left' souls stay listed with this explanation instead of being
    /// dropped from the roster.
    public var availabilityNote: String? {
        presence == .left ? "Left — no longer available. Kept in the roster for reference." : nil
    }
}

/// Decoded body of a successful census reply.
public struct CensusResponse: Codable, Sendable {
    public let ok: Bool
    public let souls: [Soul]
}

/// Broker health as returned by
/// {"v":1,"op":"health","auth":{"principal","secret"}} ->
/// {"ok":true,"uptimeMs":Int,"eventLogBytes":Int,
/// "pairings":{"accounts":Int,"principals":Int},"watches":Int}.
public struct BrokerHealth: Codable, Sendable {
    public let ok: Bool
    public let uptimeMs: Int
    public let eventLogBytes: Int
    public let pairings: PairingCounts
    public let watches: Int

    public struct PairingCounts: Codable, Sendable {
        public let accounts: Int
        public let principals: Int
    }
}

/// A soul with its subagents nested underneath. Roots are souls with no
/// parent, or whose parent ID is absent from the census. The roster is the
/// whole census: every soul renders, including 'left' ones (shown with
/// their availability note), and duplicate display names never merge
/// because nodes key by account/agent ID.
public struct SoulNode: Sendable, Hashable, Identifiable {
    public let soul: Soul
    public let children: [SoulNode]

    public var id: String { soul.id }

    public init(soul: Soul, children: [SoulNode] = []) {
        self.soul = soul
        self.children = children
    }
}

/// Nest subagent souls under their parent soul, preserving census order.
/// Children sort by agent ID for a stable listing. The forest is rebuilt
/// wholesale from each successful census, so reconciling after an outage
/// replaces rows instead of duplicating them. Repeat entries for the same
/// account/agent ID collapse to their first occurrence, and nesting is
/// scoped per account so identical agent IDs under different accounts
/// never merge.
public func buildSoulForest(_ souls: [Soul]) -> [SoulNode] {
    var seen = Set<String>()
    let unique = souls.filter { seen.insert($0.id).inserted }
    var byAccount: [String: [Soul]] = [:]
    var accountOrder: [String] = []
    for soul in unique {
        if byAccount[soul.account] == nil {
            accountOrder.append(soul.account)
            byAccount[soul.account] = []
        }
        byAccount[soul.account]!.append(soul)
    }
    var forest: [SoulNode] = []
    for account in accountOrder {
        let group = byAccount[account]!
        let byParent = Dictionary(grouping: group, by: { $0.parent ?? "" })
        let knownIDs = Set(group.map(\.agentId))
        // Parents are claims, so a census can hold a parent cycle or a soul
        // naming itself. Each soul is placed exactly once; a cycle no root
        // reaches is entered at its first soul in census order.
        var placed = Set<String>()
        func node(for soul: Soul) -> SoulNode {
            placed.insert(soul.agentId)
            let kids = (byParent[soul.agentId] ?? [])
                .filter { !placed.contains($0.agentId) }
                .sorted { $0.agentId < $1.agentId }
                .map(node(for:))
            return SoulNode(soul: soul, children: kids)
        }
        for soul in group where soul.parent == nil || !knownIDs.contains(soul.parent!) {
            forest.append(node(for: soul))
        }
        for soul in group where !placed.contains(soul.agentId) {
            forest.append(node(for: soul))
        }
    }
    return forest
}
