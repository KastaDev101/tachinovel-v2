//
//  NonVerbal.swift — recorded non-verbals (chuckle, light laugh, "hm", "mm") and breath snippets from a voice's own
//  pack, spliced around the speech instead of Nano's tags (which sounded robotic and roughened the next second of
//  speech). A pack is a folder: manifest.json + WAV files, shipped with the built-in voice and inside a .tnvoice:
//
//    { "format": "tachinovel-nonverbals", "version": 1,
//      "items": [ { "file": "chuckle-1.wav", "type": "chuckle", "duration": 0.62, "levelDb": -23.5 }, … ] }
//
//  type: chuckle | laugh | hm | mm | breath; levelDb: the snippet's speech RMS (dBFS), so it can be matched to the
//  line; duration in seconds (informative; the audio decides). WAV: PCM 16-bit or float 32, mono or stereo, any
//  rate (resampled to the engine's). Untrusted data: sizes are capped and nothing in a pack is ever executed.
//

import Foundation

/// A tiny WAV reader (RIFF/WAVE, PCM 16-bit or IEEE float 32, any channel count mixed to mono).
public enum WAVReader {
    public static let maxBytes = 4 * 1_048_576

    public static func read(_ data: Data) -> (samples: [Float], sampleRate: Int)? {
        guard data.count >= 44, data.count <= maxBytes else { return nil }
        let bytes = [UInt8](data)
        func u32(_ o: Int) -> Int { o + 3 < bytes.count ? Int(bytes[o]) | Int(bytes[o + 1]) << 8 | Int(bytes[o + 2]) << 16 | Int(bytes[o + 3]) << 24 : -1 }
        func u16(_ o: Int) -> Int { o + 1 < bytes.count ? Int(bytes[o]) | Int(bytes[o + 1]) << 8 : -1 }
        guard String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF", String(bytes: bytes[8..<12], encoding: .ascii) == "WAVE" else { return nil }
        var format = 0, channels = 0, rate = 0, bits = 0
        var dataRange: Range<Int>?
        var o = 12
        while o + 8 <= bytes.count {
            let id = String(bytes: bytes[o..<o + 4], encoding: .ascii) ?? ""
            let size = u32(o + 4)
            guard size >= 0 else { return nil }
            let body = o + 8
            let end = min(bytes.count, body + size)
            if id == "fmt ", size >= 16 {
                format = u16(body)
                channels = u16(body + 2)
                rate = u32(body + 4)
                bits = u16(body + 14)
            } else if id == "data" {
                dataRange = body..<end
            }
            o = body + size + (size & 1)
        }
        guard let range = dataRange, channels >= 1, channels <= 8, rate >= 8_000, rate <= 192_000 else { return nil }
        let pcm16 = format == 1 && bits == 16
        let float32 = format == 3 && bits == 32
        guard pcm16 || float32 else { return nil }
        let frameBytes = channels * bits / 8
        let frames = range.count / frameBytes
        var out = [Float](repeating: 0, count: frames)
        for f in 0..<frames {
            var acc: Float = 0
            for c in 0..<channels {
                let p = range.lowerBound + f * frameBytes + c * bits / 8
                if pcm16 {
                    acc += Float(Int16(bitPattern: UInt16(u16(p)))) / 32_768
                } else {
                    acc += Float(bitPattern: UInt32(truncatingIfNeeded: u32(p)))
                }
            }
            let v = acc / Float(channels)
            out[f] = v.isFinite ? max(-1, min(1, v)) : 0
        }
        return (out, rate)
    }

    /// Read and bring to `sampleRate`.
    public static func read(_ data: Data, sampleRate: Int) -> [Float]? {
        guard let (s, rate) = read(data) else { return nil }
        return rate == sampleRate ? s : TimeStretch.resample(s, ratio: Double(rate) / Double(sampleRate))
    }
}

