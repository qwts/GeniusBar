/// Blocking Unix-socket broker client. Calls are synchronous throws so the
/// library stays free of concurrency policy; the app runs them off the main
/// actor. Tests inject a LineTransport and never touch a socket.
import Darwin
import Foundation

/// One request line in, one reply line out.
public protocol LineTransport: Sendable {
    func roundTrip(requestLine: Data) throws -> Data
}

public enum BrokerError: Error, Sendable, Equatable {
    case unreachable(String)
    case badResponse(String)
    case broker(code: String, message: String)
    case timeout(String)

    /// User-facing text. The broker reports {"ok":false,"error":
    /// {"code","message"}}; unauthenticated / not-approved mean the
    /// principal is unpaired or still waiting for owner approval.
    public var userMessage: String {
        switch self {
        case .unreachable(let message), .badResponse(let message), .timeout(let message):
            return message
        case .broker(let code, let message):
            switch code {
            case "unauthenticated":
                return unpairedMessage
            case "not-approved":
                return pendingApprovalMessage
            default:
                if message.isEmpty { return code }
                return "\(message) (\(code))"
            }
        }
    }
}

/// Default monotonic deadline for one broker round trip, mirroring the
/// Node client's broker-timeout (10 s). It covers connect, send and
/// receive together so a broker that accepts but never replies cannot
/// stall polling forever.
public let brokerRoundTripTimeout: TimeInterval = 10

/// Real transport: custody checks, then newline-JSON over the Unix socket,
/// mirroring agent-comms lib/client.mjs.
public struct SocketTransport: LineTransport {
    public let paths: BrokerPaths
    public let brokerUid: uid_t
    public let timeoutSeconds: TimeInterval

    public init(paths: BrokerPaths, brokerUid: uid_t, timeoutSeconds: TimeInterval = brokerRoundTripTimeout) {
        self.paths = paths
        self.brokerUid = brokerUid
        self.timeoutSeconds = timeoutSeconds
    }

    public func roundTrip(requestLine: Data) throws -> Data {
        try checkBrokerCustody(paths: paths, brokerUid: brokerUid)
        return try unixRoundTrip(
            socketPath: paths.socket, requestLine: requestLine, timeoutSeconds: timeoutSeconds)
    }
}

private func monotonicNow() -> Double {
    var ts = timespec()
    clock_gettime(CLOCK_MONOTONIC, &ts)
    return Double(ts.tv_sec) + Double(ts.tv_nsec) / 1_000_000_000
}

private func pollWait(fd: Int32, events: Int16, deadline: Double, what: String) throws {
    while true {
        let remaining = deadline - monotonicNow()
        guard remaining > 0 else {
            throw BrokerError.timeout("\(what) timed out: the broker did not respond in time")
        }
        var pfd = pollfd(fd: fd, events: events, revents: 0)
        let timeoutMs = Int32(min(remaining * 1000, Double(INT_MAX)).rounded(.up))
        let result = poll(&pfd, 1, timeoutMs)
        if result < 0 {
            if errno == EINTR { continue }
            throw BrokerError.unreachable("poll failed: \(String(cString: strerror(errno)))")
        }
        if result == 0 {
            throw BrokerError.timeout("\(what) timed out: the broker did not respond in time")
        }
        return
    }
}

