//
//  VoiceSnippets.swift — a narrator voice's extras (docs/voice-import.md): short nonverbal sounds (chuckle, hm,
//  mm, laugh…) and breaths that natural delivery (branch natural-delivery) splices between sentences.
//
//  In a .tnvoice they are two optional folders, each with a manifest that the top manifest lists (and hashes):
//    nonverbal/manifest.json  {"kind": "nonverbal", "snippets": [{"file", "type", "duration", "rmsDb", "sha256"}]}
//    nonverbal/<file>.wav|.caf
//    breaths/manifest.json    {"kind": "breaths", …}
//    breaths/<file>.wav|.caf
//  Untrusted like the rest of the file. Checked strictly: 16/24-bit integer PCM WAV or CAF only, mono, 16–48 kHz,
//  at most 2.5 s each, at most 64 per folder, at most 8 MB of audio per pack; headers parsed with bounds checks,
//  every listed file present with its SHA-256, every file listed, duration and RMS level as the manifest says.
//
//  API for the delivery code: VoiceExtras.nonverbalSnippets(_ type:) / breathSnippets(), decoded mono Float
//  samples at the file's own rate; ExpressiveService.narratorExtras() gives the current narrator voice's.
//

import Foundation

public enum SnippetKind: String, CaseIterable, Sendable, Codable {
    case nonverbal
    case breaths

    /// "nonverbal/manifest.json"
    public var manifestPath: String { "\(rawValue)/manifest.json" }
}

public struct VoiceSnippet: Sendable, Equatable {
    public let kind: SnippetKind
    /// What it is: "chuckle", "hm", "mm", "laugh", "inhale", … (lowercase, from the manifest).
    public let type: String
    /// File name inside its folder.
    public let file: String
    public let sampleRate: Int
    /// Mono, -1…1.
    public let samples: [Float]
    /// RMS level of the whole snippet, dBFS.
    public let rmsDb: Double

    public var duration: Double { sampleRate > 0 ? Double(samples.count) / Double(sampleRate) : 0 }
}

/// A narrator voice's nonverbal sounds and breaths (empty for a voice without them).
public struct VoiceExtras: Sendable, Equatable {
    public let nonverbal: [VoiceSnippet]
    public let breaths: [VoiceSnippet]

    public init(nonverbal: [VoiceSnippet], breaths: [VoiceSnippet]) {
        self.nonverbal = nonverbal
        self.breaths = breaths
    }

    public static let none = VoiceExtras(nonverbal: [], breaths: [])

    public var isEmpty: Bool { nonverbal.isEmpty && breaths.isEmpty }

    /// The nonverbal sounds of one type ("chuckle"), or all of them.
    public func nonverbalSnippets(_ type: String? = nil) -> [VoiceSnippet] {
        guard let type else { return nonverbal }
        return nonverbal.filter { $0.type == type }
    }

    /// The breaths (optionally of one type, e.g. "inhale").
    public func breathSnippets(_ type: String? = nil) -> [VoiceSnippet] {
        guard let type else { return breaths }
        return breaths.filter { $0.type == type }
    }

    /// The nonverbal types this voice has, sorted.
    public var nonverbalTypes: [String] { Array(Set(nonverbal.map(\.type))).sorted() }
}

public enum VoiceSnippets {
    /// "chuckle-01.wav": letters, digits, "_" and "-", ending in .wav or .caf, at most 68 characters.
    public static func isSnippetFileName(_ name: String) -> Bool {
        let utf8 = Array(name.utf8)
        guard (5...68).contains(utf8.count), name.hasSuffix(".wav") || name.hasSuffix(".caf") else { return false }
        let stem = utf8.dropLast(4)
        guard let first = stem.first, isAlnum(first) else { return false }
        return stem.allSatisfy { isAlnum($0) || $0 == 0x5F || $0 == 0x2D }
    }

    static func isAlnum(_ c: UInt8) -> Bool { (48...57).contains(c) || (65...90).contains(c) || (97...122).contains(c) }

