import ExpressiveCore
import XCTest

/// A read through her studio, the parts that need no model (studio audit 2026-10-12): who owns each call's tone, her
/// Mimi EQ for the calls the studio skips, the sketch's scale, short calls padded instead of dropped, long calls in
/// stretches the blueprint takes, and model outputs that are not numbers. The Core ML models only run on the phone.
final class NephisStudioReadTests: XCTestCase {
    private func lat(_ v: Float) -> [Float] { [Float](repeating: v, count: NephisFlow.latentDim) }

    // MARK: - Tone (A3)

    func testOneOwnerForTheToneOfAStudioCall() throws {
        let pack = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"highShelfDB": 2, "softSibilance": false}"#.utf8))
        // Her studio sound is her tone: no mood shelf, no Mimi EQ (the mood's level still applies in decode).
        XCTAssertEqual(NephisFlow.studioTone(studioUsed: true, moodToneDB: -1.5, chain: pack), NephisFlow.StudioTone(moodShelfDB: 0, mimiEQ: nil))
        // Skipped or failed: exactly what the read without the studio gets, the mood's shelf and the pack's EQ.
        XCTAssertEqual(NephisFlow.studioTone(studioUsed: false, moodToneDB: -1.5, chain: pack),
                       NephisFlow.StudioTone(moodShelfDB: -1.5, mimiEQ: NephisFlow.MimiEQ(highShelfDB: 2, softSibilance: false)))
        // A pack that says nothing: the shipped EQ (VoiceTilt.nephis: +5.95 dB, softer sibilance), as the player picks it.
        XCTAssertEqual(NephisFlow.studioTone(studioUsed: false, moodToneDB: 0, chain: NephisFlow.Chain()).mimiEQ,
                       NephisFlow.MimiEQ(highShelfDB: 5.95, softSibilance: true))
        let liftOnly = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"highShelfDB": 4}"#.utf8))
        XCTAssertEqual(NephisFlow.MimiEQ(chain: liftOnly), NephisFlow.MimiEQ(highShelfDB: 4, softSibilance: true), "only the lift given: sibilance stays on")
        // A rendered call is left exactly as the studio made it.
        var x = (0..<4800).map { Float(sin(Double($0) * 0.7)) * 0.1 }
        let before = x
        NephisFlow.studioTone(studioUsed: true, moodToneDB: 2, chain: pack).apply(&x, sampleRate: 44_100)
        XCTAssertEqual(x, before)
    }

    func testAPackCanAskForHerEQAfterTheStudio() throws {
        // "eqAfterStudio": true (Kasta 2026-10-13, the darker tone with the studio): a rendered call gets her EQ at the
        // studio's rate, still no mood shelf; a skipped call is unchanged. Absent or not a bool: off, as before.
        let darker = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"highShelfDB": 2, "eqAfterStudio": true}"#.utf8))
        XCTAssertTrue(darker.eqAfterStudio)
        let eq = NephisFlow.MimiEQ(highShelfDB: 2, softSibilance: true)
        XCTAssertEqual(NephisFlow.studioTone(studioUsed: true, moodToneDB: -1.5, chain: darker), NephisFlow.StudioTone(moodShelfDB: 0, mimiEQ: eq))
        XCTAssertEqual(NephisFlow.studioTone(studioUsed: false, moodToneDB: -1.5, chain: darker), NephisFlow.StudioTone(moodShelfDB: -1.5, mimiEQ: eq))
        XCTAssertFalse(NephisFlow.Chain().eqAfterStudio)
        let odd = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"eqAfterStudio": "yes"}"#.utf8))
        XCTAssertFalse(odd.eqAfterStudio, "a value this version can't read keeps the pack playing as before")
        // Applied at 44.1 kHz it is exactly her EQ at that rate.
        var x = (0..<44_100).map { Float(sin(2 * Double.pi * 300 * Double($0) / 44_100) * 0.1) }
        var expected = x
        eq.apply(&expected, sampleRate: 44_100)
        NephisFlow.studioTone(studioUsed: true, moodToneDB: 3, chain: darker).apply(&x, sampleRate: 44_100)
        XCTAssertEqual(x, expected)
        XCTAssertNotEqual(x[30_000], Float(sin(2 * Double.pi * 300 * 30_000 / 44_100) * 0.1), "her EQ changed the sound")
    }

    func testASkippedCallGetsTheMoodShelfThenHerEQ() {
        // The same as the read without the studio: decode's mood shelf, then the player's EQ.
        var x = (0..<24_000).map { (i: Int) -> Float in
            let t = Double(i) / 24_000
            return Float((sin(2 * Double.pi * 440 * t) + 0.3 * sin(2 * Double.pi * 6500 * t)) * 0.1)
        }
        var expected = x
        NephisFlow.highShelf(&expected, db: 1.5, sampleRate: 24_000)
        NephisFlow.MimiEQ(highShelfDB: 4, softSibilance: true).apply(&expected, sampleRate: 24_000)
        NephisFlow.StudioTone(moodShelfDB: 1.5, mimiEQ: NephisFlow.MimiEQ(highShelfDB: 4, softSibilance: true)).apply(&x, sampleRate: 24_000)
        XCTAssertEqual(x, expected)
    }

    private func gainDB(_ hz: Double, _ eq: NephisFlow.MimiEQ) -> Double {
        var x = (0..<24_000).map { Float(sin(2 * Double.pi * hz * Double($0) / 24_000)) * 0.1 }
        let before = x[12_000...].reduce(Float(0)) { $0 + $1 * $1 }
        eq.apply(&x, sampleRate: 24_000)
        let after = x[12_000...].reduce(Float(0)) { $0 + $1 * $1 }
        return 10 * log10(Double(after / before))
    }

    func testMimiEQIsThePlayersNephisTilt() {
        // The numbers HDVoiceCore's NephisSoundTests hold VoiceTilt.nephis to (its bands, sibilance aside).
        let eq = NephisFlow.MimiEQ(highShelfDB: 5.95, softSibilance: false)
        XCTAssertEqual(gainDB(8000, eq), 5.95, accuracy: 0.8)
        XCTAssertEqual(gainDB(60, eq), 4, accuracy: 0.8)
        XCTAssertEqual(gainDB(1000, eq), 1, accuracy: 1.2)
        // A pack's lift moves only the top.
        let two = NephisFlow.MimiEQ(highShelfDB: 2, softSibilance: false)
        XCTAssertEqual(gainDB(8000, eq) - gainDB(8000, two), 3.95, accuracy: 0.3)
        XCTAssertEqual(gainDB(60, two), gainDB(60, eq), accuracy: 0.05)
    }

    func testMimiEQSoftensOnlyTheSibilance() {
        let fs = 24_000
        // A voiced tone with no "s": untouched.
        var voiced = (0..<fs).map { Float(sin(2 * Double.pi * 180 * Double($0) / Double(fs))) * 0.1 }
        let before = voiced
        NephisFlow.MimiEQ.softenSibilance(&voiced, sampleRate: fs)
        XCTAssertEqual(zip(voiced, before).map { abs($0 - $1) }.max() ?? 1, 0, accuracy: 0.002)
        // A pure "s" (7 kHz): turned down, gently.
        var s = (0..<fs).map { Float(sin(2 * Double.pi * 7000 * Double($0) / Double(fs))) * 0.1 }
        NephisFlow.MimiEQ.softenSibilance(&s, sampleRate: fs)
        let rms = (s[12_000...].reduce(Float(0)) { $0 + $1 * $1 } / 12_000).squareRoot()
        let db = 20 * log10(Double(rms) / (0.1 / 2.0.squareRoot()))
        XCTAssertLessThan(db, -0.3)
        XCTAssertGreaterThan(db, -8)
    }

    // MARK: - The sketch's scale (A4)

    func testTheStudioGetsTheSketchAtMimisScale() throws {
        let base = NephisFlow.embeddingDim * NephisFlow.latentDim
        var floats = [Float](repeating: 0, count: base + 2 * NephisFlow.latentDim)
        for j in 0..<NephisFlow.latentDim {
            floats[base + j] = Float(j + 1)                                  // std
            floats[base + NephisFlow.latentDim + j] = -Float(j) / 2          // mean
        }
        let p = try XCTUnwrap(NephisFlow.Projection(data: floats.withUnsafeBufferPointer { Data(buffer: $0) }))
        let stream = [lat(0), lat(1), lat(-0.5)]
        let out = p.denormalized(stream)
        XCTAssertEqual(out.count, stream.count)
        for (k, l) in stream.enumerated() {
            XCTAssertEqual(out[k].count, NephisFlow.latentDim)
            for j in 0..<NephisFlow.latentDim { XCTAssertEqual(out[k][j], l[j] * Float(j + 1) - Float(j) / 2, accuracy: 1e-6) }
        }
        XCTAssertEqual(out[0][3], -1.5, "a normalized 0 is the mean")
    }

    // MARK: - Short and long calls (A7)

    func testAShortCallIsPaddedUpToTheBlueprintsMinimumThenTrimmed() {
        let hop = 512, perLatent = 3528  // 80 ms at 44.1 kHz
        // A 0.4 s first line (5 latents) with the 50 ms the studio adds at its end, no carried context.
        let samples = 5 * perLatent + 2205
        let pad = NephisFlow.studioLeadPad(samples: samples, hop: hop, samplesPerLatent: perLatent)
        XCTAssertEqual(pad, 8)
        XCTAssertGreaterThanOrEqual(NephisFlow.studioFrames(samples: samples + pad * perLatent, hop: hop), NephisFlow.studioMinFrames)
        XCTAssertLessThan(NephisFlow.studioFrames(samples: samples + (pad - 1) * perLatent, hop: hop), NephisFlow.studioMinFrames,
                          "no more than it needs")
        XCTAssertEqual(NephisFlow.studioLeadPad(samples: 44_544, hop: hop, samplesPerLatent: perLatent), 0, "long enough: untouched")
        XCTAssertEqual(NephisFlow.studioLeadPad(samples: 44_543, hop: hop, samplesPerLatent: perLatent), 1)
        XCTAssertEqual(NephisFlow.studioFrames(samples: 44_100, hop: hop), 86, "1 s alone is a frame short of the blueprint's 87")
        // Render, then trim: the padding and the carried context come off, the call keeps its exact length.
        let carry = [Float](repeating: 7, count: 2 * perLatent)
        let call = (0..<(5 * perLatent)).map { Float($0 % 13) }
        let front = NephisFlow.studioLeadPad(samples: carry.count + call.count + 2205, hop: hop, samplesPerLatent: perLatent)
        XCTAssertGreaterThan(front, 0)
        let rendered = [Float](repeating: 0, count: front * perLatent) + carry + call + [Float](repeating: 0, count: 2205)
        XCTAssertEqual(NephisFlow.studioTrim(rendered, lead: front * perLatent + carry.count, count: call.count), call)
        XCTAssertEqual(NephisFlow.studioTrim([1, 2, 3], lead: 1, count: 3), [2, 3, 0], "a short render is zero-padded to the call")
    }

    func testLongCallStretchesCoverEveryFrameOnceAndNeverRunShort() {
        let length = 2048, context = 64
        XCTAssertEqual(NephisFlow.studioSegments(frames: 2176, length: length, context: context),
                       [NephisFlow.StudioSegment(from: 0, to: 2176, keepFrom: 0, keepTo: 2176)], "fits: one piece")
        for frames in [2177, 2300, 4096, 4097, 4100, 4160, 6200, 6150] {
            let plan = NephisFlow.studioSegments(frames: frames, length: length, context: context)
            var covered = 0
            for seg in plan {
                XCTAssertEqual(seg.keepFrom, covered, "\(frames): kept frames follow on")
                XCTAssertTrue(seg.from >= 0 && seg.from <= seg.keepFrom && seg.keepTo <= seg.to && seg.to <= frames)
                XCTAssertGreaterThanOrEqual(seg.to - seg.from, NephisFlow.studioMinFrames, "\(frames): long enough for the blueprint")
                XCTAssertLessThanOrEqual(seg.to - seg.from, length + 2 * context)
                XCTAssertGreaterThanOrEqual(seg.keepFrom - seg.from, min(context, seg.keepFrom), "\(frames): context before")
                XCTAssertGreaterThanOrEqual(seg.to - seg.keepTo, min(context, frames - seg.keepTo), "\(frames): context after")
                covered = seg.keepTo
            }
            XCTAssertEqual(covered, frames)
        }
        // 4100 frames (~48 s): the last stretch used to be 68 frames (the blueprint threw); it now reaches back to 87.
        let plan = NephisFlow.studioSegments(frames: 4100, length: length, context: context)
        XCTAssertEqual(plan.count, 3)
        XCTAssertEqual(plan[1], NephisFlow.StudioSegment(from: 1984, to: 4100, keepFrom: 2048, keepTo: 4096), "the others as before")
        XCTAssertEqual(plan[2], NephisFlow.StudioSegment(from: 4013, to: 4100, keepFrom: 4096, keepTo: 4100))
    }

    // MARK: - Model outputs (A5)

    func testAModelOutputThatIsNotAllNumbersIsCaught() {
        XCTAssertTrue(NephisFlow.allFinite([0, -1.5, 3e38]))
        XCTAssertTrue(NephisFlow.allFinite([]))
        XCTAssertFalse(NephisFlow.allFinite([0, .nan, 1]))
        XCTAssertFalse(NephisFlow.allFinite([Float.infinity]))
        XCTAssertFalse(NephisFlow.allFinite([-Float.infinity, 0]))
    }
}
