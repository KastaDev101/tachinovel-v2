import HDVoiceCore
import XCTest

final class CompletenessGuardTests: XCTestCase {
    /// `voiced` seconds of a 200 Hz tone, then `silent` seconds of silence, at 24 kHz.
    private func render(voiced: Double, silent: Double = 0.5) -> [Float] {
        let v = (0..<Int(voiced * 24_000)).map { Float(sin(2 * Double.pi * 200 * Double($0) / 24_000)) * 0.3 }
        return v + [Float](repeating: 0, count: Int(silent * 24_000))
    }

    func testFlagsACutShortRenderAndNotAWholeOne() {
        var g = CompletenessGuard()
        // 17 syllables: complete ≈ 2.6 s voiced, cut short ≈ 1.3 s (the PC measurements).
        let whole = CompletenessGuard.perSyllable(render(voiced: 2.6), sampleRate: 24_000, syllables: 17)
        let cut = CompletenessGuard.perSyllable(render(voiced: 1.3), sampleRate: 24_000, syllables: 17)
        XCTAssertEqual(CompletenessGuard.voicedSeconds(render(voiced: 2.6), sampleRate: 24_000), 2.6, accuracy: 0.02)
        XCTAssertFalse(g.isShort(whole))
        XCTAssertTrue(g.isShort(cut))
        XCTAssertNil(CompletenessGuard.perSyllable(render(voiced: 0.3), sampleRate: 24_000, syllables: 3), "short lines aren't judged")
        // A slow, deliberate voice: the running median catches a drop above the absolute floor.
        for _ in 0..<5 { g.accept(0.22) }
        XCTAssertTrue(g.isShort(0.13))
        XCTAssertFalse(g.isShort(0.2))
    }
}