    /// "chuckle", "inhale": lowercase letters, digits and "-", starting with a letter, at most 24 characters.
    static func isSnippetType(_ type: String) -> Bool {
        let utf8 = Array(type.utf8)
        guard (1...24).contains(utf8.count), let first = utf8.first, (97...122).contains(first) else { return false }
        return utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 0x2D }
    }

    /// One folder: its manifest and its files (bare name → bytes), checked and decoded, in manifest order.
    public static func read(_ kind: SnippetKind, manifest: [UInt8], files: [String: [UInt8]]) throws -> [VoiceSnippet] {
        let json: Any
        do {
            json = try JSONSerialization.jsonObject(with: Data(manifest), options: [])
        } catch {
            throw VoicePackError.manifest("\(kind.manifestPath) is not JSON")
        }
        guard let root = json as? [String: Any], root["kind"] as? String == kind.rawValue else {
            throw VoicePackError.manifest("\(kind.manifestPath) is not a \(kind.rawValue) manifest")
        }
        guard let list = root["snippets"] as? [Any], (1...VoicePackFormat.maxSnippetsPerFolder).contains(list.count) else {
            throw VoicePackError.manifest("\(kind.manifestPath) must list 1 to \(VoicePackFormat.maxSnippetsPerFolder) snippets")
        }
        guard files.count <= VoicePackFormat.maxSnippetsPerFolder else { throw VoicePackError.manifest("too many files in \(kind.rawValue)/") }
        var out: [VoiceSnippet] = []
        var seen = Set<String>()
        var total = 0
        for item in list {
            guard let o = item as? [String: Any], let file = o["file"] as? String, isSnippetFileName(file) else {
                throw VoicePackError.manifest("\(kind.manifestPath): a snippet has no valid file name")
            }
            let where_ = "\(kind.rawValue)/\(file)"
            guard seen.insert(file).inserted else { throw VoicePackError.duplicateEntry(where_) }
            guard let type = o["type"] as? String, isSnippetType(type) else { throw VoicePackError.manifest("\(where_) has no valid type") }
            guard let duration = JSONNumbers.double(o["duration"]), duration.isFinite, duration > 0,
                  duration <= VoicePackFormat.maxSnippetSeconds else { throw VoicePackError.manifest("\(where_) has no valid duration") }
            guard let rms = JSONNumbers.double(o["rmsDb"]), rms.isFinite, (-80...0).contains(rms) else {
                throw VoicePackError.manifest("\(where_) has no valid rmsDb")
            }
            guard let sha = o["sha256"] as? String, VoicePack.isHex64(sha) else { throw VoicePackError.manifest("\(where_) has no valid sha256") }
            guard let body = files[file] else { throw VoicePackError.missingPart(where_) }
            total += body.count
            guard total <= VoicePackFormat.maxSnippetBytesTotal else { throw VoicePackError.tooLarge(bytes: total, limit: VoicePackFormat.maxSnippetBytesTotal) }
            guard VoicePack.sha256Hex(body) == sha else { throw VoicePackError.checksum(where_) }
            let audio = try SnippetAudio.decode(body, caf: file.hasSuffix(".caf"), name: where_)
            let measured = audio.duration
            guard abs(measured - duration) <= 0.01 else { throw VoicePackError.damaged("\(where_) is \(String(format: "%.3f", measured)) s, not \(duration) s") }
            let level = SnippetAudio.rmsDb(audio.samples)
            guard level.isFinite, level >= -80, abs(level - rms) <= 0.5 else {
                throw VoicePackError.damaged("\(where_) is at \(String(format: "%.1f", level)) dB, not \(rms) dB")
            }
            out.append(VoiceSnippet(kind: kind, type: type, file: file, sampleRate: audio.sampleRate, samples: audio.samples, rmsDb: level))
        }
        if let stray = Set(files.keys).subtracting(seen).sorted().first { throw VoicePackError.manifest("\(kind.rawValue)/\(stray) is not listed") }
        return out
    }
}

