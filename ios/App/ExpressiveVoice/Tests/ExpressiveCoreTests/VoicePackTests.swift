//
//  VoicePackTests.swift — .tnvoice validation (VoicePack.swift): a good file, every reject path, truncated
//  and fuzzed files and headers; the imported-voice store and the Chatterbox voice slot (ImportedVoices.swift).
//  Public API only (the expressive-bench workflow runs these tests in a release build).
//  The tensors here are synthetic (patterns and zeros), never a real voice.
//

import Compression
import CryptoKit
import ExpressiveCore
import Foundation
import XCTest

// MARK: - Builders

/// Deterministic random numbers for the fuzz tests.
struct SplitMix64 {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    mutating func int(_ upper: Int) -> Int { Int(next() % UInt64(max(1, upper))) }
}

enum Bytes {
    static func le16(_ v: Int) -> [UInt8] { [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)] }
    static func le32(_ v: UInt32) -> [UInt8] { (0..<4).map { UInt8((v >> (8 * UInt32($0))) & 0xFF) } }
    static func le64(_ v: UInt64) -> [UInt8] { (0..<8).map { UInt8((v >> (8 * UInt64($0))) & 0xFF) } }

    static func crc32(_ bytes: [UInt8]) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        for b in bytes {
            c ^= UInt32(b)
            for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        }
        return c ^ 0xFFFF_FFFF
    }

    static func sha256(_ bytes: [UInt8]) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }

    static func deflate(_ bytes: [UInt8]) -> [UInt8] {
        var dst = [UInt8](repeating: 0, count: bytes.count + 1024)
        let n = bytes.withUnsafeBufferPointer { s in
            dst.withUnsafeMutableBufferPointer { d in
                compression_encode_buffer(d.baseAddress!, d.count, s.baseAddress!, s.count, nil, COMPRESSION_ZLIB)
            }
        }
        return Array(dst.prefix(n))
    }
}

struct ZipPart {
    var name: String
    var data: [UInt8]
    var deflate = false
    var flags = 0
    var method: Int?
    var crc: UInt32?
    var declaredSize: UInt32?
    var payload: [UInt8]?
}

enum TestZip {
    /// Concatenate byte groups (one call instead of long `+` chains, which are slow to type-check).
    static func join(_ groups: [[UInt8]]) -> [UInt8] { groups.flatMap { $0 } }

    static func build(_ parts: [ZipPart], trailing: [UInt8] = [], zip64Marker: Bool = false) -> [UInt8] {
        var out: [UInt8] = []
        var central: [UInt8] = []
        for p in parts {
            let payload: [UInt8] = p.payload ?? (p.deflate ? Bytes.deflate(p.data) : p.data)
            let method: Int = p.method ?? (p.deflate ? 8 : 0)
            let crc: UInt32 = p.crc ?? Bytes.crc32(p.data)
            let size: UInt32 = p.declaredSize ?? UInt32(p.data.count)
            let name: [UInt8] = Array(p.name.utf8)
            let offset = UInt32(out.count)
            let compressedField: UInt32 = zip64Marker ? 0xFFFF_FFFF : UInt32(payload.count)
            out.append(contentsOf: join([
                Bytes.le32(0x0403_4B50), Bytes.le16(20), Bytes.le16(p.flags), Bytes.le16(method), Bytes.le16(0), Bytes.le16(0),
                Bytes.le32(crc), Bytes.le32(UInt32(payload.count)), Bytes.le32(size), Bytes.le16(name.count), Bytes.le16(0), name, payload,
            ]))
            central.append(contentsOf: join([
                Bytes.le32(0x0201_4B50), Bytes.le16(20), Bytes.le16(20), Bytes.le16(p.flags), Bytes.le16(method), Bytes.le16(0), Bytes.le16(0),
                Bytes.le32(crc), Bytes.le32(compressedField), Bytes.le32(size),
                Bytes.le16(name.count), Bytes.le16(0), Bytes.le16(0), Bytes.le16(0), Bytes.le16(0), Bytes.le32(0), Bytes.le32(offset), name,
            ]))
        }
        let cdOffset = UInt32(out.count)
        out.append(contentsOf: central)
        out.append(contentsOf: join([
            Bytes.le32(0x0605_4B50), Bytes.le16(0), Bytes.le16(0), Bytes.le16(parts.count), Bytes.le16(parts.count),
            Bytes.le32(UInt32(central.count)), Bytes.le32(cdOffset), Bytes.le16(0),
        ]))
        out.append(contentsOf: trailing)
        return out
    }
}

struct TensorBlob {
    var name: String
    var dtype: String
    var shape: [Int]
    var data: [UInt8]
}

enum Safetensors {
    /// The four tensors of a Chatterbox Nano voice, filled with harmless synthetic values.
    static func nanoTensors() -> [TensorBlob] {
        func f16(count: Int, seed: UInt64) -> [UInt8] {
            var rng = SplitMix64(state: seed)
            var out: [UInt8] = []
            out.reserveCapacity(count * 2)
            for _ in 0..<count {
                // Small finite halves: exponent 0x0C..0x10 (≈ 0.008 ... 2), random sign and mantissa.
                let bits = UInt16(rng.int(2)) << 15 | UInt16(12 + rng.int(5)) << 10 | UInt16(rng.int(1024))
                out += [UInt8(bits & 0xFF), UInt8(bits >> 8)]
            }
            return out
        }
        let tokens = (0..<250).flatMap { Bytes.le32(UInt32(($0 * 37) % 6561)) }
        return [
            TensorBlob(name: "prompt_token", dtype: "I32", shape: [1, 250], data: tokens),
            TensorBlob(name: "embedding", dtype: "F16", shape: [1, 192], data: f16(count: 192, seed: 1)),
            TensorBlob(name: "prompt_feat", dtype: "F16", shape: [1, 500, 80], data: f16(count: 40_000, seed: 2)),
            TensorBlob(name: "t3_cond_emb", dtype: "F16", shape: [1, 376, 768], data: f16(count: 288_768, seed: 3)),
        ]
    }

