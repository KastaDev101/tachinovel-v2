import ExpressiveCore
import Foundation
import XCTest

/// The Voice speed test's platform-free parts (NephisSpeedTest.swift).
final class NephisSpeedTestTests: XCTestCase {
    func testThePassageSplitsIntoSentencesTheWayListenCutsThem() {
        let s = NephisSpeedTest.sentences(NephisSpeedTest.passage)
        XCTAssertEqual(s.count, 9)
        XCTAssertEqual(s.map(\.paragraph), [0, 0, 0, 0, 1, 2, 2, 3, 3])
        XCTAssertTrue(s[1].text.hasPrefix("She held a paper cup"))
        // An ellipsis followed by a lower-case word goes on in the same sentence.
        XCTAssertTrue(s[6].text.hasPrefix("Then, tentatively"))
        XCTAssertTrue(s[6].text.hasSuffix("immediately grimaced."))
        // Closing quotes stay with their sentence.
        XCTAssertEqual(s[7].text, "\u{201C}Oh!")
        XCTAssertEqual(s[8].text, "Far too hot!\u{201D}")
        // About 45 s in her voice (her pace: 0.38 s a word, pauses on top).
        let words = NephisSpeedTest.passage.joined(separator: " ").split(separator: " ").count
        XCTAssertEqual(Double(words) * NephisFlow.secondsPerWord, 45, accuracy: 8)
    }

    func testACallTakesItsParagraphsSentencesUpToTheLimit() {
        let s = NephisSpeedTest.sentences(NephisSpeedTest.passage)
        // A fast start: one sentence alone (the limit is its own length).
        XCTAssertEqual(NephisSpeedTest.group(s, from: 0, limit: s[0].text.count), 0..<1)
        // Then the rest of the paragraph, never across it.
        XCTAssertEqual(NephisSpeedTest.group(s, from: 1, limit: 400), 1..<4)
        XCTAssertEqual(NephisSpeedTest.group(s, from: 4, limit: 400), 4..<5)
        XCTAssertEqual(NephisSpeedTest.group(s, from: 7, limit: 400), 7..<9)
        // A limit shorter than a sentence still takes that sentence.
        XCTAssertEqual(NephisSpeedTest.group(s, from: 1, limit: 10), 1..<2)
        XCTAssertEqual(NephisSpeedTest.group(s, from: 9, limit: 400), 9..<9)
        // The app's pause before a call: none first, a sentence's inside a paragraph, a paragraph's before one.
        XCTAssertNil(NephisSpeedTest.pauseBefore(s, at: 0))
        XCTAssertEqual(NephisSpeedTest.pauseBefore(s, at: 1), NephisSpeedTest.sentencePause)
        XCTAssertEqual(NephisSpeedTest.pauseBefore(s, at: 4), NephisSpeedTest.paragraphPause)
        // Her chain reads them as such (NephisFlow.paragraphPauseFrom).
        XCTAssertLessThan(NephisSpeedTest.sentencePause, NephisFlow.paragraphPauseFrom)
        XCTAssertGreaterThanOrEqual(NephisSpeedTest.paragraphPause, NephisFlow.paragraphPauseFrom)
    }

    func testPlaybackCountsABreakWhenACallIsLate() {
        // Ready at 2 s (3 s long), 4 s (5 s), 12 s (2 s): the third was due at 10 s, 2 s late.
        let p = NephisSpeedTest.playback(ready: [2, 4, 12], seconds: [3, 5, 2])
        XCTAssertEqual(p.firstAudio, 2)
        XCTAssertEqual(p.breaks, 1)
        XCTAssertEqual(p.lateCalls, [2])
        XCTAssertEqual(p.breakSeconds, 2, accuracy: 1e-9)
        XCTAssertFalse(p.keepsUp)
        XCTAssertEqual(p.end, 14, accuracy: 1e-9)
        let fine = NephisSpeedTest.playback(ready: [1, 3.9, 8], seconds: [3, 5, 2])
        XCTAssertTrue(fine.keepsUp)
        XCTAssertEqual(fine.end, 11, accuracy: 1e-9)
        XCTAssertNil(NephisSpeedTest.playback(ready: [], seconds: []).firstAudio)
    }

