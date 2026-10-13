import ExpressiveCore
import Foundation
import XCTest

/// Her breaths as air (BreathPolish, 2026-10-13): the phone's version against the PC's on a 4 s piece of her studio read
/// (tachinovel-tts-lab finetune/wsl/breath_polish_phone_sim.py --export, spicy passage at 18.46 s), off means untouched,
/// and words stay as they are.
final class BreathPolishTests: XCTestCase {
    /// breath_polish_expected.json: the PC's breath flags (lab script v2 preset "a" with pyin, and the phone simulation),
    /// the simulation's voicing, and per-frame octave-band levels (dB) of the input and both outputs.
    private struct Expected: Decodable {
        let sr: Int
        let n: Int
        let breathLab: [Int]
        let breathSim: [Int]
        let voicedSim: [Int]
        let vSim: [Double]
        let bandsIn: [[Double]]
        let bandsLab: [[Double]]
        let bandsSim: [[Double]]
        let persIn: Double
        let persLab: Double
        let persSim: Double
    }

    private func resource(_ name: String, _ ext: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Resources"))
        return try Data(contentsOf: url)
    }

    /// A 16-bit mono WAV (any chunk order).
    private func readWav(_ data: Data) throws -> (samples: [Float], rate: Int) {
        let b = [UInt8](data)
        func u32(_ o: Int) -> Int { Int(b[o]) | Int(b[o + 1]) << 8 | Int(b[o + 2]) << 16 | Int(b[o + 3]) << 24 }
        func u16(_ o: Int) -> Int { Int(b[o]) | Int(b[o + 1]) << 8 }
        XCTAssertEqual(String(bytes: b[0..<4], encoding: .ascii), "RIFF")
        var o = 12, rate = 0, bits = 0, channels = 0
        while o + 8 <= b.count {
            let id = String(bytes: b[o..<(o + 4)], encoding: .ascii) ?? "", size = u32(o + 4)
            if id == "fmt " { channels = u16(o + 10); rate = u32(o + 12); bits = u16(o + 22) }
            if id == "data" {
                XCTAssertEqual(bits, 16); XCTAssertEqual(channels, 1)
                let count = min(size, b.count - o - 8) / 2
                let samples = (0..<count).map { i -> Float in
                    Float(Int16(bitPattern: UInt16(u16(o + 8 + 2 * i)))) / 32768
                }
                return (samples, rate)
            }
            o += 8 + size + (size & 1)
        }
        throw XCTSkip("no data chunk")
    }

    /// The simulation's per-frame octave-band levels (dB), from the phone's own frames.
    private func bands(_ x: [Float], rate: Int) -> [[Double]] {
        let frames = BreathPolish.powerFrames(x, sampleRate: rate)
        let n = BreathPolish.fftSize(sampleRate: rate)
        let edges = (0...9).map { 62.5 * pow(2, Double($0)) }
        return frames.map { p in
            (0..<9).map { b -> Double in
                var sum = 0.0
                for k in p.indices {
                    let f = Double(k) * Double(rate) / Double(n)
                    if f >= edges[b], f < edges[b + 1] { sum += p[k] }
                }
                return 10 * log10(sum + 1e-12)
            }
        }
    }