    /// safetensors bytes: 8-byte length, JSON header padded with spaces to 8 bytes, then the tensors in order.
    static func build(_ tensors: [TensorBlob], header override: String? = nil, extraPayload: [UInt8] = []) -> [UInt8] {
        var entries: [String] = []
        var offset = 0
        var payload: [UInt8] = []
        for t in tensors {
            entries.append("\"\(t.name)\":{\"dtype\":\"\(t.dtype)\",\"shape\":[\(t.shape.map(String.init).joined(separator: ","))],\"data_offsets\":[\(offset),\(offset + t.data.count)]}")
            offset += t.data.count
            payload += t.data
        }
        var json = Array((override ?? "{\(entries.joined(separator: ","))}").utf8)
        while (8 + json.count) % 8 != 0 { json.append(0x20) }
        return Bytes.le64(UInt64(json.count)) + json + payload + extraPayload
    }
}

enum Pack {
    static let created = "2026-10-06T23:50:00Z"

    static func manifest(name: String = "Synthetic Test Voice", parts: [(path: String, role: String, data: [UInt8])], edit: (inout [String: Any]) -> Void = { _ in }) -> [UInt8] {
        var m: [String: Any] = [
            "format": "tachinovel-voice",
            "formatVersion": 1,
            "engine": "chatterbox-nano",
            "engineVersion": 1,
            "model": ["upstream": "ResembleAI/chatterbox-nano", "weights": "t3_nano_v1+s3gen_meanflow",
                      "coreml": "FluidInference/chatterbox-nano-coreml@f28421eff8e34bb6d70663ba1e3b1295562c620b"],
            "name": name,
            "createdAt": created,
            "parts": parts.map { p -> [String: Any] in ["path": p.path, "role": p.role, "bytes": p.data.count, "sha256": Bytes.sha256(p.data)] },
            "source": ["tool": "export_voice.py", "synthetic": true] as [String: Any],
        ]
        edit(&m)
        // swiftlint:disable:next force_try
        return Array(try! JSONSerialization.data(withJSONObject: m, options: [.sortedKeys]))
    }

    /// One manifest part entry.
    static func part(_ path: String, _ role: String, bytes: Int, sha256: String) -> [[String: Any]] {
        [["path": path, "role": role, "bytes": bytes, "sha256": sha256] as [String: Any]]
    }

    /// A minimal "ftyp" box: enough for the preview sniff test.
    static let preview: [UInt8] = TestZip.join([Bytes.le32(0x1800_0000), Array("ftypM4A ".utf8), [0, 0, 0, 0], Array("M4A isom".utf8)])

    static func good(deflate: Bool = false, withPreview: Bool = true, name: String = "Synthetic Test Voice") -> [UInt8] {
        let voice = Safetensors.build(Safetensors.nanoTensors())
        var parts: [(path: String, role: String, data: [UInt8])] = [("voice.safetensors", "conditioning", voice)]
        if withPreview { parts.append(("preview.m4a", "preview", preview)) }
        var zipParts = [ZipPart(name: "manifest.json", data: manifest(name: name, parts: parts), deflate: deflate)]
        zipParts += parts.map { ZipPart(name: $0.path, data: $0.data, deflate: deflate) }
        return TestZip.build(zipParts)
    }

    /// A pack whose voice.safetensors is `voice` (manifest hashes match it).
    static func with(voice: [UInt8], edit: (inout [String: Any]) -> Void = { _ in }) -> [UInt8] {
        let parts: [(path: String, role: String, data: [UInt8])] = [("voice.safetensors", "conditioning", voice)]
        return TestZip.build([ZipPart(name: "manifest.json", data: manifest(parts: parts, edit: edit)), ZipPart(name: "voice.safetensors", data: voice)])
    }
}

func assertRejects(_ bytes: [UInt8], _ check: (VoicePackError) -> Bool, file: StaticString = #filePath, line: UInt = #line) {
    do {
        _ = try VoicePack.read(Data(bytes))
        XCTFail("accepted a bad file", file: file, line: line)
    } catch let error as VoicePackError {
        XCTAssertTrue(check(error), "unexpected error: \(error)", file: file, line: line)
        XCTAssertFalse((error.errorDescription ?? "").isEmpty, file: file, line: line)
    } catch {
        XCTFail("not a VoicePackError: \(error)", file: file, line: line)
    }
}

// MARK: - Good files

final class VoicePackGoodTests: XCTestCase {
    func testAcceptsAStoredPack() throws {
        let c = try VoicePack.read(Data(Pack.good()))
        XCTAssertEqual(c.manifest.engine, .chatterboxNano)
        XCTAssertEqual(c.manifest.name, "Synthetic Test Voice")
        XCTAssertEqual(c.manifest.createdAt, Pack.created)
        XCTAssertEqual(c.manifest.madeFor, "FluidInference/chatterbox-nano-coreml@f28421eff8e34bb6d70663ba1e3b1295562c620b")
        XCTAssertEqual(c.conditioning.count, 8 + 304 + VoicePackEngine.chatterboxNano.payloadBytes)
        XCTAssertEqual(c.conditioningSHA256, Bytes.sha256([UInt8](c.conditioning)))
        XCTAssertEqual(c.preview.map { [UInt8]($0) }, Pack.preview)
    }

