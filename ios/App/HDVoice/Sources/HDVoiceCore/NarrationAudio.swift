//
//  NarrationAudio.swift — "Download with audio" (part 1, the engine): chapters rendered ahead in her voice into audio
//  files, played before anything else and never in an older voice (Kasta, 2026-10-15: "everything should be just the
//  most updated voice").
//
//  Platform-free parts, unit-tested on the CI host:
//    - NarrationVoiceKey: what a chapter's audio was made with (her narrator and dialogue packs, her studio, the packs'
//      chains with the delivery settings, the novel's pronunciation lexicon, the renderer's version). Audio whose key
//      isn't the current one is never played: Listen reads live, the file is deleted and the chapter queued again.
//    - NarrationAudioIndex (schema 2): the files, per novel and chapter, of two kinds: downloads (kept until deleted;
//      optionally after listening) and "Prepare for the drive" (deleted after listening, capped). Migrates the drive
//      folder's schema-1 index.
//    - RenderCheckpoint: a chapter being rendered, call by call, so an interrupted render goes on from the last paragraph
//      it finished (a fresh read there) instead of starting again.
//    - AudioRenderPolicy and HeatGate: when rendering may run (live reading always wins and 30 s after it; serious heat
//      pauses it until two minutes at fair or below; Low Power Mode on battery waits; charging/Wi-Fi as asked).
//    - NarrationAudioEstimate: minutes, megabytes and render time for chapters.
//  The app side: ios/App/App/Native/Narration/{NarrationAudioStore,ChapterAudioRenderer,DrivePrep}.swift.
//

import Foundation

/// The two kinds of chapter audio on the iPhone.
public enum NarrationAudioKind: String, Codable, Sendable, Equatable, CaseIterable {
    /// "Download with audio": kept until the user deletes it (or after listening, when they ask for that).
    case download
    /// "Prepare for the drive": deleted after listening, capped at DrivePrepPolicy.defaultCapBytes.
    case drive
}

// MARK: - Voice key

/// Stable short hashes (FNV-1a, 64 bit) for change detection; not for security.
public enum NarrationAudioHash {
    public static func fnv(_ s: String) -> String {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in s.utf8 {
            h ^= UInt64(b)
            h = h &* 0x0000_0100_0000_01b3
        }
        return String(h, radix: 16)
    }

    /// A JSON value's hash, independent of its key order (sorted keys); "none" for nil or a non-JSON value.
    public static func json(_ value: Any?) -> String {
        guard let value else { return "none" }
        if let s = value as? String { return fnv(s) }
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "none" }
        return fnv(String(decoding: data, as: UTF8.self))
    }
}

/// What chapter audio was made with. Two chapters' audio sound alike only when their keys are equal.
public struct NarrationVoiceKey: Equatable, Sendable {
    /// Bumped when the renderer's sound changes (the pipeline, finishing, encoding): older files are re-rendered.
    public static let rendererVersion = 1

    public enum Family: String, Sendable { case nephis, kokoro }

    public var family: Family
    /// Her narrator pack (its weights' hash and date), or Kokoro's voice.
    public var narrator: String
    /// Her dialogue pack, "none" without one.
    public var dialogue: String
    public var studio: Bool
    /// The packs' chains and the delivery settings that change the sound (hash).
    public var chain: String
    /// The novel's pronunciation lexicon (hash).
    public var lexicon: String
    public var renderer: Int

    public init(family: Family, narrator: String, dialogue: String = "none", studio: Bool = false, chain: String, lexicon: String,
                renderer: Int = NarrationVoiceKey.rendererVersion) {
        self.family = family
        self.narrator = narrator
        self.dialogue = dialogue
        self.studio = studio
        self.chain = chain
        self.lexicon = lexicon
        self.renderer = renderer
    }

    /// The key as stored with the audio.
    public var text: String {
        "\(family.rawValue)|r\(renderer)|n:\(narrator)|d:\(dialogue)|s:\(studio ? 1 : 0)|c:\(chain)|l:\(lexicon)"
    }

    /// The voice family of a stored key (keys older builds stored for her start with "nephis|"; anything else is Kokoro).
    public static func family(of stored: String) -> Family {
        stored.hasPrefix("nephis|") ? .nephis : .kokoro
    }
}

