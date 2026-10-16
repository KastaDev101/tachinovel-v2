import HDVoiceCore
import XCTest

/// A flow call her mastering chain finished (NephisMaster, pack chain "master", 2026-10-13): natural delivery adds no
/// thump filter, EQ or soft limit on top, at either rate, and still cuts it into its sentences. A call without it is
/// finished exactly as before (StudioRateTests.testMimisStreamIsFinishedExactlyAsBefore).
final class MasteredFlowTests: XCTestCase {
    private func loud(seconds: Double, fs: Int) -> [Float] {
        let n = Int(seconds * Double(fs))
        return (0..<n).map { i in
            let t = Double(i) / Double(fs)
            return Float(0.5 * sin(2 * Double.pi * 150 * t) + 0.35 * sin(2 * Double.pi * 2500 * t + 1))
        }
    }

    func testAMasteredCallIsLeftAsItIs() {
        for fs in [NaturalFinish.mimiRate, 44_100] {
            // Loud enough for the soft limit, with sub-bass for the thump filter, and her EQ handed in: none may act.
            let x = loud(seconds: 0.8, fs: fs) + [Float](repeating: 0, count: fs * 3 / 10) + loud(seconds: 1.2, fs: fs)
            XCTAssertGreaterThan(PCM.peak(x), NaturalFinish.flowKnee)
            var finish = NaturalFinish(audio: DeliveryAudio(), studioSound: true, breaths: nil, sampleRate: fs, tilt: .nephis, plain: true)
            var unit = NaturalFinish.Unit(samples: x, lines: [12, 20].map { NaturalFinish.Line(params: nil, letters: $0, pause: 0.4) }, speed: 1,
                                          expressive: true)
            unit.flow = true
            unit.mastered = true
            let pieces = finish.render(unit)
            XCTAssertEqual(pieces.count, 2, "\(fs) Hz: still one buffer per sentence")
            XCTAssertEqual(pieces.flatMap(\.frames), x, "\(fs) Hz: sample for sample")
        }
    }

    func testMasteredIsOffByDefault() {
        let unit = NaturalFinish.Unit(samples: [0], lines: [], expressive: true)
        XCTAssertFalse(unit.mastered)
    }
}
