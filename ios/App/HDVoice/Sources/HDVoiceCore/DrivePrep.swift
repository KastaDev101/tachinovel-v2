//
//  DrivePrep.swift — "Prepare for the drive": the next chapters of a novel pre-rendered with Kokoro into
//  local audio files, so playback in the car never waits on synthesis (or on the network).
//
//  Platform-free parts, unit-tested on the CI host:
//    - DrivePrepPolicy: when preparing may run (on demand, or while charging / on Wi-Fi; never against
//      live narration or a hot phone);
//    - DriveCacheIndex: what is prepared (per novel and chapter, with the voice it was made with), the
//      storage used, eviction after listening and a size cap;
//    - DriveJob: one request ("the next 5 chapters of X"), persisted so a background task can continue it.
//  The app side (rendering, files, background tasks) is ios/App/App/Native/Narration/DrivePrep.swift.
//

import Foundation

/// When a preparation request may run.
public enum DrivePrepWhen: String, Sendable, Codable, CaseIterable {
    /// Right away (on demand), on any network and battery.
    case now
    /// While the iPhone is charging or on Wi-Fi (and not in Low Power Mode on battery).
    case chargingOrWifi
}

/// The device's situation, sampled by the app.
public struct DriveConditions: Equatable, Sendable {
    public var charging: Bool
    public var wifi: Bool
    public var lowPower: Bool
    public var thermalThrottled: Bool
    /// Kokoro is reading aloud right now: live narration gets the model first.
    public var liveNarration: Bool

    public init(charging: Bool, wifi: Bool, lowPower: Bool, thermalThrottled: Bool, liveNarration: Bool) {
        self.charging = charging
        self.wifi = wifi
        self.lowPower = lowPower
        self.thermalThrottled = thermalThrottled
        self.liveNarration = liveNarration
    }
}

public enum DrivePrepGate: Equatable, Sendable {
    case run
    /// Not now; the reason is shown to the user.
    case wait(String)

    public var reason: String? {
        if case .wait(let r) = self { return r }
        return nil
    }
}

public enum DrivePrepPolicy {
    /// Chapter counts offered by "Prepare for the drive".
    public static let chapterChoices = [1, 3, 5, 10]
    /// Storage cap for prepared audio (bytes); the oldest prepared chapters go first beyond it.
    public static let defaultCapBytes = 600 * 1_000_000

    public static func gate(_ when: DrivePrepWhen, _ c: DriveConditions) -> DrivePrepGate {
        if c.liveNarration { return .wait("Paused while Kokoro reads aloud") }
        if c.thermalThrottled { return .wait("Waiting for the iPhone to cool down") }
        switch when {
        case .now:
            return .run
        case .chargingOrWifi:
            if !c.charging && !c.wifi { return .wait("Waiting for charging or Wi-Fi") }
            if c.lowPower && !c.charging { return .wait("Waiting: Low Power Mode is on") }
            return .run
        }
    }
}

/// One prepared chapter (files live in the app's drive-audio folder).
public struct PreparedChapter: Codable, Equatable, Sendable {
    public var novelKey: String
    public var chapterPath: String
    public var title: String
    /// Kokoro voice it was rendered with: a different voice choice makes it stale.
    public var voice: String
    public var audioFile: String
    public var manifestFile: String
    public var bytes: Int
    public var durationMs: Double
    public var sentences: Int
    public var createdAt: Double

    public init(novelKey: String, chapterPath: String, title: String, voice: String, audioFile: String, manifestFile: String,
                bytes: Int, durationMs: Double, sentences: Int, createdAt: Double) {
        self.novelKey = novelKey
        self.chapterPath = chapterPath
        self.title = title
        self.voice = voice
        self.audioFile = audioFile
        self.manifestFile = manifestFile
        self.bytes = bytes
        self.durationMs = durationMs
        self.sentences = sentences
        self.createdAt = createdAt
    }

    public var id: String { DriveCacheIndex.id(novelKey: novelKey, chapterPath: chapterPath) }
}

/// The prepared chapters (index.json in the drive-audio folder).
public struct DriveCacheIndex: Codable, Equatable, Sendable {
    public static let schema = 1
    public var schemaVersion = DriveCacheIndex.schema
    public var chapters: [PreparedChapter] = []

    public init() {}

    public static func id(novelKey: String, chapterPath: String) -> String { "\(novelKey)\u{1F}\(chapterPath)" }

