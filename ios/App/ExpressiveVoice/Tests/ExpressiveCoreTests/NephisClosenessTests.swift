import ExpressiveCore
import Foundation
import XCTest

/// Pack chain "closeness" (NephisCloseness.swift): the tuner's compressor (Chromium's DynamicsCompressor, ported):
/// decoding, the tuner's parameters at the phone's level, bypass, latency, the static curve, and calls in pieces.
final class NephisClosenessTests: XCTestCase {
    private func chain(_ json: String) throws -> NephisFlow.Chain {
        try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(json.utf8))
    }

    private func sine(_ hz: Double, amplitude: Double, seconds: Double, fs: Int = 44_100) -> [Float] {
        (0..<Int(seconds * Double(fs))).map { Float(amplitude * sin(2 * Double.pi * hz * Double($0) / Double(fs))) }
    }

    /// A voice-like test signal: noise bursts and pauses at changing levels (fixed seed).
    private func bursts(_ n: Int, seed: UInt64) -> [Float] {
        var rng = NephisRoom.SplitMix64(seed: seed)
        return (0..<n).map { i in
            let phrase = (i / 6_000) % 4
            let level: Double = [0.9, 0.05, 0.4, 0][phrase]
            return Float(rng.uniform() * level)
        }
    }

    // MARK: - Decoding and parameters

    func testDecodesAndClamps() throws {
        XCTAssertEqual(try chain(#"{"closeness": {"amount": 0.15}}"#).closeness, .init(amount: 0.15))
        XCTAssertEqual(try chain(#"{"closeness": {"amount": 3}}"#).closeness?.amount, 1)
        XCTAssertEqual(try chain(#"{"closeness": {"amount": -1}}"#).closeness?.amount, 0)
        XCTAssertNil(try chain("{}").closeness)
        XCTAssertNil(try chain(#"{"closeness": {}}"#).closeness)
        let broken = try chain(#"{"carryFrames": 9, "closeness": "close"}"#)
        XCTAssertNil(broken.closeness)
        XCTAssertEqual(broken.carryFrames, 9)
        let again = try JSONDecoder().decode(NephisFlow.Chain.self, from: JSONEncoder().encode(chain(#"{"closeness": {"amount": 0.15}}"#)))
        XCTAssertEqual(again.closeness, .init(amount: 0.15))
    }

    func testTheTunersParametersAtThePhonesLevel() {
        let s = NephisCloseness.Settings(amount: 0.15)
        XCTAssertEqual(s.pageThresholdDB, -15.6, accuracy: 1e-12)
        XCTAssertEqual(s.thresholdDB, -9.58, accuracy: 0.001)
        XCTAssertEqual(s.ratio, 1.45, accuracy: 1e-12)
        XCTAssertEqual(20 * log10(s.extraMakeup), 0.248, accuracy: 0.001)
        XCTAssertEqual(NephisCloseness.Settings(amount: 1).pageThresholdDB, -50, accuracy: 1e-12)
        XCTAssertFalse(NephisCloseness.Settings(amount: 0.004).on)
        XCTAssertTrue(NephisCloseness.Settings(amount: 0.005).on)
        let comp = NephisCloseness(settings: s, sampleRate: 44_100)
        XCTAssertEqual(comp.preDelayFrames, 264)
        XCTAssertEqual(NephisCloseness(settings: s, sampleRate: 24_000).preDelayFrames, 144)
        // Chromium's own makeup gain lifts the level a little (the knee pulls 0 dBFS down).
        XCTAssertGreaterThan(comp.linearPostGain, 1)
        XCTAssertLessThan(comp.linearPostGain, 2)
    }

    // MARK: - Off

    func testOffLeavesTheAudioBitIdentical() {
        let input = bursts(20_000, seed: 4)
        var comp: NephisCloseness? = NephisCloseness(settings: .init(amount: 0.5), sampleRate: 44_100)
        var x = input
        XCTAssertFalse(NephisCloseness.apply(&comp, settings: nil, to: &x, sampleRate: 44_100, restart: false))
        XCTAssertEqual(x, input)
        XCTAssertNil(comp)
        XCTAssertFalse(NephisCloseness.apply(&comp, settings: .init(amount: 0.004), to: &x, sampleRate: 44_100, restart: true))
        XCTAssertEqual(x, input)
        XCTAssertNil(comp)
    }

    // MARK: - The sound

    func testAQuietSignalComesOutSixMillisecondsLateAtTheMakeupGain() {
        let input = sine(1000, amplitude: 0.05, seconds: 0.5)
        var comp = NephisCloseness(settings: .init(amount: 0.15), sampleRate: 44_100)
        var y = input
        comp.process(&y)
        let d = comp.preDelayFrames
        for i in 0..<d { XCTAssertEqual(y[i], 0) }
        var worst: Float = 0
        for i in d..<y.count { worst = max(worst, abs(y[i] - input[i - d] * comp.linearPostGain * comp.extraMakeup)) }
        XCTAssertLessThan(worst, 1e-7)
    }

    func testALoudSignalIsTurnedDown() {
        let fs = 44_100
        // amount 0.6: threshold -37.2 dB in the tuner, -31.2 dBFS here, ratio 2.8.
        let quiet = sine(1000, amplitude: 0.01, seconds: 1)
        let loud = sine(1000, amplitude: 0.9, seconds: 1)
        func peakGainDB(_ input: [Float]) -> Double {
            var comp = NephisCloseness(settings: .init(amount: 0.6), sampleRate: fs)
            var y = input
            comp.process(&y)
            let tail = y[(fs / 2)...].map { abs($0) }.max() ?? 0
            let inPeak = input.map { abs($0) }.max() ?? 1
            return 20 * log10(Double(tail) / Double(inPeak))
        }
        let quietDB = peakGainDB(quiet), loudDB = peakGainDB(loud)
        // 0.9 is ~30 dB over the threshold, ~18 dB past the 12 dB knee at 2.8:1: well over 6 dB down against the quiet one.
        XCTAssertGreaterThan(quietDB - loudDB, 6)
        XCTAssertLessThan(quietDB - loudDB, 25)
    }

    func testTheSameInputGivesTheSameOutput() {
        let input = bursts(30_000, seed: 8)
        var a = NephisCloseness(settings: .init(amount: 0.3), sampleRate: 44_100)
        var b = NephisCloseness(settings: .init(amount: 0.3), sampleRate: 44_100)
        var ya = input, yb = input
        a.process(&ya)
        b.process(&yb)
        XCTAssertEqual(ya, yb)
        XCTAssertNotEqual(ya, input)
        XCTAssertTrue(NephisFlow.allFinite(ya))
    }

    func testACallInPiecesSoundsExactlyLikeTheReadInOnePiece() {
        let input = bursts(48_000, seed: 2)
        let settings = NephisCloseness.Settings(amount: 0.6)
        var whole = input
        var c1: NephisCloseness?
        NephisCloseness.apply(&c1, settings: settings, to: &whole, sampleRate: 44_100, restart: true)
        var c2: NephisCloseness?
        var pieces: [Float] = []
        var i = 0
        var first = true
        for size in [1, 31, 33, 1_000, 263, 265, 7, 12_345] + [Int](repeating: 5_000, count: 10) where i < input.count {
            var piece = Array(input[i..<min(input.count, i + size)])
            NephisCloseness.apply(&c2, settings: settings, to: &piece, sampleRate: 44_100, restart: first)
            first = false
            pieces += piece
            i += size
        }
        XCTAssertEqual(pieces, whole)
    }

    func testANewReadStartsAFreshCompressor() {
        let input = bursts(20_000, seed: 6)
        var comp: NephisCloseness?
        var a = input
        NephisCloseness.apply(&comp, settings: .init(amount: 0.4), to: &a, sampleRate: 44_100, restart: true)
        var b = input
        NephisCloseness.apply(&comp, settings: .init(amount: 0.4), to: &b, sampleRate: 44_100, restart: true)
        XCTAssertEqual(a, b)
    }
}
