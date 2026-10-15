import ExpressiveCore
import Foundation
import XCTest

/// Pack chain "room" (NephisRoom.swift): the browser tuner's Room, decoded, clamped, deterministic, carried across calls,
/// and its sound against the formulas (impulse, WebAudio's normalization, the tuner's wet gain and level).
final class NephisRoomTests: XCTestCase {
    private func chain(_ json: String) throws -> NephisFlow.Chain {
        try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(json.utf8))
    }

    private func noise(_ n: Int, seed: UInt64, scale: Float = 0.3) -> [Float] {
        var rng = NephisRoom.SplitMix64(seed: seed)
        return (0..<n).map { _ in Float(rng.uniform()) * scale }
    }

    // MARK: - The reference, from the formulas (written again here, not taken from the app's code)

    private struct Mix64 {
        var s: UInt64
        mutating func next() -> UInt64 {
            s = s &+ 0x9E37_79B9_7F4A_7C15
            var z = s
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    /// ir · scale · amount · 2.2 (the wet path's impulse response), in Double.
    private func referenceWetImpulse(fs: Int, amount: Double, seconds: Double = 0.35, decay: Double = 0.07, seed: UInt64 = 1) -> [Double] {
        let f = Double(fs)
        let n = Int((f * seconds).rounded())
        var rng = Mix64(s: seed)
        var lp = 0.0
        var ir = [Double](repeating: 0, count: n)
        for i in 0..<n {
            let u = Double(rng.next() >> 11) / 9_007_199_254_740_992.0 * 2 - 1
            lp = 0.55 * lp + 0.45 * u
            let t = Double(i) / f
            ir[i] = lp * exp(-t / decay) * (t < 0.004 ? t / 0.004 : 1)
        }
        var power = (ir.map { $0 * $0 }.reduce(0, +) / Double(n)).squareRoot()
        if !power.isFinite || power < 0.000125 { power = 0.000125 }
        let scale = 1 / power * 0.00125 * 44_100 / f
        return ir.map { $0 * scale * amount * 2.2 }
    }

    // MARK: - Decoding

    func testTheTunersRoomDecodesWithItsDefaults() throws {
        let room = try XCTUnwrap(chain(#"{"room": {"amount": 0.07}}"#).room)
        XCTAssertEqual(room, NephisRoom.Settings(amount: 0.07, seconds: 0.35, decay: 0.07, seed: 1))
        XCTAssertEqual(room.wetGain, 0.07 * 2.2, accuracy: 1e-15)
        XCTAssertEqual(room.level, 1 / (1 + 0.6 * 0.07), accuracy: 1e-15)
        let full = try XCTUnwrap(chain(#"{"room": {"amount": 0.1, "seconds": 0.5, "decay": 0.1, "seed": 42}}"#).room)
        XCTAssertEqual(full, NephisRoom.Settings(amount: 0.1, seconds: 0.5, decay: 0.1, seed: 42))
        let again = try JSONDecoder().decode(NephisFlow.Chain.self, from: JSONEncoder().encode(chain(#"{"room": {"amount": 0.07}}"#)))
        XCTAssertEqual(again.room, room)
    }

    func testValuesAreClamped() throws {
        let high = try XCTUnwrap(chain(#"{"room": {"amount": 2, "seconds": 5, "decay": 0, "seed": 9}}"#).room)
        XCTAssertEqual(high, NephisRoom.Settings(amount: 0.35, seconds: 1.0, decay: 0.02, seed: 9))
        let low = try XCTUnwrap(chain(#"{"room": {"amount": -1, "seconds": 0.01, "decay": 9}}"#).room)
        XCTAssertEqual(low.amount, 0)
        XCTAssertEqual(low.seconds, 0.1)
        XCTAssertEqual(low.decay, 0.3)
    }

    func testAbsentOrUnreadableIsOffAndTheRestStillReads() throws {
        XCTAssertNil(try chain("{}").room)
        let broken = try chain(#"{"clipFrames": 40, "room": 3}"#)
        XCTAssertNil(broken.room)
        XCTAssertEqual(broken.clipFrames, 40)
        XCTAssertNil(try chain(#"{"room": {"seconds": 0.3}}"#).room)  // no amount
    }

    // MARK: - Off = untouched

    func testOffLeavesTheAudioBitIdentical() {
        let input = noise(10_000, seed: 7)
        var room: NephisRoom? = NephisRoom(settings: NephisRoom.Settings(amount: 0.1), sampleRate: 44_100)
        var x = input
        XCTAssertFalse(NephisRoom.apply(&room, settings: nil, to: &x, sampleRate: 44_100, restart: false))
        XCTAssertEqual(x, input)
        XCTAssertNil(room)
        XCTAssertFalse(NephisRoom.apply(&room, settings: NephisRoom.Settings(amount: 0), to: &x, sampleRate: 44_100, restart: true))
        XCTAssertEqual(x, input)
        XCTAssertNil(room)
    }

    // MARK: - The impulse

    func testSplitMix64SeedOneGivesTheReferenceNumbers() {
        var rng = NephisRoom.SplitMix64(seed: 1)
        XCTAssertEqual(rng.next(), 0x910A_2DEC_8902_5CC1)
        XCTAssertEqual(rng.next(), 0xBEEB_8DA1_658E_EC67)
        XCTAssertEqual(rng.next(), 0xF893_A2EE_FB32_555E)
    }

    func testTheImpulseForSeedOneIsDeterministic() {
        let ir = NephisRoom.impulse(NephisRoom.Settings(amount: 0.07), sampleRate: 44_100)
        XCTAssertEqual(ir.count, 15_435)
        XCTAssertEqual(ir[0], 0)  // the 4 ms fade-in starts at 0
        // Values from a separate Python implementation of the same recipe (double precision).
        let expected: [(Int, Double)] = [
            (1, 0.0014403018421331585), (2, 0.006386856637482781), (100, 0.027407639306903046), (176, -0.5817259997910698),
            (177, -0.45706194935003525), (1000, 0.0951317479127384), (15434, 0.0027105210317914627),
        ]
        for (i, v) in expected { XCTAssertEqual(ir[i], v, accuracy: 1e-12, "ir[\(i)]") }
        XCTAssertEqual(NephisRoom.normalizationScale(ir, sampleRate: 44_100), 0.0130779387735055, accuracy: 1e-12)
        XCTAssertEqual(NephisRoom.impulse(NephisRoom.Settings(amount: 0.2), sampleRate: 44_100), ir)  // the amount doesn't change the room
        let ir24 = NephisRoom.impulse(NephisRoom.Settings(amount: 0.07), sampleRate: 24_000)
        XCTAssertEqual(ir24.count, 8_400)
        XCTAssertEqual(ir24[176], -0.5558625610922462, accuracy: 1e-12)
        XCTAssertEqual(NephisRoom.normalizationScale(ir24, sampleRate: 24_000), 0.02409673241692076, accuracy: 1e-12)
        // A silent impulse uses WebAudio's floor power.
        XCTAssertEqual(NephisRoom.normalizationScale([0, 0, 0], sampleRate: 44_100), 1 / 0.000125 * 0.00125, accuracy: 1e-9)
        XCTAssertNotEqual(NephisRoom.impulse(NephisRoom.Settings(amount: 0.07, seed: 2), sampleRate: 44_100), ir)
    }

    func testAnImpulseGivesTheDryImpulseAndTheScaledRoom() {
        let settings = NephisRoom.Settings(amount: 0.07)
        var room = NephisRoom(settings: settings, sampleRate: 44_100)
        var x = [Float](repeating: 0, count: 20_000)
        x[0] = 1
        room.process(&x)
        let wet = referenceWetImpulse(fs: 44_100, amount: 0.07)
        let level = settings.level
        XCTAssertEqual(Double(x[0]), level, accuracy: 1e-6)  // dry · 1/(1 + 0.6a); the room starts at 0
        var worst = 0.0
        for i in 1..<x.count {
            let want = (i < wet.count ? wet[i] : 0) * level
            worst = max(worst, abs(Double(x[i]) - want))
        }
        XCTAssertLessThan(worst, 1e-6)
        XCTAssertEqual(room.scaledImpulse.count, 15_435)
    }

    // MARK: - Across calls

    func testACallInPiecesSoundsLikeTheReadInOnePiece() {
        let input = noise(3 * 24_000, seed: 11)
        let settings = NephisRoom.Settings(amount: 0.2)
        var whole = input
        var r1: NephisRoom?
        NephisRoom.apply(&r1, settings: settings, to: &whole, sampleRate: 24_000, restart: true)
        var r2: NephisRoom?
        var pieces: [Float] = []
        var i = 0
        var first = true
        for size in [1, 7, 1_000, 30_000, 333, 2_400, 8_399] + [Int](repeating: 6_000, count: 10) where i < input.count {
            var piece = Array(input[i..<min(input.count, i + size)])
            NephisRoom.apply(&r2, settings: settings, to: &piece, sampleRate: 24_000, restart: first)
            first = false
            pieces += piece
            i += size
        }
        XCTAssertEqual(pieces.count, whole.count)
        var worst: Float = 0
        for k in whole.indices { worst = max(worst, abs(pieces[k] - whole[k])) }
        XCTAssertLessThan(worst, 1e-6)
    }

    func testANewReadDropsTheTailAndAnotherRateRebuildsTheRoom() {
        var room: NephisRoom?
        var loud = noise(4_000, seed: 3, scale: 0.8)
        NephisRoom.apply(&room, settings: NephisRoom.Settings(amount: 0.3), to: &loud, sampleRate: 24_000, restart: true)
        // Carried: silence after sound still rings.
        var after = [Float](repeating: 0, count: 2_000)
        NephisRoom.apply(&room, settings: NephisRoom.Settings(amount: 0.3), to: &after, sampleRate: 24_000, restart: false)
        XCTAssertGreaterThan(after.map { abs($0) }.max() ?? 0, 1e-4)
        // A new read: no tail.
        NephisRoom.apply(&room, settings: NephisRoom.Settings(amount: 0.3), to: &loud, sampleRate: 24_000, restart: false)
        var fresh = [Float](repeating: 0, count: 2_000)
        NephisRoom.apply(&room, settings: NephisRoom.Settings(amount: 0.3), to: &fresh, sampleRate: 24_000, restart: true)
        XCTAssertEqual(fresh, [Float](repeating: 0, count: 2_000))
        // Another rate: rebuilt for it, no tail.
        NephisRoom.apply(&room, settings: NephisRoom.Settings(amount: 0.3), to: &loud, sampleRate: 24_000, restart: false)
        var other = [Float](repeating: 0, count: 2_000)
        NephisRoom.apply(&room, settings: NephisRoom.Settings(amount: 0.3), to: &other, sampleRate: 44_100, restart: false)
        XCTAssertEqual(other, [Float](repeating: 0, count: 2_000))
        XCTAssertEqual(room?.sampleRate, 44_100)
        XCTAssertEqual(room?.length, 15_435)
    }

    // MARK: - The sound against the formulas

    func testTheWetSignalMatchesADirectConvolutionOfTheFormulas() {
        // Short room (0.1 s) so the direct convolution stays quick in a debug test build.
        let fs = 24_000, amount = 0.2
        let settings = NephisRoom.Settings(amount: amount, seconds: 0.1, decay: 0.03, seed: 5)
        let input = noise(6_000, seed: 21, scale: 0.5)
        var room: NephisRoom?
        var y = input
        NephisRoom.apply(&room, settings: settings, to: &y, sampleRate: fs, restart: true)
        let h = referenceWetImpulse(fs: fs, amount: amount, seconds: 0.1, decay: 0.03, seed: 5)
        XCTAssertEqual(h.count, 2_400)
        var wantEnergy = 0.0, gotEnergy = 0.0, worst = 0.0
        for n in input.indices {
            var want = 0.0
            for k in 0...min(n, h.count - 1) { want += h[k] * Double(input[n - k]) }
            let got = Double(y[n]) / settings.level - Double(input[n])
            wantEnergy += want * want
            gotEnergy += got * got
            worst = max(worst, abs(got - want))
        }
        XCTAssertGreaterThan(wantEnergy, 0)
        XCTAssertEqual(gotEnergy / wantEnergy, 1, accuracy: 1e-3)
        XCTAssertLessThan(worst, 5e-6)
        // The wet path sits well under the voice: tens of dB for a small, close room.
        let dry = input.reduce(0.0) { $0 + Double($1) * Double($1) }
        XCTAssertLessThan(10 * log10(wantEnergy / dry), -10)
    }
}
