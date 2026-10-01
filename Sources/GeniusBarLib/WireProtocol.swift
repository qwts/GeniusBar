/// Newline-delimited JSON framing, mirroring agent-comms lib/wire.mjs:
/// one request line out, one reply line back. The 128 KiB limit applies to
/// each line body (excluding the newline delimiter) and to the trailing
/// incomplete fragment, so no peer can make us hold or parse an unbounded
/// line while any number of complete bounded lines still pass through.
import Foundation

/// Protocol version sent with every request, mirroring PROTOCOL_VERSION.
public let protocolVersion = 1

/// Maximum bytes per line, mirroring MAX_LINE_BYTES.
public let maxLineBytes = 128 * 1024

public enum WireError: Error, Sendable {
    case lineTooLong
    case notJSON(String)
    case encodeFailed(String)
}

/// Encode one request value as a single newline-terminated JSON line.
public func encodeRequestLine<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    let body: Data
    do {
        body = try encoder.encode(value)
    } catch {
        throw WireError.encodeFailed(error.localizedDescription)
    }
    guard body.count <= maxLineBytes else { throw WireError.lineTooLong }
    return body + Data([UInt8(ascii: "\n")])
}

/// Incremental splitter: feed received bytes, get back complete lines
/// (without the trailing newline). Throws on the first limit violation,
/// after which the accumulator must be discarded with the connection.
public struct LineFramer: Sendable {
    private var buffer = Data()

    public init() {}

    public mutating func append(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            if line.isEmpty { continue }
            guard line.count <= maxLineBytes else {
                buffer.removeAll()
                throw WireError.lineTooLong
            }
            lines.append(Data(line))
        }
        guard buffer.count <= maxLineBytes else {
            buffer.removeAll()
            throw WireError.lineTooLong
        }
        return lines
    }
}

/// Decode one reply line into the expected shape.
public func decodeReplyLine<T: Decodable>(_ line: Data, as type: T.Type = T.self) throws -> T {
    do {
        return try JSONDecoder().decode(T.self, from: line)
    } catch {
        throw WireError.notJSON(error.localizedDescription)
    }
}