    func testAcceptsADeflatedPackWithoutPreview() throws {
        let c = try VoicePack.read(Data(Pack.good(deflate: true, withPreview: false)))
        XCTAssertNil(c.preview)
        XCTAssertEqual(c.conditioning.count, 659_232) // the size of the built-in voice-default.safetensors
    }

    func testTheSpecMatchesTheBuiltInVoice() {
        // tables/voice-default.safetensors of FluidInference/chatterbox-nano-coreml@f28421e: 659,232 bytes, header 304.
        XCTAssertEqual(VoicePackEngine.chatterboxNano.payloadBytes, 658_920)
        XCTAssertEqual(Set(VoicePackEngine.chatterboxNano.tensors.map(\.name)), ["t3_cond_emb", "prompt_token", "prompt_feat", "embedding"])
        XCTAssertEqual(VoicePackEngine.find("chatterbox-nano"), .chatterboxNano)
        XCTAssertNil(VoicePackEngine.find("kokoro"))
    }

    func testCleansNames() {
        XCTAssertEqual(VoicePack.cleanName("  Warm\u{0007}  narrator\n"), "Warm narrator")
        XCTAssertEqual(VoicePack.cleanName("\u{202E}evil"), "evil")
        XCTAssertEqual(VoicePack.cleanName(""), "Imported voice")
        XCTAssertEqual(VoicePack.cleanName(String(repeating: "a", count: 90)).count, 40)
    }
}

// MARK: - Reject paths

final class VoicePackRejectTests: XCTestCase {
    func testRejectsHugeFilesBeforeReadingThem() {
        assertRejects([UInt8](repeating: 0, count: VoicePackFormat.maxFileBytes + 1)) { if case .tooLarge = $0 { return true }; return false }
    }

    func testRejectsNonZipData() {
        assertRejects(Array("hello, this is not a zip file at all".utf8)) { if case .notAVoiceFile = $0 { return true }; return false }
        assertRejects([]) { if case .notAVoiceFile = $0 { return true }; return false }
    }

    func testRejectsTrailingBytes() {
        assertRejects(Pack.good() + [1, 2, 3]) { if case .damaged = $0 { return true }; return false }
    }

    func testRejectsUnexpectedNamesIncludingPathTraversal() {
        for evil in ["../voice.safetensors", "/etc/passwd", "tables/voice.safetensors", "..\\manifest.json", "notes.txt", "Manifest.json", "voice.safetensors/"] {
            let zip = TestZip.build([ZipPart(name: "manifest.json", data: Array("{}".utf8)), ZipPart(name: evil, data: [1, 2, 3])])
            assertRejects(zip) { if case .unexpectedEntry = $0 { return true }; return false }
        }
    }

    func testRejectsDuplicateEntries() {
        let zip = TestZip.build([ZipPart(name: "manifest.json", data: [1]), ZipPart(name: "manifest.json", data: [2])])
        assertRejects(zip) { if case .duplicateEntry = $0 { return true }; return false }
    }

    func testRejectsMissingParts() {
        let voice = Safetensors.build(Safetensors.nanoTensors())
        // No manifest.
        assertRejects(TestZip.build([ZipPart(name: "voice.safetensors", data: voice)])) { $0 == .missingPart("manifest.json") }
        // The manifest lists the voice but it isn't in the file.
        let m = Pack.manifest(parts: [("voice.safetensors", "conditioning", voice)])
        assertRejects(TestZip.build([ZipPart(name: "manifest.json", data: m)])) { $0 == .missingPart("voice.safetensors") }
        // A part in the file that the manifest doesn't list.
        let zip = TestZip.build([ZipPart(name: "manifest.json", data: m), ZipPart(name: "voice.safetensors", data: voice), ZipPart(name: "preview.m4a", data: Pack.preview)])
        assertRejects(zip) { if case .manifest = $0 { return true }; return false }
    }

