import Foundation
import Testing
@testable import GeniusBarLib

private func soul(_ id: String, parent: String? = nil, presence: Presence = .joined) -> Soul {
    Soul(account: "user", agentId: id, name: id, harness: "codex",
         parent: parent, presence: presence, unacked: 0, lastWake: "2026-01-01T00:00:01Z")
}

@Suite("Soul forest")
struct SoulTreeTests {
    @Test("Subagents nest under their parent")
    func nestsChildren() {
        let forest = buildSoulForest([soul("agent_p"), soul("agent_c", parent: "agent_p")])
        #expect(forest.count == 1)
        #expect(forest[0].soul.agentId == "agent_p")
        #expect(forest[0].children.map(\.soul.agentId) == ["agent_c"])
    }

    @Test("Orphaned children (parent absent) become roots")
    func orphansAreRoots() {
        let forest = buildSoulForest([soul("agent_c", parent: "agent_gone")])
        #expect(forest.map(\.soul.agentId) == ["agent_c"])
    }

    @Test("Every census soul renders, including left presence")
    func leftSoulsRender() {
        let forest = buildSoulForest([soul("agent_p"), soul("agent_c", parent: "agent_p", presence: .left)])
        #expect(forest[0].children.count == 1)
    }

    @Test("Children sort by agent ID for a stable listing")
    func childrenSorted() {
        let forest = buildSoulForest([
            soul("agent_p"), soul("agent_z", parent: "agent_p"), soul("agent_a", parent: "agent_p"),
        ])
        #expect(forest[0].children.map(\.soul.agentId) == ["agent_a", "agent_z"])
    }
}

@Suite("Wire framing")
struct WireTests {
    @Test("Request encodes as one newline-terminated JSON line")
    func encodesLine() throws {
        struct Req: Codable { let v: Int; let op: String }
        let line = try encodeRequestLine(Req(v: 1, op: "census"))
        #expect(line.last == UInt8(ascii: "\n"))
        let body = try JSONDecoder().decode(Req.self, from: line.dropLast())
        #expect(body.op == "census")
    }

    @Test("Framer splits lines and skips blanks")
    func splitsLines() throws {
        var framer = LineFramer()
        let first = try framer.append(Data("{\"a\":1}\n\n{\"b\":2}\n".utf8))
        #expect(first.count == 2)
        let none = try framer.append(Data("{\"c\":".utf8))
        #expect(none.isEmpty)
        let rest = try framer.append(Data("3}\n".utf8))
        #expect(rest.count == 1)
    }

    @Test("Oversize buffered input throws and must be discarded")
    func limitEnforced() {
        var framer = LineFramer()
        #expect(throws: WireError.self) {
            try framer.append(Data(repeating: UInt8(ascii: "x"), count: maxLineBytes + 1))
        }
    }

    @Test("A line of exactly the maximum size is accepted")
    func exactlyMaxLineAccepted() throws {
        var framer = LineFramer()
        let body = Data(repeating: UInt8(ascii: "x"), count: maxLineBytes)
        let lines = try framer.append(body + Data([UInt8(ascii: "\n")]))
        #expect(lines.count == 1)
        #expect(lines[0].count == maxLineBytes)
    }

    @Test("Two valid lines arriving in one chunk both pass")
    func twoLinesInOneChunk() throws {
        var framer = LineFramer()
        // Each line body is near the limit, but the combined chunk is over it.
        let half = Data(repeating: UInt8(ascii: "y"), count: maxLineBytes - 1)
        let chunk = half + Data([UInt8(ascii: "\n")]) + half + Data([UInt8(ascii: "\n")])
        let lines = try framer.append(chunk)
        #expect(lines.count == 2)
        #expect(lines[0].count == maxLineBytes - 1)
        #expect(lines[1].count == maxLineBytes - 1)
    }

    @Test("An over-limit trailing fragment without a newline throws")
    func overLimitFragmentThrows() {
        var framer = LineFramer()
        #expect(throws: WireError.self) {
            try framer.append(Data(repeating: UInt8(ascii: "z"), count: maxLineBytes + 1))
        }
    }
}

