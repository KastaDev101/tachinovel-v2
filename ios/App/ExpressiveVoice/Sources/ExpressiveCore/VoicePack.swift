//
//  VoicePack.swift — imported voices: ".tnvoice" files made on the PC (tachinovel-narrator
//  py/export_voice.py; format in docs/voice-import.md).
//
//  A .tnvoice file is UNTRUSTED data from outside the app. Nothing in it is ever executed; this file
//  checks everything before the app keeps it:
//   - size cap on the whole file and on every part, BEFORE anything is decompressed;
//   - ZIP: one disk, no ZIP64, no encryption, stored or deflate only, at most 136 entries, entries may not
//     overlap, every name must be exactly one of manifest.json / voice.safetensors / preview.m4a /
//     nonverbal|breaths/manifest.json, or a plain snippet file name inside nonverbal/ or breaths/ (no deeper
//     folders, no "..", no duplicates: nothing is ever extracted to a path taken from the file), CRC-32
//     and the exact uncompressed size checked;
//   - manifest.json: schema (format, version, engine, engine version, model weights, name, createdAt,
//     parts), every part listed with its size and SHA-256 and every listed part present;
//   - voice.safetensors: header parsed with bounds checks (length, JSON, offsets), exactly the tensor
//     names, dtypes and shapes the engine's precomputed voice has, tensors tiling the payload with no
//     gap, overlap or trailing bytes, finite floats, token ids inside the speech vocabulary;
//   - nonverbal/ and breaths/ (optional): VoiceSnippets.swift.
//  The engine spec is a table (VoicePackEngine.all): a Kokoro voice pack could be added the same way later.
//

import Compression
import CryptoKit
import Foundation

public enum VoicePackError: Error, LocalizedError, Equatable {
    case tooLarge(bytes: Int, limit: Int)
    case notAVoiceFile(String)
    case unsupportedZip(String)
    case unexpectedEntry(String)
    case duplicateEntry(String)
    case missingPart(String)
    case damaged(String)
    case manifest(String)
    case newerFormat(Int)
    case unknownEngine(String)
    case incompatible(String)
    case checksum(String)
    case conditioning(String)
    case unsafeID(String)
    case notFound(String)

    public var errorDescription: String? {
        switch self {
        case let .tooLarge(bytes, limit):
            return "This file is too big for a voice (\(bytes / 1024) KB; the limit is \(limit / 1024) KB)."
        case .notAVoiceFile(let why): return "This isn’t a TachiNovel voice file (\(why))."
        case .unsupportedZip(let why): return "This voice file can’t be read safely (\(why))."
        case .unexpectedEntry(let name): return "This voice file contains something unexpected (“\(VoicePack.printable(name))”)."
        case .duplicateEntry(let name): return "This voice file contains “\(VoicePack.printable(name))” twice."
        case .missingPart(let name): return "This voice file is incomplete (\(name) is missing)."
        case .damaged(let why): return "This voice file is damaged (\(why))."
        case .manifest(let why): return "This voice file’s description is invalid (\(why))."
        case .newerFormat(let version):
            return "This voice file was made by a newer export tool (format \(version)). Update TachiNovel to import it."
        case .unknownEngine(let engine): return "This voice is for “\(VoicePack.printable(engine))”, which TachiNovel can’t use."
        case .incompatible(let why): return "This voice doesn’t fit the expressive engine in this app (\(why))."
        case .checksum(let name): return "This voice file is damaged (\(name) doesn’t match its checksum)."
        case .conditioning(let why): return "The voice data is invalid (\(why))."
        case .unsafeID(let id): return "Unknown voice “\(VoicePack.printable(id))”."
        case .notFound(let id): return "The voice “\(VoicePack.printable(id))” isn’t on this iPhone any more."
        }
    }
}

/// File names, limits and the format version of a .tnvoice file.
public enum VoicePackFormat {
    public static let fileExtension = "tnvoice"
    /// Exported type identifier (Info.plist UTExportedTypeDeclarations).
    public static let typeIdentifier = "app.tachinovel.voice"
    public static let format = "tachinovel-voice"
    public static let formatVersion = 1

    public static let manifestName = "manifest.json"
    public static let conditioningName = "voice.safetensors"
    public static let previewName = "preview.m4a"

    public static let maxFileBytes = 16 * 1_048_576
    public static let maxManifestBytes = 64 * 1024
    public static let maxConditioningBytes = 2 * 1_048_576
    public static let maxPreviewBytes = 3 * 1_048_576
    /// manifest, voice, preview, two folder manifests and 2 × 64 snippets, with a little room.
    public static let maxEntries = 136
    public static let maxSafetensorsHeaderBytes = 64 * 1024
    public static let maxNameCharacters = 40

