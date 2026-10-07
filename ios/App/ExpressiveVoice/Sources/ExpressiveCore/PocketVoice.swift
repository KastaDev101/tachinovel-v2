//
//  PocketVoice.swift
//
//  The Narrator voice for Pocket TTS, shipped in the app: <app>/BuiltInVoices/pocket/narrator.pocketvoice +
//  narrator.json. The file is FluidAudio's cloned-voice format (`PocketTtsVoiceData.audioPrompt`): raw little-endian
//  float32 `[frames, 1024]`, the Mimi latents of the reference projected by `speaker_proj_weight`, at most 125 frames
//  (10 s). Made on the PC from the approved Narrator reference with tachinovel-narrator py/round8/pocket_voice.py;
//  tools/built-in-voices.ts checks it in CI with the same rules as here.
//
//  Checked like an imported voice: the manifest's size, shape and sha256 must match and every value must be finite.
//  A file that doesn't pass is never used (Pocket's load fails and Listen falls back to the next engine).
//

import CryptoKit
import Foundation

public struct PocketVoice: Sendable, Equatable {
    public static let embeddingDim = 1024
    public static let maxFrames = 125
    public static let folder = "pocket"
    public static let narratorName = "narrator"
    /// The same voice, performing: dialogue and thoughts (from the performed reference ref-8A2-persona).
    public static let characterName = "character"
    public static let fileExtension = "pocketvoice"

    public let name: String
    /// Row-major `[frames * embeddingDim]`.
    public let audioPrompt: [Float]
    public let frames: Int

    public enum Problem: Error, LocalizedError, Equatable {
        case missing(String)
        case manifest(String)
        case shape(String)
        case checksum
        case notFinite

        public var errorDescription: String? {
            switch self {
            case .missing(let what): return "The Narrator voice for Pocket TTS is missing (\(what))."
            case .manifest(let why): return "The Narrator voice for Pocket TTS has a bad manifest: \(why)."
            case .shape(let why): return "The Narrator voice for Pocket TTS has the wrong shape: \(why)."
            case .checksum: return "The Narrator voice for Pocket TTS doesn't match its checksum."
            case .notFinite: return "The Narrator voice for Pocket TTS contains invalid numbers."
            }
        }
    }

    /// The shipped Narrator voice in `<builtInVoices>/pocket/`.
    public static func narrator(builtInVoices: URL) throws -> PocketVoice {
        try load(builtInVoices: builtInVoices, name: narratorName)
    }

    /// A shipped voice: `<builtInVoices>/pocket/<name>.pocketvoice` + `<name>.json`.
    public static func load(builtInVoices: URL, name: String) throws -> PocketVoice {
        let dir = builtInVoices.appendingPathComponent(folder, isDirectory: true)
        guard let manifest = try? Data(contentsOf: dir.appendingPathComponent("\(name).json")) else { throw Problem.missing("\(name).json") }
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("\(name).\(fileExtension)")) else {
            throw Problem.missing("\(name).\(fileExtension)")
        }
        return try parse(manifest: manifest, data: data)
    }

    public static func parse(manifest: Data, data: Data) throws -> PocketVoice {
        guard let m = (try? JSONSerialization.jsonObject(with: manifest)) as? [String: Any] else { throw Problem.manifest("not JSON") }
        guard m["schemaVersion"] as? Int == 1 else { throw Problem.manifest("schemaVersion must be 1") }
        guard m["engine"] as? String == "pocket-tts" else { throw Problem.manifest("engine must be pocket-tts") }
        guard let frames = m["frames"] as? Int, let dim = m["embeddingDim"] as? Int, let bytes = m["bytes"] as? Int,
              let sha = m["sha256"] as? String else { throw Problem.manifest("frames, embeddingDim, bytes and sha256 are required") }
        guard dim == embeddingDim else { throw Problem.shape("embedding \(dim), expected \(embeddingDim)") }
        guard frames > 0, frames <= maxFrames else { throw Problem.shape("\(frames) frames (1…\(maxFrames))") }
        guard bytes == frames * dim * 4, data.count == bytes else { throw Problem.shape("\(data.count) bytes for \(frames) × \(dim) floats") }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == sha.lowercased() else { throw Problem.checksum }
        var floats = [Float](repeating: 0, count: frames * dim)
        data.withUnsafeBytes { raw in
            for i in floats.indices {
                floats[i] = Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: i * 4, as: UInt32.self)))
            }
        }
        guard floats.allSatisfy(\.isFinite) else { throw Problem.notFinite }
        return PocketVoice(name: m["name"] as? String ?? "Narrator", audioPrompt: floats, frames: frames)
    }
}