    func testRejectsBadManifests() {
        let voice = Safetensors.build(Safetensors.nanoTensors())
        let parts: [(path: String, role: String, data: [UInt8])] = [("voice.safetensors", "conditioning", voice)]
        func zip(_ manifest: [UInt8]) -> [UInt8] {
            TestZip.build([ZipPart(name: "manifest.json", data: manifest), ZipPart(name: "voice.safetensors", data: voice)])
        }
        assertRejects(zip(Array("not json".utf8))) { $0 == .manifest("not JSON") }
        assertRejects(zip(Array("[1,2]".utf8))) { $0 == .manifest("not a JSON object") }
        assertRejects(zip(Pack.manifest(parts: parts) { $0["format"] = "something-else" })) { if case .notAVoiceFile = $0 { return true }; return false }
        assertRejects(zip(Pack.manifest(parts: parts) { $0["formatVersion"] = 2 })) { $0 == .newerFormat(2) }
        assertRejects(zip(Pack.manifest(parts: parts) { $0["formatVersion"] = true })) { $0 == .manifest("formatVersion is missing") }
        assertRejects(zip(Pack.manifest(parts: parts) { $0["formatVersion"] = 0 })) { if case .manifest = $0 { return true }; return false }
        assertRejects(zip(Pack.manifest(parts: parts) { $0["engine"] = "kokoro" })) { $0 == .unknownEngine("kokoro") }
        assertRejects(zip(Pack.manifest(parts: parts) { $0.removeValue(forKey: "engine") })) { $0 == .manifest("engine is missing") }
        assertRejects(zip(Pack.manifest(parts: parts) { $0["engineVersion"] = 2 })) { if case .incompatible = $0 { return true }; return false }
        assertRejects(zip(Pack.manifest(parts: parts) { $0["model"] = ["weights": "t3_turbo_v1+s3gen_meanflow"] })) { if case .incompatible = $0 { return true }; return false }
        assertRejects(zip(Pack.manifest(parts: parts) { $0.removeValue(forKey: "model") })) { $0 == .manifest("model.weights is missing") }
        assertRejects(zip(Pack.manifest(parts: parts) { $0["name"] = 42 })) { $0 == .manifest("name is missing") }
        assertRejects(zip(Pack.manifest(parts: parts) { $0["createdAt"] = "yesterday" })) { $0 == .manifest("createdAt is not a date") }
        assertRejects(zip(Pack.manifest(parts: parts) { $0["parts"] = [Any]() })) { if case .manifest = $0 { return true }; return false }
        assertRejects(zip(Pack.manifest(parts: parts) { m in
            m["parts"] = Pack.part("voice.safetensors", "preview", bytes: voice.count, sha256: Bytes.sha256(voice))
        })) { if case .manifest = $0 { return true }; return false }
        assertRejects(zip(Pack.manifest(parts: parts) { m in
            m["parts"] = Pack.part("voice.safetensors", "conditioning", bytes: voice.count, sha256: "ABC")
        })) { if case .manifest = $0 { return true }; return false }
        assertRejects(zip(Pack.manifest(parts: parts) { m in
            m["parts"] = Pack.part("../voice.safetensors", "conditioning", bytes: voice.count, sha256: Bytes.sha256(voice))
        })) { if case .unexpectedEntry = $0 { return true }; return false }
    }

    func testRejectsChecksumAndSizeMismatches() {
        let voice = Safetensors.build(Safetensors.nanoTensors())
        let wrongHash = Pack.manifest(parts: [("voice.safetensors", "conditioning", voice)]) { m in
            m["parts"] = Pack.part("voice.safetensors", "conditioning", bytes: voice.count, sha256: String(repeating: "0", count: 64))
        }
        assertRejects(TestZip.build([ZipPart(name: "manifest.json", data: wrongHash), ZipPart(name: "voice.safetensors", data: voice)])) { $0 == .checksum("voice.safetensors") }
        let wrongSize = Pack.manifest(parts: [("voice.safetensors", "conditioning", voice)]) { m in
            m["parts"] = Pack.part("voice.safetensors", "conditioning", bytes: voice.count - 1, sha256: Bytes.sha256(voice))
        }
        assertRejects(TestZip.build([ZipPart(name: "manifest.json", data: wrongSize), ZipPart(name: "voice.safetensors", data: voice)])) { if case .damaged = $0 { return true }; return false }
    }

    func testRejectsUnsafeZipFeatures() {
        let m = Array("{}".utf8)
        assertRejects(TestZip.build([ZipPart(name: "manifest.json", data: m, flags: 1)])) { $0 == .unsupportedZip("encrypted") }
        assertRejects(TestZip.build([ZipPart(name: "manifest.json", data: m, method: 12)])) { $0 == .unsupportedZip("compression method 12") }
        assertRejects(TestZip.build([ZipPart(name: "manifest.json", data: m, crc: 1234)])) { if case .damaged = $0 { return true }; return false }
        assertRejects(TestZip.build([ZipPart(name: "manifest.json", data: m)], zip64Marker: true)) { $0 == .unsupportedZip("ZIP64") }
        // A declared size over the part's cap is refused before anything is inflated.
        assertRejects(TestZip.build([ZipPart(name: "manifest.json", data: m, deflate: true, declaredSize: 50_000_000)])) { if case .tooLarge = $0 { return true }; return false }
        // A deflate stream that expands to more than declared (a zip bomb's trick) is refused.
        let big = [UInt8](repeating: 0x20, count: 60_000)
        assertRejects(TestZip.build([ZipPart(name: "manifest.json", data: Array(big.prefix(10)), deflate: true, payload: Bytes.deflate(big))])) { if case .damaged = $0 { return true }; return false }
        // Stored entry whose two sizes differ.
        assertRejects(TestZip.build([ZipPart(name: "manifest.json", data: m, declaredSize: 99)])) { if case .damaged = $0 { return true }; return false }
        // Too many entries.
        let many = (0..<9).map { ZipPart(name: "f\($0)", data: [1]) }
        assertRejects(TestZip.build(many)) { if case .unsupportedZip = $0 { return true }; return false }
    }

    func testRejectsOverlappingEntries() {
        // Two directory entries pointing at the same local header.
        var zip = TestZip.build([ZipPart(name: "manifest.json", data: [1]), ZipPart(name: "manifest.json", data: [1])])
        // Point the second central entry's local offset at the first local header (offset 0).
        let eocd = zip.count - 22
        let cdOffset = Int(zip[eocd + 16]) | Int(zip[eocd + 17]) << 8 | Int(zip[eocd + 18]) << 16 | Int(zip[eocd + 19]) << 24
        let secondCentral = cdOffset + 46 + "manifest.json".utf8.count
        for k in 0..<4 { zip[secondCentral + 42 + k] = 0 }
        assertRejects(zip) { if case .unsupportedZip("overlapping entries") = $0 { return true }; return false }
    }