/// A voice's recorded non-verbals and breaths.
public struct NonVerbalPack: Sendable {
    public struct Item: Sendable {
        public let type: String
        public let samples: [Float]
        /// The snippet's speech RMS, dBFS (measured when the manifest doesn't say).
        public let levelDB: Double
    }

    public let items: [Item]

    public init(items: [Item]) {
        self.items = items
    }

    public static let maxItems = 64
    public static let maxSeconds = 3.0

    /// Load a pack folder (manifest.json + WAVs). Unknown types, missing or unreadable files are skipped; nil when
    /// nothing usable is left.
    public static func load(directory: URL, sampleRate: Int) -> NonVerbalPack? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("manifest.json")), data.count <= 64 * 1024,
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], (o["format"] as? String) == "tachinovel-nonverbals",
              let list = o["items"] as? [Any] else { return nil }
        let known = Set(NonVerbalType.allCases.map(\.rawValue) + ["breath"])
        var items: [Item] = []
        for case let e as [String: Any] in list.prefix(maxItems) {
            guard let file = e["file"] as? String, let type = e["type"] as? String, known.contains(type),
                  file.range(of: "^[A-Za-z0-9._-]{1,80}\\.wav$", options: .regularExpression) != nil,
                  let wav = try? Data(contentsOf: directory.appendingPathComponent(file)),
                  var samples = WAVReader.read(wav, sampleRate: sampleRate), !samples.isEmpty else { continue }
            if samples.count > Int(maxSeconds * Double(sampleRate)) { samples = Array(samples.prefix(Int(maxSeconds * Double(sampleRate)))) }
            let measured = StudioSound.speechRMS(samples, sampleRate: sampleRate)
            let level = (e["levelDb"] as? NSNumber)?.doubleValue ?? 20 * log10(max(Double(measured), 1e-6))
            items.append(Item(type: type, samples: samples, levelDB: level))
        }
        return items.isEmpty ? nil : NonVerbalPack(items: items)
    }

    public func has(_ type: NonVerbalType) -> Bool { items.contains { $0.type == type.rawValue } }

    /// A snippet of `type` (by seed), never the one played last time when there's another; its index too.
    public func pick(_ type: NonVerbalType, seed: UInt64, avoiding last: Int?) -> (index: Int, item: Item)? {
        let candidates = items.indices.filter { items[$0].type == type.rawValue }
        guard !candidates.isEmpty else { return nil }
        let pool = candidates.count > 1 ? candidates.filter { $0 != last } : candidates
        let i = pool[Int(seed % UInt64(pool.count))]
        return (i, items[i])
    }

    /// The pack's breaths as a breath source (nil without any).
    public var breaths: SnippetBreaths? {
        let s = items.filter { $0.type == "breath" }.map(\.samples)
        return s.isEmpty ? nil : SnippetBreaths(snippets: s, sampleRate: 24_000)
    }
}

public enum NonVerbalSplice {
    /// [snippet][gap][speech]: the snippet loudness-matched to the speech (its speech RMS `levelDB` brought to the
    /// line's speech RMS + `relativeDB`), with equal-power fades.
    public static func splice(_ snippet: NonVerbalPack.Item, before speech: [Float], sampleRate: Int, gap: Double, fade: Double, relativeDB: Double) -> [Float] {
        var s = snippet.samples
        guard !s.isEmpty else { return speech }
        let line = StudioSound.speechRMS(speech, sampleRate: sampleRate)
        if line > 0 {
            let want = 20 * log10(Double(line)) + relativeDB
            let g = Float(pow(10, (want - snippet.levelDB) / 20))
            for i in s.indices { s[i] *= g }
        }
        PCM.applyEqualPowerFades(&s, sampleRate: sampleRate, seconds: fade)
        var out = s
        out.append(contentsOf: repeatElement(Float(0), count: PCM.silenceFrames(seconds: gap, sampleRate: sampleRate)))
        out.append(contentsOf: speech)
        return out
    }
}
