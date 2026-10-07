import HDVoiceCore
import XCTest

final class SystemMessageSoundTests: XCTestCase {
    func testChimeThenTonedVoiceAtTheSameLoudness() {
        let fs = 24_000
        let voice = (0..<fs).map { i -> Float in Float(sin(2 * Double.pi * 150 * Double(i) / Double(fs)) + 0.5 * sin(2 * Double.pi * 2500 * Double(i) / Double(fs))) * 0.2 }
        let out = SystemMessageSound.apply(voice, sampleRate: fs, chime: true, tone: true)
        let lead = Int((0.42 + SystemMessageSound.chimeGap) * Double(fs))
        XCTAssertEqual(out.count, voice.count + lead)
        XCTAssertGreaterThan(out[..<Int(0.2 * Double(fs))].map(abs).max() ?? 0, 0.01, "the chime is there")
        let rms = { (x: ArraySlice<Float>) in (x.reduce(0) { $0 + $1 * $1 } / Float(x.count)).squareRoot() }
        XCTAssertEqual(rms(out[lead...]), rms(voice[...]), accuracy: 0.01, "same loudness")
        XCTAssertEqual(SystemMessageSound.apply(voice, sampleRate: fs, chime: false, tone: false), voice)
    }
}
