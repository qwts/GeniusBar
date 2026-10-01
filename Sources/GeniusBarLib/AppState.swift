import SwiftUI

/// Polling state for the menubar listing. All broker I/O runs off the main
/// actor; published snapshots drive the views.
@MainActor
public final class AppState: ObservableObject {
    @Published public var forest: [SoulNode] = []
    @Published public var health: BrokerHealth?
    @Published public var lastError: String?
    @Published public var lastRefresh: Date?
    /// Set while the broker is unreachable. The last successful census
    /// stays on screen as "Last known" until the next success reconciles it.
    @Published public var brokerUnreachable = false
    @Published public var isLoadingCredential = true
    @Published public var isUnpaired = false

    private var credential: PrincipalCredential?
    private let paths: BrokerPaths
    private let store: any CredentialStore
    private var running = false

    public init(paths: BrokerPaths = brokerPaths(), store: any CredentialStore) {
        self.paths = paths
        self.store = store
        Task { await loadCredential() }
    }

    /// Keychain reads stay off the main actor; results publish back on it.
    private func loadCredential() async {
        let store = self.store
        let result = await Task.detached(priority: .utility) { () -> Result<PrincipalCredential?, Error> in
            do {
                return .success(try store.load())
            } catch {
                return .failure(error)
            }
        }.value
        self.isLoadingCredential = false
        switch result {
        case .success(let loaded):
            self.credential = loaded
            if loaded == nil {
                self.isUnpaired = true
                // Pairing is done by the agent-comms CLI, which stores the
                // principal credential in the login keychain for us to read.
                self.lastError = unpairedMessage
            }
        case .failure(let error):
            self.lastError = String(describing: error)
        }
    }

    public func start() {
        guard !running else { return }
        running = true
        Task { await pollLoop() }
    }

    public func refreshNow() {
        Task { await refresh() }
    }

    /// One census+health fetch through the exact path the poll loop uses.
    /// `--snapshot` drives this once instead of starting the loop, so the
    /// same BrokerClient custody and auth checks are exercised.
    public func refreshOnce() async {
        await refresh()
    }

    private func pollLoop() async {
        while running {
            await refresh()
            try? await Task.sleep(for: .seconds(5))
        }
    }

    private func refresh() async {
        guard let credential else { return }
        let paths = self.paths
        let result = await Task.detached(priority: .utility) { () -> (Result<([Soul], BrokerHealth), Error>) in
            do {
                let client = BrokerClient(paths: paths, credential: credential)
                let souls = try client.census()
                let health = try client.health()
                return .success((souls, health))
            } catch {
                return .failure(error)
            }
        }.value
        switch result {
        case .success(let (souls, health)):
            // Rebuilt wholesale: reconciling after an outage replaces rows
            // instead of duplicating them.
            self.forest = buildSoulForest(souls)
            self.health = health
            self.lastError = nil
            self.lastRefresh = Date()
            self.brokerUnreachable = false
        case .failure(let error):
            // Keep the last successful census on screen; only flag the outage.
            self.brokerUnreachable = true
            if let brokerError = error as? BrokerError {
                self.lastError = brokerError.userMessage
            } else {
                self.lastError = String(describing: error)
            }
        }
    }
}