@Suite("Broker client decoding")
struct BrokerClientTests {
    struct Stub: LineTransport {
        let reply: String
        let expectedPrincipal: String
        let expectedSecret: String
        func roundTrip(requestLine: Data) throws -> Data {
            // Every request is one versioned line authenticated with
            // {"principal","secret"}.
            #expect(requestLine.last == UInt8(ascii: "\n"))
            let body = requestLine.dropLast()
            let req = try JSONDecoder().decode(RequestShape.self, from: body)
            #expect(req.v == 1)
            #expect(["census", "health"].contains(req.op))
            #expect(req.auth.principal == expectedPrincipal)
            #expect(req.auth.secret == expectedSecret)
            return Data(reply.utf8)
        }
    }

    struct RequestShape: Decodable {
        let v: Int
        let op: String
        let auth: AuthBlock
    }

    static let credential = PrincipalCredential(
        principal: "principal_123e4567-e89b-12d3-a456-426614174000",
        secret: "s", brokerUid: 501, pairedAt: "2026-01-01T00:00:00Z", account: "user")

    private static func stub(_ reply: String) -> Stub {
        Stub(reply: reply, expectedPrincipal: credential.principal, expectedSecret: credential.secret)
    }

    @Test("Census decodes the contract sample")
    func censusContract() throws {
        let reply = """
        {"ok":true,"souls":[{"account":"user","agentId":"agent_1","name":"luna","harness":"codex","parent":null,"presence":"joined","unacked":0,"lastWake":"2026-01-01T00:00:01Z"},{"account":"user","agentId":"agent_2","name":null,"harness":null,"parent":"agent_1","presence":"watching","unacked":3,"lastWake":null}]}
        """
        let client = BrokerClient(transport: Self.stub(reply), credential: Self.credential)
        let souls = try client.census()
        #expect(souls.count == 2)
        #expect(souls[0].name == "luna")
        #expect(souls[0].lastWake == "2026-01-01T00:00:01Z")
        #expect(souls[1].name == nil)
        #expect(souls[1].harness == nil)
        #expect(souls[1].parent == "agent_1")
        #expect(souls[1].lastWake == nil)
        let forest = buildSoulForest(souls)
        #expect(forest.count == 1)
        #expect(forest[0].children.count == 1)
    }

    @Test("Health decodes the contract sample")
    func healthContract() throws {
        let reply = """
        {"ok":true,"uptimeMs":12000,"eventLogBytes":512,"pairings":{"accounts":1,"principals":2},"watches":3}
        """
        let client = BrokerClient(transport: Self.stub(reply), credential: Self.credential)
        let health = try client.health()
        #expect(health.ok)
        #expect(health.uptimeMs == 12000)
        #expect(health.eventLogBytes == 512)
        #expect(health.pairings.accounts == 1)
        #expect(health.pairings.principals == 2)
        #expect(health.watches == 3)
    }

    @Test("Broker error replies surface code and message")
    func brokerError() {
        let client = BrokerClient(
            transport: Self.stub(#"{"ok":false,"error":{"code":"no-such-soul","message":"gone"}}"#),
            credential: Self.credential)
        #expect(throws: BrokerError.broker(code: "no-such-soul", message: "gone")) {
            try client.census()
        }
    }

    @Test("Unauthenticated census points at principal pairing")
    func unauthenticatedMessage() {
        let client = BrokerClient(
            transport: Self.stub(#"{"ok":false,"error":{"code":"unauthenticated","message":"unknown principal"}}"#),
            credential: Self.credential)
        #expect(throws: BrokerError.broker(code: "unauthenticated", message: "unknown principal")) {
            try client.census()
        }
        #expect(BrokerError.broker(code: "unauthenticated", message: "unknown principal").userMessage
            == "Not paired or not approved. Run: agent-comms principal pair")
    }

    @Test("Not-approved health waits for owner approval")
    func notApprovedMessage() {
        let client = BrokerClient(
            transport: Self.stub(#"{"ok":false,"error":{"code":"not-approved","message":"the owner has not approved this principal yet"}}"#),
            credential: Self.credential)
        let error = BrokerError.broker(code: "not-approved", message: "the owner has not approved this principal yet")
        #expect(throws: error) {
            try client.health()
        }
        // The broker's message is prose, never a code, so it is not echoed as one.
        #expect(error.userMessage == pendingApprovalMessage)
        #expect(BrokerError.broker(code: "not-approved", message: "").userMessage == pendingApprovalMessage)
    }
}

