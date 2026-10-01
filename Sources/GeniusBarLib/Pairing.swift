/// Principal credential and request auth, matching the agent-comms broker
/// contract. Pairing itself is done by the `agent-comms principal pair`
/// CLI command (GeniusBar never sends pair requests): the CLI stores the
/// credential in the login keychain under service
/// "qwts.GeniusBar.principal", account "principal", as JSON
/// {"principal","secret","brokerUid","pairedAt","account"}. Census and
/// health authenticate with "auth": {"principal","secret"}.
import Foundation

/// Saved principal credential: the paired principal ID
/// ("principal_<uuid>"), the secret the broker paired, and the broker
/// account UID pinned at pairing time (whoever can replace this can point
/// us at their own socket). `account` is the requesting account name for
/// display only, and may be absent in credentials written before it was
/// kept.
public struct PrincipalCredential: Codable, Sendable {
    public let principal: String
    public let secret: String
    public let brokerUid: uid_t
    public let pairedAt: String
    public let account: String?

    public init(principal: String, secret: String, brokerUid: uid_t, pairedAt: String, account: String? = nil) {
        self.principal = principal
        self.secret = secret
        self.brokerUid = brokerUid
        self.pairedAt = pairedAt
        self.account = account
    }

    enum CodingKeys: String, CodingKey {
        case principal, secret, brokerUid, pairedAt, account
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        principal = try c.decode(String.self, forKey: .principal)
        secret = try c.decode(String.self, forKey: .secret)
        let rawUid = try c.decode(Int.self, forKey: .brokerUid)
        guard let uid = uid_t(exactly: rawUid) else {
            throw DecodingError.dataCorruptedError(
                forKey: .brokerUid, in: c,
                debugDescription: "brokerUid \(rawUid) is out of range for uid_t")
        }
        brokerUid = uid
        pairedAt = try c.decode(String.self, forKey: .pairedAt)
        account = try c.decodeIfPresent(String.self, forKey: .account)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(principal, forKey: .principal)
        try c.encode(secret, forKey: .secret)
        try c.encode(Int(brokerUid), forKey: .brokerUid)
        try c.encode(pairedAt, forKey: .pairedAt)
        try c.encodeIfPresent(account, forKey: .account)
    }
}

/// The auth block attached to every broker request:
/// {"principal","secret"}.
public struct AuthBlock: Codable, Sendable {
    public let principal: String
    public let secret: String
}

/// Shown when census/health fail with unauthenticated, or when no
/// credential is stored at all.
public let unpairedMessage = "Not paired or not approved. Run: agent-comms principal pair"

/// Shown when census/health fail with not-approved. The broker's error
/// carries no approval code, so the owner looks it up.
public let pendingApprovalMessage =
    "Waiting for owner approval. The owner runs: agent-comms admin principals, then agent-comms admin principal-approve CODE"