    func testRejectsBadPreview() {
        let voice = Safetensors.build(Safetensors.nanoTensors())
        let fake = Array("not audio, just text".utf8)
        let parts: [(path: String, role: String, data: [UInt8])] = [("voice.safetensors", "conditioning", voice), ("preview.m4a", "preview", fake)]
        let zip = TestZip.build([ZipPart(name: "manifest.json", data: Pack.manifest(parts: parts)), ZipPart(name: "voice.safetensors", data: voice), ZipPart(name: "preview.m4a", data: fake)])
        assertRejects(zip) { if case .damaged = $0 { return true }; return false }
    }
}

// MARK: - voice.safetensors

final class ConditioningTests: XCTestCase {
    private func rejects(_ voice: [UInt8], file: StaticString = #filePath, line: UInt = #line) {
        assertRejects(Pack.with(voice: voice), { if case .conditioning = $0 { return true }; if case .tooLarge = $0 { return true }; return false }, file: file, line: line)
        XCTAssertThrowsError(try VoicePack.validateConditioning(Data(voice), engine: .chatterboxNano), file: file, line: line)
    }

    func testAcceptsTheExactLayout() throws {
        XCTAssertNoThrow(try VoicePack.validateConditioning(Data(Safetensors.build(Safetensors.nanoTensors())), engine: .chatterboxNano))
        // Tensor order in the payload doesn't matter, and metadata is allowed.
        let reversed = Safetensors.build(Array(Safetensors.nanoTensors().reversed()))
        XCTAssertNoThrow(try VoicePack.validateConditioning(Data(reversed), engine: .chatterboxNano))
        let parsed = try SafetensorsHeader.parse(Safetensors.build(Safetensors.nanoTensors()), maxHeaderBytes: 65_536)
        XCTAssertEqual(parsed.tensors.map(\.name), ["prompt_token", "embedding", "prompt_feat", "t3_cond_emb"])
        XCTAssertEqual(parsed.payloadStart, 312)
    }

    func testRejectsWrongTensors() {
        var t = Safetensors.nanoTensors()
        t[0].dtype = "F32" // prompt_token as floats (same byte size: 4)
        rejects(Safetensors.build(t))

        t = Safetensors.nanoTensors()
        t[3].shape = [1, 768, 376] // right size, wrong shape
        rejects(Safetensors.build(t))

        t = Safetensors.nanoTensors()
        t[2].shape = [1, 400, 80]
        t[2].data = Array(t[2].data.prefix(400 * 80 * 2)) // a shorter reference: shapes must match exactly
        rejects(Safetensors.build(t))

        t = Safetensors.nanoTensors()
        t.removeLast()
        rejects(Safetensors.build(t))

        t = Safetensors.nanoTensors()
        t.append(TensorBlob(name: "extra", dtype: "F16", shape: [1], data: [0, 0]))
        rejects(Safetensors.build(t))

        t = Safetensors.nanoTensors()
        t[1].name = "embeddings"
        rejects(Safetensors.build(t))
    }

    func testRejectsBadValues() {
        var t = Safetensors.nanoTensors()
        t[1].data[10] = 0x00
        t[1].data[11] = 0x7E // F16 NaN
        rejects(Safetensors.build(t))

        t = Safetensors.nanoTensors()
        t[3].data[0] = 0x00
        t[3].data[1] = 0xFC // F16 −infinity
        rejects(Safetensors.build(t))

        t = Safetensors.nanoTensors()
        t[0].data.replaceSubrange(0..<4, with: Bytes.le32(6561)) // the speech vocabulary is 0..<6561
        rejects(Safetensors.build(t))

        t = Safetensors.nanoTensors()
        t[0].data.replaceSubrange(4..<8, with: Bytes.le32(UInt32(bitPattern: -1)))
        rejects(Safetensors.build(t))
    }

    func testRejectsBadLayouts() {
        let t = Safetensors.nanoTensors()
        // Trailing bytes after the last tensor.
        rejects(Safetensors.build(t, extraPayload: [0, 0]))
        // Offsets that overlap / leave a gap / point past the end.
        let shapes = "\"prompt_token\":{\"dtype\":\"I32\",\"shape\":[1,250],\"data_offsets\":[0,1000]},\"embedding\":{\"dtype\":\"F16\",\"shape\":[1,192],\"data_offsets\":[1000,1384]},\"prompt_feat\":{\"dtype\":\"F16\",\"shape\":[1,500,80],\"data_offsets\":[1384,81384]}"
        let overlap = "{\(shapes),\"t3_cond_emb\":{\"dtype\":\"F16\",\"shape\":[1,376,768],\"data_offsets\":[81382,658918]}}"
        rejects(Safetensors.build(t, header: overlap))
        let past = "{\(shapes),\"t3_cond_emb\":{\"dtype\":\"F16\",\"shape\":[1,376,768],\"data_offsets\":[81384,9999999]}}"
        rejects(Safetensors.build(t, header: past))
        let reversedOffsets = "{\(shapes),\"t3_cond_emb\":{\"dtype\":\"F16\",\"shape\":[1,376,768],\"data_offsets\":[658920,81384]}}"
        rejects(Safetensors.build(t, header: reversedOffsets))
        let negative = "{\(shapes),\"t3_cond_emb\":{\"dtype\":\"F16\",\"shape\":[1,-376,768],\"data_offsets\":[81384,658920]}}"
        rejects(Safetensors.build(t, header: negative))
        let overflow = "{\(shapes),\"t3_cond_emb\":{\"dtype\":\"F16\",\"shape\":[9007199254740991,9007199254740991],\"data_offsets\":[81384,658920]}}"
        rejects(Safetensors.build(t, header: overflow))
        let fractional = "{\(shapes),\"t3_cond_emb\":{\"dtype\":\"F16\",\"shape\":[1,376.5,768],\"data_offsets\":[81384,658920]}}"
        rejects(Safetensors.build(t, header: fractional))
        let badMeta = "{\"__metadata__\":{\"a\":1},\(shapes),\"t3_cond_emb\":{\"dtype\":\"F16\",\"shape\":[1,376,768],\"data_offsets\":[81384,658920]}}"
        rejects(Safetensors.build(t, header: badMeta))
        rejects(Safetensors.build(t, header: "{not json"))
        rejects(Safetensors.build(t, header: "[]"))
    }