@Suite("Roster keys and fallbacks")
struct RosterTests {
    private func mkSoul(
        account: String = "user", id: String, name: String? = nil,
        harness: String? = nil, parent: String? = nil, presence: Presence = .joined
    ) -> Soul {
        Soul(account: account, agentId: id, name: name, harness: harness,
             parent: parent, presence: presence)
    }

    @Test("Rows key by account and agent ID, never by display name")
    func keysByAccountAndAgent() {
        #expect(mkSoul(id: "agent_1", name: "luna").id == "user/agent_1")
        #expect(mkSoul(account: "other", id: "agent_1", name: "luna").id == "other/agent_1")
    }

    @Test("Duplicate display names stay as separate rows")
    func duplicateNamesStaySeparate() {
        let forest = buildSoulForest([
            mkSoul(id: "agent_1", name: "luna"),
            mkSoul(id: "agent_2", name: "luna"),
        ])
        #expect(forest.count == 2)
        #expect(Set(forest.map(\.id)).count == 2)
    }

    @Test("Same agent ID under different accounts never merges")
    func accountsStaySeparate() {
        let forest = buildSoulForest([
            mkSoul(account: "a", id: "agent_p"),
            mkSoul(account: "a", id: "agent_c", parent: "agent_p"),
            mkSoul(account: "b", id: "agent_p"),
        ])
        #expect(forest.count == 2)
        let aRoot = forest.first { $0.id == "a/agent_p" }
        let bRoot = forest.first { $0.id == "b/agent_p" }
        #expect(aRoot?.children.map(\.id) == ["a/agent_c"])
        #expect(bRoot?.children.isEmpty == true)
    }

    @Test("Missing name falls back to the short agent ID")
    func nameFallback() {
        #expect(mkSoul(id: "agent_abcdef1234").displayName == "agent_ab")
        #expect(mkSoul(id: "agent_abcdef1234", name: "").displayName == "agent_ab")
        #expect(mkSoul(id: "agent_abcdef1234", name: "luna").displayName == "luna")
    }

    @Test("Missing harness falls back to unknown harness")
    func harnessFallback() {
        #expect(mkSoul(id: "agent_1").displayHarness == "unknown harness")
        #expect(mkSoul(id: "agent_1", harness: "").displayHarness == "unknown harness")
        #expect(mkSoul(id: "agent_1", harness: "codex").displayHarness == "codex")
    }

    @Test("Left souls carry a text state and explanation")
    func leftNote() {
        #expect(mkSoul(id: "agent_1", presence: .left).availabilityNote != nil)
        #expect(mkSoul(id: "agent_1", presence: .joined).availabilityNote == nil)
        #expect(mkSoul(id: "agent_1", presence: .watching).availabilityNote == nil)
    }

    @Test("Repeat census entries collapse instead of duplicating rows")
    func duplicatesCollapse() {
        let dupe = mkSoul(id: "agent_1", name: "luna")
        let forest = buildSoulForest([dupe, dupe])
        #expect(forest.count == 1)
    }

    @Test("Reconciling after an outage replaces rows without duplication")
    func reconcileReplaces() {
        _ = buildSoulForest([mkSoul(id: "agent_a"), mkSoul(id: "agent_b")])
        let after = buildSoulForest([mkSoul(id: "agent_b"), mkSoul(id: "agent_c")])
        #expect(after.map(\.id).sorted() == ["user/agent_b", "user/agent_c"])
    }
}

