/// Path custody for the shared rendezvous directory, mirroring agent-comms
/// lib/custody.mjs (ADR-0006 decision 1): refuse a directory another account
/// could have created, replaced, or redirected. The shared directory must be
/// a real directory owned by the broker account and writable by nobody else;
/// every ancestor must be owned by root or the broker account and, if
/// others can write it, sticky. The socket must be the broker account's.
import Darwin
import Foundation

public enum CustodyError: Error, Sendable, Equatable {
    case untrusted(String)
    case unreachable(String)
}

private let stickyBit: mode_t = 0o1000

private struct FileFacts {
    let isDir: Bool
    let isSocket: Bool
    let isSymlink: Bool
    let uid: uid_t
    let mode: mode_t
}

private func facts(at path: String, code: CustodyError) throws -> FileFacts {
    var st = stat()
    guard lstat(path, &st) == 0 else {
        if case .untrusted = code { throw CustodyError.untrusted("\(path) does not exist") }
        throw CustodyError.unreachable("\(path) does not exist")
    }
    let type = st.st_mode & S_IFMT
    return FileFacts(
        isDir: type == S_IFDIR,
        isSocket: type == S_IFSOCK,
        isSymlink: type == S_IFLNK,
        uid: st.st_uid,
        mode: st.st_mode
    )
}

/// Check every ancestor of `dir` (starting at its real parent, up to /).
public func assertAncestors(of dir: String, ownerUid: uid_t) throws {
    var current = URL(fileURLWithPath: dir).resolvingSymlinksInPath()
        .deletingLastPathComponent().path
    while true {
        let info = try facts(at: current, code: .untrusted(""))
        guard info.isDir else {
            throw CustodyError.untrusted("\(current) is not a directory")
        }
        guard info.uid == 0 || info.uid == ownerUid else {
            throw CustodyError.untrusted(
                "\(current) is owned by uid \(info.uid), neither root nor the broker account")
        }
        if (info.mode & 0o022) != 0 && (info.mode & stickyBit) == 0 {
            throw CustodyError.untrusted("\(current) is writable by others and not sticky")
        }
        let parent = URL(fileURLWithPath: current).deletingLastPathComponent().path
        if parent == current { return }
        current = parent
    }
}

private func assertOwnedDir(_ dir: String, ownerUid: uid_t) throws -> FileFacts {
    let info = try facts(at: dir, code: .untrusted(""))
    guard info.isDir && !info.isSymlink else {
        throw CustodyError.untrusted("\(dir) is not a real directory")
    }
    guard info.uid == ownerUid else {
        throw CustodyError.untrusted(
            "\(dir) is owned by uid \(info.uid), not the broker account \(ownerUid)")
    }
    return info
}

private func assertBrokerSocket(_ file: String, ownerUid: uid_t) throws {
    let info = try facts(at: file, code: .unreachable(""))
    guard info.isSocket && info.uid == ownerUid else {
        throw CustodyError.untrusted("\(file) is not the broker account's socket")
    }
}

/// Refuse to talk to a broker whose rendezvous fails custody.
public func checkBrokerCustody(paths: BrokerPaths, brokerUid: uid_t) throws {
    try assertAncestors(of: paths.shared, ownerUid: brokerUid)
    let dir = try assertOwnedDir(paths.shared, ownerUid: brokerUid)
    guard (dir.mode & 0o022) == 0 else {
        throw CustodyError.untrusted("\(paths.shared) is writable by accounts other than the broker's")
    }
    try assertBrokerSocket(paths.socket, ownerUid: brokerUid)
}