    // Optional nonverbal/ and breaths/ folders (VoiceSnippets.swift).
    public static let maxSnippetsPerFolder = 64
    public static let maxSnippetSeconds = 2.5
    /// All snippet audio of a pack together (uncompressed).
    public static let maxSnippetBytesTotal = 8 * 1_048_576
    /// One snippet file: 2.5 s of 48 kHz 24-bit mono is 360 KB.
    public static let maxSnippetFileBytes = 512 * 1024
    public static let snippetSampleRates = 16_000...48_000
    public static let snippetBits: Set<Int> = [16, 24]

    /// The only top-level names (and folder manifests) a .tnvoice may contain, with each one's size cap and
    /// manifest role. Snippet audio has its own rule (snippetEntry).
    static let allowedEntries: [String: (limit: Int, role: String?)] = [
        manifestName: (maxManifestBytes, nil),
        conditioningName: (maxConditioningBytes, "conditioning"),
        previewName: (maxPreviewBytes, "preview"),
        "nonverbal/manifest.json": (maxManifestBytes, "nonverbal"),
        "breaths/manifest.json": (maxManifestBytes, "breaths"),
    ]

    /// "nonverbal/chuckle-01.wav" → (.nonverbal, "chuckle-01.wav"): a snippet's folder and bare file name, or nil
    /// for any other name (no deeper paths, no "..", only .wav/.caf).
    static func snippetEntry(_ name: String) -> (kind: SnippetKind, file: String)? {
        let parts = name.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, let kind = SnippetKind(rawValue: String(parts[0])) else { return nil }
        let file = String(parts[1])
        return VoiceSnippets.isSnippetFileName(file) ? (kind, file) : nil
    }
}

public enum TensorDType: String, Sendable, Equatable {
    case f16 = "F16"
    case f32 = "F32"
    case i32 = "I32"

    public var size: Int {
        switch self {
        case .f16: return 2
        case .f32, .i32: return 4
        }
    }
}

public struct TensorSpec: Sendable, Equatable {
    public let name: String
    public let dtype: TensorDType
    public let shape: [Int]
    /// Allowed values of an integer tensor (token ids), `lower..<upper`.
    public let intRange: Range<Int32>?

    public init(_ name: String, _ dtype: TensorDType, _ shape: [Int], intRange: Range<Int32>? = nil) {
        self.name = name
        self.dtype = dtype
        self.shape = shape
        self.intRange = intRange
    }

    public var byteCount: Int { shape.reduce(dtype.size, *) }
}

/// One kind of importable voice: which engine reads it and exactly what its data must look like.
public struct VoicePackEngine: Sendable, Equatable {
    /// manifest "engine"
    public let id: String
    public let title: String
    /// manifest "engineVersion": the layout of the voice data this app understands.
    public let engineVersion: Int
    /// manifest "model.weights": the checkpoint the voice was computed with (the app runs exactly these).
    public let weights: String
    /// The tensors of voice.safetensors, in no particular order.
    public let tensors: [TensorSpec]

    /// Chatterbox Nano (FluidAudio 0.17.5, FluidInference/chatterbox-nano-coreml): the same tensors as its
    /// built-in `tables/voice-default.safetensors` (mobius export-tables-nano.py): T3 conditioning (1 speaker
    /// row + 375 prompt-token rows) × 768, the S3Gen reference (250 speech tokens at 25 Hz, 500 mel frames ×
    /// 80) and the CAMPPlus x-vector. Same shapes as the built-in voice, so the per-call text and audio
    /// budgets (135 BPE tokens, ≈ 9.9 s) stay the same.
    public static let chatterboxNano = VoicePackEngine(
        id: "chatterbox-nano",
        title: "Chatterbox Nano",
        engineVersion: 1,
        weights: "t3_nano_v1+s3gen_meanflow",
        tensors: [
            TensorSpec("t3_cond_emb", .f16, [1, 376, 768]),
            TensorSpec("prompt_token", .i32, [1, 250], intRange: 0..<6561),
            TensorSpec("prompt_feat", .f16, [1, 500, 80]),
            TensorSpec("embedding", .f16, [1, 192]),
        ]
    )

    /// Every kind of voice the app imports. A Kokoro voice pack would be one more entry here (plus the place
    /// its engine reads it from); nothing else in the import path is engine-specific.
    public static let all: [VoicePackEngine] = [.chatterboxNano]

    public static func find(_ id: String) -> VoicePackEngine? { all.first { $0.id == id } }

