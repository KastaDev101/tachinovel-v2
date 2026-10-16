import CoreML
import CryptoKit
@testable import ExpressiveCore
import XCTest

/// The de-wind cleaner (NephisDewind.swift, NephisDewindModel.swift) against the lab's vectors
/// (tachinovel-tts-lab coreml-swap/dewind/vectors, trimmed into Resources/dewind_vectors.json): constants, the resamplers,
/// one pass frame by frame with the network's recorded outputs replayed, and the chain and the calls of a read with a small
/// stand-in network (blocks, chunking, call lengths, joins, restarts). The Core ML model itself ships in the voice pack, not
/// in the repository: its tests run when DEWIND_MODEL names a DewindNet .mlpackage (a Mac with the pack's model), and are
/// skipped otherwise; the phone checks it at every load against the pack's dewind_check.json.
final class NephisDewindTests: XCTestCase {
    // MARK: - Vectors

    struct Vectors: Decodable {
        struct Resampler: Decodable {
            let up: Int
            let down: Int
            let pre_remove: Int
            let taps_per_phase: Int
            let rows: [Int]
            let polyphase_rows: [[Double]]
        }

        struct DSP: Decodable {
            let call_sizes: [Int]
            let outputs_per_call: [Int]
            let input_f32: String
            let output_f32: String
            let analysis_frames: Int
            let X_f32: String
            let f_erb_f32: String
            let f_spec_f32: String
            let model_frames: Int
            let in_f_erb_f32: String
            let in_f_spec_f32: String
            let gains_f32: String
            let coefs_tap_bin_f32: String
            let detail_frames: Int
            let Y_f32: String
            let synth_out_f32: String
        }

        struct Chain: Decodable {
            let call_sizes: [Int]
            let outputs_per_call: [Int]
            let holdback: Int
            let input44_f32: String
            let input48_f32: String
            let pass2_48k_f32: String
            let output44_2pass_f32: String
        }

        let window_index: [Int]
        let window_value: [Float]
        let band_of_bin: [Int]
        let erb_norm_init: [Float]
        let unit_norm_init: [Float]
        let resamplers: [String: Resampler]
        let dsp: DSP
        let chain: Chain
    }

    private static let vectors: Vectors? = {
        guard let url = Bundle.module.url(forResource: "dewind_vectors", withExtension: "json", subdirectory: "Resources"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Vectors.self, from: data)
    }()

    private func vectors() throws -> Vectors { try XCTUnwrap(Self.vectors, "Resources/dewind_vectors.json") }