private func unixRoundTrip(socketPath: String, requestLine: Data, timeoutSeconds: TimeInterval) throws -> Data {
    let deadline = monotonicNow() + timeoutSeconds
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw BrokerError.unreachable("socket() failed: \(errno)") }
    defer { close(fd) }

    // A send() on a disconnected socket must surface as EPIPE, never SIGPIPE.
    var noSigPipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

    // Nonblocking throughout so the single monotonic deadline below bounds
    // connect, send and receive together.
    let flags = fcntl(fd, F_GETFL)
    if flags >= 0 {
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
    }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathCount = MemoryLayout.size(ofValue: addr.sun_path)
    guard socketPath.utf8.count + 1 <= pathCount else {
        throw BrokerError.unreachable("socket path too long")
    }
    socketPath.withCString { cstr in
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            if let base = buf.baseAddress {
                strncpy(base.assumingMemoryBound(to: CChar.self), cstr, buf.count - 1)
            }
        }
    }
    let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
    let connected = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, addrLen)
        }
    }
    if connected != 0 {
        let err = errno
        if err != EINPROGRESS {
            throw BrokerError.unreachable("cannot reach the broker: \(String(cString: strerror(err)))")
        }
        try pollWait(fd: fd, events: Int16(POLLOUT), deadline: deadline, what: "connect")
        var soError: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &soError, &len)
        guard soError == 0 else {
            throw BrokerError.unreachable("cannot reach the broker: \(String(cString: strerror(soError)))")
        }
    }

    var written = 0
    try requestLine.withUnsafeBytes { buf in
        guard let base = buf.baseAddress else { return }
        while written < requestLine.count {
            try pollWait(fd: fd, events: Int16(POLLOUT), deadline: deadline, what: "send")
            let n = send(fd, base.advanced(by: written), requestLine.count - written, 0)
            if n > 0 {
                written += n
            } else if n < 0 {
                let err = errno
                if err == EINTR { continue }
                if err == EAGAIN || err == EWOULDBLOCK { continue }
                if err == EPIPE {
                    throw BrokerError.unreachable("the broker closed the connection")
                }
                throw BrokerError.unreachable("send failed: \(String(cString: strerror(err)))")
            } else {
                throw BrokerError.unreachable("the broker closed the connection")
            }
            guard deadline - monotonicNow() > 0 else {
                throw BrokerError.timeout("send timed out: the broker did not respond in time")
            }
        }
    }

    var framer = LineFramer()
    var chunk = [UInt8](repeating: 0, count: 4096)
    while true {
        try pollWait(fd: fd, events: Int16(POLLIN), deadline: deadline, what: "receive")
        let n = recv(fd, &chunk, chunk.count, 0)
        if n > 0 {
            let lines = try framer.append(Data(chunk[..<n]))
            if let first = lines.first { return first }
        } else if n == 0 {
            throw BrokerError.unreachable("the broker closed the connection")
        } else {
            let err = errno
            if err == EINTR { continue }
            if err == EAGAIN || err == EWOULDBLOCK { continue }
            throw BrokerError.unreachable("read failed: \(String(cString: strerror(err)))")
        }
        guard deadline - monotonicNow() > 0 else {
            throw BrokerError.timeout("receive timed out: the broker did not respond in time")
        }
    }
}

private struct CensusCall: Encodable {
    let v: Int
    let op = "census"
    let auth: AuthBlock
}

private struct HealthCall: Encodable {
    let v: Int
    let op = "health"
    let auth: AuthBlock
}

private struct ErrorReply: Decodable {
    let ok: Bool
    let error: ErrorBody?
    struct ErrorBody: Decodable {
        let code: String?
        let message: String?
    }
}

/// Display-only broker client: census and health reads, no routing.
public struct BrokerClient: Sendable {
    private let transport: any LineTransport
    private let auth: AuthBlock

    /// Connect over the real socket with custody checks.
    public init(paths: BrokerPaths, credential: PrincipalCredential, timeoutSeconds: TimeInterval = brokerRoundTripTimeout) {
        self.transport = SocketTransport(paths: paths, brokerUid: credential.brokerUid, timeoutSeconds: timeoutSeconds)
        self.auth = AuthBlock(principal: credential.principal, secret: credential.secret)
    }

    /// Inject a fake transport (tests, previews).
    public init(transport: any LineTransport, credential: PrincipalCredential) {
        self.transport = transport
        self.auth = AuthBlock(principal: credential.principal, secret: credential.secret)
    }

    private func call<Req: Encodable, Res: Decodable>(_ request: Req) throws -> Res {
        let line = try encodeRequestLine(request)
        let reply: Data
        do {
            reply = try transport.roundTrip(requestLine: line)
        } catch let error as WireError {
            throw BrokerError.badResponse("\(error)")
        }
        if let err = try? decodeReplyLine(reply, as: ErrorReply.self), !err.ok {
            throw BrokerError.broker(
                code: err.error?.code ?? "internal",
                message: err.error?.message ?? "request failed"
            )
        }
        do {
            return try decodeReplyLine(reply, as: Res.self)
        } catch {
            throw BrokerError.badResponse("cannot decode reply: \(error)")
        }
    }

    /// Souls from the census operation.
    public func census() throws -> [Soul] {
        let res: CensusResponse = try call(CensusCall(v: protocolVersion, auth: auth))
        guard res.ok else { throw BrokerError.broker(code: "internal", message: "census failed") }
        return res.souls
    }

    /// Broker health for the menubar header.
    public func health() throws -> BrokerHealth {
        let res: BrokerHealth = try call(HealthCall(v: protocolVersion, auth: auth))
        guard res.ok else { throw BrokerError.broker(code: "internal", message: "health failed") }
        return res
    }
}