    func testAheadIsTheReadyAudioNotYetPlayed() {
        let ready: [Double] = [2, 4, 12], seconds: [Double] = [3, 5, 2]
        XCTAssertEqual(NephisSpeedTest.ahead(at: 1, ready: ready, seconds: seconds), 0)
        XCTAssertEqual(NephisSpeedTest.ahead(at: 2, ready: ready, seconds: seconds), 3, accuracy: 1e-9)
        XCTAssertEqual(NephisSpeedTest.ahead(at: 4, ready: ready, seconds: seconds), 6, accuracy: 1e-9)  // 1 s of the first + 5
        XCTAssertEqual(NephisSpeedTest.ahead(at: 11, ready: ready, seconds: seconds), 0)  // played out, waiting for the third
        XCTAssertEqual(NephisSpeedTest.ahead(at: 12.5, ready: ready, seconds: seconds), 1.5, accuracy: 1e-9)
    }

    func testFilesAreNamedByTheMinute() {
        let date = Date(timeIntervalSince1970: 1_792_063_800)  // 2026-10-15 11:30 UTC
        XCTAssertEqual(NephisSpeedTest.fileStem(date, timeZone: TimeZone(identifier: "UTC") ?? .current), "speedtest-2026-10-15-1130")
        XCTAssertEqual(NephisSpeedTest.fileStem(date, timeZone: TimeZone(identifier: "UTC") ?? .current, steady: true),
                       "speedtest-steady-2026-10-15-1130")
    }

    /// The steady-state run ("Start with 60 s buffered"): a minute already waiting plays first, so the calls count as far
    /// ahead (Listen's lead-ins and background priority) and the first call is only late once that minute has run out.
    func testAHeadStartPlaysFirst() {
        let ready: [Double] = [2, 4, 12], seconds: [Double] = [3, 5, 2]
        XCTAssertEqual(NephisSpeedTest.ahead(at: 0, ready: ready, seconds: seconds, banked: 60), 60, accuracy: 1e-9)
        XCTAssertEqual(NephisSpeedTest.ahead(at: 4, ready: ready, seconds: seconds, banked: 60), 56 + 8, accuracy: 1e-9)
        XCTAssertEqual(NephisSpeedTest.ahead(at: 61, ready: ready, seconds: seconds, banked: 60), 10 - 1, accuracy: 1e-9)
        XCTAssertEqual(NephisSpeedTest.ahead(at: 4, ready: ready, seconds: seconds, banked: 0),
                       NephisSpeedTest.ahead(at: 4, ready: ready, seconds: seconds), "no head start: as before")
        let fine = NephisSpeedTest.playback(ready: ready, seconds: seconds, banked: 60)
        XCTAssertTrue(fine.keepsUp)
        XCTAssertEqual(fine.end, 70, accuracy: 1e-9)
        let late = NephisSpeedTest.playback(ready: [70], seconds: [3], banked: 60)
        XCTAssertEqual(late.lateCalls, [0], "the first call isn't there when the minute runs out")
        XCTAssertEqual(late.breakSeconds, 10, accuracy: 1e-9)
    }

    func testTheWavHoldsTheExactFloatSamples() {
        let samples: [Float] = [0, 0.5, -0.25, 1.5]
        let wav = NephisSpeedTest.wavFloat32(samples, sampleRate: 44_100)
        XCTAssertEqual(wav.count, 58 + samples.count * 4)
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
        func u32(_ at: Int) -> UInt32 { wav.subdata(in: at..<(at + 4)).withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) } }
        func u16(_ at: Int) -> UInt16 { wav.subdata(in: at..<(at + 2)).withUnsafeBytes { UInt16(littleEndian: $0.loadUnaligned(as: UInt16.self)) } }
        XCTAssertEqual(u32(4), UInt32(wav.count - 8))
        XCTAssertEqual(u16(20), 3)  // IEEE float
        XCTAssertEqual(u32(24), 44_100)
        XCTAssertEqual(String(decoding: wav.subdata(in: 50..<54), as: UTF8.self), "data")
        XCTAssertEqual(u32(54), UInt32(samples.count * 4))
        XCTAssertEqual((0..<samples.count).map { Float(bitPattern: u32(58 + 4 * $0)) }, samples)
    }
}
