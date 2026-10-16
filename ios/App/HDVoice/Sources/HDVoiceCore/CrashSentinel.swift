//
//  CrashSentinel.swift — contain a crash inside a voice's model (Kokoro's Core ML stages, Nephis's Pocket TTS).
//
//  On iOS 26.4+ Apple's BNNS runtime can SIGSEGV inside Core ML (FluidAudio issues #817, #844, #889: uncatchable,
//  intermittent, any compute-unit routing). A crash takes the whole app down, so it can only be detected on the next
//  launch: a marker file is written before every model call and removed after it. A marker found at launch means the
//  process died while a call ran.
//
//  The process dies with a marker in place in many other ways too: a swipe-away, an update or an AltStore refresh,
//  iOS closing the app for memory or in the background, a phone restart, an app bug while her call runs. So the
//  marker alone is not a crash: the app's run journal (RunJournal) says how the last run ended and what signal killed
//  it (CrashSignals), and only a memory fault (SIGSEGV, SIGBUS) off the main thread with the call in flight counts
//  (RunEnds.classify; same install, not closed properly). Every other end with a call in flight is noted (`lastEnd`,
//  `history`, `notCounted`) and never counted.
//
//  Policy: after `disableAfter` counted crashes in a row (no successful call in between), the voice is switched off
//  until the user turns it back on (Settings › Voices, the Voice test).
//
//  Files, not UserDefaults: defaults are cached in-process and flushed asynchronously, so a SIGSEGV loses the write. A
//  file write reaches the kernel immediately and survives a crash of the process.
//

import Foundation

public struct CrashRecord: Sendable, Equatable, Codable {
    public var consecutive: Int = 0
    public var total: Int = 0
    public var lastCrashAt: Date?
    /// What was being synthesized when it last crashed (voice, route, sentence length).
    public var lastContext: String?
    public var disabled: Bool = false
    /// Ends with a call in flight that weren't held against the voice (updates, swipe-aways, memory, unsure).
    public var notCounted: Int = 0
    /// The last end with a call of this voice in flight, counted or not.
    public var lastEnd: RunEndNote?
    /// The last few of those, oldest first.
    public var history: [RunEndNote] = []
    /// The build that last checked this record ("2.0.0 (57)"): a new build starts the streak over.
    public var build: String?

    public static let historyLimit = 10

    public init() {}

    enum CodingKeys: String, CodingKey {
        case consecutive, total, lastCrashAt, lastContext, disabled, notCounted, lastEnd, history, build
    }

    /// Records written by builds before `notCounted`/`lastEnd`/`history`/`build` decode as they were.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        consecutive = try c.decodeIfPresent(Int.self, forKey: .consecutive) ?? 0
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? 0
        lastCrashAt = try c.decodeIfPresent(Date.self, forKey: .lastCrashAt)
        lastContext = try c.decodeIfPresent(String.self, forKey: .lastContext)
        disabled = try c.decodeIfPresent(Bool.self, forKey: .disabled) ?? false
        notCounted = try c.decodeIfPresent(Int.self, forKey: .notCounted) ?? 0
        lastEnd = try? c.decodeIfPresent(RunEndNote.self, forKey: .lastEnd)
        history = (try? c.decodeIfPresent([RunEndNote].self, forKey: .history)) ?? []
        build = try c.decodeIfPresent(String.self, forKey: .build)
    }
}

public final class CrashSentinel: @unchecked Sendable {
    public let directory: URL
    public let disableAfter: Int
    /// The voice in plain words ("Nephis", "Kokoro").
    public let name: String
    private let lock = NSLock()
    private var record: CrashRecord
    private var clearedThisLaunch = false
    /// Calls running now: the marker goes only when the last one returns (Nephis's next call starts while the one
    /// before decodes).
    private var calls = 0
    /// This run's journal record (its `startedAt`), written into every marker.
    private var run: Date?

    private var markerURL: URL { directory.appendingPathComponent("kokoro-inflight.txt") }
    private var recordURL: URL { directory.appendingPathComponent("kokoro-crashes.json") }

