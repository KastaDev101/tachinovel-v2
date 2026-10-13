@testable import ExpressiveCore
import Foundation
import XCTest

/// Her mastering chain on the phone (NephisMaster, 2026-10-13) against its Python twin (tachinovel-tts-lab
/// finetune/wsl/master_stream.py, `vector` mode: the same fixed test signal, the same four calls, the same meters), off
/// means untouched, calls join without a seam, and the limiter holds its ceiling.
final class NephisMasterTests: XCTestCase {
    private static let fs = 44_100

    // MARK: - The fixed vector (master_stream.py vector(): same math, Double, stored as Float)

    private static let segments: [(a: Double, b: Double, f0: Double)] = [(0.3, 2.6, 190), (2.9, 5.2, 210), (5.9, 8.8, 175), (9.3, 11.6, 200)]
    private static let pads: [(a: Double, b: Double)] = [(5.2, 5.9), (8.8, 9.3), (11.6, 12.0)]

    /// Harmonic voice in four segments with a 4 Hz syllable swell, sibilant bursts, a -70 dB floor, exact-zero pads.
    static func vector(seconds: Double = 12) -> [Float] {
        let n = Int(seconds * Double(fs))
        var x = [Float](repeating: 0, count: n)
        var s: UInt32 = 12_345
        var prev = 0.0
        for i in 0..<n {
            s ^= s << 13
            s ^= s >> 17
            s ^= s << 5
            let nz = Double(s) / 4_294_967_296.0 * 2 - 1
            let t = Double(i) / Double(fs)
            var v = 3e-4 * nz
            for seg in segments where seg.a <= t && t < seg.b {
                let swell = 0.55 + 0.45 * sin(2 * Double.pi * 4 * t)
                let env = 0.08 * swell * swell * min(1, (t - seg.a) / 0.02, (seg.b - t) / 0.02)
                var h = 0.0
                for k in 1...20 { h += sin(2 * Double.pi * seg.f0 * Double(k) * t) / Double(k) }
                v += env * h
                let ph = (t - seg.a).truncatingRemainder(dividingBy: 0.7) - 0.35
                if abs(ph) < 0.03 { v += 0.05 * (nz - prev) * (0.5 + 0.5 * cos(Double.pi * ph / 0.03)) }
            }
            for pad in pads where pad.a <= t && t < pad.b { v = 0 }
            prev = nz
            x[i] = Float(v)
        }
        return x
    }

    /// The Python run's four calls.
    private static func calls(_ n: Int) -> [Range<Int>] {
        let b1 = Int(3.7 * 44_100.0), b2 = Int(5.6 * 44_100.0), b3 = Int(9.0 * 44_100.0)
        return [0..<b1, b1..<b2, b2..<b3, b3..<n]
    }

    private func master(_ x: [Float], _ settings: NephisMaster.Settings, calls: [Range<Int>]) -> (out: [Float], chain: NephisMaster) {
        var m = NephisMaster(settings: settings, sampleRate: Self.fs)
        var out: [Float] = []
        out.reserveCapacity(x.count)
        for r in calls {
            var part = Array(x[r])
            m.process(&part)
            XCTAssertEqual(part.count, r.count, "a call keeps its length")
            out += part
        }
        return (out, m)
    }

    // MARK: - Meters (master_stream.py bs1770, band_levels, meters)

    private static func filtered(_ x: [Float], _ sections: [MasterSection]) -> [Double] {
        var z = [Double](repeating: 0, count: 2 * sections.count)
        return x.map { s in
            var v = Double(s)
            for (k, c) in sections.enumerated() {
                let y = c.b0 * v + z[2 * k]
                z[2 * k] = c.b1 * v - c.a1 * y + z[2 * k + 1]
                z[2 * k + 1] = c.b2 * v - c.a2 * y
                v = y
            }
            return v
        }
    }

