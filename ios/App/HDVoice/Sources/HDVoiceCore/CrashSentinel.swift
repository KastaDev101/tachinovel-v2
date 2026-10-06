//
//  CrashSentinel.swift — contain a crash inside Core ML.
//
//  On iOS 26.4+ Apple's BNNS runtime can SIGSEGV inside Kokoro's Core ML stages (FluidAudio issues #817,
//  #844, #889: uncatchable, intermittent, any compute-unit routing). A crash takes the whole app down, so
//  it can only be detected on the next launch: a marker file is written before every synthesis call and
//  removed after it. A marker found at launch means the process died mid-synthesis.
//
//  Policy: after `disableAfter` such crashes in a row (no successful synthesis in between), Kokoro is turned
//  off and the Apple voice is used until the user turns it back on (Settings › Voices).
//
//  Files, not UserDefaults: defaults are cached in-process and flushed asynchronously, so a SIGSEGV loses
//  the write. A file write reaches the kernel immediately and survives a crash of the process.
//

import Foundation

public struct CrashRecord: Sendable, Equatable, Codable {
    public var consecutive: Int = 0
    public var total: Int = 0
    public var lastCrashAt: Date?
    /// What was being synthesized when it last crashed (voice, route, sentence length).
    public var lastContext: String?
    public var disabled: Bool = false

    public init() {}
}

public final class CrashSentinel: @unchecked Sendable {
    public let directory: URL
    public let disableAfter: Int
    private let lock = NSLock()
    private var record: CrashRecord
    private var clearedThisLaunch = false

    private var markerURL: URL { directory.appendingPathComponent("kokoro-inflight.txt") }
    private var recordURL: URL { directory.appendingPathComponent("kokoro-crashes.json") }

    public init(directory: URL, disableAfter: Int = 2) {
        self.directory = directory
        self.disableAfter = max(1, disableAfter)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let data = try? Data(contentsOf: directory.appendingPathComponent("kokoro-crashes.json")),
           let r = try? decoder.decode(CrashRecord.self, from: data) {
            record = r
        } else {
            record = CrashRecord()
        }
    }

    public var current: CrashRecord {
        lock.lock()
        defer { lock.unlock() }
        return record
    }

    /// Call once at launch, before any synthesis. Returns true if the previous run crashed mid-synthesis.
    @discardableResult
    public func checkAtLaunch(now: Date = Date()) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let context = try? String(contentsOf: markerURL, encoding: .utf8) else { return false }
        try? FileManager.default.removeItem(at: markerURL)
        record.consecutive += 1
        record.total += 1
        record.lastCrashAt = now
        record.lastContext = context
        if record.consecutive >= disableAfter { record.disabled = true }
        save()
        return true
    }

    /// Before a synthesis call.
    public func begin(_ context: String) {
        try? Data(context.utf8).write(to: markerURL)
    }

    /// After a synthesis call returned (successfully or with a Swift error: the process survived).
    public func end(success: Bool) {
        try? FileManager.default.removeItem(at: markerURL)
        guard success else { return }
        lock.lock()
        defer { lock.unlock() }
        // One success breaks the streak; write the record at most once per launch.
        if !clearedThisLaunch, record.consecutive > 0 {
            record.consecutive = 0
            save()
        }
        clearedThisLaunch = true
    }

    /// The user turned Kokoro back on.
    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        record.consecutive = 0
        record.disabled = false
        save()
    }

    private func save() {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(record) { try? data.write(to: recordURL, options: .atomic) }
    }
}