    func testRejectsBadHeaderLengths() {
        let good = Safetensors.build(Safetensors.nanoTensors())
        var huge = good
        huge.replaceSubrange(0..<8, with: Bytes.le64(UInt64.max))
        rejects(huge)
        var past = good
        past.replaceSubrange(0..<8, with: Bytes.le64(UInt64(good.count)))
        rejects(past)
        var big = good
        big.replaceSubrange(0..<8, with: Bytes.le64(70_000)) // over the 64 KiB header cap
        rejects(big)
        rejects([1, 2, 3])
        rejects(Bytes.le64(0))
    }
}

// MARK: - Truncation and fuzzing: never a crash, never a bad file accepted

final class VoicePackFuzzTests: XCTestCase {
    func testTruncatedPacksAreRejected() {
        let good = Pack.good(deflate: true)
        var cuts = Array(0..<min(600, good.count))
        cuts += Array(stride(from: 600, to: good.count, by: 997))
        cuts += Array(max(0, good.count - 600)..<good.count)
        for n in cuts {
            XCTAssertThrowsError(try VoicePack.read(Data(good.prefix(n))), "accepted a file cut at \(n) of \(good.count) bytes")
        }
    }

    func testTruncatedSafetensorsHeadersAreRejected() {
        let good = Safetensors.build(Safetensors.nanoTensors())
        for n in 0..<400 {
            XCTAssertThrowsError(try VoicePack.validateConditioning(Data(good.prefix(n)), engine: .chatterboxNano), "cut at \(n)")
        }
        // The header cut short (its JSON is 300 bytes + 4 spaces), the length field matching the cut: the JSON ends early.
        for n in stride(from: 9, to: 307, by: 7) {
            var b = Array(good.prefix(n)) + Array(good.dropFirst(312))
            b.replaceSubrange(0..<8, with: Bytes.le64(UInt64(n - 8)))
            XCTAssertThrowsError(try VoicePack.validateConditioning(Data(b), engine: .chatterboxNano), "header cut at \(n)")
        }
    }

    func testRandomByteFlipsNeverCrash() {
        let packs = [Pack.good(), Pack.good(deflate: true)]
        var rng = SplitMix64(state: 2026)
        var accepted = 0
        for round in 0..<300 {
            var b = packs[round % 2]
            for _ in 0..<(1 + rng.int(4)) {
                // Mostly the structural parts: local headers, the directory, the safetensors header, the manifest.
                let i = rng.int(3) == 0 ? rng.int(b.count) : (rng.int(2) == 0 ? rng.int(min(b.count, 1200)) : b.count - 1 - rng.int(min(b.count, 300)))
                b[i] ^= UInt8(1 + rng.int(255))
            }
            do {
                let c = try VoicePack.read(Data(b))
                // A flip in a byte nobody checks (e.g. "version made by") may pass: the voice must still be valid.
                XCTAssertNoThrow(try VoicePack.validateConditioning(c.conditioning, engine: .chatterboxNano))
                accepted += 1
            } catch {
                XCTAssertTrue(error is VoicePackError, "round \(round): \(error)")
            }
        }
        XCTAssertLessThan(accepted, 150)
    }

    func testRandomSafetensorsHeadersNeverCrash() {
        let good = Safetensors.build(Safetensors.nanoTensors())
        var rng = SplitMix64(state: 7)
        for round in 0..<500 {
            var b = good
            for _ in 0..<(1 + rng.int(3)) { b[rng.int(312)] ^= UInt8(1 + rng.int(255)) }
            do {
                try VoicePack.validateConditioning(Data(b), engine: .chatterboxNano)
            } catch {
                XCTAssertTrue(error is VoicePackError, "round \(round): \(error)")
            }
        }
    }
}

// MARK: - Store and slot

