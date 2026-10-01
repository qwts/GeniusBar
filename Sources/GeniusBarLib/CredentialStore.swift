/// Principal credential storage. The credential lives in the login
/// keychain with access limited to this app; a small protocol keeps tests
/// and previews from ever touching the keychain.
import Foundation

/// Load/save the principal credential, or nil when unpaired.
public protocol CredentialStore: Sendable {
    func load() throws -> PrincipalCredential?
    func save(_ credential: PrincipalCredential) throws
    func delete() throws
}

public enum CredentialStoreError: Error, Sendable, Equatable {
    case unreadable(String)
    case unwritable(String)
}

#if canImport(Security)
import Security

/// Keychain store: generic-password item in the login keychain, readable
/// only on this device while unlocked, never synced.
public struct KeychainCredentialStore: CredentialStore {
    private let service = "qwts.GeniusBar.principal"
    private let account = "principal"

    public init() {}

    private func query() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func load() throws -> PrincipalCredential? {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw CredentialStoreError.unreadable("keychain read failed (\(status))")
        }
        do {
            return try JSONDecoder().decode(PrincipalCredential.self, from: data)
        } catch {
            throw CredentialStoreError.unreadable("saved credential is unreadable; pair again")
        }
    }

    public func save(_ credential: PrincipalCredential) throws {
        let data = try JSONEncoder().encode(credential)
        var q = query()
        q[kSecValueData as String] = data
        // Limited to this app's device and lock state: no sync, no backup
        // restore onto another device, no access while locked.
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        q[kSecAttrSynchronizable as String] = false
        var status = SecItemAdd(q as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update: [String: Any] = [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            ]
            status = SecItemUpdate(query() as CFDictionary, update as CFDictionary)
        }
        guard status == errSecSuccess else {
            throw CredentialStoreError.unwritable("keychain write failed (\(status))")
        }
    }

    public func delete() throws {
        let status = SecItemDelete(query() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.unwritable("keychain delete failed (\(status))")
        }
    }
}
#endif

/// In-memory store for tests and SwiftUI previews. Never touches the keychain.
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: PrincipalCredential?

    public init(_ initial: PrincipalCredential? = nil) {
        self.stored = initial
    }

    public func load() throws -> PrincipalCredential? {
        lock.withLock { stored }
    }

    public func save(_ credential: PrincipalCredential) throws {
        lock.withLock { stored = credential }
    }

    public func delete() throws {
        lock.withLock { stored = nil }
    }
}
