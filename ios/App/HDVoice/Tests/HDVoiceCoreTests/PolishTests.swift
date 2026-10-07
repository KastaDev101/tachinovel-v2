import XCTest
@testable import HDVoiceCore

final class PolishTests: XCTestCase {
    func sine(_ f: Double, amplitude: Double, seconds: Double, sampleRate: Int) -> [Float] {
        let n = Int(seconds * Double(sampleRate))
        return (0..<n).map { Float(amplitude * sin(2 * Double.pi * f * Double($0) / Double(sampleRate))) }
    }

    /// Speech-like test signal: noise in syllable-sized bursts (deterministic).
    func speechLike(seconds: Double, level: Float, sampleRate: Int, seed: UInt32) -> [Float] {
        var s = seed
        let n = Int(seconds * Double(sampleRate))
        return (0..<n).map { i in
            s ^= s << 13
            s ^= s >> 17
            s ^= s << 5
            let white = Float(Double(s) / Double(UInt32.max) * 2 - 1)
            let syllable = 0.5 + 0.5 * sin(2 * Double.pi * 4 * Double(i) / Double(sampleRate))
            return white * level * Float(syllable)
        }
    }

    func rms(_ x: [Float]) -> Double { Double(PCM.rms(x)) }

    func testLoudnessMatchesBS1770Reference() throws {
        // BS.1770: a 997 Hz sine at 0 dBFS reads −3.01 LUFS (K-weighting is ~0 dB there).
        let full48 = try XCTUnwrap(LoudnessMeter.integrated(sine(997, amplitude: 1, seconds: 5, sampleRate: 48_000), sampleRate: 48_000))
        XCTAssertEqual(full48, -3.01, accuracy: 0.05)
        let full24 = try XCTUnwrap(LoudnessMeter.integrated(sine(997, amplitude: 1, seconds: 5, sampleRate: 24_000), sampleRate: 24_000))
        XCTAssertEqual(full24, -3.01, accuracy: 0.15, "24 kHz (Kokoro's rate)")
        let quiet = try XCTUnwrap(LoudnessMeter.integrated(sine(997, amplitude: 0.1, seconds: 5, sampleRate: 24_000), sampleRate: 24_000))
        XCTAssertEqual(quiet, -23.01, accuracy: 0.15, "−20 dBFS")
    }

    func testLoudnessGates() throws {
        let fs = 24_000
        let tone = sine(997, amplitude: 0.1, seconds: 5, sampleRate: fs)
        let reference = try XCTUnwrap(LoudnessMeter.integrated(tone, sampleRate: fs))
        // Silence is below the absolute gate.
        let withSilence = try XCTUnwrap(LoudnessMeter.integrated(tone + [Float](repeating: 0, count: 5 * fs), sampleRate: fs))
        XCTAssertEqual(withSilence, reference, accuracy: 0.25, "the blocks straddling the end pull it ~0.13 LU down")
        // A part 20 dB quieter is below the relative gate (−10 LU).
        let withQuiet = try XCTUnwrap(LoudnessMeter.integrated(tone + sine(997, amplitude: 0.01, seconds: 5, sampleRate: fs), sampleRate: fs))
        XCTAssertEqual(withQuiet, reference, accuracy: 0.25)
        XCTAssertNil(LoudnessMeter.integrated([Float](repeating: 0, count: fs), sampleRate: fs))
        XCTAssertNil(LoudnessMeter.integrated(sine(997, amplitude: 1, seconds: 0.2, sampleRate: fs), sampleRate: fs), "shorter than one 400 ms block")
    }

    func testFilters() {
        let fs = 24_000.0
        func gain(_ make: () -> Biquad, _ f: Double) -> Double {
            var q = make()
            var x = sine(f, amplitude: 0.5, seconds: 1, sampleRate: Int(fs))
            q.process(&x)
            let settled = Array(x[x.count / 2...])
            return 20 * log10(rms(settled) / (0.5 / 2.0.squareRoot()))
        }
        XCTAssertLessThan(gain({ .highPass(frequency: 70, q: 0.707, sampleRate: fs) }, 20), -18, "rumble cut")
        XCTAssertEqual(gain({ .highPass(frequency: 70, q: 0.707, sampleRate: fs) }, 1000), 0, accuracy: 0.1)
        XCTAssertEqual(gain({ .peaking(frequency: 3200, q: 1, gainDB: 2, sampleRate: fs) }, 3200), 2, accuracy: 0.15)
        XCTAssertEqual(gain({ .peaking(frequency: 3200, q: 1, gainDB: 2, sampleRate: fs) }, 300), 0, accuracy: 0.2)
    }

