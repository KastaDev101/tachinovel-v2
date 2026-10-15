import ExpressiveCore
import Foundation
import XCTest

/// Pack chain "breathAir" (NephisBreathAir.swift): the tuner's parallel exciter with Chromium's 4x oversampled shaper:
/// decoding, bypass, its small-signal gain and latency, lows untouched, aliasing kept down, calls in pieces.
final class NephisBreathAirTests: XCTestCase {
    private func chain(_ json: String) throws -> NephisFlow.Chain {
        try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(json.utf8))
    }

    private func sine(_ hz: Double, amplitude: Double, seconds: Double, fs: Int = 44_100) -> [Float] {
        (0..<Int(seconds * Double(fs))).map { Float(amplitude * sin(2 * Double.pi * hz * Double($0) / Double(fs))) }
    }

    private func noise(_ n: Int, seed: UInt64, scale: Double) -> [Float] {
        var rng = NephisRoom.SplitMix64(seed: seed)
        return (0..<n).map { _ in Float(rng.uniform() * scale) }
    }

    /// Amplitude of the `hz` component of `x` over `x[from...]` (a whole number of cycles), in Double.
    private func amplitude(_ x: [Double], hz: Double, fs: Int, from: Int) -> Double {
        var re = 0.0, im = 0.0
        for n in from..<x.count {
            let w = 2 * Double.pi * hz * Double(n) / Double(fs)
            re += x[n] * cos(w)
            im += x[n] * sin(w)
        }
        return 2 * (re * re + im * im).squareRoot() / Double(x.count - from)
    }

    /// |H| of the RBJ high-pass (Q 1.1220: WebAudio's default 1 dB) at `f`.
    private func highPassGain(_ f: Double, corner: Double, fs: Double) -> Double {
        let w0 = 2 * Double.pi * corner / fs, c = cos(w0), al = sin(w0) / (2 * 1.1220)
        let b = [(1 + c) / 2, -(1 + c), (1 + c) / 2], a = [1 + al, -2 * c, 1 - al]
        let w = 2 * Double.pi * f / fs
        let nr = b[0] + b[1] * cos(w) + b[2] * cos(2 * w), ni = -(b[1] * sin(w) + b[2] * sin(2 * w))
        let dr = a[0] + a[1] * cos(w) + a[2] * cos(2 * w), di = -(a[1] * sin(w) + a[2] * sin(2 * w))
        return ((nr * nr + ni * ni) / (dr * dr + di * di)).squareRoot()
    }

    private func wet(_ input: [Float], amount: Double, fs: Int = 44_100) -> [Double] {
        var air = NephisBreathAir(settings: NephisBreathAir.Settings(amount: amount), sampleRate: fs)
        var y = input
        air.process(&y)
        return zip(y, input).map { Double($0) - Double($1) }
    }

    // MARK: - Decoding and bypass

    func testDecodesAndClamps() throws {
        let air = try XCTUnwrap(chain(#"{"breathAir": {"amount": 0.2}}"#).breathAir)
        XCTAssertEqual(air.amount, 0.2)
        XCTAssertEqual(air.preGain, 5)
        XCTAssertEqual(air.mix, 0.048, accuracy: 1e-12)
        XCTAssertEqual(try chain(#"{"breathAir": {"amount": 4}}"#).breathAir?.amount, 1)
        XCTAssertEqual(try chain(#"{"breathAir": {"amount": -4}}"#).breathAir?.amount, 0)
        XCTAssertNil(try chain("{}").breathAir)
        XCTAssertNil(try chain(#"{"breathAir": {"mix": 1}}"#).breathAir)
        let broken = try chain(#"{"clipFrames": 50, "breathAir": [1]}"#)
        XCTAssertNil(broken.breathAir)
        XCTAssertEqual(broken.clipFrames, 50)
        let again = try JSONDecoder().decode(NephisFlow.Chain.self, from: JSONEncoder().encode(chain(#"{"breathAir": {"amount": 0.2}}"#)))
        XCTAssertEqual(again.breathAir, air)
    }

    func testOffLeavesTheAudioBitIdentical() {
        let input = noise(10_000, seed: 1, scale: 0.4)
        var air: NephisBreathAir? = NephisBreathAir(settings: NephisBreathAir.Settings(amount: 0.5), sampleRate: 44_100)
        var x = input
        XCTAssertFalse(NephisBreathAir.apply(&air, settings: nil, to: &x, sampleRate: 44_100, restart: false))
        XCTAssertEqual(x, input)
        XCTAssertNil(air)
        XCTAssertFalse(NephisBreathAir.apply(&air, settings: NephisBreathAir.Settings(amount: 0), to: &x, sampleRate: 44_100, restart: true))
        XCTAssertEqual(x, input)
        XCTAssertNil(air)
    }

    // MARK: - The sound

    func testASmallHighSignalGetsTheExcitersLinearGain() {
        // Tiny: the shaper is linear there, tanh(4v)/tanh(4) ≈ 4v/tanh(4).
        let fs = 44_100, hz = 10_000.0, amp = 1e-4
        let w = wet(sine(hz, amplitude: amp, seconds: 1), amount: 0.5)
        let got = amplitude(w, hz: hz, fs: fs, from: fs / 2)
        let want = amp * 0.24 * 0.5 * 5 * 4 / tanh(4) * highPassGain(hz, corner: 5_000, fs: 44_100) * highPassGain(hz, corner: 7_000, fs: 44_100)
        XCTAssertEqual(20 * log10(got / want), 0, accuracy: 0.1)
    }

    func testTheHighPassesHaveTheTunersQOfOneDecibel() {
        // WebAudio reads a BiquadFilterNode's Q in dB for low- and high-pass: the default 1 is 10^(1/20) linear.
        XCTAssertEqual(NephisBreathAir.highPassQ, 1.1220, accuracy: 1e-4)
        XCTAssertEqual(20 * log10(highPassGain(7_000, corner: 7_000, fs: 44_100)), 1, accuracy: 0.01, "+1 dB at the corner")
        // At the second filter's corner the air is +1 dB there (and the first filter's gain at 7 kHz), not -3 dB.
        let fs = 44_100, hz = 7_000.0, amp = 1e-4
        let w = wet(sine(hz, amplitude: amp, seconds: 1), amount: 0.5)
        let got = amplitude(w, hz: hz, fs: fs, from: fs / 2)
        let want = amp * 0.24 * 0.5 * 5 * 4 / tanh(4) * highPassGain(hz, corner: 5_000, fs: 44_100) * highPassGain(hz, corner: 7_000, fs: 44_100)
        XCTAssertEqual(20 * log10(got / want), 0, accuracy: 0.1)
    }

    func testTheAirLagsTheDrySoundByChromiumsLatency() {
        XCTAssertEqual(NephisBreathAir.latency, 192)
        var click = [Float](repeating: 0, count: 4_000)
        click[1_000] = 1e-3
        let w = wet(click, amount: 1)
        let peak = w.indices.max { abs(w[$0]) < abs(w[$1]) } ?? 0
        XCTAssertGreaterThanOrEqual(peak, 1_000 + 190)
        XCTAssertLessThanOrEqual(peak, 1_000 + 196)
        // Nothing before the click comes out of the air.
        XCTAssertLessThan(w[0..<1_000].map { abs($0) }.max() ?? 0, 1e-12)
    }

    func testLowsAreUntouched() {
        // After the first 10 ms (the sine's abrupt start is a click the high-passes let through, as in the tuner).
        let input = sine(200, amplitude: 0.3, seconds: 0.5)
        let w = wet(input, amount: 1)
        XCTAssertLessThan(w[441...].map { abs($0) }.max() ?? 1, 1e-4)
    }

    func testALoudHighSoundAddsHarmonicsWithoutAliases() {
        // 7 kHz driven into the shaper: odd harmonics at 21 kHz (kept), 35 and 49 kHz, which without oversampling would
        // fold back to 9.1 and 4.9 kHz.
        let fs = 44_100
        let w = wet(sine(7_000, amplitude: 0.5, seconds: 1), amount: 1)
        let fundamental = amplitude(w, hz: 7_000, fs: fs, from: fs / 2)
        XCTAssertGreaterThan(fundamental, 0.01)
        for alias in [9_100.0, 4_900.0] {
            let a = amplitude(w, hz: alias, fs: fs, from: fs / 2)
            XCTAssertLessThan(20 * log10(max(a, 1e-30) / fundamental), -35, "\(alias) Hz")
        }
    }

    func testTheSameInputGivesTheSameOutput() {
        let input = noise(20_000, seed: 3, scale: 0.5)
        XCTAssertEqual(wet(input, amount: 0.3), wet(input, amount: 0.3))
        XCTAssertTrue(wet(input, amount: 0.3).contains { $0 != 0 })
    }

    func testACallInPiecesSoundsLikeTheReadInOnePiece() {
        let input = noise(30_000, seed: 9, scale: 0.5)
        let settings = NephisBreathAir.Settings(amount: 0.4)
        var whole = input
        var a1: NephisBreathAir?
        NephisBreathAir.apply(&a1, settings: settings, to: &whole, sampleRate: 44_100, restart: true)
        var a2: NephisBreathAir?
        var pieces: [Float] = []
        var i = 0
        var first = true
        for size in [1, 2, 63, 64, 127, 128, 255, 1_000, 7_777] + [Int](repeating: 4_000, count: 10) where i < input.count {
            var piece = Array(input[i..<min(input.count, i + size)])
            NephisBreathAir.apply(&a2, settings: settings, to: &piece, sampleRate: 44_100, restart: first)
            first = false
            pieces += piece
            i += size
        }
        XCTAssertEqual(pieces.count, whole.count)
        var worst: Float = 0
        for k in whole.indices { worst = max(worst, abs(pieces[k] - whole[k])) }
        XCTAssertLessThan(worst, 1e-6)
        // A new read starts fresh: the same call gives the same audio again.
        var again = Array(input[0..<5_000])
        NephisBreathAir.apply(&a1, settings: settings, to: &again, sampleRate: 44_100, restart: true)
        XCTAssertEqual(Array(again), Array(whole[0..<5_000]))
    }
}
