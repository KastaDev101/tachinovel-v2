import HDVoiceCore
import XCTest

/// Her studio's reads run at 44.1 kHz (the app's SessionRate): natural delivery's flow path must keep their length and
/// leave their tone alone (NephisFlowSynth sets it), cut a studio call into its sentences at that rate, and finish
/// Mimi's 24 kHz stream exactly as before.
final class StudioRateTests: XCTestCase {
    private static let studioRate = 44_100

    /// Tones at whole-cycle frequencies for a 0.5 s window (2 Hz apart), up to 20 kHz. The thump filter (70 Hz high-pass,
    /// 4th order, kept for the studio stream) is the only step that touches the low end: 0.24 dB down at 100 Hz, 0.04 dB
    /// at 126 Hz, nothing above, so the lowest tone measured is 126 Hz.
    private static let tones: [Double] = [126, 250, 500, 1000, 2000, 3000, 4000, 6000, 8000, 11_000, 12_000, 15_500, 18_000, 20_000]

    /// A sum of tones (each with its own phase, so the peaks don't line up).
    private func multitone(_ freqs: [Double], amplitude: Double, seconds: Double, fs: Int) -> [Float] {
        let n = Int(seconds * Double(fs))
        return (0..<n).map { i in
            let t = Double(i) / Double(fs)
            var s = 0.0
            for (k, f) in freqs.enumerated() { s += amplitude * sin(2 * Double.pi * f * t + Double(k)) }
            return Float(s)
        }
    }

    /// A voice-like tone (150 Hz and its harmonics, syllable-rate swell), as in DeliveryTests.
    private func voiced(seconds: Double, level: Double, fs: Int) -> [Float] {
        let n = Int(seconds * Double(fs))
        return (0..<n).map { i in
            let t = Double(i) / Double(fs)
            var s = 0.0
            for h in 1...12 { s += sin(2 * Double.pi * 150 * Double(h) * t) / Double(h) }
            return Float(level * 0.4 * s * (0.55 + 0.45 * sin(2 * Double.pi * 4 * t)))
        }
    }

    /// The level (dB) of the `hz` component over x[from..<to]: one DFT bin (whole cycles, so no leakage between tones).
    private func level(_ x: [Float], hz: Double, fs: Int, from: Int, to: Int) -> Double {
        var re = 0.0, im = 0.0
        for i in from..<to {
            let w = 2 * Double.pi * hz * Double(i) / Double(fs)
            re += Double(x[i]) * cos(w)
            im += Double(x[i]) * sin(w)
        }
        return 10 * log10(max(re * re + im * im, 1e-30))
    }

    private func flowUnit(_ x: [Float], letters: [Int]) -> NaturalFinish.Unit {
        var u = NaturalFinish.Unit(samples: x, lines: letters.map { NaturalFinish.Line(params: nil, letters: $0, pause: 0.4) }, speed: 1,
                                   expressive: true)
        u.flow = true
        return u
    }

    private func studioFinish(tilt: VoiceTilt?) -> NaturalFinish {
        // As HybridSpeechEngine makes it for Nephis in her studio's read: plain (her own sound), no breaths, 44.1 kHz.
        NaturalFinish(audio: DeliveryAudio(), studioSound: true, breaths: nil, sampleRate: Self.studioRate, tilt: tilt, plain: true)
    }

    func testHerStudioStreamKeepsItsLengthAndItsTone() {
        let fs = Self.studioRate
        // Quiet enough that the soft limit never acts (14 tones × 0.03 < the knee).
        let x = multitone(Self.tones, amplitude: 0.03, seconds: 1, fs: fs)
        var finish = studioFinish(tilt: nil)
        let pieces = finish.render(flowUnit(x, letters: [40]))
        XCTAssertEqual(pieces.count, 1)
        let out = pieces.flatMap(\.frames)
        XCTAssertEqual(out.count, x.count, "no samples added or lost: the unit lasts samples / 44 100 s")
        XCTAssertEqual(pieces.reduce(0) { $0 + $1.speechSeconds }, Double(x.count) / Double(fs), accuracy: 1e-9)
        for hz in Self.tones {
            // The second half: the thump filter has long settled.
            let change = level(out, hz: hz, fs: fs, from: fs / 2, to: fs) - level(x, hz: hz, fs: fs, from: fs / 2, to: fs)
            XCTAssertEqual(change, 0, accuracy: 0.1, "\(hz) Hz")
        }
    }

    func testHerEQNeverGoesOnTopOfHerStudio() {
        let x = multitone(Self.tones, amplitude: 0.03, seconds: 1, fs: Self.studioRate)
        var plain = studioFinish(tilt: nil)
        var given = studioFinish(tilt: .nephis)
        // Even when a caller passes her Mimi EQ, a 44.1 kHz stream gets none (NephisFlowSynth owns its tone).
        let withEQ = given.render(flowUnit(x, letters: [40])).flatMap(\.frames)
        let without = plain.render(flowUnit(x, letters: [40])).flatMap(\.frames)
        XCTAssertEqual(withEQ, without)
    }

    func testAStudioCallIsCutIntoItsSentences() {
        let fs = Self.studioRate
        let x = voiced(seconds: 1, level: 0.3, fs: fs) + [Float](repeating: 0, count: Int(0.4 * Double(fs))) + voiced(seconds: 2, level: 0.3, fs: fs)
        var finish = studioFinish(tilt: nil)
        let pieces = finish.render(flowUnit(x, letters: [10, 20]))
        // One buffer per sentence of the call (HybridSpeechEngine.renderedGroup), none of it lost or doubled.
        XCTAssertEqual(pieces.count, 2)
        XCTAssertTrue(finish.lastReport.confident)
        XCTAssertEqual(pieces.reduce(0) { $0 + $1.frames.count }, x.count)
        XCTAssertEqual(pieces[0].speechSeconds, 1.2, accuracy: 0.1, "cut in the middle of the 400 ms pause")
        XCTAssertFalse(pieces[1].frames.isEmpty)
    }

    func testMimisStreamIsFinishedExactlyAsBefore() {
        let fs = NaturalFinish.mimiRate
        // Two sentences with a pause between them, loud enough for the soft limit to act.
        let x = multitone([150, 300, 450, 2500, 8000], amplitude: 0.25, seconds: 0.8, fs: fs) + [Float](repeating: 0, count: fs * 3 / 10)
            + multitone([180, 360, 3000], amplitude: 0.3, seconds: 1.2, fs: fs)
        XCTAssertGreaterThan(PCM.peak(x), NaturalFinish.flowKnee)
        var finish = NaturalFinish(audio: DeliveryAudio(), studioSound: true, breaths: nil, sampleRate: fs, tilt: .nephis, plain: true)
        let pieces = finish.render(flowUnit(x, letters: [12, 20]))
        XCTAssertEqual(pieces.count, 2)
        // The v4.2 chain by hand: the thump filter, her EQ, the fixed gain and the soft limit, then the cut (highlighting
        // only: the pieces together are the whole stream).
        var expected = x
        StartupSound.removeThump(&expected, sampleRate: fs)
        VoiceTilt.nephis.apply(&expected, sampleRate: fs)
        let g = Float(pow(10, NaturalFinish.flowGainDB / 20))
        let knee = NaturalFinish.flowKnee
        let room = NaturalFinish.peakCeiling - knee
        for i in expected.indices {
            let v = expected[i] * g
            let a = abs(v)
            expected[i] = a <= knee ? v : (v < 0 ? -1 : 1) * (knee + room * Float(tanh(Double((a - knee) / room))))
        }
        XCTAssertEqual(pieces.flatMap(\.frames), expected)
    }
}