    func testCompressorIsGentleAndLeavesQuietSignalsAlone() {
        var c = Compressor()
        XCTAssertEqual(c.reduction(levelDB: -30), 0)
        XCTAssertEqual(c.reduction(levelDB: -6), 6, accuracy: 0.01, "12 dB over at 2:1 → 6 dB less")
        XCTAssertGreaterThan(c.reduction(levelDB: -18), 0, "soft knee")
        var loud = sine(440, amplitude: 0.9, seconds: 1, sampleRate: 24_000)
        let before = rms(loud)
        c.process(&loud, sampleRate: 24_000)
        XCTAssertLessThan(rms(loud), before * 0.7)
        var quiet = sine(440, amplitude: 0.02, seconds: 1, sampleRate: 24_000)
        let q0 = quiet
        var c2 = Compressor()
        c2.process(&quiet, sampleRate: 24_000)
        XCTAssertEqual(quiet, q0, "below the knee: untouched")
    }

    func testPolishBringsAChapterToMinus16LUFSWithoutClipping() throws {
        let fs = 24_000
        var polish = NarrationPolish(sampleRate: fs, roomTone: false)
        var all: [Float] = []
        for k in 0..<12 {
            let s = speechLike(seconds: 3, level: 0.15, sampleRate: fs, seed: UInt32(k + 1))
            let out = polish.prepareSentence(s, pause: 0.3)
            XCTAssertLessThanOrEqual(PCM.peak(out), NarrationPolish.peakCeiling + 1e-4)
            all += out
        }
        let lufs = try XCTUnwrap(LoudnessMeter.integrated(all, sampleRate: fs))
        XCTAssertEqual(lufs, NarrationPolish.targetLUFS, accuracy: 1.5)
        // Deterministic.
        var again = NarrationPolish(sampleRate: fs, roomTone: false)
        let first = again.prepareSentence(speechLike(seconds: 3, level: 0.06, sampleRate: fs, seed: 1), pause: 0.3)
        var other = NarrationPolish(sampleRate: fs, roomTone: false)
        XCTAssertEqual(first, other.prepareSentence(speechLike(seconds: 3, level: 0.06, sampleRate: fs, seed: 1), pause: 0.3))
    }

    func testRoomToneFillsPausesFaintly() {
        let fs = 24_000
        var plain = NarrationPolish(sampleRate: fs, roomTone: false)
        let a = plain.prepareSentence(speechLike(seconds: 1, level: 0.06, sampleRate: fs, seed: 3), pause: 1)
        XCTAssertTrue(a.suffix(fs / 2).allSatisfy { $0 == 0 }, "digital silence without room tone")
        var toned = NarrationPolish(sampleRate: fs, roomTone: true)
        let b = toned.prepareSentence(speechLike(seconds: 1, level: 0.06, sampleRate: fs, seed: 3), pause: 1)
        let tail = Array(b.suffix(fs / 2))
        let db = 20 * log10(rms(tail))
        XCTAssertEqual(db, RoomTone.defaultLevelDB, accuracy: 3)
    }

    func testJoinPartsTrimsAndSpacesParts() {
        let fs = 24_000
        let pad = [Float](repeating: 0, count: fs / 2)
        let voiced = sine(300, amplitude: 0.3, seconds: 0.5, sampleRate: fs)
        let joined = PCM.joinParts([pad + voiced + pad, pad + voiced + pad, []], sampleRate: fs, gap: 0.12)
        let one = PCM.trimSilence(pad + voiced + pad, sampleRate: fs).count
        XCTAssertEqual(joined.count, 2 * one + PCM.silenceFrames(seconds: 0.12, sampleRate: fs))
        XCTAssertEqual(PCM.joinParts([], sampleRate: fs, gap: 0.12), [])
    }
}
