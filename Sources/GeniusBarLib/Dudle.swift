/// Dudle derivation: a round, spongy character's look derived
/// deterministically from the soul ID. The hash is FNV-1a over UTF-8 --
/// stable across processes and restarts -- never Swift's randomized Hasher.
/// Same soul ID always yields the same Dudle; distinct IDs spread across
/// the look space.
import Foundation

/// FNV-1a 64-bit. Fixed offsets, no per-process seed.
public func stableHash64(_ string: String) -> UInt64 {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in string.utf8 {
        hash ^= UInt64(byte)
        hash &*= 0x0100_0000_01b3
    }
    return hash
}

/// Extra independent bits via salted rehash of the same stable function.
private func stableHash64(_ string: String, salt: String) -> UInt64 {
    stableHash64("\(salt)::\(string)")
}

/// Unit-interval value from 16 bits of hash starting at bit offset.
private func unit(_ hash: UInt64, offset: Int) -> Double {
    Double((hash >> offset) & 0xFFFF) / Double(0xFFFF)
}

/// Every visual trait of a Dudle. All values are unit-interval or derived
/// ranges documented per field; the renderer must treat them as opaque.
public struct DudleSpec: Sendable, Hashable {
    /// Body hue, 0..<1 around the color wheel.
    public let bodyHue: Double
    /// Body radius multiplier, 0.92...1.08 (size wobble).
    public let sizeWobble: Double
    /// Eye separation as a fraction of body radius, 0.45...0.75.
    public let eyeSpacing: Double
    /// Eye radius multiplier, 0.85...1.15.
    public let eyeScale: Double
    /// Cheek blush strength, 0...1.
    public let blush: Double
    /// Resting squish (width over height), 0.94...1.06.
    public let squish: Double
    /// Specular highlight angle in radians, 0..<2pi.
    public let highlightAngle: Double

    public init(
        bodyHue: Double,
        sizeWobble: Double,
        eyeSpacing: Double,
        eyeScale: Double,
        blush: Double,
        squish: Double,
        highlightAngle: Double
    ) {
        self.bodyHue = bodyHue
        self.sizeWobble = sizeWobble
        self.eyeSpacing = eyeSpacing
        self.eyeScale = eyeScale
        self.blush = blush
        self.squish = squish
        self.highlightAngle = highlightAngle
    }
}

/// Eyelid scale for the idle blink: 1 while open, dipping smoothly to
/// 0.08 mid-blink and back, so the curve is continuous at both edges of
/// the closed window. Pure and deterministic.
public func blinkEyeScale(at t: TimeInterval, period: TimeInterval = 3.6, closedDuration: TimeInterval = 0.14) -> Double {
    guard period > 0, closedDuration > 0 else { return 1 }
    let phase = t.truncatingRemainder(dividingBy: period)
    guard phase >= 0, phase < closedDuration else { return 1 }
    let u = sin(.pi * phase / closedDuration)
    return 1 - 0.92 * u * u
}

/// Derive a Dudle's look from a soul ID. Pure and deterministic.
public func deriveDudle(soulID: String) -> DudleSpec {
    let h1 = stableHash64(soulID)
    let h2 = stableHash64(soulID, salt: "dudle-v1")
    return DudleSpec(
        bodyHue: unit(h1, offset: 0),
        sizeWobble: 0.92 + 0.16 * unit(h1, offset: 16),
        eyeSpacing: 0.45 + 0.30 * unit(h1, offset: 32),
        eyeScale: 0.85 + 0.30 * unit(h1, offset: 48),
        blush: unit(h2, offset: 0),
        squish: 0.94 + 0.12 * unit(h2, offset: 16),
        highlightAngle: 2 * .pi * unit(h2, offset: 32)
    )
}