final class ImportedVoiceStoreTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("voices-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testAddListRenameSelectDelete() throws {
        let store = ImportedVoiceStore(root: dir)
        XCTAssertEqual(store.list(engine: "chatterbox-nano"), [])
        let contents = try VoicePack.read(Data(Pack.good()))
        let (voice, replaced) = try store.add(contents, sourceFile: "Mommy.tnvoice", now: Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertFalse(replaced)
        XCTAssertTrue(ImportedVoiceStore.isValidID(voice.id))
        XCTAssertEqual(voice.id, "v" + String(contents.conditioningSHA256.prefix(16)))
        XCTAssertTrue(voice.hasPreview)
        XCTAssertEqual(store.list(engine: "chatterbox-nano").map(\.id), [voice.id])
        XCTAssertNotNil(store.previewURL(voice.id, engine: "chatterbox-nano"))
        XCTAssertEqual(try store.conditioning(voice.id, engine: "chatterbox-nano"), contents.conditioning)

        try store.rename(voice.id, engine: "chatterbox-nano", to: "  Mommy\n")
        XCTAssertEqual(store.voice(voice.id, engine: "chatterbox-nano")?.name, "Mommy")
        // The same voice imported again keeps its new name and its single copy.
        let again = try store.add(contents, sourceFile: nil)
        XCTAssertTrue(again.replaced)
        XCTAssertEqual(again.voice.name, "Mommy")
        XCTAssertEqual(store.list(engine: "chatterbox-nano").count, 1)

        XCTAssertNil(store.selection(engine: "chatterbox-nano"))
        try store.setSelection(voice.id, engine: "chatterbox-nano")
        XCTAssertEqual(ImportedVoiceStore(root: dir).selection(engine: "chatterbox-nano"), voice.id) // survives a restart
        try store.delete(voice.id, engine: "chatterbox-nano")
        XCTAssertNil(store.selection(engine: "chatterbox-nano"), "deleting the narrator voice goes back to the built-in voice")
        XCTAssertEqual(store.list(engine: "chatterbox-nano"), [])
        XCTAssertThrowsError(try store.conditioning(voice.id, engine: "chatterbox-nano"))
    }

    func testRefusesUnsafeIDsAndUnknownVoices() throws {
        let store = ImportedVoiceStore(root: dir)
        for bad in ["../x", "v0123456789abcdef/../../x", "V0123456789ABCDEF", "", "v123"] {
            XCTAssertThrowsError(try store.directory(bad, engine: "chatterbox-nano"), bad)
            XCTAssertThrowsError(try store.setSelection(bad, engine: "chatterbox-nano"), bad)
            XCTAssertThrowsError(try store.delete(bad, engine: "chatterbox-nano"), bad)
        }
        XCTAssertThrowsError(try store.setSelection("v0123456789abcdef", engine: "chatterbox-nano"))
        XCTAssertThrowsError(try store.directory("v0123456789abcdef", engine: "../kokoro"))
        // Chatterbox's own voice and a shipped voice can be chosen (BundledVoices checks that a shipped one exists).
        try store.setSelection("builtin", engine: "chatterbox-nano")
        XCTAssertEqual(store.selection(engine: "chatterbox-nano"), "builtin")
        try store.setSelection("b0123456789abcdef", engine: "chatterbox-nano")
        XCTAssertEqual(store.selection(engine: "chatterbox-nano"), "b0123456789abcdef")
        try store.setSelection(nil, engine: "chatterbox-nano")
        XCTAssertNil(store.selection(engine: "chatterbox-nano"))
    }

    func testATamperedVoiceIsRefusedAtLoadTime() throws {
        let store = ImportedVoiceStore(root: dir)
        let voice = try store.add(try VoicePack.read(Data(Pack.good())), sourceFile: nil).voice
        let file = try store.directory(voice.id, engine: "chatterbox-nano").appendingPathComponent("voice.safetensors")
        var bytes = try [UInt8](Data(contentsOf: file))
        bytes[400] ^= 0x01
        try Data(bytes).write(to: file)
        XCTAssertThrowsError(try store.conditioning(voice.id, engine: "chatterbox-nano")) { XCTAssertEqual($0 as? VoicePackError, .checksum("voice.safetensors")) }
        try FileManager.default.removeItem(at: file)
        XCTAssertThrowsError(try store.conditioning(voice.id, engine: "chatterbox-nano")) { XCTAssertEqual($0 as? VoicePackError, .notFound(voice.id)) }
    }
}

