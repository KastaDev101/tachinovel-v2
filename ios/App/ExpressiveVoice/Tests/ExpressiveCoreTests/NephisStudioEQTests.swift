import ExpressiveCore
import Foundation
import XCTest

/// Pack chain "studioEQ" (NephisStudioEQ.swift): decoding, clamping, and the filters against the reference designs the
/// PC used for the audio Kasta approved (RBJ cookbook with Q).
final class NephisStudioEQTests: XCTestCase {
    /// Pack 18's chain, as its pack.json carries it.
    static let pack18 = #"""
    {"eqAfterStudio": false, "studioEQ": {"gainDB": -1.25, "sections": [
      {"type": "highShelf", "hz": 10040, "q": 0.721, "db": 9.19},
      {"type": "lowShelf",  "hz": 200,   "q": 0.7,   "db": 3.5},
      {"type": "peaking",   "hz": 500,   "q": 1.0,   "db": -1.5}]}}
    """#

    private func chain(_ json: String) throws -> NephisFlow.Chain {
        try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(json.utf8))
    }

    // MARK: - Reference (the PC's Python designs, in Double)

    private typealias Coefficients = (b: [Double], a: [Double])

    private func reference(_ type: String, hz f: Double, q: Double, db: Double, fs: Double) -> Coefficients {
        let A = pow(10, db / 40), w = 2 * Double.pi * f / fs, c = cos(w), s = sin(w)
        let al = s / (2 * q), r = 2 * A.squareRoot() * al
        switch type {
        case "highShelf":
            return ([A * ((A + 1) + (A - 1) * c + r), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - r)],
                    [(A + 1) - (A - 1) * c + r, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - r])
        case "lowShelf":
            return ([A * ((A + 1) - (A - 1) * c + r), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - r)],
                    [(A + 1) + (A - 1) * c + r, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - r])
        case "highPass":
            return ([(1 + c) / 2, -(1 + c), (1 + c) / 2], [1 + al, -2 * c, 1 - al])
        case "lowPass":
            return ([(1 - c) / 2, 1 - c, (1 - c) / 2], [1 + al, -2 * c, 1 - al])
        default:
            return ([1 + al * A, -2 * c, 1 - al * A], [1 + al / A, -2 * c, 1 - al / A])
        }
    }

    /// |H(e^jw)| of the sections in dB, plus the overall gain.
    private func referenceDB(at f: Double, fs: Double, sections: [Coefficients], gainDB: Double) -> Double {
        let w = 2 * Double.pi * f / fs
        var mag = 1.0
        for (b, a) in sections {
            // H(z) at z = e^{jw}: (b0 + b1 z^-1 + b2 z^-2) / (a0 + a1 z^-1 + a2 z^-2).
            let nr = b[0] + b[1] * cos(w) + b[2] * cos(2 * w), ni = -(b[1] * sin(w) + b[2] * sin(2 * w))
            let dr = a[0] + a[1] * cos(w) + a[2] * cos(2 * w), di = -(a[1] * sin(w) + a[2] * sin(2 * w))
            mag *= ((nr * nr + ni * ni) / (dr * dr + di * di)).squareRoot()
        }
        return 20 * log10(mag) + gainDB
    }

    private var pack18Reference: [Coefficients] {
        [reference("highShelf", hz: 10040, q: 0.721, db: 9.19, fs: 44_100), reference("lowShelf", hz: 200, q: 0.7, db: 3.5, fs: 44_100),
         reference("peaking", hz: 500, q: 1.0, db: -1.5, fs: 44_100)]
    }

    /// The gain (dB) the Swift filter gives a steady sine at `hz` (1 s settles, the next 1 s is measured: whole periods).
    private func measuredDB(_ eq: NephisFlow.StudioEQ, hz: Double, fs: Int = 44_100) -> Double {
        let n = 2 * fs
        var x = (0..<n).map { Float(0.25 * sin(2 * Double.pi * hz * Double($0) / Double(fs))) }
        let input = x
        eq.apply(&x, sampleRate: fs)
        var e0 = 0.0, e1 = 0.0
        for i in fs..<n {
            e0 += Double(input[i]) * Double(input[i])
            e1 += Double(x[i]) * Double(x[i])
        }
        return 10 * log10(e1 / e0)
    }

    // MARK: - Decoding

    func testPack18DecodesItsStudioEQ() throws {
        let eq = try XCTUnwrap(chain(Self.pack18).studioEQ)
        XCTAssertEqual(eq.gainDB, -1.25)
        XCTAssertEqual(eq.sections, [
            .init(type: .highShelf, hz: 10040, q: 0.721, db: 9.19),
            .init(type: .lowShelf, hz: 200, q: 0.7, db: 3.5),
            .init(type: .peaking, hz: 500, q: 1.0, db: -1.5),
        ])
    }

    func testAChainWithoutStudioEQIsExactlyAsBefore() throws {
        XCTAssertNil(try chain(#"{"highShelfDB": 2}"#).studioEQ)
        XCTAssertNil(try chain("{}").studioEQ)
        XCTAssertEqual(try chain(#"{"highShelfDB": 2}"#), try chain(#"{"highShelfDB": 2, "studioEQ": null}"#))
        // Unreadable: nil, and the rest of the chain still reads.
        let broken = try chain(#"{"clipFrames": 40, "studioEQ": 3}"#)
        XCTAssertNil(broken.studioEQ)
        XCTAssertEqual(broken.clipFrames, 40)
        XCTAssertNil(try chain(#"{"studioEQ": {"sections": 5}}"#).studioEQ?.sections.first)
    }

    func testAnUnknownSectionIsSkippedNotTheChain() throws {
        let c = try chain(#"""
        {"carryFrames": 10, "studioEQ": {"gainDB": 1, "sections": [
          {"type": "tiltShelf", "hz": 1000, "db": 3},
          {"type": "peaking", "hz": 3000, "q": 2, "db": 2},
          {"hz": 500, "db": 1},
          "nonsense",
          {"type": "lowShelf", "hz": 120, "db": 2}]}}
        """#)
        XCTAssertEqual(c.carryFrames, 10)
        let eq = try XCTUnwrap(c.studioEQ)
        XCTAssertEqual(eq.sections.map(\.type), [.peaking, .lowShelf])
        XCTAssertEqual(eq.sections[1].q, 0.707)  // the default Q
    }

    func testValuesAreClampedToSaneRanges() throws {
        let sections = (0..<12).map { _ in #"{"type": "peaking", "hz": 99999, "q": 50, "db": 40}"# }.joined(separator: ",")
        let eq = try XCTUnwrap(chain(#"{"studioEQ": {"gainDB": 20, "sections": [\#(sections)]}}"#).studioEQ)
        XCTAssertEqual(eq.sections.count, NephisFlow.StudioEQ.maxSections)
        XCTAssertEqual(eq.gainDB, 6)
        XCTAssertEqual(eq.sections[0].hz, 20_000)
        XCTAssertEqual(eq.sections[0].q, 10)
        XCTAssertEqual(eq.sections[0].db, 12)
        let low = try XCTUnwrap(chain(#"{"studioEQ": {"gainDB": -40, "sections": [{"type": "lowShelf", "hz": 1, "q": 0, "db": -40}]}}"#).studioEQ)
        XCTAssertEqual(low.gainDB, -12)
        XCTAssertEqual(low.sections[0].hz, 20)
        XCTAssertEqual(low.sections[0].q, 0.1)
        XCTAssertEqual(low.sections[0].db, -12)
    }

    func testTheChainKeepsItsStudioEQWhenEncodedAgain() throws {
        let c = try chain(Self.pack18)
        let again = try JSONDecoder().decode(NephisFlow.Chain.self, from: JSONEncoder().encode(c))
        XCTAssertEqual(again.studioEQ, c.studioEQ)
    }

    // MARK: - The sound

    func testPack18MatchesThePCsDesignsWithinATenthOfADecibel() throws {
        let eq = try XCTUnwrap(chain(Self.pack18).studioEQ)
        let ref = pack18Reference
        for hz in [50.0, 100, 200, 500, 1000, 3000, 6000, 10000, 12000, 15000, 18000] {
            let want = referenceDB(at: hz, fs: 44_100, sections: ref, gainDB: -1.25)
            XCTAssertEqual(measuredDB(eq, hz: hz), want, accuracy: 0.1, "\(hz) Hz")
        }
        // The shape Kasta approved (gain -1.25 included): warm lows, a dip at 500 Hz, the air lift on top.
        XCTAssertEqual(referenceDB(at: 100, fs: 44_100, sections: ref, gainDB: -1.25), 2.0, accuracy: 0.3)
        XCTAssertLessThan(referenceDB(at: 500, fs: 44_100, sections: ref, gainDB: -1.25), -0.5)
        let at10k = measuredDB(eq, hz: 10000)
        XCTAssertGreaterThanOrEqual(at10k, 3.0)
        XCTAssertLessThanOrEqual(at10k, 3.4)
        XCTAssertEqual(measuredDB(eq, hz: 15000), 7.4, accuracy: 0.3)
    }

    func testEachShapeMatchesItsCookbookDesignAtOtherRates() {
        for fs in [24_000, 48_000] {
            let shapes: [(String, NephisFlow.StudioEQ.Kind)] = [("highShelf", .highShelf), ("lowShelf", .lowShelf), ("peaking", .peaking)]
            for (type, kind) in shapes {
                let eq = NephisFlow.StudioEQ(gainDB: 0, sections: [.init(type: kind, hz: 1500, q: 0.9, db: 6)])
                let ref = [reference(type, hz: 1500, q: 0.9, db: 6, fs: Double(fs))]
                for hz in [200.0, 1500, 5000] {
                    XCTAssertEqual(measuredDB(eq, hz: hz, fs: fs), referenceDB(at: hz, fs: Double(fs), sections: ref, gainDB: 0),
                                   accuracy: 0.1, "\(type) at \(fs) Hz, \(hz) Hz")
                }
            }
        }
    }

    func testAFrequencyOverNyquistStaysStable() {
        // 20 kHz at 24 kHz would be above Nyquist: moved just under it, never NaN or a blow-up.
        let eq = NephisFlow.StudioEQ(gainDB: 0, sections: [.init(type: .highShelf, hz: 20_000, q: 0.7, db: 6)])
        var x = (0..<24_000).map { Float(0.25 * sin(2 * Double.pi * 1000 * Double($0) / 24_000)) }
        eq.apply(&x, sampleRate: 24_000)
        XCTAssertTrue(NephisFlow.allFinite(x))
        XCTAssertLessThan(x.map { abs($0) }.max() ?? 0, 1)
    }

    func testAFlatEQLeavesTheAudioBitIdentical() {
        var rng = SystemRandomNumberGenerator()
        let input = (0..<4_410).map { _ in Float.random(in: -0.5...0.5, using: &rng) }
        var x = input
        NephisFlow.StudioEQ(gainDB: 0, sections: []).apply(&x, sampleRate: 44_100)
        XCTAssertEqual(x, input)
        // A 0 dB section is left out too.
        NephisFlow.StudioEQ(gainDB: 0, sections: [.init(type: .peaking, hz: 1000, q: 1, db: 0)]).apply(&x, sampleRate: 44_100)
        XCTAssertEqual(x, input)
    }

    func testACallInPiecesSoundsExactlyLikeTheCallInOnePiece() throws {
        let eq = try XCTUnwrap(chain(Self.pack18).studioEQ)
        var rng = SystemRandomNumberGenerator()
        let input = (0..<44_100).map { _ in Float.random(in: -0.3...0.3, using: &rng) }
        var whole = input
        eq.apply(&whole, sampleRate: 44_100)
        var filter = eq.filter(sampleRate: 44_100)
        var pieces: [Float] = []
        var i = 0
        for size in [1, 7, 1_000, 4_410, 333, 20_000] + [Int](repeating: 5_000, count: 10) where i < input.count {
            var piece = Array(input[i..<min(input.count, i + size)])
            filter.process(&piece)
            pieces += piece
            i += size
        }
        XCTAssertEqual(pieces.count, whole.count)
        XCTAssertEqual(pieces, whole)
    }

    // MARK: - The tuner's low cut and top cut (2026-10-15)

    func testLowAndTopCutsDecodeAndTheirGainIsIgnored() throws {
        let eq = try XCTUnwrap(chain(#"""
        {"studioEQ": {"sections": [{"type": "highPass", "hz": 80, "q": 0.7071}, {"type": "lowPass", "hz": 14000, "q": 0.7071, "db": 6}]}}
        """#).studioEQ)
        XCTAssertEqual(eq.sections.map(\.type), [.highPass, .lowPass])
        // A cut runs with db 0 (a 0 dB shelf or peak is left out), and its db changes nothing.
        let withDB = NephisFlow.StudioEQ(sections: [.init(type: .lowPass, hz: 3000, q: 0.7071, db: 6)])
        let without = NephisFlow.StudioEQ(sections: [.init(type: .lowPass, hz: 3000, q: 0.7071, db: 0)])
        XCTAssertEqual(measuredDB(withDB, hz: 6000), measuredDB(without, hz: 6000))
        XCTAssertLessThan(measuredDB(without, hz: 6000), -10)
    }

    func testCutsAreThreeDecibelsDownAtTheCornerWithButterworthQ() {
        for fs in [24_000, 44_100, 48_000] {
            let hp = NephisFlow.StudioEQ(sections: [.init(type: .highPass, hz: 200, q: 0.7071, db: 0)])
            let lp = NephisFlow.StudioEQ(sections: [.init(type: .lowPass, hz: 3000, q: 0.7071, db: 0)])
            XCTAssertEqual(measuredDB(hp, hz: 200, fs: fs), 20 * log10(0.7071), accuracy: 0.02, "high-pass at \(fs) Hz")
            XCTAssertEqual(measuredDB(lp, hz: 3000, fs: fs), 20 * log10(0.7071), accuracy: 0.02, "low-pass at \(fs) Hz")
        }
    }

    func testCutsRollOffSteadilyAndMatchTheCookbook() {
        let fs = 44_100
        let hp = NephisFlow.StudioEQ(sections: [.init(type: .highPass, hz: 1000, q: 0.7071, db: 0)])
        let lp = NephisFlow.StudioEQ(sections: [.init(type: .lowPass, hz: 2000, q: 0.7071, db: 0)])
        let hpRef = [reference("highPass", hz: 1000, q: 0.7071, db: 0, fs: 44_100)]
        let lpRef = [reference("lowPass", hz: 2000, q: 0.7071, db: 0, fs: 44_100)]
        var last = -Double.infinity
        for hz in [50.0, 100, 200, 400, 800, 1000, 2000, 4000, 8000] {
            let g = measuredDB(hp, hz: hz, fs: fs)
            XCTAssertGreaterThan(g, last, "high-pass rises to \(hz) Hz")
            XCTAssertEqual(g, referenceDB(at: hz, fs: 44_100, sections: hpRef, gainDB: 0), accuracy: 0.1, "high-pass \(hz) Hz")
            last = g
        }
        last = .infinity
        for hz in [100.0, 500, 1000, 2000, 4000, 8000, 12000, 16000, 20000] {
            let g = measuredDB(lp, hz: hz, fs: fs)
            XCTAssertLessThan(g, last, "low-pass falls to \(hz) Hz")
            XCTAssertEqual(g, referenceDB(at: hz, fs: 44_100, sections: lpRef, gainDB: 0), accuracy: 0.1, "low-pass \(hz) Hz")
            last = g
        }
        // 12 dB per octave well past the corner.
        XCTAssertEqual(measuredDB(hp, hz: 100, fs: fs) - measuredDB(hp, hz: 200, fs: fs), -12, accuracy: 0.5)
    }

    func testATopCutOverNyquistStaysStable() {
        let eq = NephisFlow.StudioEQ(sections: [.init(type: .lowPass, hz: 20_000, q: 0.7071, db: 0)])
        var x = (0..<24_000).map { Float(0.25 * sin(2 * Double.pi * 1000 * Double($0) / 24_000)) }
        eq.apply(&x, sampleRate: 24_000)
        XCTAssertTrue(NephisFlow.allFinite(x))
        XCTAssertLessThan(x.map { abs($0) }.max() ?? 0, 1)
    }
}