    /// Base64 little-endian float32 → [Float].
    static func floats(_ b64: String) -> [Float] {
        guard let d = Data(base64Encoded: b64) else { return [] }
        return d.withUnsafeBytes { raw in
            (0..<(d.count / 4)).map { Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: $0 * 4, as: UInt32.self))) }
        }
    }

    private func maxDiff(_ a: [Float], _ b: [Float]) -> Float {
        zip(a, b).reduce(0) { max($0, abs($1.0 - $1.1)) }
    }

    private func maxDiff(_ a: [Double], _ b: [Double]) -> Double {
        zip(a, b).reduce(0) { max($0, abs($1.0 - $1.1)) }
    }

    // MARK: - Networks for the tests

    /// Plays back the lab's recorded network outputs frame by frame (N = 1), checking the features it is given.
    final class ReplayNet: DewindNetwork, @unchecked Sendable {
        let framesPerCall = 1
        let erb: [Float], spec: [Float], gains: [Float], coefs: [Float]
        var next = 0
        var worstInput: Float = 0

        init(_ v: Vectors.DSP) {
            erb = NephisDewindTests.floats(v.in_f_erb_f32)
            spec = NephisDewindTests.floats(v.in_f_spec_f32)
            gains = NephisDewindTests.floats(v.gains_f32)
            // [frame][tap][bin][re, im] → the model's [frame][bin][tap · 2 + re/im]
            let tb = NephisDewindTests.floats(v.coefs_tap_bin_f32)
            var c = [Float](repeating: 0, count: tb.count)
            let frames = tb.count / 960
            for f in 0..<frames {
                for tap in 0..<5 {
                    for bin in 0..<96 {
                        for part in 0..<2 { c[f * 960 + bin * 10 + tap * 2 + part] = tb[f * 960 + (tap * 96 + bin) * 2 + part] }
                    }
                }
            }
            coefs = c
        }

        func run(featErb: [Float], featSpec: [Float], state: inout NephisDewind.NetState) throws -> (gains: [Float], coefs: [Float]) {
            let f = next
            guard (f + 1) * 32 <= gains.count else { throw NephisDewind.DewindError.badNetwork("replay ran out of frames") }
            next += 1
            for b in 0..<32 { worstInput = max(worstInput, abs(featErb[b] - erb[f * 32 + b])) }
            for k in 0..<96 {
                // in_f_spec is [frame][bin][re, im]; featSpec [re…][im…]
                worstInput = max(worstInput, abs(featSpec[k] - spec[(f * 96 + k) * 2]), abs(featSpec[96 + k] - spec[(f * 96 + k) * 2 + 1]))
            }
            return (Array(gains[(f * 32)..<((f + 1) * 32)]), Array(coefs[(f * 960)..<((f + 1) * 960)]))
        }
    }

    /// A small causal, stateful stand-in network: frame by frame (so N doesn't change a single bit), its "GRU" a running
    /// mean in h[0], gains and coefficients smooth functions of the features.
    struct ToyNet: DewindNetwork {
        let framesPerCall: Int

        func run(featErb: [Float], featSpec: [Float], state: inout NephisDewind.NetState) throws -> (gains: [Float], coefs: [Float]) {
            let n = framesPerCall
            var gains = [Float](repeating: 0, count: n * 32)
            var coefs = [Float](repeating: 0, count: n * 960)
            for i in 0..<n {
                var mean: Float = 0
                for b in 0..<32 { mean += featErb[i * 32 + b] }
                state.h[0] = 0.9 * state.h[0] + 0.1 * mean / 32
                for b in 0..<32 { gains[i * 32 + b] = 0.55 + 0.4 * tanhf(featErb[i * 32 + b] + state.h[0]) }
                for k in 0..<96 {
                    let re = featSpec[i * 96 + k], im = featSpec[(n + i) * 96 + k]
                    for tap in 0..<5 {
                        coefs[i * 960 + k * 10 + tap * 2] = (tap == 2 ? 0.8 : 0.04) * (1 + 0.1 * tanhf(re))
                        coefs[i * 960 + k * 10 + tap * 2 + 1] = 0.02 * tanhf(im + state.h[0])
                    }
                }
            }
            return (gains, coefs)
        }
    }

    /// Fails on its `failAt`-th call (counting from 0), else the toy network.
    final class FailingNet: DewindNetwork, @unchecked Sendable {
        let framesPerCall = 8
        let failAt: Int
        var calls = 0
        init(failAt: Int) { self.failAt = failAt }
        func run(featErb: [Float], featSpec: [Float], state: inout NephisDewind.NetState) throws -> (gains: [Float], coefs: [Float]) {
            defer { calls += 1 }
            if calls == failAt { throw NephisDewind.DewindError.badNetwork("test failure") }
            return try ToyNet(framesPerCall: 8).run(featErb: featErb, featSpec: featSpec, state: &state)
        }
    }

    /// Speech-like test audio: a few partials under a slow envelope, with a little noise.
    private func voiceLike(_ n: Int, rate: Int, seed: UInt64 = 7) -> [Float] {
        var s = seed
        return (0..<n).map { i in
            s = s &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            let noise = Double(Int64(bitPattern: s >> 11) % 2_000) / 2_000 - 0.5
            let t = Double(i) / Double(rate)
            let env = 0.5 + 0.5 * sin(2 * Double.pi * 3 * t)
            let tone = 0.3 * sin(2 * Double.pi * 220 * t) + 0.15 * sin(2 * Double.pi * 660 * t) + 0.05 * sin(2 * Double.pi * 3_300 * t)
            return Float(env * tone + 0.01 * noise)
        }
    }

    // MARK: - Settings

    private func chain(_ json: String) throws -> NephisFlow.Chain {
        try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(json.utf8))
    }

    func testThePackChainDecodesDewind() throws {
        XCTAssertEqual(try chain(#"{"dewind": {"passes": 2}}"#).dewind, NephisDewind.Settings(passes: 2))
        XCTAssertEqual(try chain(#"{"dewind": {"passes": 1}}"#).dewind?.passes, 1)
        XCTAssertEqual(try chain(#"{"dewind": {"passes": 5}}"#).dewind?.passes, 2, "clamped to 2")
        XCTAssertEqual(try chain(#"{"dewind": {"passes": 1.4}}"#).dewind?.passes, 1)
        XCTAssertNil(try chain(#"{"dewind": {"passes": 0}}"#).dewind, "0 = off")
        XCTAssertNil(try chain(#"{"dewind": {"passes": -3}}"#).dewind)
        XCTAssertNil(try chain(#"{"dewind": {}}"#).dewind, "no passes: unreadable, off")
        XCTAssertNil(try chain("{}").dewind)
        let broken = try chain(#"{"clipFrames": 50, "dewind": "yes"}"#)
        XCTAssertNil(broken.dewind)
        XCTAssertEqual(broken.clipFrames, 50, "the rest of the chain still reads")
        let again = try JSONDecoder().decode(NephisFlow.Chain.self, from: JSONEncoder().encode(chain(#"{"dewind": {"passes": 2}}"#)))
        XCTAssertEqual(again.dewind?.passes, 2)
    }

    // MARK: - Constants

    func testConstantsMatchTheLab() throws {
        let v = try vectors()
        XCTAssertEqual(NephisDewind.erbWidths.reduce(0, +), 481)
        XCTAssertEqual(NephisDewind.bandOfBin, v.band_of_bin)
        for (i, want) in zip(v.window_index, v.window_value) { XCTAssertEqual(NephisDewind.window[i], want, accuracy: 1e-7, "window[\(i)]") }
        XCTAssertEqual(maxDiff(NephisDewind.erbNormInit, v.erb_norm_init), 0, accuracy: 1e-5)
        XCTAssertEqual(maxDiff(NephisDewind.unitNormInit, v.unit_norm_init), 0, accuracy: 1e-10)
        XCTAssertEqual(NephisDewind.passDelay, 1_440)
    }

    func testTheDFTIsTheTrueOneAndItsInverse() throws {
        let dft = try XCTUnwrap(NephisDewind.RealDFT.shared)
        // A cosine at bin 5 and a sine at bin 7: X[5] = n/2, X[7] = -i n/2.
        let n = 960
        let x = (0..<n).map { t in Float(cos(2 * Double.pi * 5 * Double(t) / Double(n)) + sin(2 * Double.pi * 7 * Double(t) / Double(n))) }
        let s = dft.forward(x, scale: 1)
        XCTAssertEqual(s.re[5], 480, accuracy: 1e-3)
        XCTAssertEqual(s.im[5], 0, accuracy: 1e-3)
        XCTAssertEqual(s.re[7], 0, accuracy: 1e-3)
        XCTAssertEqual(s.im[7], -480, accuracy: 1e-3)
        XCTAssertEqual(s.re[0], 0, accuracy: 1e-3)
        // The unnormalised inverse: n · x.
        let back = dft.inverse(s)
        XCTAssertLessThan(maxDiff(back.map { $0 / Float(n) }, x), 1e-5)
    }

    // MARK: - Resampling

    func testTheResamplersTablesAreScipys() throws {
        let v = try vectors()
        for (key, from, to) in [("44100->48000", 44_100, 48_000), ("48000->44100", 48_000, 44_100)] {
            let want = try XCTUnwrap(v.resamplers[key])
            let r = NephisDewind.StreamResampler(from: from, to: to)
            XCTAssertEqual(r.up, want.up, key)
            XCTAssertEqual(r.down, want.down, key)
            XCTAssertEqual(r.pre, want.pre_remove, key)
            XCTAssertEqual(r.taps, want.taps_per_phase, key)
            for (row, values) in zip(want.rows, want.polyphase_rows) {
                XCTAssertLessThan(maxDiff(r.polyphase(row), values), 1e-12, "\(key) phase \(row)")
            }
        }
        // 24 kHz (her Mimi sound): 2 up, 1 down and back.
        let r24 = NephisDewind.StreamResampler(from: 24_000, to: 48_000)
        XCTAssertEqual([r24.up, r24.down], [2, 1])
        let back = NephisDewind.StreamResampler(from: 48_000, to: 24_000)
        XCTAssertEqual([back.up, back.down], [1, 2])
    }

    func testTheResamplersStreamLikeResamplePoly() throws {
        let v = try vectors().chain
        let input44 = Self.floats(v.input44_f32)
        var up = NephisDewind.StreamResampler(from: 44_100, to: 48_000)
        var wide: [Double] = []
        var at = 0
        for n in v.call_sizes {
            wide += up.process(input44[at..<(at + n)].map(Double.init))
            at += n
        }
        wide += up.flush()
        let want48 = Self.floats(v.input48_f32)
        XCTAssertEqual(wide.count, want48.count)
        XCTAssertLessThan(maxDiff(wide.map(Float.init), want48), 1e-6)

        let pass2 = Self.floats(v.pass2_48k_f32)
        var down = NephisDewind.StreamResampler(from: 48_000, to: 44_100)
        var narrow: [Double] = []
        for chunk in stride(from: 0, to: pass2.count, by: 1_777) {
            narrow += down.process(pass2[chunk..<min(pass2.count, chunk + 1_777)].map(Double.init))
        }
        narrow += down.flush()
        let want44 = Self.floats(v.output44_2pass_f32)
        XCTAssertEqual(narrow.count, want44.count)
        XCTAssertLessThan(maxDiff(narrow.map(Float.init), want44), 2e-6)

        // Any chunking gives the same bits as one call.
        var whole = NephisDewind.StreamResampler(from: 44_100, to: 48_000)
        let once = whole.process(input44.map(Double.init)) + whole.flush()
        XCTAssertEqual(once, wide)
    }

    // MARK: - One pass, frame by frame (the network's outputs replayed)

    func testOnePassMatchesTheLabFrameByFrame() throws {
        let v = try vectors().dsp
        let net = ReplayNet(v)
        var pass = NephisDewind.Pass(frames: 1)
        pass.trace = .init()
        let input = Self.floats(v.input_f32)
        var out: [Float] = []
        var sizes: [Int] = []
        var at = 0
        for n in v.call_sizes {
            let o = try pass.process(Array(input[at..<(at + n)]), net: net)
            sizes.append(o.count)
            out += o
            at += n
        }
        let tail = try pass.flush(net: net)
        sizes.append(tail.count)
        out += tail
        XCTAssertEqual(sizes, v.outputs_per_call)
        XCTAssertEqual(net.next, v.model_frames, "one network step per model frame")
        XCTAssertLessThan(net.worstInput, 1e-4, "the features the network got (frame t + 2's)")

        let trace = try XCTUnwrap(pass.trace)
        let X = Self.floats(v.X_f32), erb = Self.floats(v.f_erb_f32), spec = Self.floats(v.f_spec_f32)
        for k in 0..<v.analysis_frames {
            var got: [Float] = []
            for b in 0..<481 { got += [trace.spectra[k].re[b], trace.spectra[k].im[b]] }
            XCTAssertLessThan(maxDiff(got, Array(X[(k * 962)..<((k + 1) * 962)])), 1e-5, "X of frame \(k)")
            XCTAssertLessThan(maxDiff(trace.erb[k], Array(erb[(k * 32)..<((k + 1) * 32)])), 1e-4, "f_erb of frame \(k)")
            var fs: [Float] = []
            for b in 0..<96 { fs += [trace.specRe[k][b], trace.specIm[k][b]] }
            XCTAssertLessThan(maxDiff(fs, Array(spec[(k * 192)..<((k + 1) * 192)])), 1e-4, "f_spec of frame \(k)")
        }
        let Y = Self.floats(v.Y_f32), synth = Self.floats(v.synth_out_f32)
        for t in 0..<v.detail_frames {
            var got: [Float] = []
            for b in 0..<481 { got += [trace.enhanced[t].re[b], trace.enhanced[t].im[b]] }
            XCTAssertLessThan(maxDiff(got, Array(Y[(t * 962)..<((t + 1) * 962)])), 1e-5, "Y of frame \(t)")
            XCTAssertLessThan(maxDiff(trace.synthesised[t], Array(synth[(t * 480)..<((t + 1) * 480)])), 1e-5, "synthesis of frame \(t)")
        }
        let want = Self.floats(v.output_f32)
        XCTAssertEqual(out.count, want.count)
        XCTAssertLessThan(maxDiff(out, want), 3e-5, "the pass's output (PORTING.md: ~1e-5)")
    }

    // MARK: - Blocks, chunks, the chain

    func testBlocksOfEightGiveTheSameBitsAsFrameByFrame() throws {
        let input = try Self.floats(vectors().dsp.input_f32)
        func run(_ n: Int) throws -> [Float] {
            var pass = NephisDewind.Pass(frames: n)
            let net = ToyNet(framesPerCall: n)
            return try pass.process(input, net: net) + pass.flush(net: net)
        }
        let one = try run(1), eight = try run(8)
        XCTAssertEqual(one.count, input.count)
        XCTAssertEqual(one, eight)
    }

    func testTheChainChunkedEqualsWholeAndKeepsItsLength() throws {
        let input = try Self.floats(vectors().chain.input44_f32)
        let net = ToyNet(framesPerCall: 8)
        var whole = NephisDewind.Chain(rate: 44_100, passes: 2, frames: 8)
        let once = try whole.process(input, net: net) + whole.flush(net: net)
        XCTAssertEqual(once.count, input.count)
        var chunked = NephisDewind.Chain(rate: 44_100, passes: 2, frames: 8)
        var out: [Float] = []
        var at = 0
        for n in [441, 4_000, 1, 2_222, 17, 4_344] {
            out += try chunked.process(Array(input[at..<(at + n)]), net: net)
            at += n
        }
        out += try chunked.flush(net: net)
        XCTAssertEqual(out, once)
        // The chain holds back ~70 ms plus up to 7 frames per pass while a block of 8 fills (here 0.25 s of audio).
        XCTAssertGreaterThan(chunked.outputs, 0)
    }

    // MARK: - A read's calls

    func testCallsKeepTheirLengthAndMatchTheWholeReadAwayFromTheJoins() throws {
        let rate = 44_100
        let calls = [30_000, 50_000, 1, 52_300]
        // Like her calls: each ends in her fade-out and starts with the pause before it (quiet around every join).
        var input = voiceLike(calls.reduce(0, +), rate: rate)
        var edge = 0
        for n in calls {
            edge += n
            for i in max(0, edge - 6_615)..<min(input.count, edge + 6_615) { input[i] *= 0.003 }
        }
        let net = ToyNet(framesPerCall: 8)
        var whole = NephisDewind.Chain(rate: rate, passes: 2, frames: 8)
        let once = try whole.process(input, net: net) + whole.flush(net: net)
        var stream = NephisDewind.Stream(settings: .init(passes: 2), sampleRate: rate, framesPerCall: 8)
        var out: [Float] = []
        var joins: [Int] = []
        var at = 0
        for n in calls {
            let o = try stream.process(Array(input[at..<(at + n)]), net: net)
            XCTAssertEqual(o.count, n, "a call comes back as long as it went in")
            out += o
            at += n
            joins.append(at)
        }
        XCTAssertEqual(out.count, once.count)
        // Before each join two passes' lookahead (~61 ms) assumed silence; after it a 5 ms crossfade. Everything else is
        // the whole read's output, bit for bit.
        let before = Int(0.1 * Double(rate)), fade = stream.fade
        var exact = [Bool](repeating: true, count: out.count)
        for j in joins {
            for i in max(0, j - before)..<min(out.count, j + fade) { exact[i] = false }
        }
        var compared = 0
        for i in out.indices where exact[i] {
            XCTAssertEqual(out[i], once[i], "sample \(i)")
            if out[i] != once[i] { break }
            compared += 1
        }
        XCTAssertGreaterThan(compared, 100_000)
        // Near the joins (quiet, as hers are): close, never a jump.
        XCTAssertLessThan(maxDiff(out, once), 0.01)
    }

    /// MUST-FIX (Kasta 2026-10-15: a "duh" between sentences): a read cut into calls the way the phone cuts it (each call
    /// opens in the pause before its first word and ends in her fade-out, NephisFlow.fadeOut's -68 dB) comes out of the
    /// cleaner with no transient at any join. Against one continuous run, the largest difference within 100 ms of a join
    /// stays 50 dB under the speech (the lab's run of the real network on a real read, 25 joins: 70 dB under, 97 dBFS;
    /// this stand-in network: 68 dB), and no sample step there is larger than the continuous run's own. A misaligned tail,
    /// a sample lost or doubled at a join, or a crossfade the wrong way round puts one at speech level.
    func testJoinsHaveNoTransient() throws {
        for (rate, passes) in [(44_100, 2), (24_000, 1)] {
            let lengths = [52_920, 79_380, 1, 114_660, 66_150].map { max(1, $0 * rate / 44_100) }
            var input: [Float] = []
            for (k, n) in lengths.enumerated() {
                var call = voiceLike(n, rate: rate, seed: UInt64(10 + k))
                let lead = min(n, rate * 15 / 100), fade = min(n - lead, rate * 3 / 10)
                for i in 0..<lead { call[i] *= 0.0005 }  // the pause before the first word, about -70 dB
                for i in 0..<fade { call[n - fade + i] *= Float(pow(10, -68 / 20 * Double(i + 1) / Double(fade))) }
                input += call
            }
            let net = ToyNet(framesPerCall: 8)
            var whole = NephisDewind.Chain(rate: rate, passes: passes, frames: 8)
            let once = try whole.process(input, net: net) + whole.flush(net: net)
            var stream = NephisDewind.Stream(settings: .init(passes: passes), sampleRate: rate, framesPerCall: 8)
            var out: [Float] = []
            var joins: [Int] = []
            for n in lengths {
                out += try stream.process(Array(input[out.count..<(out.count + n)]), net: net)
                joins.append(out.count)
            }
            joins.removeLast()
            XCTAssertEqual(out.count, once.count)
            let loud = input.filter { abs($0) > 0.01 }
            let speech = (loud.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(max(1, loud.count))).squareRoot()
            let h = rate / 10
            for j in joins {
                let lo = max(0, j - h), hi = min(out.count, j + h)
                var peak = 0.0, stepOut = 0.0, stepRef = 0.0
                for i in lo..<hi {
                    peak = max(peak, Double(abs(out[i] - once[i])))
                    if i > lo {
                        stepOut = max(stepOut, Double(abs(out[i] - out[i - 1])))
                        stepRef = max(stepRef, Double(abs(once[i] - once[i - 1])))
                    }
                }
                let db = 20 * log10(peak / speech + 1e-12)
                XCTAssertLessThan(db, -50, "\(rate) Hz, join at \(j): \(String(format: "%.1f", db)) dB against the speech")
                XCTAssertLessThanOrEqual(stepOut, stepRef * 1.5 + 1e-5, "\(rate) Hz, join at \(j): a step the continuous run doesn't have")
            }
        }
    }

    func testOneCallIsTheWholeReadUpToItsLastLookahead() throws {
        let rate = 24_000  // her Mimi sound
        let input = voiceLike(48_000, rate: rate)
        let net = ToyNet(framesPerCall: 8)
        var whole = NephisDewind.Chain(rate: rate, passes: 1, frames: 8)
        let once = try whole.process(input, net: net) + whole.flush(net: net)
        var stream = NephisDewind.Stream(settings: .init(passes: 1), sampleRate: rate, framesPerCall: 8)
        let out = try stream.process(input, net: net)
        XCTAssertEqual(out.count, input.count)
        let exact = input.count - Int(0.1 * Double(rate))
        XCTAssertEqual(Array(out[0..<exact]), Array(once[0..<exact]))
    }

    func testTheCleanerOffRestartsAndFailures() async throws {
        let rate = 44_100
        let a = voiceLike(20_000, rate: rate, seed: 1), b = voiceLike(30_000, rate: rate, seed: 2)
        let toy = ToyNet(framesPerCall: 8)
        // Off: the call untouched, bit for bit.
        let off = NephisDewinder(network: toy, name: "toy", computeUnits: "cpu")
        let untouched = await off.process(a, settings: .init(passes: 0), sampleRate: rate, restart: true)
        XCTAssertEqual(untouched.samples, a)
        XCTAssertEqual(untouched.ms, 0)
        // A restart is a fresh cleaner.
        let fresh = await NephisDewinder(network: toy, name: "toy", computeUnits: "cpu").process(b, settings: .init(passes: 2), sampleRate: rate,
                                                                                               restart: true)
        let d = NephisDewinder(network: toy, name: "toy", computeUnits: "cpu")
        let first = await d.process(a, settings: .init(passes: 2), sampleRate: rate, restart: true)
        XCTAssertEqual(first.samples.count, a.count)
        XCTAssertNotEqual(first.samples, a)
        let carried = await d.process(b, settings: .init(passes: 2), sampleRate: rate, restart: false)
        XCTAssertNotEqual(carried.samples, fresh.samples, "the read's state carries")
        let restarted = await d.process(b, settings: .init(passes: 2), sampleRate: rate, restart: true)
        XCTAssertEqual(restarted.samples, fresh.samples)
        // Another rate starts afresh too.
        let at24 = await d.process(b, settings: .init(passes: 2), sampleRate: 24_000, restart: false)
        let fresh24 = await NephisDewinder(network: toy, name: "toy", computeUnits: "cpu").process(b, settings: .init(passes: 2), sampleRate: 24_000,
                                                                                                 restart: false)
        XCTAssertEqual(at24.samples, fresh24.samples)
        // A failing network: that call as it was, and the next one starts afresh.
        let failing = NephisDewinder(network: FailingNet(failAt: 0), name: "toy", computeUnits: "cpu")
        let failed = await failing.process(a, settings: .init(passes: 2), sampleRate: rate, restart: true)
        XCTAssertEqual(failed.samples, a)
        XCTAssertNotNil(failed.error)
        let after = await failing.process(b, settings: .init(passes: 2), sampleRate: rate, restart: false)
        XCTAssertNil(after.error)
        XCTAssertEqual(after.samples, fresh.samples)
    }

    // MARK: - The model's files

    func testDewindJSONIsChecked() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("dewind-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertEqual(try NephisDewindModel.readConfig(in: dir), NephisDewindModel.Config(), "none: the defaults")
        func write(_ json: String) throws { try Data(json.utf8).write(to: dir.appendingPathComponent("dewind.json")) }
        try write(#"{"model": "DewindNet", "frames_per_call": 8, "sample_rate": 48000, "sha256": "ab", "compute_units": "cpu"}"#)
        let c = try NephisDewindModel.readConfig(in: dir)
        XCTAssertEqual(c.model, "DewindNet")
        XCTAssertEqual(c.frames_per_call, 8)
        for bad in [#"{"sample_rate": 44100}"#, #"{"frames_per_call": 0}"#, #"{"model": "../x"}"#, #"{"check": "a/b.json"}"#] {
            try write(bad)
            XCTAssertThrowsError(try NephisDewindModel.readConfig(in: dir), bad)
        }
        XCTAssertEqual(NephisDewindModel.units(nil), .cpuOnly, "the CPU unless the pack says otherwise")
        XCTAssertEqual(NephisDewindModel.units("ane"), .cpuAndNeuralEngine)
    }

    func testThePackagesHashIsOverItsFilesInPathOrder() throws {
        let pkg = FileManager.default.temporaryDirectory.appendingPathComponent("hash-\(UUID().uuidString).mlpackage")
        let fm = FileManager.default
        try fm.createDirectory(at: pkg.appendingPathComponent("Data/com.apple.CoreML/weights"), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: pkg) }
        let files = ["Manifest.json": "{}", "Data/com.apple.CoreML/model.mlmodel": "spec", "Data/com.apple.CoreML/weights/weight.bin": "w"]
        for (rel, text) in files { try Data(text.utf8).write(to: pkg.appendingPathComponent(rel)) }
        var lines = ""
        for rel in files.keys.sorted() {
            let digest = SHA256.hash(data: Data(files[rel]!.utf8)).map { String(format: "%02x", $0) }.joined()
            lines += "\(rel)\u{0}\(digest)\n"
        }
        let want = SHA256.hash(data: Data(lines.utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(try NephisDewindModel.treeHash(of: pkg), want)
    }

    func testTheLoadCheckMeasuresTheNetworkAgainstThePC() throws {
        let v = try vectors().dsp
        let replay = ReplayNet(v)
        let check = Self.checkVectors(v, frames: 16)
        XCTAssertEqual(try NephisDewindModel.check(replay, against: check), 0, accuracy: 1e-9)
        XCTAssertGreaterThan(try NephisDewindModel.check(ToyNet(framesPerCall: 8), against: check), NephisDewindModel.checkLimit)
    }

    /// The dsp vectors' model frames as dewind_check.json would hold them (the first `frames`).
    static func checkVectors(_ v: Vectors.DSP, frames: Int) -> NephisDewindModel.CheckVectors {
        let erb = floats(v.in_f_erb_f32), spec = floats(v.in_f_spec_f32), gains = floats(v.gains_f32), tb = floats(v.coefs_tap_bin_f32)
        var c = NephisDewindModel.CheckVectors(feat_erb: [], feat_spec: [], gains: [], coefs: [])
        for f in 0..<frames {
            c.feat_erb.append(Array(erb[(f * 32)..<((f + 1) * 32)]))
            c.feat_spec.append([(0..<96).map { spec[(f * 96 + $0) * 2] }, (0..<96).map { spec[(f * 96 + $0) * 2 + 1] }])
            c.gains.append(Array(gains[(f * 32)..<((f + 1) * 32)]))
            c.coefs.append((0..<96).map { bin in (0..<10).map { j in tb[f * 960 + ((j / 2) * 96 + bin) * 2 + j % 2] } })
        }
        return c
    }

    // MARK: - The Core ML model (DEWIND_MODEL = a DewindNet .mlpackage; skipped without it)

    private func coreMLModel() async throws -> NephisDewindModel {
        guard let path = ProcessInfo.processInfo.environment["DEWIND_MODEL"], !path.isEmpty else {
            throw XCTSkip("DEWIND_MODEL not set: the model ships in the voice pack, not the repository")
        }
        let compiled = try await MLModel.compileModel(at: URL(fileURLWithPath: path))
        let mc = MLModelConfiguration()
        mc.computeUnits = .cpuOnly
        let model = try MLModel(contentsOf: compiled, configuration: mc)
        let shape = model.modelDescription.inputDescriptionsByName["feat_erb"]?.multiArrayConstraint?.shape.map(\.intValue) ?? []
        return NephisDewindModel(model: model, name: "DewindNet", framesPerCall: shape.count == 4 ? shape[2] : 8, computeUnits: "cpu")
    }

    func testCoreMLModelIOMatchesThePC() async throws {
        let model = try await coreMLModel()
        let v = try vectors().dsp
        let e = try NephisDewindModel.check(model, against: Self.checkVectors(v, frames: 16))
        XCTAssertLessThan(e, 1e-4, "fp32 on the CPU (PORTING.md: ~1e-4)")
    }

    func testCoreMLTwoPassChainMatchesTheLab() async throws {
        let model = try await coreMLModel()
        let v = try vectors().chain
        let input = Self.floats(v.input44_f32)
        var chain = NephisDewind.Chain(rate: 44_100, passes: 2, frames: model.framesPerCall)
        var out: [Float] = []
        var at = 0
        for n in v.call_sizes {
            out += try chain.process(Array(input[at..<(at + n)]), net: model)
            at += n
        }
        out += try chain.flush(net: model)
        let want = Self.floats(v.output44_2pass_f32)
        XCTAssertEqual(out.count, want.count)
        XCTAssertLessThan(maxDiff(out, want), 1e-4)
    }
}
