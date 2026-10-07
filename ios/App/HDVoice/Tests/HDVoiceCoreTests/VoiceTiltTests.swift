import HDVoiceCore
import XCTest

final class VoiceTiltTests: XCTestCase {
    private func tone(_ hz: Double, fs: Int = 24_000) -> [Float] {
        (0..<fs).map { Float(sin(2 * Double.pi * hz * Double($0) / Double(fs))) * 0.1 }
    }

    private func gainDB(_ hz: Double) -> Double {
        var x = tone(hz)
        let before = x[12_000...].reduce(Float(0)) { $0 + $1 * $1 }
        VoiceTilt.pocketTts.apply(&x, sampleRate: 24_000)
        let after = x[12_000...].reduce(Float(0)) { $0 + $1 * $1 }
        return 10 * log10(Double(after / before))
    }

    func testPocketTiltLiftsPresenceAndTamesAir() {
        XCTAssertEqual(gainDB(3000), 3.5, accuracy: 0.6)
        XCTAssertEqual(gainDB(11_000), -4, accuracy: 0.8)
        XCTAssertEqual(gainDB(300), 0, accuracy: 0.4)
    }
}