    /// Size of a voice.safetensors payload (without the header).
    public var payloadBytes: Int { tensors.reduce(0) { $0 + $1.byteCount } }
}

public struct VoicePackManifest: Sendable, Equatable {
    public let engine: VoicePackEngine
    /// Display name, cleaned (VoicePack.cleanName).
    public let name: String
    public let createdAt: String
    /// The Core ML conversion the PC tool made it for (informative; "repo@revision").
    public let madeFor: String?
}

public struct VoicePackContents: Sendable {
    public let manifest: VoicePackManifest
    public let conditioning: Data
    public let preview: Data?
    /// Lowercase hex SHA-256 of `conditioning`.
    public let conditioningSHA256: String
    /// Decoded nonverbal sounds and breaths (empty when the pack has none).
    public let extras: VoiceExtras
    /// The checked nonverbal/ and breaths/ files as they were in the pack ("nonverbal/manifest.json",
    /// "nonverbal/chuckle-01.wav", …), for the store to keep.
    public let extraFiles: [String: Data]
}

public enum VoicePack {
    /// Read and check a .tnvoice file (never more than `maxFileBytes` are read).
    public static func read(fileAt url: URL) throws -> VoicePackContents {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        if values?.isRegularFile == false { throw VoicePackError.notAVoiceFile("not a file") }
        if let size = values?.fileSize, size > VoicePackFormat.maxFileBytes {
            throw VoicePackError.tooLarge(bytes: size, limit: VoicePackFormat.maxFileBytes)
        }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return try read(data)
    }

    /// Check a whole .tnvoice file in memory and return its parts.
    public static func read(_ data: Data) throws -> VoicePackContents {
        guard data.count <= VoicePackFormat.maxFileBytes else {
            throw VoicePackError.tooLarge(bytes: data.count, limit: VoicePackFormat.maxFileBytes)
        }
        let bytes = [UInt8](data)
        let entries = try TinyZip.entries(bytes)
        // Snippet audio: the declared sizes together under the cap before anything is decompressed.
        let snippetBytes = entries.reduce(0) { VoicePackFormat.snippetEntry($1.name) == nil ? $0 : $0 + $1.uncompressedSize }
        guard snippetBytes <= VoicePackFormat.maxSnippetBytesTotal else {
            throw VoicePackError.tooLarge(bytes: snippetBytes, limit: VoicePackFormat.maxSnippetBytesTotal)
        }
        var parts: [String: [UInt8]] = [:]
        var snippets: [SnippetKind: [String: [UInt8]]] = [:]
        for entry in entries {
            if let s = VoicePackFormat.snippetEntry(entry.name) {
                guard snippets[s.kind]?[s.file] == nil else { throw VoicePackError.duplicateEntry(entry.name) }
                snippets[s.kind, default: [:]][s.file] = try TinyZip.extract(entry, from: bytes, limit: VoicePackFormat.maxSnippetFileBytes)
                continue
            }
            guard let allowed = VoicePackFormat.allowedEntries[entry.name] else { throw VoicePackError.unexpectedEntry(entry.name) }
            guard parts[entry.name] == nil else { throw VoicePackError.duplicateEntry(entry.name) }
            parts[entry.name] = try TinyZip.extract(entry, from: bytes, limit: allowed.limit)
        }
        guard let manifestBytes = parts[VoicePackFormat.manifestName] else { throw VoicePackError.missingPart(VoicePackFormat.manifestName) }
        let parsed = try parseManifest(manifestBytes)
        // Every part in the file is described by the manifest and vice versa, with a matching size and hash.
        let inFile = Set(parts.keys).subtracting([VoicePackFormat.manifestName])
        let listed = Set(parsed.parts.map(\.path))
        if let extra = inFile.subtracting(listed).sorted().first { throw VoicePackError.manifest("\(extra) is not listed") }
        if let missing = listed.subtracting(inFile).sorted().first { throw VoicePackError.missingPart(missing) }
        for part in parsed.parts {
            guard let body = parts[part.path] else { throw VoicePackError.missingPart(part.path) }
            guard body.count == part.bytes else { throw VoicePackError.damaged("\(part.path) has the wrong size") }
            guard sha256Hex(body) == part.sha256 else { throw VoicePackError.checksum(part.path) }
        }
        guard let conditioning = parts[VoicePackFormat.conditioningName] else { throw VoicePackError.missingPart(VoicePackFormat.conditioningName) }
        try validateConditioning(conditioning, engine: parsed.manifest.engine)
        let preview = parts[VoicePackFormat.previewName]
        if let preview { try checkPreview(preview) }
        // nonverbal/ and breaths/: each folder's manifest is a listed part (hashed above) and lists every file in it.
        var decoded: [SnippetKind: [VoiceSnippet]] = [:]
        var extraFiles: [String: Data] = [:]
        for kind in SnippetKind.allCases {
            let manifestPath = kind.manifestPath
            let files = snippets[kind] ?? [:]
            guard let folderManifest = parts[manifestPath] else {
                if let stray = files.keys.sorted().first { throw VoicePackError.manifest("\(kind.rawValue)/\(stray) is not listed") }
                continue
            }
            decoded[kind] = try VoiceSnippets.read(kind, manifest: folderManifest, files: files)
            extraFiles[manifestPath] = Data(folderManifest)
            for (file, body) in files { extraFiles["\(kind.rawValue)/\(file)"] = Data(body) }
        }
        return VoicePackContents(manifest: parsed.manifest, conditioning: Data(conditioning), preview: preview.map { Data($0) },
                                 conditioningSHA256: sha256Hex(conditioning),
                                 extras: VoiceExtras(nonverbal: decoded[.nonverbal] ?? [], breaths: decoded[.breaths] ?? []),
                                 extraFiles: extraFiles)
    }

