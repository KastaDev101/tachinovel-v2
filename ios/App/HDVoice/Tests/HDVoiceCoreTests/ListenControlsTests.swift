import XCTest
@testable import HDVoiceCore

final class ListenControlsTests: XCTestCase {
    func testVolumeGainAndLimiter() {
        XCTAssertEqual(VoiceVolume.gainDB(1), 0, accuracy: 0.0001)
        XCTAssertEqual(VoiceVolume.gainDB(1.5), 3.52, accuracy: 0.01, "150 % ≈ +3.5 dB")
        XCTAssertEqual(VoiceVolume.gainDB(0.5), -6.02, accuracy: 0.01)
        XCTAssertEqual(VoiceVolume.gainDB(0), VoiceVolume.silenceDB)
        XCTAssertEqual(VoiceVolume.gainDB(9), VoiceVolume.gainDB(1.5), "clamped to 150 %")
        XCTAssertEqual(VoiceVolume.gainDB(.nan), 0, accuracy: 0.0001, "bad input → default 100 %")
        XCTAssertFalse(VoiceVolume.limiterActive(1))
        XCTAssertFalse(VoiceVolume.limiterActive(0.4))
        XCTAssertTrue(VoiceVolume.limiterActive(1.05), "the limiter only works above 100 %")
        XCTAssertEqual(VoiceVolume.percent(1.234), 123)
    }

    func testSpeedGridRangeAndPresets() {
        XCTAssertEqual(SpeechSpeed.clamp(1.12), 1.1, accuracy: 1e-9)
        XCTAssertEqual(SpeechSpeed.clamp(1.13), 1.15, accuracy: 1e-9)
        XCTAssertEqual(SpeechSpeed.clamp(0.1), 0.5)
        XCTAssertEqual(SpeechSpeed.clamp(9), 2.5)
        XCTAssertEqual(SpeechSpeed.clamp(.infinity), 1)
        XCTAssertEqual(SpeechSpeed.preset(matching: 1.25), 1.25)
        XCTAssertEqual(SpeechSpeed.preset(matching: 1.26), 1.25, "snapped to the grid first")
        XCTAssertNil(SpeechSpeed.preset(matching: 1.35))
        XCTAssertTrue(SpeechSpeed.presets.allSatisfy { SpeechSpeed.clamp($0) == $0 }, "presets lie on the grid")
    }

    func testPreferencesKeepSpeedAndVolumeAndDecodeOlderSettings() throws {
        let fresh = VoicePreferences()
        XCTAssertEqual(fresh.speed, 1)
        XCTAssertEqual(fresh.volume, 1)
        XCTAssertTrue(fresh.kokoroEnabled, "Kokoro is the default voice on first launch")
        XCTAssertEqual(fresh.defaultVoice, VoiceCatalog.defaultVoiceId)
        let old = try JSONDecoder().decode(VoicePreferences.self, from: Data(#"{"defaultVoice":"bf_emma","kokoroEnabled":true}"#.utf8))
        XCTAssertEqual(old.speed, 1)
        XCTAssertEqual(old.volume, 1)
        let weird = try JSONDecoder().decode(VoicePreferences.self, from: Data(#"{"speed":7,"volume":-2}"#.utf8))
        XCTAssertEqual(weird.speed, 2.5)
        XCTAssertEqual(weird.volume, 0)
        var p = VoicePreferences()
        p.speed = 1.35
        p.volume = 1.4
        let back = try JSONDecoder().decode(VoicePreferences.self, from: JSONEncoder().encode(p))
        XCTAssertEqual(back.speed, 1.35, accuracy: 1e-9)
        XCTAssertEqual(back.volume, 1.4, accuracy: 1e-9)
    }
}