@Suite("Blink")
struct BlinkTests {
    @Test("Eyes are open outside the blink window")
    func openOutsideWindow() {
        #expect(blinkEyeScale(at: 1.0) == 1)
        #expect(blinkEyeScale(at: 0.14) == 1)
        #expect(blinkEyeScale(at: 3.599) == 1)
    }

    @Test("Eyes close mid-blink")
    func closedMidBlink() {
        #expect(abs(blinkEyeScale(at: 0.07) - 0.08) < 1e-9)
    }

    @Test("Blink curve is continuous at the window edge")
    func continuousEdge() {
        #expect(abs(blinkEyeScale(at: 0.14 - 1e-6) - 1) < 0.001)
        #expect(abs(blinkEyeScale(at: 1e-9) - 1) < 0.001)
    }

    @Test("Degenerate parameters stay open")
    func degenerateStaysOpen() {
        #expect(blinkEyeScale(at: 0.07, period: 0) == 1)
        #expect(blinkEyeScale(at: 0.07, closedDuration: 0) == 1)
    }
}

@Suite("Credential store")
struct CredentialStoreTests {
    @Test("In-memory store round-trips without the keychain")
    func roundTrip() throws {
        let store = InMemoryCredentialStore()
        #expect(try store.load() == nil)
        let cred = PrincipalCredential(
            principal: "principal_123e4567-e89b-12d3-a456-426614174000",
            secret: "s3cr3t", brokerUid: 501, pairedAt: "2026-01-01T00:00:00Z", account: "user")
        try store.save(cred)
        #expect(try store.load()?.principal == "principal_123e4567-e89b-12d3-a456-426614174000")
        #expect(try store.load()?.secret == "s3cr3t")
        #expect(try store.load()?.brokerUid == 501)
        try store.delete()
        #expect(try store.load() == nil)
    }

    @Test("Credential decodes the keychain JSON written by the CLI")
    func decodesCliKeychainJSON() throws {
        // Exact shape stored by `agent-comms principal pair` under service
        // "qwts.GeniusBar.principal", account "principal".
        let line = """
        {"principal":"principal_123e4567-e89b-12d3-a456-426614174000","secret":"s3cr3t","brokerUid":501,"pairedAt":"2026-01-01T00:00:00Z","account":"user"}
        """
        let cred = try JSONDecoder().decode(PrincipalCredential.self, from: Data(line.utf8))
        #expect(cred.principal == "principal_123e4567-e89b-12d3-a456-426614174000")
        #expect(cred.secret == "s3cr3t")
        #expect(cred.brokerUid == 501)
        #expect(cred.pairedAt == "2026-01-01T00:00:00Z")
        #expect(cred.account == "user")
    }

    @Test("Requesting account name is optional for display")
    func accountOptional() throws {
        let line = """
        {"principal":"principal_123e4567-e89b-12d3-a456-426614174000","secret":"s3cr3t","brokerUid":501,"pairedAt":"2026-01-01T00:00:00Z"}
        """
        let cred = try JSONDecoder().decode(PrincipalCredential.self, from: Data(line.utf8))
        #expect(cred.account == nil)
        #expect(cred.principal.hasPrefix("principal_"))
    }
}

@Suite("Paths")
struct PathsTests {
    @Test("Environment overrides resolve socket and credential paths")
    func envOverrides() {
        let bp = brokerPaths(env: [
            "AGENT_COMMS_SHARED_DIR": "/tmp/t/shared",
            "AGENT_COMMS_BROKER_STATE_DIR": "/tmp/t/bstate",
        ])
        #expect(bp.socket == "/tmp/t/shared/broker.sock")
        #expect(bp.proofs == "/tmp/t/shared/pairing")
        #expect(bp.admin == "/tmp/t/bstate/admin.sock")
        let cp = clientPaths(env: ["AGENT_COMMS_CLIENT_STATE_DIR": "/tmp/t/cstate"])
        #expect(cp.credential == "/tmp/t/cstate/credential.json")
    }
}