/// Whether stored audio may play, given the current key for its novel.
public enum NarrationAudioFreshness: Equatable, Sendable {
    /// Made with the current voice: plays.
    case fresh
    /// Made with an older version of the current voice: never played; deleted and rendered again.
    case stale
    /// Another voice (Kokoro audio while Nephis reads, or the other way round), or the current voice isn't known yet:
    /// not played, kept.
    case other

    public static func of(stored: String, current: NarrationVoiceKey?) -> NarrationAudioFreshness {
        guard let current else { return .other }
        if stored == current.text { return .fresh }
        return NarrationVoiceKey.family(of: stored) == current.family ? .stale : .other
    }
}

// MARK: - Index

/// One chapter's audio on the iPhone (files relative to the audio folder).
public struct NarrationAudioEntry: Codable, Equatable, Sendable {
    public var novelKey: String
    public var chapterPath: String
    public var title: String
    public var kind: NarrationAudioKind
    /// NarrationVoiceKey.text it was made with (or an older build's drive key).
    public var voice: String
    public var audioFile: String
    public var manifestFile: String
    public var bytes: Int
    public var durationMs: Double
    public var sentences: Int
    public var createdAt: Double
    /// The chapter's spoken text (hash), for the record.
    public var textHash: String?
    /// The novel's name (a re-render's request names it).
    public var novelName: String?

    public init(novelKey: String, chapterPath: String, title: String, kind: NarrationAudioKind, voice: String, audioFile: String,
                manifestFile: String, bytes: Int, durationMs: Double, sentences: Int, createdAt: Double, textHash: String? = nil,
                novelName: String? = nil) {
        self.novelKey = novelKey
        self.chapterPath = chapterPath
        self.title = title
        self.kind = kind
        self.voice = voice
        self.audioFile = audioFile
        self.manifestFile = manifestFile
        self.bytes = bytes
        self.durationMs = durationMs
        self.sentences = sentences
        self.createdAt = createdAt
        self.textHash = textHash
        self.novelName = novelName
    }

    /// The novel key's source and path ("pluginId:novelPath": a source id has no colon).
    public var source: (pluginId: String, novelPath: String) {
        guard let i = novelKey.firstIndex(of: ":") else { return (novelKey, "") }
        return (String(novelKey[..<i]), String(novelKey[novelKey.index(after: i)...]))
    }

    public var id: String { NarrationAudioIndex.id(novelKey: novelKey, chapterPath: chapterPath) }
}

/// The chapter audio on the iPhone (index.json in the audio folder).
public struct NarrationAudioIndex: Codable, Equatable, Sendable {
    public static let schema = 2
    public var schemaVersion = NarrationAudioIndex.schema
    public var entries: [NarrationAudioEntry] = []

    public init() {}

    public static func id(novelKey: String, chapterPath: String) -> String { "\(novelKey)\u{1F}\(chapterPath)" }

    /// A novel's folder and a chapter's file stem: short, fixed names (a chapter's audio is replaced in place).
    public static func folder(novelKey: String) -> String { "n" + NarrationAudioHash.fnv(novelKey) }
    public static func stem(chapterPath: String) -> String { "c" + NarrationAudioHash.fnv(chapterPath) }
    /// The work folder of a chapter being rendered.
    public static func workFolder(novelKey: String, chapterPath: String) -> String {
        "w" + NarrationAudioHash.fnv(id(novelKey: novelKey, chapterPath: chapterPath))
    }

    public func find(novelKey: String, chapterPath: String) -> NarrationAudioEntry? {
        entries.first { $0.novelKey == novelKey && $0.chapterPath == chapterPath }
    }

    /// Add or replace; returns the entry it replaced (its files go unless they are the same files).
    @discardableResult
    public mutating func upsert(_ e: NarrationAudioEntry) -> NarrationAudioEntry? {
        if let i = entries.firstIndex(where: { $0.id == e.id }) {
            let old = entries[i]
            // A drive request never turns a download into drive audio (it would then be deleted after listening).
            var e = e
            if old.kind == .download { e.kind = .download }
            entries[i] = e
            return old
        }
        entries.append(e)
        return nil
    }

