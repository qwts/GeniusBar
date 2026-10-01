import Testing
@testable import GeniusBarLib

@Suite("Dudle derivation")
struct DudleTests {
    @Test("Same soul ID derives the same Dudle across calls")
    func deterministic() {
        #expect(deriveDudle(soulID: "agent_abc123") == deriveDudle(soulID: "agent_abc123"))
    }

    @Test("Stable hash has fixed known values (no randomized Hasher)")
    func stableHashKnownValues() {
        #expect(stableHash64("") == 0xcbf2_9ce4_8422_2325)
        #expect(stableHash64("agent_abc123") == stableHash64("agent_abc123"))
        #expect(stableHash64("agent_abc123") != stableHash64("agent_abc124"))
    }

    @Test("Distinct IDs spread across the hue wheel")
    func distinctIDsDiffer() {
        let hues = (0..<50).map { deriveDudle(soulID: "agent_\($0)").bodyHue }
        #expect(Set(hues).count > 40)
    }

    @Test("All traits stay inside their documented ranges")
    func rangesHold() {
        for i in 0..<200 {
            let d = deriveDudle(soulID: "agent_probe_\(i)")
            #expect((0..<1).contains(d.bodyHue))
            #expect((0.92...1.08).contains(d.sizeWobble))
            #expect((0.45...0.75).contains(d.eyeSpacing))
            #expect((0.85...1.15).contains(d.eyeScale))
            #expect((0...1).contains(d.blush))
            #expect((0.94...1.06).contains(d.squish))
            #expect((0..<2 * .pi).contains(d.highlightAngle))
        }
    }

    @Test("IDs that differ only in the tail still differ")
    func tailSensitivity() {
        let a = deriveDudle(soulID: "agent_worker_long_prefix_001")
        let b = deriveDudle(soulID: "agent_worker_long_prefix_002")
        #expect(a != b)
    }
}