    public init(directory: URL, name: String = "The voice", disableAfter: Int = 2) {
        self.directory = directory
        self.name = name
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

    /// A call of this voice is running now.
    public var inFlight: Bool {
        lock.lock()
        defer { lock.unlock() }
        return calls > 0
    }

    /// What the launch check found.
    public struct LaunchCheck: Sendable, Equatable {
        /// How the last run ended, when a call of this voice was in flight then (counted or not); nil otherwise.
        public var note: RunEndNote?
        /// This build is new to the record (an update, or the first launch with this check): the streak started over
        /// and a voice switched off by crashes was turned back on.
        public var turnedBackOn = false

        public init(note: RunEndNote? = nil, turnedBackOn: Bool = false) {
            self.note = note
            self.turnedBackOn = turnedBackOn
        }
    }

    /// Call once at launch, after the journal started this run's record and before any call: the last run's marker (if
    /// any) judged with the journal's record of how that run ended.
    @discardableResult
    public func checkAtLaunch(_ journal: RunJournal, now: Date = Date(), policy: RunEndPolicy = RunEndPolicy()) -> LaunchCheck {
        checkAtLaunch(previous: journal.previous, identity: journal.identity, run: journal.current?.startedAt, booted: journal.booted,
                      now: now, policy: policy)
    }

    /// `run`: this run's journal record (`startedAt`), written into this run's markers. `booted`: the phone's boot now.
    @discardableResult
    public func checkAtLaunch(previous: RunRecord?, identity: RunIdentity, run: Date? = nil, booted: Date? = nil, now: Date = Date(),
                              policy: RunEndPolicy = RunEndPolicy()) -> LaunchCheck {
        lock.lock()
        defer { lock.unlock() }
        self.run = run
        var check = LaunchCheck()
        // A new build is a fresh start: crashes of the build before don't make a streak with this one's (an update may
        // carry the fix), and a voice that build switched off gets its chance again.
        let build = "\(identity.version) (\(identity.build))"
        if record.build != build {
            check.turnedBackOn = record.disabled
            record.consecutive = 0
            record.disabled = false
            record.build = build
            save()
        }
        guard let marker = readMarker() else { return check }
        try? FileManager.default.removeItem(at: markerURL)
        let note = RunEnds.classify(previous: previous, identity: identity, marker: marker, booted: booted, policy: policy)
        if note.counted {
            record.consecutive += 1
            record.total += 1
            record.lastCrashAt = note.at ?? now
            record.lastContext = note.context
            if record.consecutive >= disableAfter { record.disabled = true }
        } else {
            record.notCounted += 1
        }
        record.lastEnd = note
        record.history.append(note)
        if record.history.count > CrashRecord.historyLimit { record.history.removeFirst(record.history.count - CrashRecord.historyLimit) }
        save()
        check.note = note
        return check
    }

    /// Before a model call.
    public func begin(_ context: String, now: Date = Date()) {
        lock.lock()
        defer { lock.unlock() }
        calls += 1
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = (try? encoder.encode(InFlightMarker(context: context, at: now, run: run))) ?? Data(context.utf8)
        try? data.write(to: markerURL)
    }

    /// After a model call returned (successfully or with a Swift error: the process survived).
    public func end(success: Bool) {
        lock.lock()
        defer { lock.unlock() }
        calls = max(0, calls - 1)
        if calls == 0 { try? FileManager.default.removeItem(at: markerURL) }
        guard success else { return }
        // One success breaks the streak; write the record at most once per launch.
        if !clearedThisLaunch, record.consecutive > 0 {
            record.consecutive = 0
            save()
        }
        clearedThisLaunch = true
    }

    /// The user turned the voice back on.
    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        record.consecutive = 0
        record.disabled = false
        save()
    }

    /// The last end with a call in flight, in plain words (nil: none yet).
    public func lastEndLine(now: Date = Date(), timeZone: TimeZone = .current) -> String? {
        current.lastEnd.map { RunEndWords.line($0, voice: name, now: now, timeZone: timeZone) }
    }

    /// Why the voice is switched off, in plain words (nil while it isn't).
    public func offLine(now: Date = Date(), timeZone: TimeZone = .current) -> String? {
        RunEndWords.offLine(current, voice: name, now: now, timeZone: timeZone)
    }

    /// The marker left by the last run: JSON from this build on, plain context text from older builds.
    private func readMarker() -> InFlightMarker? {
        guard let data = try? Data(contentsOf: markerURL) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let m = try? decoder.decode(InFlightMarker.self, from: data) { return m }
        return InFlightMarker(context: String(decoding: data, as: UTF8.self), at: nil)
    }

    private func save() {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(record) { try? data.write(to: recordURL, options: .atomic) }
    }
}