    @discardableResult
    public mutating func remove(novelKey: String, chapterPath: String) -> [NarrationAudioEntry] {
        let gone = entries.filter { $0.novelKey == novelKey && $0.chapterPath == chapterPath }
        entries.removeAll { $0.novelKey == novelKey && $0.chapterPath == chapterPath }
        return gone
    }

    /// One novel's audio (or of one kind only).
    @discardableResult
    public mutating func removeNovel(_ key: String, kind: NarrationAudioKind? = nil) -> [NarrationAudioEntry] {
        let match = { (e: NarrationAudioEntry) in e.novelKey == key && (kind == nil || e.kind == kind) }
        let gone = entries.filter(match)
        entries.removeAll(where: match)
        return gone
    }

    @discardableResult
    public mutating func removeAll(kind: NarrationAudioKind? = nil) -> [NarrationAudioEntry] {
        let gone = entries.filter { kind == nil || $0.kind == kind }
        entries.removeAll { kind == nil || $0.kind == kind }
        return gone
    }

    public var totalBytes: Int { entries.reduce(0) { $0 + $1.bytes } }
    public func entries(novelKey: String) -> [NarrationAudioEntry] { entries.filter { $0.novelKey == novelKey } }
    public func bytes(novelKey: String) -> Int { entries(novelKey: novelKey).reduce(0) { $0 + $1.bytes } }
    public func bytes(kind: NarrationAudioKind) -> Int { entries.filter { $0.kind == kind }.reduce(0) { $0 + $1.bytes } }

    /// "Prepare for the drive" audio, oldest first, until it fits `cap`, never one of `keep`. Downloads have no cap.
    public mutating func trimDrive(toBytes cap: Int, keep: Set<String> = []) -> [NarrationAudioEntry] {
        var total = bytes(kind: .drive)
        guard total > cap else { return [] }
        var removed: [NarrationAudioEntry] = []
        for e in entries.filter({ $0.kind == .drive }).sorted(by: { $0.createdAt < $1.createdAt }) where total > cap && !keep.contains(e.id) {
            removed.append(e)
            total -= e.bytes
        }
        let ids = Set(removed.map(\.id))
        entries.removeAll { ids.contains($0.id) }
        return removed
    }

    /// The drive folder's schema-1 index as "Prepare for the drive" entries of this index, each with its files' move
    /// (from the drive folder's names to this folder's). Keys stay as they were: an older voice's audio is then stale
    /// and re-rendered like any other.
    public static func migrate(_ old: DriveCacheIndex) -> (index: NarrationAudioIndex, moves: [(from: String, to: String)]) {
        var index = NarrationAudioIndex()
        var moves: [(from: String, to: String)] = []
        for c in old.chapters {
            let dir = Self.folder(novelKey: c.novelKey)
            let name = Self.stem(chapterPath: c.chapterPath)
            let audio = "\(dir)/\(name).m4a"
            let manifest = "\(dir)/\(name).json"
            moves.append((c.audioFile, audio))
            moves.append((c.manifestFile, manifest))
            index.upsert(NarrationAudioEntry(novelKey: c.novelKey, chapterPath: c.chapterPath, title: c.title, kind: .drive, voice: c.voice,
                                             audioFile: audio, manifestFile: manifest, bytes: c.bytes, durationMs: c.durationMs,
                                             sentences: c.sentences, createdAt: c.createdAt))
        }
        return (index, moves)
    }

    /// Entries made with an older version of the current voice (`current(novelKey)`: nil = not known yet: kept).
    public func stale(current: (String) -> NarrationVoiceKey?) -> [NarrationAudioEntry] {
        entries.filter { NarrationAudioFreshness.of(stored: $0.voice, current: current($0.novelKey)) == .stale }
    }
}

// MARK: - Resumable render

/// A chapter being rendered (checkpoint.json in its work folder): the calls done so far, each in its own chunk file.
public struct RenderCheckpoint: Codable, Equatable, Sendable {
    public static let schema = 1

    public struct Call: Codable, Equatable, Sendable {
        /// The call's first sentence and how many it read.
        public var first: Int
        public var count: Int
        /// Frames of each of its sentences, in order (the real cuts: the sentence highlighting).
        public var frames: [Int]
        /// It ends a paragraph: a render can go on after it with a fresh read.
        public var endsParagraph: Bool
        /// Its chunk file (16-bit PCM at the checkpoint's rate).
        public var file: String
        /// Her studio and dialogue pack were used as asked (false: retried once, then kept).
        public var complete: Bool
        public var renderMs: Double