    static func lufs(_ x: [Float], fs: Int) -> Double {
        let f = Double(fs)
        let k = filtered(x, [MasterSection(.highShelf, 1681.9744509555319, q: 0.7071752369554193, db: 3.99984385397, fs: f),
                             MasterSection(.hp, 38.13547087613982, q: 0.5003270373253953, fs: f)])
        var cs = [Double](repeating: 0, count: k.count + 1)
        for i in k.indices { cs[i + 1] = cs[i] + k[i] * k[i] }
        let b = Int((0.4 * f).rounded()), h = Int((0.1 * f).rounded())
        var z: [Double] = []
        var st = 0
        while st + b <= k.count {
            z.append((cs[st + b] - cs[st]) / Double(b))
            st += h
        }
        let gated = z.filter { -0.691 + masterDB($0) > -70 }
        guard !gated.isEmpty else { return -70 }
        let rel = -0.691 + masterDB(gated.reduce(0, +) / Double(gated.count)) - 10
        let kept = gated.filter { -0.691 + masterDB($0) > rel }
        return -0.691 + masterDB(kept.reduce(0, +) / Double(kept.count))
    }

    static let bandHz: [Double] = [200, 500, 1000, 2500, 5000, 7000, 10_000]

    /// RMS (dB) through RBJ band-passes (Q 2), relative to the 1 kHz band.
    static func bands(_ x: [Float], fs: Int) -> [Double] {
        let levels = bandHz.map { hz -> Double in
            let y = filtered(x, [MasterSection(.bp, hz, q: 2, fs: Double(fs))])
            return masterDB(y.reduce(0) { $0 + $1 * $1 } / Double(y.count))
        }
        return levels.map { $0 - levels[2] }
    }

    private static func rms(_ x: [Float], _ r: Range<Int>) -> Double {
        masterDB(x[r].reduce(0) { $0 + Double($1) * Double($1) } / Double(r.count))
    }

    private static func peakDB(_ x: [Float]) -> Double { 20 * log10(Double(x.map { abs($0) }.max() ?? 0) + 1e-12) }

    /// The 4x interpolated peak (the limiter's own interpolator), dBFS.
    private static func interpolatedPeakDB(_ x: [Float]) -> Double {
        let fir = MasterLimiter.interpolator()
        let padded = [Float](repeating: 0, count: 3) + x + [Float](repeating: 0, count: 4)
        var m = 0.0
        for i in 3..<(3 + x.count) { m = max(m, MasterLimiter.peak(padded, i, fir)) }
        return 20 * log10(m + 1e-12)
    }

    // MARK: - Parity with the Python twin

    /// master_stream.py vector, 2026-10-13: per preset the loudness (LUFS), the band levels (dB rel. 1 kHz), the room
    /// tone in the three pads (dBFS, shifted by the latency), the latency (samples) and the loudness gain (dB).
    private struct Expected {
        let lufs: Double
        let bands: [Double]
        let pads: [Double]
        let latency: Int
        let gain: Double
    }

    private static let expected: [NephisMaster.Preset: Expected] = [
        .minimal: Expected(lufs: -18.154, bands: [8.136, 2.805, 0.0, -4.101, -10.217, -12.005, -11.208], pads: [-68.1, -68.12, -67.95], latency: 1834, gain: 11.011),
        .clean: Expected(lufs: -17.817, bands: [7.386, 3.323, 0.0, -5.724, -12.725, -15.246, -14.885], pads: [-68.04, -68.1, -67.89], latency: 2054, gain: 10.832),
        .warm: Expected(lufs: -17.777, bands: [7.867, 3.75, 0.0, -6.055, -13.053, -15.616, -15.418], pads: [-70.07, -69.81, -70.0], latency: 2054, gain: 10.127),
        .crisp: Expected(lufs: -17.873, bands: [7.392, 3.334, 0.0, -5.198, -11.995, -14.454, -13.784], pads: [-68.03, -68.1, -67.92], latency: 2054, gain: 10.773),
    ]