    // MARK: - Manifest

    struct Part: Equatable {
        let path: String
        let bytes: Int
        let sha256: String
    }

    static func parseManifest(_ bytes: [UInt8]) throws -> (manifest: VoicePackManifest, parts: [Part]) {
        let json: Any
        do {
            json = try JSONSerialization.jsonObject(with: Data(bytes), options: [])
        } catch {
            throw VoicePackError.manifest("not JSON")
        }
        guard let root = json as? [String: Any] else { throw VoicePackError.manifest("not a JSON object") }
        guard root["format"] as? String == VoicePackFormat.format else { throw VoicePackError.notAVoiceFile("format is not “\(VoicePackFormat.format)”") }
        guard let version = JSONNumbers.int(root["formatVersion"]) else { throw VoicePackError.manifest("formatVersion is missing") }
        if version > VoicePackFormat.formatVersion { throw VoicePackError.newerFormat(version) }
        guard version == VoicePackFormat.formatVersion else { throw VoicePackError.manifest("formatVersion \(version) is not supported") }
        guard let engineID = root["engine"] as? String, !engineID.isEmpty else { throw VoicePackError.manifest("engine is missing") }
        guard let engine = VoicePackEngine.find(engineID) else { throw VoicePackError.unknownEngine(String(engineID.prefix(40))) }
        guard let engineVersion = JSONNumbers.int(root["engineVersion"]) else { throw VoicePackError.manifest("engineVersion is missing") }
        guard engineVersion == engine.engineVersion else {
            throw VoicePackError.incompatible("made for \(engine.title) voice format \(engineVersion); this app reads format \(engine.engineVersion)")
        }
        guard let model = root["model"] as? [String: Any], let weights = model["weights"] as? String else {
            throw VoicePackError.manifest("model.weights is missing")
        }
        guard weights == engine.weights else {
            throw VoicePackError.incompatible("made with the model weights “\(printable(String(weights.prefix(60))))”; this app runs “\(engine.weights)”")
        }
        guard let rawName = root["name"] as? String else { throw VoicePackError.manifest("name is missing") }
        guard rawName.count <= 200 else { throw VoicePackError.manifest("name is too long") }
        guard let createdAt = root["createdAt"] as? String, createdAt.count <= 40, parseDate(createdAt) != nil else {
            throw VoicePackError.manifest("createdAt is not a date")
        }
        guard let list = root["parts"] as? [Any], (1...4).contains(list.count) else { throw VoicePackError.manifest("parts must list 1 to 4 files") }
        var parts: [Part] = []
        for item in list {
            guard let o = item as? [String: Any], let path = o["path"] as? String else { throw VoicePackError.manifest("a part has no path") }
            guard let allowed = VoicePackFormat.allowedEntries[path], let role = allowed.role else { throw VoicePackError.unexpectedEntry(path) }
            guard o["role"] as? String == role else { throw VoicePackError.manifest("\(path) must have the role “\(role)”") }
            guard let size = JSONNumbers.int(o["bytes"]), size >= 0, size <= allowed.limit else { throw VoicePackError.manifest("\(path) has no valid size") }
            guard let sha = o["sha256"] as? String, isHex64(sha) else { throw VoicePackError.manifest("\(path) has no valid sha256") }
            guard !parts.contains(where: { $0.path == path }) else { throw VoicePackError.duplicateEntry(path) }
            parts.append(Part(path: path, bytes: size, sha256: sha))
        }
        guard parts.contains(where: { $0.path == VoicePackFormat.conditioningName }) else { throw VoicePackError.missingPart(VoicePackFormat.conditioningName) }
        let madeFor = (model["coreml"] as? String).map { String($0.prefix(120)) }
        let manifest = VoicePackManifest(engine: engine, name: cleanName(rawName), createdAt: createdAt, madeFor: madeFor)
        return (manifest, parts)
    }