/// 16/24-bit integer PCM, mono, 16–48 kHz, ≤ 2.5 s, from WAV (little-endian RIFF) or CAF (Apple Core Audio
/// Format). Every offset is bounds-checked; anything else is refused.
enum SnippetAudio {
    struct Decoded {
        let sampleRate: Int
        let samples: [Float]
        var duration: Double { Double(samples.count) / Double(sampleRate) }
    }

    static let maxChunks = 32

    static func decode(_ b: [UInt8], caf: Bool, name: String) throws -> Decoded {
        caf ? try decodeCAF(b, name: name) : try decodeWAV(b, name: name)
    }

    static func rmsDb(_ samples: [Float]) -> Double {
        guard !samples.isEmpty else { return -.infinity }
        var sum = 0.0
        for s in samples { sum += Double(s) * Double(s) }
        let rms = (sum / Double(samples.count)).squareRoot()
        return rms > 0 ? 20 * log10(rms) : -.infinity
    }

    private static func u16le(_ b: [UInt8], _ o: Int) -> Int { Int(b[o]) | Int(b[o + 1]) << 8 }
    private static func u32le(_ b: [UInt8], _ o: Int) -> Int { Int(b[o]) | Int(b[o + 1]) << 8 | Int(b[o + 2]) << 16 | Int(b[o + 3]) << 24 }
    private static func u32be(_ b: [UInt8], _ o: Int) -> Int { Int(b[o]) << 24 | Int(b[o + 1]) << 16 | Int(b[o + 2]) << 8 | Int(b[o + 3]) }
    private static func u16be(_ b: [UInt8], _ o: Int) -> Int { Int(b[o]) << 8 | Int(b[o + 1]) }
    private static func tag(_ b: [UInt8], _ o: Int) -> String { String(decoding: b[o..<(o + 4)], as: UTF8.self) }

    static func decodeWAV(_ b: [UInt8], name: String) throws -> Decoded {
        let bad = { (why: String) in VoicePackError.damaged("\(name): \(why)") }
        guard b.count >= 12, tag(b, 0) == "RIFF", tag(b, 8) == "WAVE" else { throw bad("not a WAV file") }
        let end = 8 + u32le(b, 4)
        guard end >= 12, end <= b.count, b.count - end <= 1 else { throw bad("bad RIFF size") }
        var p = 12
        var format: (tag: Int, channels: Int, rate: Int, byteRate: Int, align: Int, bits: Int)?
        var data: Range<Int>?
        var chunks = 0
        while p + 8 <= end {
            chunks += 1
            guard chunks <= maxChunks else { throw bad("too many chunks") }
            let id = tag(b, p)
            let size = u32le(b, p + 4)
            let body = p + 8
            guard size <= end - body else { throw bad("chunk “\(VoicePack.printable(id))” runs past the end") }
            if id == "fmt " {
                guard format == nil, size >= 16 else { throw bad("bad fmt chunk") }
                format = (tag: u16le(b, body), channels: u16le(b, body + 2), rate: u32le(b, body + 4), byteRate: u32le(b, body + 8),
                          align: u16le(b, body + 12), bits: u16le(b, body + 14))
            } else if id == "data" {
                guard data == nil else { throw bad("two data chunks") }
                data = body..<(body + size)
            }
            p = body + size + (size & 1)
        }
        guard let f = format, let samples = data else { throw bad("missing fmt or data") }
        guard f.tag == 1 else { throw bad("not integer PCM (format \(f.tag))") }
        return try pcm(b, range: samples, channels: f.channels, rate: f.rate, bits: f.bits, align: f.align, byteRate: f.byteRate,
                       bigEndian: false, name: name)
    }