    /// The simulation's `pers`: correlation of the spectral fine structure (log power minus its 9-bin mean, 1-6 kHz)
    /// between flagged frames `lag` apart. A pitched buzz keeps its peaks from frame to frame; air does not.
    private func persistence(_ x: [Float], rate: Int, flags: [Bool], lag: Int = 2) -> Double {
        let frames = BreathPolish.powerFrames(x, sampleRate: rate)
        let n = BreathPolish.fftSize(sampleRate: rate)
        let bins = (0..<frames[0].count).filter { k in let f = Double(k) * Double(rate) / Double(n); return f >= 1000 && f < 6000 }
        func fine(_ t: Int) -> [Double] {
            let l = frames[t].map { log($0 + 1e-12) }
            return bins.map { k in
                var s = 0.0
                for j in (k - 4)...(k + 4) { s += l[j] }
                return l[k] - s / 9
            }
        }
        var cs: [Double] = []
        for t in 0..<(min(flags.count, frames.count) - lag) where flags[t] && flags[t + lag] {
            let a = fine(t), b = fine(t + lag)
            let ma = a.reduce(0, +) / Double(a.count), mb = b.reduce(0, +) / Double(b.count)
            var sab = 0.0, saa = 0.0, sbb = 0.0
            for i in a.indices { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) * (a[i] - ma); sbb += (b[i] - mb) * (b[i] - mb) }
            cs.append(sab / (saa * sbb).squareRoot())
        }
        return cs.isEmpty ? 0 : cs.reduce(0, +) / Double(cs.count)
    }

    private func rmsDB(_ x: [Float]) -> Double {
        10 * log10(x.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(max(1, x.count)) + 1e-20)
    }

    private func agreement(_ a: [Bool], _ b: [Int]) -> Double {
        let n = min(a.count, b.count)
        return Double((0..<n).filter { a[$0] == (b[$0] != 0) }.count) / Double(max(1, n))
    }

    // MARK: - (a) The phone does what the PC does

    func testMatchesThePCOnAPieceOfHerRead() throws {
        let e = try JSONDecoder().decode(Expected.self, from: try resource("breath_polish_expected", "json"))
        let (x, rate) = try readWav(try resource("breath_polish_in", "wav"))
        XCTAssertEqual(rate, e.sr)
        XCTAssertEqual(x.count, e.n)

        // Breath frames: the simulation's (same detector) nearly frame for frame; the lab script's (pyin) mostly.
        let a = BreathPolish.analyze(x, sampleRate: rate)
        XCTAssertEqual(a.breath.count, e.breathSim.count)
        XCTAssertGreaterThanOrEqual(agreement(a.breath, e.breathSim), 0.97, "breath frames vs the PC simulation")
        XCTAssertGreaterThanOrEqual(agreement(a.breath, e.breathLab), 0.90, "breath frames vs the lab script (pyin)")
        XCTAssertGreaterThanOrEqual(agreement(a.voiced, e.voicedSim), 0.97, "voiced frames vs the PC simulation")
        let vDiff = zip(a.voicing, e.vSim).map { abs($0 - $1) }.reduce(0, +) / Double(e.vSim.count)
        XCTAssertLessThan(vDiff, 0.01, "voicing strength vs the PC simulation")
        XCTAssertGreaterThan(a.breath.filter { $0 }.count, 20, "the piece has breaths")

        var y = x
        let report = BreathPolish.apply(&y, sampleRate: rate, settings: BreathPolish.Settings())
        XCTAssertGreaterThan(report.touchedFrames, 50)
        let seconds = Double(x.count) / Double(rate)
        print("BreathPolish: \(report.summary) for \(String(format: "%.1f", seconds)) s of 44.1 kHz audio = "
            + "\(String(format: "%.1f", report.ms / seconds)) ms per audio second (CI Mac, debug build)")

        // Magnitude envelopes (phases are random): per-frame octave bands against the simulation (same noise, so close)
        // and the lab script (other noise and detector: looser). Frames above the piece's silence only.
        let out = bands(y, rate: rate)
        let top = e.bandsIn.flatMap { $0 }.max() ?? 0
        func meanDiff(_ ref: [[Double]]) -> Double {
            var sum = 0.0, count = 0
            for t in 0..<min(out.count, ref.count) {
                for b in 0..<9 where e.bandsIn[t][b] > top - 80 { sum += abs(out[t][b] - ref[t][b]); count += 1 }
            }
            return sum / Double(max(1, count))
        }
        let toSim = meanDiff(e.bandsSim), toLab = meanDiff(e.bandsLab), toIn = meanDiff(e.bandsIn)
        print("BreathPolish: mean |band dB| vs PC simulation \(toSim), vs lab script \(toLab), vs input \(toIn)")
        XCTAssertLessThan(toSim, 0.3, "octave-band envelope vs the PC simulation")
        XCTAssertLessThan(toLab, 0.8, "octave-band envelope vs the lab script")

        // The buzz is gone the way the simulation removes it, and the level stays.
        let flags = e.breathSim.map { $0 != 0 }
        let pers = persistence(y, rate: rate, flags: flags), persIn = persistence(x, rate: rate, flags: flags)
        print("BreathPolish: breath buzz (fine-structure persistence, lag 2) in \(persIn) out \(pers); PC: in \(e.persIn) "
            + "simulation \(e.persSim) lab \(e.persLab)")
        XCTAssertEqual(persIn, e.persIn, accuracy: 0.005)
        XCTAssertLessThan(pers, persIn - 0.01, "less buzz in her breaths")
        XCTAssertEqual(pers, e.persSim, accuracy: 0.015)
        XCTAssertEqual(rmsDB(y), rmsDB(x), accuracy: 0.25, "same level")
    }

    // MARK: - (b) Off is off

    func testOffChangesNothing() throws {
        let (x, rate) = try readWav(try resource("breath_polish_in", "wav"))
        var y = x
        XCTAssertEqual(BreathPolish.apply(&y, sampleRate: rate, settings: nil), BreathPolish.Report())
        XCTAssertEqual(y, x)
        var nothing = BreathPolish.Settings()
        nothing.strength = 0
        nothing.wordBlend = 0
        BreathPolish.apply(&y, sampleRate: rate, settings: nothing)
        XCTAssertEqual(y, x)

        // A pack without "breathPolish" (every pack before), or one this version can't read: off.
        XCTAssertNil(NephisFlow.Chain().breathPolish)
        XCTAssertNil(try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"highShelfDB": 2}"#.utf8)).breathPolish)
        XCTAssertNil(try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"breathPolish": 3}"#.utf8)).breathPolish)
        // {} = the phone's tuned values; a field overrides one, clamped; an unreadable field keeps its default.
        let on = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"breathPolish": {}}"#.utf8))
        XCTAssertEqual(on.breathPolish, BreathPolish.Settings())
        let tuned = try JSONDecoder().decode(NephisFlow.Chain.self,
                                             from: Data(#"{"breathPolish": {"strength": 0.5, "wordBlend": 7, "phase": "x", "plainToo": true}}"#.utf8))
        XCTAssertEqual(tuned.breathPolish?.strength, 0.5)
        XCTAssertEqual(tuned.breathPolish?.wordBlend, 1)
        XCTAssertEqual(tuned.breathPolish?.phase, 1)
        XCTAssertEqual(tuned.breathPolish?.plainToo, true)
        // Round trip (the pack library writes chains back).
        let again = try JSONDecoder().decode(NephisFlow.Chain.self, from: try JSONEncoder().encode(tuned))
        XCTAssertEqual(again.breathPolish, tuned.breathPolish)
    }

    // MARK: - (c) Words stay as they are

    /// Deterministic noise for the synthetic tests.
    private struct LCG {
        var state: UInt64
        mutating func next() -> Float {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Float(Double(state >> 11) / 9_007_199_254_740_992.0 * 2 - 1)
        }
    }

    func testWordsAndHissAreUntouchedBreathsAreRebuilt() {
        let rate = 44_100
        var rng = LCG(state: 7)
        func tone(_ s: Double) -> [Float] {   // a voiced vowel: 180 Hz, harmonics at 1/k
            (0..<Int(s * Double(rate))).map { i in
                var v = 0.0
                for k in 1...40 { v += sin(2 * Double.pi * 180 * Double(k) * Double(i) / Double(rate)) / Double(k) }
                return Float(0.15 * v)
            }
        }
        func quiet(_ s: Double) -> [Float] { (0..<Int(s * Double(rate))).map { _ in 0.0001 * rng.next() } }
        func breath(_ s: Double) -> [Float] {   // dark noise (two one-pole low-passes), well under the vowel (PC: centroid 2.6 kHz)
            var a = 0.0, b = 0.0
            return (0..<Int(s * Double(rate))).map { _ in
                a = 0.85 * a + 0.15 * Double(rng.next()); b = 0.85 * b + 0.15 * a
                return Float(0.1 * b)
            }
        }
        func hiss(_ s: Double) -> [Float] {   // an "s": bright noise (centroid far above 5 kHz)
            var last: Float = 0
            return (0..<Int(s * Double(rate))).map { _ in let v = rng.next(); defer { last = v }; return 0.01 * (v - last) }
        }
        let parts: [[Float]] = [tone(0.8), quiet(0.3), breath(0.5), quiet(0.3), hiss(0.3), quiet(0.3), tone(0.8)]
        let x = parts.flatMap { $0 }
        var starts: [Int] = [], o = 0
        for p in parts { starts.append(o); o += p.count }

        let a = BreathPolish.analyze(x, sampleRate: rate)
        let hop = a.hop
        func frames(_ part: Int, margin: Int = 6) -> Range<Int> {
            (starts[part] / hop + margin)..<((starts[part] + parts[part].count) / hop - margin)
        }
        XCTAssertGreaterThan(Double(frames(2).filter { a.breath[$0] }.count) / Double(frames(2).count), 0.8, "the breath is found")
        XCTAssertFalse(frames(4).contains { a.breath[$0] }, "an 's' is not a breath")
        XCTAssertFalse(frames(0).contains { a.breath[$0] } || frames(6).contains { a.breath[$0] }, "a vowel is not a breath")
        XCTAssertTrue(frames(0).allSatisfy { a.voiced[$0] }, "the vowel is voiced")
        XCTAssertEqual(a.f0[frames(0).lowerBound + 10], 180, accuracy: 1)

        var y = x
        let report = BreathPolish.apply(&y, sampleRate: rate, settings: BreathPolish.Settings())
        XCTAssertEqual(report.wordFrames, 0, "a clean vowel has no breathy air to rebuild")
        // Words and the "s": every sample as it was (the breath's rebuilt frames reach ~12 frames around it, no further).
        func samples(_ part: Int, margin: Int) -> Range<Int> { (starts[part] + margin)..<(starts[part] + parts[part].count - margin) }
        XCTAssertEqual(Array(y[samples(0, margin: 0)]), Array(x[samples(0, margin: 0)]))
        XCTAssertEqual(Array(y[samples(6, margin: 0)]), Array(x[samples(6, margin: 0)]))
        XCTAssertEqual(Array(y[samples(4, margin: 0)]), Array(x[samples(4, margin: 0)]))
        // The breath: changed, at its level.
        let br = samples(2, margin: 4096)
        XCTAssertNotEqual(Array(y[br]), Array(x[br]))
        XCTAssertEqual(rmsDB(Array(y[br])), rmsDB(Array(x[br])), accuracy: 1.0)
    }

    func testBreathyWordsKeepEverythingUnderTheCutoff() throws {
        // On her read: voiced frames away from breaths keep their sound under 1 kHz (bands 62.5-1000 Hz) within 0.3 dB.
        let (x, rate) = try readWav(try resource("breath_polish_in", "wav"))
        let a = BreathPolish.analyze(x, sampleRate: rate)
        var y = x
        let report = BreathPolish.apply(&y, sampleRate: rate, settings: BreathPolish.Settings())
        XCTAssertGreaterThan(report.wordFrames, 0, "the piece has breathy words")
        let bi = bands(x, rate: rate), bo = bands(y, rate: rate)
        let breaths = a.breath.indices.filter { a.breath[$0] }
        let far = a.voiced.indices.filter { t in a.voiced[t] && !breaths.contains { abs($0 - t) <= 12 } }
        XCTAssertGreaterThan(far.count, 10)
        var sum = 0.0
        for t in far { for b in 0..<4 { sum += abs(bo[t][b] - bi[t][b]) } }
        let low = sum / Double(far.count * 4)
        print("BreathPolish: voiced frames under 1 kHz changed \(low) dB on average (\(far.count) frames)")
        XCTAssertLessThan(low, 0.3)
    }
}