    func testEveryPresetMatchesThePythonTwinOnTheFixedVector() {
        let x = Self.vector()
        XCTAssertEqual(x.count, 529_200)
        XCTAssertEqual(Self.lufs(x, fs: Self.fs), -29.011, accuracy: 0.05, "the vector itself")
        for preset in NephisMaster.Preset.allCases {
            guard let want = Self.expected[preset] else { return XCTFail("no expected values for \(preset)") }
            let started = Date()
            let (y, chain) = master(x, NephisMaster.Settings(preset: preset), calls: Self.calls(x.count))
            let ms = Date().timeIntervalSince(started) * 1000
            print("NephisMaster \(preset.rawValue): \(String(format: "%.0f", ms)) ms for 12 s of audio (debug build)")
            XCTAssertEqual(chain.latency, want.latency, "\(preset)")
            XCTAssertEqual(chain.gainDB, want.gain, accuracy: 0.3, "\(preset): loudness gain")
            XCTAssertEqual(Self.lufs(y, fs: Self.fs), want.lufs, accuracy: 0.3, "\(preset): loudness")
            for (k, (got, exp)) in zip(Self.bands(y, fs: Self.fs), want.bands).enumerated() {
                XCTAssertEqual(got, exp, accuracy: 0.4, "\(preset): band \(Self.bandHz[k]) Hz")
            }
            let half = Int(0.05 * Double(Self.fs))
            for (k, pad) in Self.pads.enumerated() {
                let r = (Int(pad.a * Double(Self.fs)) + want.latency + half)..<(Int(pad.b * Double(Self.fs)) + want.latency - half)
                XCTAssertEqual(Self.rms(y, r), want.pads[k], accuracy: 1.5, "\(preset): room tone in pad \(k)")
            }
            XCTAssertLessThanOrEqual(Self.peakDB(y), -1 + 1e-4, "\(preset): sample peak")
        }
    }

    // MARK: - Off, joins, ceiling, pads

