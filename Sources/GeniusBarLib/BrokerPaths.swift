/// Socket and state path resolution, mirroring agent-comms lib/paths.mjs.
/// Environment overrides exist for tests and isolated brokers; production
/// uses the shared space and the broker state directory.
import Foundation

/// Rendezvous paths for the broker socket and pairing proofs.
public struct BrokerPaths: Sendable {
    public let shared: String
    public let socket: String
    public let proofs: String
    public let state: String
    public let admin: String

    public init(shared: String, socket: String, proofs: String, state: String, admin: String) {
        self.shared = shared
        self.socket = socket
        self.proofs = proofs
        self.state = state
        self.admin = admin
    }
}

/// Each account's own client state paths (credential file).
public struct ClientPaths: Sendable {
    public let dir: String
    public let credential: String
}

private func stateHome(env: [String: String]) -> String {
    if let override = env["XDG_STATE_HOME"], !override.isEmpty { return override }
    return (NSHomeDirectory() as NSString).appendingPathComponent(".local/state")
}

public func brokerPaths(env: [String: String] = ProcessInfo.processInfo.environment) -> BrokerPaths {
    let shared = env["AGENT_COMMS_SHARED_DIR"] ?? "/Users/Shared/Public/agent-comms"
    let state = env["AGENT_COMMS_BROKER_STATE_DIR"] ?? (stateHome(env: env) as NSString).appendingPathComponent("agent-comms-broker")
    return BrokerPaths(
        shared: shared,
        socket: (shared as NSString).appendingPathComponent("broker.sock"),
        proofs: (shared as NSString).appendingPathComponent("pairing"),
        state: state,
        admin: (state as NSString).appendingPathComponent("admin.sock")
    )
}

public func clientPaths(env: [String: String] = ProcessInfo.processInfo.environment) -> ClientPaths {
    let dir = env["AGENT_COMMS_CLIENT_STATE_DIR"]
        ?? (stateHome(env: env) as NSString).appendingPathComponent("agent-comms")
    return ClientPaths(
        dir: dir,
        credential: (dir as NSString).appendingPathComponent("credential.json")
    )
}