    static func isHex64(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    static func parseDate(_ text: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    /// A display name: no control characters, single spaces, at most 40 characters, never empty.
    public static func cleanName(_ raw: String) -> String {
        let scalars = raw.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : Character($0) }
        let collapsed = String(scalars).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let cut = String(collapsed.prefix(VoicePackFormat.maxNameCharacters)).trimmingCharacters(in: .whitespaces)
        return cut.isEmpty ? "Imported voice" : cut
    }

    /// For error messages: no control characters, at most 60 characters.
    static func printable(_ raw: String) -> String {
        let cleaned = String(raw.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? "?" : Character($0) })
        return cleaned.count > 60 ? String(cleaned.prefix(60)) + "…" : cleaned
    }

    // MARK: - voice.safetensors

    /// The conditioning tensors are exactly what `engine` expects (names, dtypes, shapes, layout, values).
    public static func validateConditioning(_ data: Data, engine: VoicePackEngine) throws {
        try validateConditioning([UInt8](data), engine: engine)
    }

    static func validateConditioning(_ bytes: [UInt8], engine: VoicePackEngine) throws {
        guard bytes.count <= VoicePackFormat.maxConditioningBytes else {
            throw VoicePackError.tooLarge(bytes: bytes.count, limit: VoicePackFormat.maxConditioningBytes)
        }
        let header = try SafetensorsHeader.parse(bytes, maxHeaderBytes: VoicePackFormat.maxSafetensorsHeaderBytes)
        let names = Set(header.tensors.map(\.name))
        let expected = Set(engine.tensors.map(\.name))
        if let extra = names.subtracting(expected).sorted().first { throw VoicePackError.conditioning("unexpected tensor “\(printable(extra))”") }
        if let missing = expected.subtracting(names).sorted().first { throw VoicePackError.conditioning("tensor “\(missing)” is missing") }
        guard header.tensors.count == engine.tensors.count else { throw VoicePackError.conditioning("duplicate tensors") }
        for spec in engine.tensors {
            guard let t = header.tensors.first(where: { $0.name == spec.name }) else { throw VoicePackError.conditioning("tensor “\(spec.name)” is missing") }
            guard t.dtype == spec.dtype.rawValue else { throw VoicePackError.conditioning("\(spec.name) is \(printable(t.dtype)), expected \(spec.dtype.rawValue)") }
            guard t.shape == spec.shape else {
                throw VoicePackError.conditioning("\(spec.name) has shape \(t.shape.map(String.init).joined(separator: "×")), expected \(spec.shape.map(String.init).joined(separator: "×"))")
            }
            guard t.end - t.begin == spec.byteCount else { throw VoicePackError.conditioning("\(spec.name) has the wrong byte length") }
            let start = header.payloadStart + t.begin
            try checkValues(bytes, range: start..<(start + spec.byteCount), spec: spec)
        }
    }

    static func checkValues(_ bytes: [UInt8], range: Range<Int>, spec: TensorSpec) throws {
        switch spec.dtype {
        case .f16:
            var i = range.lowerBound
            while i < range.upperBound {
                let bits = UInt16(bytes[i]) | UInt16(bytes[i + 1]) << 8
                if bits & 0x7C00 == 0x7C00 { throw VoicePackError.conditioning("\(spec.name) contains NaN or infinity") }
                i += 2
            }
        case .f32:
            var i = range.lowerBound
            while i < range.upperBound {
                let bits = UInt32(bytes[i]) | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2]) << 16 | UInt32(bytes[i + 3]) << 24
                if bits & 0x7F80_0000 == 0x7F80_0000 { throw VoicePackError.conditioning("\(spec.name) contains NaN or infinity") }
                i += 4
            }
        case .i32:
            guard let allowed = spec.intRange else { return }
            var i = range.lowerBound
            while i < range.upperBound {
                let raw = UInt32(bytes[i]) | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2]) << 16 | UInt32(bytes[i + 3]) << 24
                let value = Int32(bitPattern: raw)
                if !allowed.contains(value) { throw VoicePackError.conditioning("\(spec.name) has an id outside \(allowed.lowerBound)..<\(allowed.upperBound)") }
                i += 4
            }
        }
    }

    /// A preview must at least look like an MPEG-4 audio file ("ftyp" box); AVAudioPlayer decodes the rest.
    static func checkPreview(_ bytes: [UInt8]) throws {
        guard bytes.count >= 12, bytes[4] == 0x66, bytes[5] == 0x74, bytes[6] == 0x79, bytes[7] == 0x70 else {
            throw VoicePackError.damaged("preview.m4a is not an M4A file")
        }
    }

    public static func sha256Hex(_ bytes: [UInt8]) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// Integers from JSONSerialization: whole numbers only, never booleans.