    /// The prepared chapter, if any; with `voice`, only one made with that voice.
    public func find(novelKey: String, chapterPath: String, voice: String? = nil) -> PreparedChapter? {
        chapters.first { $0.novelKey == novelKey && $0.chapterPath == chapterPath && (voice == nil || $0.voice == voice) }
    }

    /// Add or replace; returns the entry it replaced (whose files must go).
    @discardableResult
    public mutating func upsert(_ c: PreparedChapter) -> PreparedChapter? {
        if let i = chapters.firstIndex(where: { $0.id == c.id }) {
            let old = chapters[i]
            chapters[i] = c
            return old
        }
        chapters.append(c)
        return nil
    }

    @discardableResult
    public mutating func remove(novelKey: String, chapterPath: String) -> [PreparedChapter] {
        let gone = chapters.filter { $0.novelKey == novelKey && $0.chapterPath == chapterPath }
        chapters.removeAll { $0.novelKey == novelKey && $0.chapterPath == chapterPath }
        return gone
    }

    @discardableResult
    public mutating func removeNovel(_ key: String) -> [PreparedChapter] {
        let gone = chapters.filter { $0.novelKey == key }
        chapters.removeAll { $0.novelKey == key }
        return gone
    }

    @discardableResult
    public mutating func removeAll() -> [PreparedChapter] {
        let gone = chapters
        chapters = []
        return gone
    }

    public var totalBytes: Int { chapters.reduce(0) { $0 + $1.bytes } }

    public func chapters(novelKey: String) -> [PreparedChapter] { chapters.filter { $0.novelKey == novelKey } }

    public func bytes(novelKey: String) -> Int { chapters(novelKey: novelKey).reduce(0) { $0 + $1.bytes } }

    /// Oldest first until the total fits `cap`, never one of `keep` (ids of the request in progress).
    /// Returns what was removed.
    public mutating func trim(toBytes cap: Int, keep: Set<String> = []) -> [PreparedChapter] {
        var total = totalBytes
        guard total > cap else { return [] }
        var removed: [PreparedChapter] = []
        for c in chapters.sorted(by: { $0.createdAt < $1.createdAt }) where total > cap && !keep.contains(c.id) {
            removed.append(c)
            total -= c.bytes
        }
        let ids = Set(removed.map(\.id))
        chapters.removeAll { ids.contains($0.id) }
        return removed
    }
}

/// One "Prepare for the drive" request, persisted so it can continue in a background task.
public struct DriveJob: Codable, Equatable, Sendable {
    public var pluginId: String
    public var novelPath: String
    public var novelName: String
    public var coverUrl: String?
    /// How many chapters to have ready, starting where listening would resume.
    public var count: Int
    public var when: DrivePrepWhen
    public var voice: String
    public var createdAt: Double
    /// The next chapter to prepare (nil: start at the resume point; walking ends when it can't continue).
    public var cursor: String?
    /// Chapters done (prepared now or already prepared), in order.
    public var done: [String] = []
    public var titles: [String] = []
    public var failures: Int = 0
    public var lastError: String?
    /// No more chapters to prepare (all done, the last chapter, or a locked one).
    public var finished = false

    public init(pluginId: String, novelPath: String, novelName: String, coverUrl: String?, count: Int, when: DrivePrepWhen, voice: String, createdAt: Double) {
        self.pluginId = pluginId
        self.novelPath = novelPath
        self.novelName = novelName
        self.coverUrl = coverUrl
        self.count = max(1, min(count, 50))
        self.when = when
        self.voice = voice
        self.createdAt = createdAt
    }

    public var novelKey: String { "\(pluginId):\(novelPath)" }
    public var remaining: Int { finished ? 0 : max(0, count - done.count) }

    /// A chapter is ready; `next` is the following chapter (nil = none, or locked).
    public mutating func completed(_ chapterPath: String, title: String, next: String?) {
        if !done.contains(chapterPath) {
            done.append(chapterPath)
            titles.append(title)
        }
        failures = 0
        lastError = nil
        cursor = next
        if next == nil || done.count >= count { finished = true }
    }

    /// Too many failures in a row stop the request (it can be started again).
    public static let maxFailures = 3

    public mutating func failed(_ message: String) {
        failures += 1
        lastError = message
        if failures >= Self.maxFailures { finished = true }
    }
}