final class BundledVoicesTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("shipped-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func write(_ name: String, _ bytes: [UInt8]) throws {
        try Data(bytes).write(to: dir.appendingPathComponent(name))
    }

    func testListsValidShippedVoicesDefaultFirstAndLeavesOutBrokenOnes() throws {
        try write("second.tnvoice", Pack.good(withPreview: false, name: "Second"))
        try write("narrator.tnvoice", Pack.good(name: "Narrator"))
        try write("broken.tnvoice", Array(Pack.good().prefix(5000)))
        try write("notes.txt", Array("not a voice".utf8))
        try write("voices.json", Array(#"{"schemaVersion":1,"default":"narrator.tnvoice"}"#.utf8))
        let shipped = BundledVoices(directory: dir)
        XCTAssertEqual(shipped.entries.map(\.fileName), ["narrator.tnvoice", "second.tnvoice"])
        let narrator = try XCTUnwrap(shipped.entries.first)
        XCTAssertTrue(narrator.isDefault)
        XCTAssertTrue(narrator.hasPreview)
        XCTAssertEqual(narrator.name, "Narrator")
        XCTAssertEqual(narrator.id, BundledVoices.id(forFileName: "narrator.tnvoice"))
        XCTAssertTrue(BundledVoices.isBundledID(narrator.id))
        XCTAssertFalse(ImportedVoiceStore.isValidID(narrator.id))
        XCTAssertEqual(shipped.defaultID(engine: "chatterbox-nano"), narrator.id)
        XCTAssertEqual(shipped.problems.count, 1)
        XCTAssertTrue(shipped.problems[0].hasPrefix("broken.tnvoice: "))
        let contents = try shipped.contents(narrator.id)
        XCTAssertEqual(contents.conditioningSHA256, narrator.sha256)
        XCTAssertNotNil(contents.preview)
        XCTAssertThrowsError(try shipped.contents("b0000000000000000"))
        XCTAssertThrowsError(try shipped.contents("../narrator.tnvoice"))
    }

    func testIdsFollowTheFileNameSoARetunedVoiceKeepsItsId() throws {
        try write("narrator.tnvoice", Pack.good(name: "Narrator v1"))
        let before = BundledVoices(directory: dir).entries.first
        try write("narrator.tnvoice", Pack.good(deflate: true, withPreview: false, name: "Narrator v2"))
        let after = BundledVoices(directory: dir).entries.first
        XCTAssertEqual(before?.id, after?.id)
        XCTAssertEqual(after?.name, "Narrator v2")
    }

    func testABadDefaultOrNoFolderMeansNoShippedDefault() throws {
        try write("narrator.tnvoice", Pack.good(name: "Narrator"))
        try write("voices.json", Array(#"{"schemaVersion":1,"default":"missing.tnvoice"}"#.utf8))
        let shipped = BundledVoices(directory: dir)
        XCTAssertNil(shipped.defaultID(engine: "chatterbox-nano"))
        XCTAssertEqual(shipped.entries.count, 1)
        XCTAssertEqual(shipped.problems.count, 1)
        XCTAssertEqual(BundledVoices(directory: nil).entries, [])
        XCTAssertEqual(BundledVoices(directory: dir.appendingPathComponent("nope")).entries, [])
    }

    func testAShippedFileChangedAfterListingIsRefusedWhenLoaded() throws {
        try write("narrator.tnvoice", Pack.good(name: "Narrator"))
        let shipped = BundledVoices(directory: dir)
        let id = try XCTUnwrap(shipped.entries.first?.id)
        try write("narrator.tnvoice", Pack.good(deflate: true, name: "Narrator"))
        XCTAssertNoThrow(try shipped.contents(id)) // same voice data, repacked: fine
        var t = Safetensors.nanoTensors()
        t[1].data[0] ^= 0x01
        try write("narrator.tnvoice", Pack.with(voice: Safetensors.build(t)))
        XCTAssertThrowsError(try shipped.contents(id)) { XCTAssertEqual($0 as? VoicePackError, .checksum("narrator.tnvoice")) }
    }
}

private actor Overlap {
    var now = 0
    var most = 0
    func enter() {
        now += 1
        most = max(most, now)
    }

    func leave() { now -= 1 }
}

final class AsyncGateTests: XCTestCase {
    func testOneHolderAtATime() async {
        let gate = AsyncGate()
        let overlap = Overlap()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    await gate.acquire()
                    await overlap.enter()
                    try? await Task.sleep(nanoseconds: 2_000_000)
                    await overlap.leave()
                    await gate.release()
                }
            }
        }
        let most = await overlap.most
        XCTAssertEqual(most, 1)
    }
}

final class ChatterboxVoiceSlotTests: XCTestCase {
    private var dir: URL!
    private let pinned = Data("pinned built-in voice".utf8)

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("slot-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("tables"), withIntermediateDirectories: true)
        try pinned.write(to: dir.appendingPathComponent("tables/voice-default.safetensors"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private var slot: ChatterboxVoiceSlot { ChatterboxVoiceSlot(engineDirectory: dir, pinnedSHA256: VoicePack.sha256Hex(pinned)) }

    func testSwapsAVoiceInAndBack() throws {
        let s = slot
        XCTAssertTrue(s.holdsBuiltInVoice)
        try s.install(Data("imported".utf8))
        XCTAssertFalse(s.holdsBuiltInVoice)
        XCTAssertEqual(try Data(contentsOf: s.slotURL), Data("imported".utf8))
        try s.restorePinned()
        XCTAssertTrue(s.holdsBuiltInVoice)
        // Twice in a row (the backup is reused) and restoring when nothing changed.
        try s.install(Data("another".utf8))
        try s.install(Data("third".utf8))
        try s.restorePinned()
        try s.restorePinned()
        XCTAssertEqual(try Data(contentsOf: s.slotURL), pinned)
    }

    func testRepairsTheSlotAfterACrashMidLoad() throws {
        try slot.install(Data("imported".utf8))
        // The app died here: a fresh launch restores the built-in voice.
        let relaunched = slot
        try relaunched.restorePinned()
        XCTAssertTrue(relaunched.holdsBuiltInVoice)
    }

    func testRefusesWhenTheBuiltInVoiceIsGone() throws {
        try Data("damaged".utf8).write(to: slot.slotURL)
        XCTAssertThrowsError(try slot.install(Data("imported".utf8))) { XCTAssertEqual($0 as? VoiceSlotError, .builtInVoiceMissing) }
        XCTAssertThrowsError(try slot.restorePinned()) { XCTAssertEqual($0 as? VoiceSlotError, .builtInVoiceMissing) }
    }

    func testNothingToDoWithoutAModel() throws {
        let empty = ChatterboxVoiceSlot(engineDirectory: dir.appendingPathComponent("missing"), pinnedSHA256: VoicePack.sha256Hex(pinned))
        XCTAssertNoThrow(try empty.restorePinned())
    }
}