enum JSONNumbers {
    static func int(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d == d.rounded(), abs(d) <= 9_007_199_254_740_991 else { return nil }
        return Int(d)
    }

    /// A finite JSON number (never a boolean).
    static func double(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }
}

// MARK: - safetensors header

public struct SafetensorsTensor: Sendable, Equatable {
    public let name: String
    public let dtype: String
    public let shape: [Int]
    /// Byte range inside the payload (after the header).
    public let begin: Int
    public let end: Int
}

public enum SafetensorsHeader {
    /// Parse the header of a safetensors file with bounds checks: an 8-byte little-endian length, a JSON
    /// object of tensors (plus an optional "__metadata__" of strings), offsets inside the payload, byte
    /// lengths that match dtype × shape (overflow-checked), and tensors that tile the whole payload.
    public static func parse(_ bytes: [UInt8], maxHeaderBytes: Int) throws -> (tensors: [SafetensorsTensor], payloadStart: Int) {
        guard bytes.count >= 8 else { throw VoicePackError.conditioning("truncated header") }
        var length: UInt64 = 0
        for i in 0..<8 { length |= UInt64(bytes[i]) << (8 * UInt64(i)) }
        guard length >= 2, length <= UInt64(maxHeaderBytes), length <= UInt64(bytes.count - 8) else {
            throw VoicePackError.conditioning("bad header length")
        }
        let headerEnd = 8 + Int(length)
        let json: Any
        do {
            json = try JSONSerialization.jsonObject(with: Data(bytes[8..<headerEnd]), options: [])
        } catch {
            throw VoicePackError.conditioning("header is not JSON")
        }
        guard let object = json as? [String: Any] else { throw VoicePackError.conditioning("header is not a JSON object") }
        let payload = bytes.count - headerEnd
        var tensors: [SafetensorsTensor] = []
        for (name, value) in object {
            if name == "__metadata__" {
                guard let meta = value as? [String: Any], meta.values.allSatisfy({ $0 is String }) else {
                    throw VoicePackError.conditioning("bad metadata")
                }
                continue
            }
            guard name.utf8.count <= 128 else { throw VoicePackError.conditioning("tensor name too long") }
            guard let entry = value as? [String: Any], let dtype = entry["dtype"] as? String,
                  let rawShape = entry["shape"] as? [Any], rawShape.count <= 8,
                  let rawOffsets = entry["data_offsets"] as? [Any], rawOffsets.count == 2 else {
                throw VoicePackError.conditioning("bad entry “\(VoicePack.printable(name))”")
            }
            let shape = rawShape.compactMap { JSONNumbers.int($0) }
            let offsets = rawOffsets.compactMap { JSONNumbers.int($0) }
            guard shape.count == rawShape.count, shape.allSatisfy({ $0 >= 0 }), offsets.count == 2 else {
                throw VoicePackError.conditioning("bad entry “\(VoicePack.printable(name))”")
            }
            let begin = offsets[0]
            let end = offsets[1]
            guard begin >= 0, begin <= end, end <= payload else { throw VoicePackError.conditioning("\(VoicePack.printable(name)) points outside the file") }
            let elementSize: Int
            switch dtype {
            case "F16", "BF16", "I16", "U16": elementSize = 2
            case "F32", "I32", "U32": elementSize = 4
            case "F64", "I64", "U64": elementSize = 8
            case "U8", "I8", "BOOL", "F8_E4M3", "F8_E5M2": elementSize = 1
            default: throw VoicePackError.conditioning("unknown dtype in “\(VoicePack.printable(name))”")
            }
            var count = elementSize
            for dim in shape {
                let (product, overflow) = count.multipliedReportingOverflow(by: dim)
                guard !overflow, product <= payload else { throw VoicePackError.conditioning("\(VoicePack.printable(name)) is too large") }
                count = product
            }
            guard end - begin == count else { throw VoicePackError.conditioning("\(VoicePack.printable(name)) has the wrong byte length") }
            tensors.append(SafetensorsTensor(name: name, dtype: dtype, shape: shape, begin: begin, end: end))
        }
        // The tensors must cover the payload exactly: no gaps, no overlaps, no trailing bytes.
        var cursor = 0
        for t in tensors.sorted(by: { ($0.begin, $0.end) < ($1.begin, $1.end) }) {
            guard t.begin == cursor else { throw VoicePackError.conditioning(t.begin < cursor ? "tensors overlap" : "gap between tensors") }
            cursor = t.end
        }
        guard cursor == payload else { throw VoicePackError.conditioning("unexpected bytes after the tensors") }
        return (tensors.sorted { $0.begin < $1.begin }, headerEnd)
    }
}