        public init(first: Int, count: Int, frames: [Int], endsParagraph: Bool, file: String, complete: Bool = true, renderMs: Double = 0) {
            self.first = first
            self.count = count
            self.frames = frames
            self.endsParagraph = endsParagraph
            self.file = file
            self.complete = complete
            self.renderMs = renderMs
        }

        public var totalFrames: Int { frames.reduce(0, +) }
    }

    public var schemaVersion = RenderCheckpoint.schema
    public var novelKey: String
    public var chapterPath: String
    /// The voice key and the chapter's text it was started with: anything else starts again.
    public var voice: String
    public var textHash: String
    public var sampleRate: Int
    public var sentences: Int
    public var calls: [Call] = []
    /// Calls kept with her studio or dialogue pack missing (after one retry each).
    public var incomplete = 0

    public init(novelKey: String, chapterPath: String, voice: String, textHash: String, sampleRate: Int, sentences: Int) {
        self.novelKey = novelKey
        self.chapterPath = chapterPath
        self.voice = voice
        self.textHash = textHash
        self.sampleRate = sampleRate
        self.sentences = sentences
    }

    /// The next sentence to render.
    public var next: Int { calls.last.map { $0.first + $0.count } ?? 0 }
    public var done: Bool { next >= sentences }
    public var totalFrames: Int { calls.reduce(0) { $0 + $1.totalFrames } }
    public var seconds: Double { Double(totalFrames) / Double(max(1, sampleRate)) }

    /// It fits a render of `voice` and `textHash` at `sampleRate` for `sentences` sentences.
    public func matches(voice: String, textHash: String, sampleRate: Int, sentences: Int) -> Bool {
        self.voice == voice && self.textHash == textHash && self.sampleRate == sampleRate && self.sentences == sentences
            && schemaVersion == Self.schema
    }

    /// Going on after an interruption: back to the last call that ended a paragraph (the render continues there with a
    /// fresh read, so no join is made mid-paragraph). Returns the calls dropped (their chunk files go).
    public mutating func rollBackToParagraph() -> [Call] {
        guard let keep = calls.lastIndex(where: \.endsParagraph) else {
            defer { calls = [] }
            return calls
        }
        let dropped = Array(calls[(keep + 1)...])
        calls.removeLast(calls.count - keep - 1)
        return dropped
    }

    /// Each sentence's start and end in the finished file (seconds), from the calls' real cuts.
    public func times() -> [(t0: Double, t1: Double)] {
        let rate = Double(max(1, sampleRate))
        var out: [(t0: Double, t1: Double)] = []
        var at = 0
        for c in calls {
            for f in c.frames {
                out.append((Double(at) / rate, Double(at + f) / rate))
                at += f
            }
        }
        return out
    }
}

// MARK: - When rendering may run

/// Serious heat pauses rendering; it goes on after two minutes at fair or below (the phone cools first, then stays cool).
public struct HeatGate: Equatable, Sendable {
    /// ProcessInfo.ThermalState raw values: nominal 0, fair 1, serious 2, critical 3.
    public static let pauseAt = 2
    public static let coolFor = 120.0

    public private(set) var paused = false
    public private(set) var coolSince: Double?

    public init() {}

    /// The phone's heat now; true when rendering may run.
    @discardableResult
    public mutating func update(thermal: Int, now: Double) -> Bool {
        if thermal >= Self.pauseAt {
            paused = true
            coolSince = nil
            return false
        }
        guard paused else { return true }
        let since = coolSince ?? now
        coolSince = since
        if now - since >= Self.coolFor {
            paused = false
            coolSince = nil
            return true
        }
        return false
    }

    /// Seconds until it may run again (while cooling at fair or below), nil when not waiting on time.
    public func remaining(now: Double) -> Double? {
        guard paused, let since = coolSince else { return nil }
        return max(0, Self.coolFor - (now - since))
    }
}

