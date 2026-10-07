//
//  PocketVoiceTests.swift
//
//  The Narrator voice for Pocket TTS (PocketVoice.swift): the shipped file passes, and a tampered, mis-sized or
//  non-finite one never does.
//

import CryptoKit
import ExpressiveCore
import Foundation
import XCTest

final class PocketVoiceTests: XCTestCase {
    private func manifest(frames: Int, data: Data, sha: String? = nil, engine: String = "pocket-tts") -> Data {
        let digest = sha ?? SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let m: [String: Any] = ["schemaVersion": 1, "engine": engine, "name": "Narrator", "frames": frames, "embeddingDim": 1024,
                                "bytes": frames * 1024 * 4, "sha256": digest]
        return try! JSONSerialization.data(withJSONObject: m)
    }

    private func floats(_ values: [Float]) -> Data {
        values.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    func testParsesAndRejects() throws {
        let values = (0..<2048).map { Float(sin(Double($0))) * 0.1 }
        let data = floats(values)
        let voice = try PocketVoice.parse(manifest: manifest(frames: 2, data: data), data: data)
        XCTAssertEqual(voice.frames, 2)
        XCTAssertEqual(voice.audioPrompt, values)
        XCTAssertThrowsError(try PocketVoice.parse(manifest: manifest(frames: 2, data: data, sha: String(repeating: "0", count: 64)), data: data)) {
            XCTAssertEqual($0 as? PocketVoice.Problem, .checksum)
        }
        XCTAssertThrowsError(try PocketVoice.parse(manifest: manifest(frames: 3, data: data), data: data))
        XCTAssertThrowsError(try PocketVoice.parse(manifest: manifest(frames: 2, data: data, engine: "chatterbox-nano"), data: data))
        let big = floats([Float](repeating: 0, count: 126 * 1024))
        XCTAssertThrowsError(try PocketVoice.parse(manifest: manifest(frames: 126, data: big), data: big))
        var bad = values
        bad[7] = .nan
        let nan = floats(bad)
        XCTAssertThrowsError(try PocketVoice.parse(manifest: manifest(frames: 2, data: nan), data: nan)) {
            XCTAssertEqual($0 as? PocketVoice.Problem, .notFinite)
        }
    }

    func testShippedNarrator() throws {
        // ios/App/ExpressiveVoice/Tests/ExpressiveCoreTests → ios/App/App/BuiltInVoices
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("App/BuiltInVoices", isDirectory: true)
        let voice = try PocketVoice.narrator(builtInVoices: dir)
        XCTAssertEqual(voice.name, "Narrator")
        XCTAssertGreaterThan(voice.frames, 60, "at least ~5 s of the reference")
        XCTAssertLessThanOrEqual(voice.frames, PocketVoice.maxFrames)
        XCTAssertEqual(voice.audioPrompt.count, voice.frames * PocketVoice.embeddingDim)
    }
}