// MARK: - ZIP (read-only, just enough for .tnvoice)

struct ZipEntry: Equatable {
    let name: String
    let flags: Int
    let method: Int
    let crc32: UInt32
    let compressedSize: Int
    let uncompressedSize: Int
    let localHeaderOffset: Int
    /// Where the entry's (compressed) bytes start, checked against the local header and the directory.
    var dataOffset: Int = 0
}

enum TinyZip {
    private static func u16(_ b: [UInt8], _ o: Int) throws -> Int {
        guard o >= 0, o + 2 <= b.count else { throw VoicePackError.damaged("truncated ZIP") }
        return Int(b[o]) | Int(b[o + 1]) << 8
    }

    private static func u32(_ b: [UInt8], _ o: Int) throws -> Int {
        guard o >= 0, o + 4 <= b.count else { throw VoicePackError.damaged("truncated ZIP") }
        return Int(b[o]) | Int(b[o + 1]) << 8 | Int(b[o + 2]) << 16 | Int(b[o + 3]) << 24
    }

    /// The central directory, checked: one disk, no ZIP64, entries inside the file, at most maxEntries.
    static func entries(_ b: [UInt8]) throws -> [ZipEntry] {
        guard b.count >= 22 else { throw VoicePackError.notAVoiceFile("not a ZIP file") }
        // The end-of-central-directory record is in the last 22 + 65535 bytes.
        var eocd = -1
        var i = b.count - 22
        let lowest = max(0, b.count - 22 - 0xFFFF)
        while i >= lowest {
            if b[i] == 0x50, b[i + 1] == 0x4B, b[i + 2] == 0x05, b[i + 3] == 0x06 {
                eocd = i
                break
            }
            i -= 1
        }
        guard eocd >= 0 else { throw VoicePackError.notAVoiceFile("not a ZIP file") }
        let disk = try u16(b, eocd + 4)
        let cdDisk = try u16(b, eocd + 6)
        let onDisk = try u16(b, eocd + 8)
        let total = try u16(b, eocd + 10)
        let cdSize = try u32(b, eocd + 12)
        let cdOffset = try u32(b, eocd + 16)
        let commentLength = try u16(b, eocd + 20)
        guard eocd + 22 + commentLength == b.count else { throw VoicePackError.damaged("unexpected bytes at the end") }
        guard total != 0xFFFF, cdSize != 0xFFFF_FFFF, cdOffset != 0xFFFF_FFFF else { throw VoicePackError.unsupportedZip("ZIP64") }
        guard disk == 0, cdDisk == 0, onDisk == total else { throw VoicePackError.unsupportedZip("split archive") }
        guard total >= 1 else { throw VoicePackError.notAVoiceFile("empty ZIP file") }
        guard total <= VoicePackFormat.maxEntries else { throw VoicePackError.unsupportedZip("\(total) entries") }
        guard cdOffset + cdSize <= eocd else { throw VoicePackError.damaged("bad central directory") }

        var out: [ZipEntry] = []
        var p = cdOffset
        for _ in 0..<total {
            guard try u32(b, p) == 0x0201_4B50 else { throw VoicePackError.damaged("bad central directory") }
            let flags = try u16(b, p + 8)
            let method = try u16(b, p + 10)
            let crc = UInt32(try u32(b, p + 16))
            let compressed = try u32(b, p + 20)
            let uncompressed = try u32(b, p + 24)
            let nameLength = try u16(b, p + 28)
            let extraLength = try u16(b, p + 30)
            let commentLen = try u16(b, p + 32)
            let entryDisk = try u16(b, p + 34)
            let local = try u32(b, p + 42)
            let nameStart = p + 46
            let next = nameStart + nameLength + extraLength + commentLen
            guard next <= cdOffset + cdSize else { throw VoicePackError.damaged("bad central directory") }
            guard entryDisk == 0 else { throw VoicePackError.unsupportedZip("split archive") }
            guard compressed != 0xFFFF_FFFF, uncompressed != 0xFFFF_FFFF, local != 0xFFFF_FFFF else { throw VoicePackError.unsupportedZip("ZIP64") }
            guard nameLength > 0, nameLength <= 255, let name = String(bytes: b[nameStart..<(nameStart + nameLength)], encoding: .utf8) else {
                throw VoicePackError.damaged("bad file name")
            }
            out.append(ZipEntry(name: name, flags: flags, method: method, crc32: crc, compressedSize: compressed,
                                uncompressedSize: uncompressed, localHeaderOffset: local))
            p = next
        }
        guard p == cdOffset + cdSize else { throw VoicePackError.damaged("bad central directory") }
        // Entries may not share bytes (overlapping entries are a zip-bomb trick) and must sit before the directory.
        var ranges: [Range<Int>] = []
        for i in out.indices {
            let start = try dataStart(out[i], b, directoryOffset: cdOffset)
            out[i].dataOffset = start
            ranges.append(out[i].localHeaderOffset..<(start + out[i].compressedSize))
        }
        ranges.sort { $0.lowerBound < $1.lowerBound }
        for (a, c) in zip(ranges, ranges.dropFirst()) where a.upperBound > c.lowerBound {
            throw VoicePackError.unsupportedZip("overlapping entries")
        }
        return out
    }