    static func decodeCAF(_ b: [UInt8], name: String) throws -> Decoded {
        let bad = { (why: String) in VoicePackError.damaged("\(name): \(why)") }
        guard b.count >= 8, tag(b, 0) == "caff", u16be(b, 4) == 1, u16be(b, 6) == 0 else { throw bad("not a CAF file") }
        var p = 8
        var desc: (rate: Double, formatID: String, flags: Int, bytesPerPacket: Int, framesPerPacket: Int, channels: Int, bits: Int)?
        var data: Range<Int>?
        var chunks = 0
        while p + 12 <= b.count {
            chunks += 1
            guard chunks <= maxChunks else { throw bad("too many chunks") }
            let id = tag(b, p)
            var raw: UInt64 = 0
            for i in 0..<8 { raw = raw << 8 | UInt64(b[p + 4 + i]) }
            let size = Int64(bitPattern: raw)
            let body = p + 12
            let length: Int
            if size == -1, id == "data" {
                length = b.count - body // "until the end of the file": only for the last chunk
            } else {
                guard size >= 0, size <= Int64(b.count - body) else { throw bad("chunk “\(VoicePack.printable(id))” runs past the end") }
                length = Int(size)
            }
            if id == "desc" {
                guard desc == nil, length == 32 else { throw bad("bad desc chunk") }
                var rateBits: UInt64 = 0
                for i in 0..<8 { rateBits = rateBits << 8 | UInt64(b[body + i]) }
                desc = (rate: Double(bitPattern: rateBits), formatID: tag(b, body + 8), flags: u32be(b, body + 12),
                        bytesPerPacket: u32be(b, body + 16), framesPerPacket: u32be(b, body + 20), channels: u32be(b, body + 24),
                        bits: u32be(b, body + 28))
            } else if id == "data" {
                guard data == nil, length >= 4 else { throw bad("bad data chunk") }
                data = (body + 4)..<(body + length) // after the edit count
            }
            p = body + length
        }
        guard let d = desc, let samples = data else { throw bad("missing desc or data") }
        guard d.formatID == "lpcm", d.flags & 1 == 0 else { throw bad("not integer PCM") }
        guard d.framesPerPacket == 1, d.rate.isFinite, d.rate == d.rate.rounded(), d.rate >= 1, d.rate <= 1_000_000 else { throw bad("bad sample rate") }
        let rate = Int(d.rate)
        return try pcm(b, range: samples, channels: d.channels, rate: rate, bits: d.bits, align: d.bytesPerPacket, byteRate: rate * d.bytesPerPacket,
                       bigEndian: d.flags & 2 == 0, name: name)
    }

    // swiftlint:disable:next function_parameter_count
    private static func pcm(_ b: [UInt8], range: Range<Int>, channels: Int, rate: Int, bits: Int, align: Int, byteRate: Int,
                            bigEndian: Bool, name: String) throws -> Decoded {
        let bad = { (why: String) in VoicePackError.damaged("\(name): \(why)") }
        guard channels == 1 else { throw bad("\(channels) channels; snippets must be mono") }
        guard VoicePackFormat.snippetBits.contains(bits), align == bits / 8, byteRate == rate * align else { throw bad("\(bits)-bit samples; only 16 or 24-bit") }
        guard VoicePackFormat.snippetSampleRates.contains(rate) else { throw bad("\(rate) Hz; 16–48 kHz only") }
        guard range.lowerBound >= 0, range.upperBound <= b.count, range.count % align == 0 else { throw bad("bad data size") }
        let frames = range.count / align
        guard frames >= 1, Double(frames) <= VoicePackFormat.maxSnippetSeconds * Double(rate) else { throw bad("longer than \(VoicePackFormat.maxSnippetSeconds) s or empty") }
        var out = [Float](repeating: 0, count: frames)
        var o = range.lowerBound
        for i in 0..<frames {
            if bits == 16 {
                let raw = bigEndian ? UInt16(b[o]) << 8 | UInt16(b[o + 1]) : UInt16(b[o + 1]) << 8 | UInt16(b[o])
                out[i] = Float(Int16(bitPattern: raw)) / 32_768
            } else {
                let (hi, mid, lo) = bigEndian ? (b[o], b[o + 1], b[o + 2]) : (b[o + 2], b[o + 1], b[o])
                let raw = Int32(bitPattern: UInt32(hi) << 24 | UInt32(mid) << 16 | UInt32(lo) << 8) >> 8
                out[i] = Float(raw) / 8_388_608
            }
            o += align
        }
        return Decoded(sampleRate: rate, samples: out)
    }
}
