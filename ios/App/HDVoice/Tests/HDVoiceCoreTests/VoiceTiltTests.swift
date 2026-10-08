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

final class NephisSoundTests: XCTestCase {
    private func gainDB(_ hz: Double, _ tilt: VoiceTilt) -> Double {
        var x = (0..<24_000).map { Float(sin(2 * Double.pi * hz * Double($0) / 24_000)) * 0.1 }
        let before = x[12_000...].reduce(Float(0)) { $0 + $1 * $1 }
        tilt.apply(&x, sampleRate: 24_000)
        let after = x[12_000...].reduce(Float(0)) { $0 + $1 * $1 }
        return 10 * log10(Double(after / before))
    }

    func testNephisIsClearerAndKeepsHerDepth() {
        XCTAssertEqual(gainDB(8000, .nephis), 5.95, accuracy: 0.8)  // the clarity back
        XCTAssertEqual(gainDB(60, .nephis), 2, accuracy: 0.6)       // the depth kept
        XCTAssertEqual(gainDB(700, .nephis), 0, accuracy: 1.2)      // the middle of her voice left alone
    }

    func testThumpGoesVoiceStays() {
        func level(_ hz: Double) -> Double {
            var x = (0..<24_000).map { Float(sin(2 * Double.pi * hz * Double($0) / 24_000)) * 0.1 }
            StartupSound.removeThump(&x, sampleRate: 24_000)
            return 10 * log10(Double(x[12_000...].reduce(Float(0)) { $0 + $1 * $1 } / (0.005 * 12_000)))
        }
        XCTAssertLessThan(level(30), -20)
        XCTAssertEqual(level(150), 0, accuracy: 1)
    }

    func testStartupSoundIsTurnedDownButTheWordIsNot() {
        let sr = 24_000
        // 0.2 s of start-up sound at about -34 dBFS, a 60 ms dip, then the word at about -14 dBFS.
        var x = [Float](repeating: 0, count: sr)
        for i in 0..<Int(0.2 * Double(sr)) { x[i] = Float(sin(Double(i) * 0.9)) * 0.028 }
        for i in Int(0.2 * Double(sr))..<Int(0.26 * Double(sr)) { x[i] = Float(sin(Double(i) * 0.9)) * 0.001 }
        let word = Int(0.26 * Double(sr))
        for i in word..<sr { x[i] = Float(sin(Double(i) * 0.05)) * 0.28 }
        let wordBefore = Array(x[word...])
        let softened = StartupSound.soften(&x, sampleRate: sr)
        XCTAssertGreaterThan(softened, 0.15)
        XCTAssertLessThanOrEqual(softened, StartupSound.maxSeconds)
        XCTAssertLessThan(x[Int(0.03 * Double(sr))..<Int(0.15 * Double(sr))].map { abs($0) }.max() ?? 1, 0.028 * 0.1)
        XCTAssertEqual(Array(x[word...]), wordBefore)
    }

    func testAWordThatStartsAtOnceIsUntouched() {
        var x = (0..<24_000).map { Float(sin(Double($0) * 0.05)) * 0.28 }
        let before = x
        XCTAssertEqual(StartupSound.soften(&x, sampleRate: 24_000), 0)
        XCTAssertEqual(x, before)
    }
}