    /// Offset of an entry's data, after checking its local header against the central directory.
    private static func dataStart(_ e: ZipEntry, _ b: [UInt8], directoryOffset: Int) throws -> Int {
        let h = e.localHeaderOffset
        guard h + 30 <= directoryOffset, try u32(b, h) == 0x0403_4B50 else { throw VoicePackError.damaged("bad local header") }
        let nameLength = try u16(b, h + 26)
        let extraLength = try u16(b, h + 28)
        let start = h + 30 + nameLength + extraLength
        guard nameLength == e.name.utf8.count, start <= directoryOffset, Array(b[(h + 30)..<(h + 30 + nameLength)]) == Array(e.name.utf8) else {
            throw VoicePackError.damaged("local header doesn’t match the directory")
        }
        guard start + e.compressedSize <= directoryOffset else { throw VoicePackError.damaged("entry runs past the directory") }
        return start
    }

    /// The entry's bytes: size cap checked before decompressing; exact size and CRC-32 checked after.
    static func extract(_ e: ZipEntry, from b: [UInt8], limit: Int) throws -> [UInt8] {
        guard e.flags & 0x41 == 0 else { throw VoicePackError.unsupportedZip("encrypted") }
        guard e.uncompressedSize <= limit else { throw VoicePackError.tooLarge(bytes: e.uncompressedSize, limit: limit) }
        // Entries come from entries(), which checked dataOffset against the local header and the directory.
        let start = e.dataOffset
        guard start > 0, start <= b.count, e.compressedSize <= b.count - start else { throw VoicePackError.damaged("entry outside the file") }
        let raw = b[start..<(start + e.compressedSize)]
        let out: [UInt8]
        switch e.method {
        case 0:
            guard e.compressedSize == e.uncompressedSize else { throw VoicePackError.damaged("stored entry with two sizes") }
            out = Array(raw)
        case 8:
            out = try inflate(raw, expected: e.uncompressedSize)
        default:
            throw VoicePackError.unsupportedZip("compression method \(e.method)")
        }
        guard CRC32.checksum(out) == e.crc32 else { throw VoicePackError.damaged("\(VoicePack.printable(e.name)) fails its CRC check") }
        return out
    }

    /// Raw DEFLATE (RFC 1951; Apple's COMPRESSION_ZLIB) into a buffer one byte larger than expected, so
    /// output longer than declared is detected instead of truncated.
    static func inflate(_ src: ArraySlice<UInt8>, expected: Int) throws -> [UInt8] {
        guard !src.isEmpty else { throw VoicePackError.damaged("empty compressed entry") }
        var dst = [UInt8](repeating: 0, count: expected + 1)
        let produced = src.withUnsafeBufferPointer { s -> Int in
            dst.withUnsafeMutableBufferPointer { d -> Int in
                guard let sBase = s.baseAddress, let dBase = d.baseAddress else { return -1 }
                return compression_decode_buffer(dBase, d.count, sBase, s.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard produced == expected else { throw VoicePackError.damaged("compressed data doesn’t match its size") }
        dst.removeLast()
        return dst
    }
}

enum CRC32 {
    static let table: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func checksum(_ bytes: [UInt8]) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        for byte in bytes { c = table[Int((c ^ UInt32(byte)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFF_FFFF
    }
}