    func testOffLeavesEveryCallUntouched() throws {
        let chain = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"pieceGap": 0.4}"#.utf8))
        XCTAssertNil(chain.master, "no \"master\" in the pack: off")
        let x = Self.vector(seconds: 2)
        var samples = x
        var master: NephisMaster?
        for restart in [true, false, false] {
            XCTAssertFalse(NephisMaster.apply(&master, settings: chain.master, to: &samples, sampleRate: Self.fs, restart: restart))
        }
        XCTAssertNil(master)
        XCTAssertEqual(samples, x, "bit for bit")
    }

    func testPackSettings() throws {
        func chain(_ json: String) throws -> NephisFlow.Chain { try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(json.utf8)) }
        XCTAssertEqual(try chain(#"{"master": {"preset": "warm"}}"#).master, NephisMaster.Settings(preset: .warm))
        XCTAssertEqual(try chain(#"{"master": {}}"#).master, NephisMaster.Settings(), "an empty block: clean, -18 LUFS, -1 dBTP, room tone")
        XCTAssertEqual(try chain(#"{"master": {"preset": "D_crisp_studio"}}"#).master?.preset, .crisp, "the lab's names work too")
        XCTAssertEqual(try chain(#"{"master": {"preset": "c"}}"#).master?.preset, .warm)
        let clamped = try chain(#"{"master": {"preset": "minimal", "lufs": -5, "ceiling": 3, "roomTone": false}}"#).master
        XCTAssertEqual(clamped, NephisMaster.Settings(preset: .minimal, lufs: -12, ceilingDB: -0.1, roomTone: false))
        XCTAssertNil(try chain(#"{"master": {"preset": "loud"}}"#).master, "an unknown preset: off, the pack still loads")
        XCTAssertNil(try chain(#"{"master": "clean"}"#).master, "not a block: off")
        // Round trip (the pack library re-encodes chains).
        let settings = NephisMaster.Settings(preset: .crisp, lufs: -16, ceilingDB: -1.5, roomTone: true)
        XCTAssertEqual(try JSONDecoder().decode(NephisMaster.Settings.self, from: JSONEncoder().encode(settings)), settings)
    }

    func testCallsJoinWithoutASeam() {
        // The same read in its first call plus one more, or in many small odd-sized calls: the chain carries every filter,
        // level, tracker and delay line across a join, so the audio is the same sample for sample.
        let x = Self.vector()
        let first = Int(3.7 * 44_100.0)
        let sizes = [1, 7, 441, 1000, 4410, 12_345, 333, 44, 45, 2205]
        var pieces = [0..<first]
        var at = first, k = 0
        while at < x.count {
            let end = min(x.count, at + sizes[k % sizes.count])
            pieces.append(at..<end)
            at = end
            k += 1
        }
        for preset in NephisMaster.Preset.allCases {
            let whole = master(x, NephisMaster.Settings(preset: preset), calls: [0..<first, first..<x.count]).out
            let split = master(x, NephisMaster.Settings(preset: preset), calls: pieces).out
            XCTAssertEqual(whole.count, split.count)
            var worst: Float = 0
            for i in whole.indices { worst = max(worst, abs(whole[i] - split[i])) }
            XCTAssertLessThan(worst, 2e-4, "\(preset): \(pieces.count) calls against 2")
        }
    }

    func testTheLimiterNeverPassesTheCeiling() {
        // Hot audio pushed 10 dB past its loudness by the target: square-ish waves, single-sample spikes at full scale,
        // a sibilant hiss, in odd-sized calls.
        let fs = Self.fs, n = 4 * fs
        var s: UInt32 = 99
        let x = (0..<n).map { i -> Float in
            s ^= s << 13
            s ^= s >> 17
            s ^= s << 5
            let t = Double(i) / Double(fs)
            var v = 0.6 * sin(2 * Double.pi * 220 * t) + 0.3 * sin(2 * Double.pi * 3100 * t + 1) + 0.25 * sin(2 * Double.pi * 9000 * t + 2)
            v = max(-0.95, min(0.95, 1.6 * v))
            if i % 2205 == 0 { v = i % 4410 == 0 ? 1 : -1 }
            v += 0.2 * (Double(s) / 4_294_967_296.0 - 0.5)
            return Float(v)
        }
        for preset in NephisMaster.Preset.allCases {
            for ceiling in [-1.0, -3.0] {
                let settings = NephisMaster.Settings(preset: preset, lufs: -12, ceilingDB: ceiling)
                var m = NephisMaster(settings: settings, sampleRate: fs)
                var out: [Float] = []
                var at = 0, k = 0
                while at < n {
                    let end = min(n, at + [3000, 17, 9999, 512][k % 4])
                    var part = Array(x[at..<end])
                    m.process(&part)
                    out += part
                    at = end
                    k += 1
                }
                let c = Float(pow(10, ceiling / 20))
                XCTAssertLessThanOrEqual(out.map { abs($0) }.max() ?? 0, c, "\(preset) \(ceiling) dB: no sample over the ceiling")
                XCTAssertLessThanOrEqual(Self.interpolatedPeakDB(out), ceiling + 0.3, "\(preset) \(ceiling) dB: between samples")
            }
        }
    }

    func testPadsGetRoomToneNotDigitalSilence() {
        let x = Self.vector()
        for preset in NephisMaster.Preset.allCases {
            let (y, chain) = master(x, NephisMaster.Settings(preset: preset), calls: Self.calls(x.count))
            // Past the first 100 ms (the delay lines start empty), never 10 ms of digital zero.
            var run = 0, longest = 0
            for v in y[(Self.fs / 10)...] {
                run = abs(v) < 1.5e-5 ? run + 1 : 0
                longest = max(longest, run)
            }
            XCTAssertLessThan(longest, Self.fs / 100, "\(preset): a cut to digital silence")
            for pad in Self.pads {
                let r = (Int(pad.a * Double(Self.fs)) + chain.latency)..<(Int(pad.b * Double(Self.fs)) + chain.latency)
                let level = Self.rms(y, r)
                XCTAssertGreaterThan(level, -85, "\(preset): room tone in the pad at \(pad.a) s")
                XCTAssertLessThan(level, -60, "\(preset): room tone stays far under her (\(pad.a) s)")
            }
            // Room tone off: the pads stay as the app made them.
            let (plain, plainChain) = master(x, NephisMaster.Settings(preset: preset, roomTone: false), calls: Self.calls(x.count))
            let pad = Self.pads[0]
            // (From 150 ms in: the filters' ringing after the last sound has died away.)
            let inside = (Int(pad.a * Double(Self.fs)) + plainChain.latency + Self.fs * 15 / 100)..<(Int(pad.b * Double(Self.fs)) + plainChain.latency - Self.fs / 20)
            XCTAssertLessThan(Self.rms(plain, inside), -90, "\(preset): roomTone false leaves the pad silent")
        }
    }

    func testAFreshReadStartsAFreshChain() {
        let x = Self.vector(seconds: 3)
        var master: NephisMaster?
        var a = x, b = x
        XCTAssertTrue(NephisMaster.apply(&master, settings: .init(preset: .warm), to: &a, sampleRate: Self.fs, restart: true))
        XCTAssertTrue(NephisMaster.apply(&master, settings: .init(preset: .warm), to: &b, sampleRate: Self.fs, restart: true))
        XCTAssertEqual(a, b, "restart: the second read sounds exactly like the first")
        var c = x
        NephisMaster.apply(&master, settings: .init(preset: .warm), to: &c, sampleRate: 24_000, restart: false)
        XCTAssertEqual(master?.sampleRate, 24_000, "another rate: a new chain at that rate")
    }
}