/// The device's situation for rendering, sampled by the app.
public struct AudioRenderConditions: Equatable, Sendable {
    public var charging: Bool
    public var wifi: Bool
    public var online: Bool
    public var lowPower: Bool
    /// Live speech is being read aloud (Listen in speech mode, the Voice speed test): it always wins.
    public var live: Bool
    /// Seconds since live speech last stopped (nil: none since launch).
    public var sinceLive: Double?
    /// A downloaded chapter is about to end and the next one goes live: her engine warms for it.
    public var handoff: Bool
    /// Her model can't be used for a while (resting after a memory warning, the studio test): seconds left, if known.
    public var voiceBlocked: String?

    public init(charging: Bool, wifi: Bool, online: Bool, lowPower: Bool, live: Bool, sinceLive: Double?, handoff: Bool = false,
                voiceBlocked: String? = nil) {
        self.charging = charging
        self.wifi = wifi
        self.online = online
        self.lowPower = lowPower
        self.live = live
        self.sinceLive = sinceLive
        self.handoff = handoff
        self.voiceBlocked = voiceBlocked
    }
}

public enum AudioRenderPolicy {
    /// After live speech stops, rendering waits this long (a pause to check something shouldn't start it).
    public static let afterLive = 30.0

    /// Whether a request made `when` may render now. `heatOK`: HeatGate's answer; `needsText`: its next chapter's text
    /// isn't saved yet (the network is needed).
    public static func gate(_ when: DrivePrepWhen, _ c: AudioRenderConditions, heatOK: Bool, needsText: Bool) -> DrivePrepGate {
        if c.live { return .wait("Paused while you listen") }
        if let since = c.sinceLive, since < afterLive { return .wait("Resuming shortly after listening") }
        if c.handoff { return .wait("Paused while the next chapter gets ready") }
        if !heatOK { return .wait("Waiting for the iPhone to cool down") }
        if let why = c.voiceBlocked { return .wait(why) }
        if c.lowPower && !c.charging { return .wait("Waiting: Low Power Mode is on") }
        switch when {
        case .now:
            break
        case .chargingOrWifi:
            if !c.charging && !c.wifi { return .wait("Waiting for charging or Wi-Fi") }
        case .charging:
            if !c.charging { return .wait("Waiting for charging") }
        }
        if needsText && !c.online { return .wait("Waiting for the internet") }
        return .run
    }
}

// MARK: - Estimates

public enum NarrationAudioEstimate {
    /// Her pace: about 0.38 s a word with her pauses on top; ~14 characters a second of finished audio.
    public static let charactersPerSecond = 14.0
    /// A chapter's length when nothing better is known (minutes).
    public static let defaultChapterMinutes = 12.0
    /// AAC bit rates: her studio's 44.1 kHz chapters, and 24 kHz ones (Kokoro, her voice without the studio).
    public static let studioBitRate = 128_000
    public static let plainBitRate = 32_000

    /// Megabytes a minute at `bitRate` (128 kbps ≈ 0.96 MB a minute).
    public static func megabytesPerMinute(bitRate: Int) -> Double { Double(bitRate) * 60 / 8 / 1_000_000 }

    public static func minutes(characters: Int) -> Double { Double(max(0, characters)) / charactersPerSecond / 60 }

    /// For `chapters` chapters: their minutes (from `characters` when known, else `averageMinutes` each), megabytes at
    /// `bitRate`, and the render time at `speedX` × real time (audio seconds per render second; 1 when unknown).
    public static func estimate(chapters: Int, characters: Int? = nil, averageMinutes: Double? = nil, bitRate: Int = studioBitRate,
                                speedX: Double? = nil) -> (minutes: Double, megabytes: Double, renderMinutes: Double) {
        let minutes = characters.map { Self.minutes(characters: $0) } ?? Double(max(0, chapters)) * (averageMinutes ?? defaultChapterMinutes)
        let x = speedX.flatMap { $0.isFinite && $0 > 0.05 ? $0 : nil } ?? 1
        return (minutes, minutes * megabytesPerMinute(bitRate: bitRate), minutes / x)
    }

    /// The measured render speed, a moving average (newest call weighted `weight`).
    public static func blend(_ old: Double?, _ new: Double, weight: Double = 0.2) -> Double {
        guard new.isFinite, new > 0 else { return old ?? 1 }
        guard let old, old.isFinite, old > 0 else { return new }
        return old * (1 - weight) + new * weight
    }
}
