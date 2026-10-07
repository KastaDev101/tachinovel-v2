//
//  NarrationManifest.swift — the sentence timestamp file next to a narrated chapter's audio
//  (v1 experiments/tts/manifest.ts, schema 1, kind "tachinovel.narration").
//
//  Read for PC-narrated chapters (the "TachiNovel Audio" folder) and written for chapters prepared on the
//  iPhone ("Prepare for the drive"), so both play through the same audio path with sentence highlighting.
//  Segment tuples: [id, block, start, end, t0Ms, t1Ms, hash24, kindCode] (+ v2: reader paragraph).
//

import Foundation

/// Decoded narration timestamp manifest.
public struct NarrationTiming: Sendable {
    public struct Segment: Equatable, Sendable {
        public let id: Int
        public let block: Int
        public let start: Int
        public let end: Int
        /// Seconds, chapter time.
        public let t0: Double
        public let t1: Double
        /// Text hash of the sentence (v1 frontend), when present.
        public let hash: Int?
        /// Reader paragraph (v2 extension), when present.
        public let paragraph: Int?

        public init(id: Int, block: Int, start: Int, end: Int, t0: Double, t1: Double, hash: Int? = nil, paragraph: Int? = nil) {
            self.id = id
            self.block = block
            self.start = start
            self.end = end
            self.t0 = t0
            self.t1 = t1
            self.hash = hash
            self.paragraph = paragraph
        }
    }

    public let segments: [Segment]
    /// Chapter start inside the audio file (bundles), seconds.
    public let offset: Double
    public let duration: Double
    public let nextChapterPath: String?
    public let nextTitle: String?
    /// Previous chapter (v2 manifests), for "previous chapter" without the network.
    public let prevChapterPath: String?
    public let prevTitle: String?

    public init(segments: [Segment], offset: Double = 0, duration: Double, nextChapterPath: String? = nil, nextTitle: String? = nil,
                prevChapterPath: String? = nil, prevTitle: String? = nil) {
        self.segments = segments.sorted { $0.t0 < $1.t0 }
        self.offset = offset
        self.duration = duration
        self.nextChapterPath = nextChapterPath
        self.nextTitle = nextTitle
        self.prevChapterPath = prevChapterPath
        self.prevTitle = prevTitle
    }

    public init?(json: String) {
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any],
              obj["kind"] as? String == "tachinovel.narration" else { return nil }
        let audio = obj["audio"] as? [String: Any] ?? [:]
        let chapter = obj["chapter"] as? [String: Any] ?? [:]
        let next = chapter["next"] as? [String: Any]
        let prev = chapter["prev"] as? [String: Any]
        var segs: [Segment] = []
        for raw in obj["segments"] as? [[Any]] ?? [] {
            let n = raw.map { ($0 as? NSNumber)?.doubleValue }
            guard n.count >= 6, let id = n[0], let block = n[1], let start = n[2], let end = n[3], let t0 = n[4], let t1 = n[5] else { continue }
            let hash = n.count > 6 ? n[6].map { Int($0) } : nil
            let paragraph = n.count > 8 ? n[8].map { Int($0) } : nil
            segs.append(Segment(id: Int(id), block: Int(block), start: Int(start), end: Int(end), t0: t0 / 1000, t1: t1 / 1000,
                                hash: hash, paragraph: paragraph))
        }
        self.init(segments: segs,
                  offset: ((audio["offsetMs"] as? NSNumber)?.doubleValue ?? 0) / 1000,
                  duration: ((audio["durationMs"] as? NSNumber)?.doubleValue ?? 0) / 1000,
                  nextChapterPath: next?["chapterPath"] as? String,
                  nextTitle: next?["title"] as? String,
                  prevChapterPath: prev?["chapterPath"] as? String,
                  prevTitle: prev?["title"] as? String)
    }

    /// Segment playing at chapter time `t` (the last one starting at or before it), or nil before the first.
    public func segmentIndex(at t: Double) -> Int? {
        var lo = 0
        var hi = segments.count - 1
        var ans: Int?
        while lo <= hi {
            let mid = (lo + hi) / 2
            if segments[mid].t0 <= t {
                ans = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return ans
    }

    /// Chapter time of the first segment in `block` or after it ("listen from this paragraph").
    public func time(forBlock block: Int) -> Double? {
        segments.first { $0.block >= block }?.t0
    }

    /// Chapter time of the first segment in reader paragraph `paragraph` or after it (v2 manifests).
    public func time(forParagraph paragraph: Int) -> Double? {
        segments.first { ($0.paragraph ?? $0.block) >= paragraph }?.t0
    }

    /// What the chapter was rendered with and where it belongs (written into the manifest).
    public struct Source: Sendable {
        public var pluginId: String
        public var novelPath: String
        public var chapterPath: String
        public var title: String
        public var voice: String
        public var audioFile: String

        public init(pluginId: String, novelPath: String, chapterPath: String, title: String, voice: String, audioFile: String) {
            self.pluginId = pluginId
            self.novelPath = novelPath
            self.chapterPath = chapterPath
            self.title = title
            self.voice = voice
            self.audioFile = audioFile
        }
    }

    /// The manifest JSON for chapter audio rendered on the device.
    public func manifestJSON(source: Source, createdAt: Date = Date()) -> Data {
        var chapter: [String: Any] = ["pluginId": source.pluginId, "novelPath": source.novelPath, "chapterPath": source.chapterPath, "title": source.title]
        if let nextChapterPath {
            var next: [String: Any] = ["chapterPath": nextChapterPath]
            if let nextTitle { next["title"] = nextTitle }
            chapter["next"] = next
        }
        if let prevChapterPath {
            var prev: [String: Any] = ["chapterPath": prevChapterPath]
            if let prevTitle { prev["title"] = prevTitle }
            chapter["prev"] = prev
        }
        let ms = { (s: Double) -> Int in Int((s * 1000).rounded()) }
        let obj: [String: Any] = [
            "schemaVersion": 1,
            "kind": "tachinovel.narration",
            "createdAt": ISO8601DateFormatter().string(from: createdAt),
            "engine": ["name": "kokoro-82m-v1.0", "runtime": "FluidAudio Core ML (iPhone)", "voice": source.voice, "speed": 1, "frontendVersion": 1] as [String: Any],
            "chapter": chapter,
            "audio": ["file": source.audioFile, "format": "m4a", "sampleRate": 24_000, "offsetMs": ms(offset), "durationMs": ms(duration)] as [String: Any],
            "segments": segments.map { s -> [Int] in
                [s.id, s.block, s.start, s.end, ms(s.t0), ms(s.t1), s.hash ?? 0, 0, s.paragraph ?? s.block]
            },
        ]
        return (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data()
    }
}
