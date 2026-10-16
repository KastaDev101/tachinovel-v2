//
//  NephisTempoTests.swift — a dialogue mood's tempo (NephisTempo.swift): 1 is bit-identical, the length follows the
//  tempo, the pitch stays, the level stays, and nothing clicks where frames join.
//

import ExpressiveCore
import Foundation
import XCTest

final class NephisTempoTests: XCTestCase {
    private let rate = 24_000

    private func tone(_ hz: Double, seconds: Double, amplitude: Double = 0.3) -> [Float] {
        (0..<Int(seconds * Double(rate))).map { Float(amplitude * sin(2 * Double.pi * hz * Double($0) / Double(rate))) }
    }

    /// Upward zero crossings a second over the middle of `x`: the pitch of a pure tone.
    private func pitch(_ x: [Float]) -> Double {
        let lo = x.count / 4, hi = 3 * x.count / 4
        var n = 0
        for i in (lo + 1)..<hi where x[i - 1] < 0 && x[i] >= 0 { n += 1 }
        return Double(n) / (Double(hi - lo) / Double(rate))
    }

    private func rms(_ x: ArraySlice<Float>) -> Double {
        (x.reduce(0) { $0 + Double($1) * Double($1) } / Double(max(1, x.count))).squareRoot()
    }

    func testOneLeavesTheSoundAsItIs() {
        let x = tone(220, seconds: 0.5)
        XCTAssertEqual(NephisTempo.stretch(x, tempo: 1, sampleRate: rate), x)
        XCTAssertEqual(NephisTempo.stretch(x, tempo: 1.003, sampleRate: rate), x, "under 0.005 from 1: untouched")
        XCTAssertFalse(NephisTempo.changes(nil))
        XCTAssertFalse(NephisTempo.changes(.nan))
        XCTAssertTrue(NephisTempo.changes(0.93))
        XCTAssertEqual(NephisTempo.clamped(2), 1.15)
        XCTAssertEqual(NephisTempo.clamped(0.2), 0.85)
    }

    func testTheLengthFollowsTheTempoAndThePitchStays() {
        let x = tone(220, seconds: 1)
        for t in [0.88, 0.93, 1.07, 1.12] {
            let y = NephisTempo.stretch(x, tempo: t, sampleRate: rate)
            XCTAssertEqual(y.count, Int((Double(x.count) / t).rounded()), "\(t)")
            XCTAssertEqual(pitch(y), 220, accuracy: 220 * 0.02, "pitch kept at \(t)")
            XCTAssertEqual(20 * log10(rms(y[(y.count / 4)..<(3 * y.count / 4)]) / rms(x[...])), 0, accuracy: 0.5, "level kept at \(t)")
        }
    }

    func testFramesJoinWithoutClicks() {
        // A voiced-like tone with a slow glide: the largest sample-to-sample step stays near the input's.
        let x = (0..<rate).map { i -> Float in
            let t = Double(i) / Double(rate)
            return Float(0.3 * sin(2 * Double.pi * (180 * t + 20 * t * t)))
        }
        let y = NephisTempo.stretch(x, tempo: 1.1, sampleRate: rate)
        func maxStep(_ v: [Float]) -> Float { zip(v.dropFirst(), v).map { abs($0 - $1) }.max() ?? 0 }
        XCTAssertLessThan(maxStep(y), maxStep(x) * 1.6)
    }
}
