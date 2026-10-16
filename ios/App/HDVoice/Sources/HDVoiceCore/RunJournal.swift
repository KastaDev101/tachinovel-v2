//
//  RunJournal.swift — how the app last ended, so a voice's crash sentinel counts only real crashes.
//
//  A voice's in-flight marker (CrashSentinel) only says that the process died while one of its calls ran. iOS ends
//  apps in many ways that leave the same marker: a swipe-away, an update, a reinstall or an AltStore refresh, closing
//  an app in the background for memory. Counting each of those as a crash switched Nephis off by mistake.
//
//  The journal notes what the app knew about itself while it ran, in one small file rewritten at every change (a file,
//  not UserDefaults: a killed process loses its unflushed defaults):
//    - who ran: version, build and the install (the app bundle's folder, new with every install, update or refresh);
//    - where it was: foreground or background, narration playing or not, memory warnings, the last stop;
//    - clean ends it saw: closed (applicationWillTerminate), its window closed (scene disconnect), put in the
//      background with the voice idle;
//    - a heartbeat every ~10 s while a voice works: chapter, voice, heat, memory;
//    - the phone's boot, so a restart (or a dead battery) isn't taken for a crash;
//    - the fatal signal the process died of, if any (CrashSignals: its own small file, written as the process dies).
//  At the next launch `classify` turns the last run's record (and a voice's marker) into a RunEndNote: what most likely
//  ended the run and whether it counts against the voice; RunEndWords says it in plain words for Diagnostics.
//
//  A run counts against a voice only when its call was in flight, the same install ran, the app didn't close properly,
//  and the process died of a memory fault (SIGSEGV, SIGBUS) off the main thread: how a crash inside Core ML ends the
//  app. A Swift trap or abort() (an app bug: the Oct 9 crash), a fault on the main thread (where no voice model runs),
//  or an end with no crash signal at all (a swipe-away, an update or refresh, iOS closing the app for memory, in the
//  background, for a hang or the CPU, a restart) is noted, never counted. Without the signal handler (it couldn't be
//  installed) the old rule applies: her call in flight while the app was in use, no clean end, no memory pressure.
//

import Foundation

/// The app that ran: another one at the next launch means an update, a reinstall or an AltStore refresh.
public struct RunIdentity: Sendable, Equatable, Codable {
    public var version: String
    public var build: String
    /// The install: the app bundle's container folder, which iOS creates anew for every install, update or refresh.
    public var install: String

    public init(version: String, build: String, install: String) {
        self.version = version
        self.build = build
        self.install = install
    }
}

/// The app's state, noted every ~10 s while a voice works (and at once when narration starts).
public struct RunHeartbeat: Sendable, Equatable, Codable {
    public var at: Date
    /// The chapter narration is on (its name as the app shows it).
    public var chapter: String?
    /// Who reads ("Nephis", "Kokoro", "Apple voice", "prepared audio").
    public var voice: String?
    /// ProcessInfo.ThermalState in a word: nominal, fair, serious or critical.
    public var thermal: String?
    /// The app's memory footprint, MB.
    public var memoryMB: Double?
    /// Memory left before iOS's limit for the app (os_proc_available_memory), MB.
    public var availableMB: Double?
    /// Voices with a call in flight ("Nephis", "Kokoro").
    public var busy: [String]
    public var foreground: Bool
    public var playing: Bool

    public init(at: Date, chapter: String? = nil, voice: String? = nil, thermal: String? = nil, memoryMB: Double? = nil,
                availableMB: Double? = nil, busy: [String] = [], foreground: Bool, playing: Bool) {
        self.at = at
        self.chapter = chapter
        self.voice = voice
        self.thermal = thermal
        self.memoryMB = memoryMB
        self.availableMB = availableMB
        self.busy = busy
        self.foreground = foreground
        self.playing = playing
    }
}

/// The fatal signal the process died of, noted by the app as it died (CrashSignals) and read back at the next launch.
public struct RunSignal: Sendable, Equatable, Codable {
    /// SIGSEGV, SIGBUS, SIGABRT, SIGTRAP or SIGILL.
    public var number: Int32
    /// When it came (nil: not noted).
    public var at: Date?
    /// On the main thread (the UI, narration's controller), where no voice model runs: voices run off it.
    public var mainThread: Bool

    public init(number: Int32, at: Date?, mainThread: Bool) {
        self.number = number
        self.at = at
        self.mainThread = mainThread
    }

    public var name: String {
        switch number {
        case SIGSEGV: return "SIGSEGV"
        case SIGBUS: return "SIGBUS"
        case SIGABRT: return "SIGABRT"
        case SIGTRAP: return "SIGTRAP"
        case SIGILL: return "SIGILL"
        default: return "signal \(number)"
        }
    }

    /// A memory fault off the main thread: how a crash inside Core ML (Apple's BNNS runtime) ends the app. A Swift trap
    /// or abort() (a fatalError, an exclusivity violation), or a fault on the main thread, is an app bug.
    public var isModelFault: Bool { (number == SIGSEGV || number == SIGBUS) && !mainThread }

    /// "SIGSEGV off the main thread"
    public var summary: String { "\(name) \(mainThread ? "on" : "off") the main thread" }

    /// The run's signal file: its first line names the run (its start, as `RunJournal.stamp` writes it), then one line
    /// "<signal> <unix seconds> <1|0>" per fatal signal noted; the first one ended the run. Nil: none, or another run's.
    static func parse(_ text: String, run: String) -> RunSignal? {
        let lines = text.split(separator: "\n")
        guard let first = lines.first, String(first) == run else { return nil }
        for line in lines.dropFirst() {
            let fields = line.split(separator: " ")
            guard fields.count == 3, let number = Int32(fields[0]), number > 0, let seconds = Int(fields[1]),
                  fields[2] == "0" || fields[2] == "1" else { continue }
            return RunSignal(number: number, at: seconds > 0 ? Date(timeIntervalSince1970: TimeInterval(seconds)) : nil,
                             mainThread: fields[2] == "1")
        }
        return nil
    }
}

/// A clean end the app saw itself.
public enum RunCleanEnd: String, Sendable, Codable {
    /// applicationWillTerminate: swiped away while it was running, or closed properly by iOS. Final.
    case closed
    /// Its window (the UIKit scene) was disconnected. Undone when the app is used again.
    case windowClosed
    /// It went to the background with no voice working; iOS may close it any time after that. Undone when used again.
    case backgroundIdle
}

/// One run of the app as the journal file keeps it.
public struct RunRecord: Sendable, Equatable, Codable {
    public var identity: RunIdentity
    public var startedAt: Date
    /// The last write: the latest moment the app is known to have been alive.
    public var updatedAt: Date
    public var foreground: Bool
    /// Narration playing (or loading its next chapter).
    public var playing: Bool
    public var backgroundSince: Date?
    public var end: RunCleanEnd?
    public var endAt: Date?
    /// The last time narration was stopped.
    public var stoppedAt: Date?
    public var memoryWarnings: Int
    public var lastMemoryWarningAt: Date?
    public var heartbeat: RunHeartbeat?
    /// The phone's boot (kern.boottime) when this run started: a later boot at the next launch means it restarted.
    public var bootedAt: Date?
    /// The fatal-signal handler watched this run (CrashSignals): an end without a noted signal was no crash.
    public var signalsWatched: Bool?
    /// The fatal signal this run died of: read back from its signal file at the next launch (nil: none noted).
    public var signal: RunSignal?

    public init(identity: RunIdentity, startedAt: Date, foreground: Bool, bootedAt: Date? = nil) {
        self.identity = identity
        self.startedAt = startedAt
        updatedAt = startedAt
        self.foreground = foreground
        playing = false
        backgroundSince = foreground ? nil : startedAt
        memoryWarnings = 0
        self.bootedAt = bootedAt
    }
}

/// What a voice's in-flight marker says: the call that ran when the process died.
public struct InFlightMarker: Sendable, Equatable, Codable {
    public var context: String
    /// When the call began (nil: a marker written by an older build).
    public var at: Date?
    /// The run it was written in (its journal record's `startedAt`; nil: unknown). A marker from a run before the last
    /// recorded one (a launch whose check never ran) can't be judged with the last run's record.
    public var run: Date?

    public init(context: String, at: Date?, run: Date? = nil) {
        self.context = context
        self.at = at
        self.run = run
    }
}

/// How a run ended, most likely.
public enum RunEndKind: String, Sendable, Codable, CaseIterable {
    /// The voice's model crashed: a memory fault off the main thread with its call in flight (or, without the signal
    /// handler, its call in flight while the app was in use). Counts against the voice.
    case crashed
    /// The app itself crashed: a Swift trap or abort(), or a memory fault on the main thread. An app bug, never held
    /// against a voice.
    case appError
    /// A memory fault off the main thread with no call of this voice in flight (the app-level view, or another voice's
    /// call): the app crashed, not inside this voice's model. Not counted.
    case fault
    /// Stopped without a crash signal while in use: iOS ended it (a hang, memory or CPU limits) or it was swiped away
    /// while suspended.
    case stopped
    /// The phone restarted or ran out of power.
    case restarted
    /// Another build or install ran before: an update, a reinstall or an AltStore refresh.
    case updated
    /// The app saw applicationWillTerminate (swiped away, or closed properly by iOS).
    case closed
    /// The app's window was disconnected.
    case windowClosed
    /// Closed by iOS after it went to the background with no voice working.
    case backgroundIdle
    /// Closed by iOS for memory (memory warnings or little memory left just before).
    case memory
    /// Closed by iOS in the background while nothing played.
    case background
    /// Ended without a word while in use, no voice call in flight, and no signal handler to tell a crash from a kill.
    case unexpected
    /// No readable record of the last run (the first launch with this check, or a damaged file).
    case unknown
}

/// The verdict on the last run, for one voice (with its marker) or for the app (without).
public struct RunEndNote: Sendable, Equatable, Codable {
    public var kind: RunEndKind
    /// Held against the voice.
    public var counted: Bool
    /// The voice's call was in flight when the process died.
    public var inFlight: Bool
    /// When it most likely ended (nil: unknown).
    public var at: Date?
    /// `at` is the last sign of life: the end came some time after it.
    public var approximate: Bool
    public var foreground: Bool?
    public var playing: Bool?
    /// What the voice was doing (the marker's context).
    public var context: String?
    public var heartbeat: RunHeartbeat?
    /// The build that ran then ("2.0.0 (57)").
    public var build: String?
    /// The fatal signal the process died of ("SIGABRT on the main thread"; nil: none noted).
    public var signal: String?

    public init(kind: RunEndKind, counted: Bool = false, inFlight: Bool = false, at: Date? = nil, approximate: Bool = false,
                foreground: Bool? = nil, playing: Bool? = nil, context: String? = nil, heartbeat: RunHeartbeat? = nil, build: String? = nil,
                signal: String? = nil) {
        self.kind = kind
        self.counted = counted
        self.inFlight = inFlight
        self.at = at
        self.approximate = approximate
        self.foreground = foreground
        self.playing = playing
        self.context = context
        self.heartbeat = heartbeat
        self.build = build
        self.signal = signal
    }

    /// An end iOS or the user caused while the app was idle or properly closed (not worth a Diagnostics problem line).
    public var isQuiet: Bool {
        switch kind {
        case .updated, .closed, .windowClosed, .backgroundIdle, .restarted: return true
        case .crashed, .appError, .fault, .stopped, .memory, .background, .unexpected, .unknown: return false
        }
    }
}

/// What points at a memory kill.
public struct RunEndPolicy: Sendable, Equatable {
    /// A memory warning this close (seconds) before the last sign of life.
    public var memoryWindow: TimeInterval
    /// Memory left under this (MB) at a heartbeat that close before the last sign of life.
    public var lowMemoryMB: Double
    /// A boot this much later (seconds) than the last run's is a restart (the boot time moves a little with clock fixes).
    public var bootSlack: TimeInterval

    public init(memoryWindow: TimeInterval = 120, lowMemoryMB: Double = 200, bootSlack: TimeInterval = 60) {
        self.memoryWindow = memoryWindow
        self.lowMemoryMB = lowMemoryMB
        self.bootSlack = bootSlack
    }
}

public enum RunEnds {
    /// How the last run (`previous`) ended, seen from this run (`identity`, the phone's boot `booted`) and a voice's
    /// marker (nil: no call in flight, or the app-level view).
    public static func classify(previous: RunRecord?, identity: RunIdentity, marker: InFlightMarker?, booted: Date? = nil,
                                policy: RunEndPolicy = RunEndPolicy()) -> RunEndNote {
        let inFlight = marker != nil
        guard let r = previous else {
            return RunEndNote(kind: .unknown, inFlight: inFlight, at: marker?.at, context: marker?.context)
        }
        if let run = marker?.run, run != r.startedAt {
            // Left by an earlier run than the last one recorded: how that run ended is not known.
            return RunEndNote(kind: .unknown, inFlight: true, at: marker?.at, context: marker?.context)
        }
        let lastSeen = [r.updatedAt, r.heartbeat?.at, marker?.at].compactMap { $0 }.max() ?? r.updatedAt
        var note = RunEndNote(kind: .unknown, inFlight: inFlight, at: lastSeen, approximate: !(inFlight || r.playing),
                              foreground: r.foreground, playing: r.playing, context: marker?.context, heartbeat: r.heartbeat,
                              build: "\(r.identity.version) (\(r.identity.build))")
        // Another build or install: an update, a reinstall, an AltStore refresh. Never a crash.
        if r.identity != identity {
            note.kind = .updated
            note.approximate = true
            return note
        }
        // Closed properly (applicationWillTerminate): final, whatever happened while the process wound down.
        if r.end == .closed {
            note.kind = .closed
            note.at = r.endAt ?? lastSeen
            note.approximate = false
            return note
        }
        // What killed the process, noted as it died. A memory fault off the main thread with the voice's call in
        // flight is how a crash inside Core ML ends the app; a Swift trap, abort() or a fault on the main thread is
        // the app's own bug, never the voice's.
        if let s = r.signal {
            note.signal = s.summary
            if let at = s.at {
                note.at = at
                note.approximate = false
            }
            if !s.isModelFault {
                note.kind = .appError
            } else if inFlight {
                note.kind = .crashed
                note.counted = true
            } else {
                note.kind = .fault
            }
            return note
        }
        // The phone booted after the run was last seen: it restarted or ran out of power.
        if let booted, let before = r.bootedAt, booted.timeIntervalSince(before) > policy.bootSlack, booted >= lastSeen {
            note.kind = .restarted
            note.approximate = true
            return note
        }
        // A soft clean end, unless the app worked after it (a voice's call began, or a heartbeat: playing or busy).
        if let end = r.end {
            let endAt = r.endAt ?? lastSeen
            let workedAfter = [marker?.at, r.heartbeat?.at].contains { ($0 ?? .distantPast) > endAt }
            if !workedAfter {
                switch end {
                case .closed: note.kind = .closed
                case .windowClosed: note.kind = .windowClosed
                case .backgroundIdle: note.kind = .backgroundIdle
                }
                note.at = endAt
                // Its window closed: that moment. Idle in the background: iOS closed it some time later.
                note.approximate = end == .backgroundIdle
                return note
            }
        }
        if memoryEvidence(r, lastSeen: lastSeen, policy: policy) {
            note.kind = .memory
            return note
        }
        if !r.foreground, !r.playing {
            note.kind = .background
            return note
        }
        // No crash signal: iOS stopped the app (a hang, memory or CPU limits) or it was swiped away while suspended.
        if r.signalsWatched == true {
            note.kind = .stopped
            return note
        }
        // No signal handler this run: the old rule (her call in flight while in use, nothing else to explain it).
        note.kind = inFlight ? .crashed : .unexpected
        note.counted = inFlight
        return note
    }

    /// A memory warning just before the end (or any since a suspended app went to the background: not playing, so no
    /// heartbeat proves it lived on after the warning), or little memory left at the last heartbeat.
    static func memoryEvidence(_ r: RunRecord, lastSeen: Date, policy: RunEndPolicy) -> Bool {
        if let warned = r.lastMemoryWarningAt {
            if lastSeen.timeIntervalSince(warned) <= policy.memoryWindow { return true }
            if !r.foreground, !r.playing, let since = r.backgroundSince, warned >= since { return true }
        }
        if let hb = r.heartbeat, let free = hb.availableMB, free > 0, free < policy.lowMemoryMB,
           lastSeen.timeIntervalSince(hb.at) <= policy.memoryWindow {
            return true
        }
        return false
    }
}

/// The app's run journal: one small JSON file, rewritten at every change, and the run's signal file (CrashSignals).
/// Thread-safe; the app drives it from main.
public final class RunJournal: @unchecked Sendable {
    public let directory: URL
    public let identity: RunIdentity
    /// The phone's boot (nil: unknown).
    public let booted: Date?
    /// The last run's record as it was left, with the fatal signal it died of (nil: none, or unreadable).
    public let previous: RunRecord?
    private let lock = NSLock()
    private var record: RunRecord?
    /// This run's signal file, open from `start` (watched runs only).
    private var signalFD: Int32 = -1

    private var fileURL: URL { directory.appendingPathComponent("run.json") }

    static func makeEncoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }

    static func makeDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }

    /// The run's signal file: the run's stamp, then what the handler notes as the process dies.
    static func signalURL(_ directory: URL) -> URL { directory.appendingPathComponent("signal.txt") }

    /// A run's name in its signal file: its start as run.json keeps it (ISO 8601, whole seconds).
    static func stamp(_ startedAt: Date) -> String { ISO8601DateFormatter().string(from: startedAt) }

    /// Reads the last run's record and the signal it died of; nothing is written until `start`.
    public init(directory: URL, identity: RunIdentity, booted: Date? = RunJournal.bootTime()) {
        self.directory = directory
        self.identity = identity
        self.booted = booted
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try? Data(contentsOf: directory.appendingPathComponent("run.json"))
        var last = data.flatMap { try? Self.makeDecoder().decode(RunRecord.self, from: $0) }
        if let startedAt = last?.startedAt, let text = try? String(contentsOf: Self.signalURL(directory), encoding: .utf8) {
            last?.signal = RunSignal.parse(text, run: Self.stamp(startedAt))
        }
        previous = last
    }

    deinit {
        if signalFD >= 0 { close(signalFD) }
    }

    /// When the phone booted (kern.boottime; nil where it can't be read).
    public static func bootTime() -> Date? {
        var tv = timeval()
        var size = MemoryLayout<timeval>.stride
        guard sysctlbyname("kern.boottime", &tv, &size, nil, 0) == 0, tv.tv_sec > 0 else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(tv.tv_sec) + TimeInterval(tv.tv_usec) / 1_000_000)
    }

    /// This run's record so far (nil before `start`).
    public var current: RunRecord? {
        lock.lock()
        defer { lock.unlock() }
        return record
    }

    /// How the last run ended, as far as the app can tell without a voice's marker.
    public var lastEnd: RunEndNote { classify(marker: nil) }

    public func classify(marker: InFlightMarker?, policy: RunEndPolicy = RunEndPolicy()) -> RunEndNote {
        RunEnds.classify(previous: previous, identity: identity, marker: marker, booted: booted, policy: policy)
    }

    /// This run begins (once, at launch): its record replaces the last run's file. `watch` gets this run's signal file
    /// (emptied and stamped with the run) and installs the fatal-signal handler on it (`CrashSignals.install`; nil: no
    /// handler, the old rule).
    public func start(foreground: Bool, now: Date = Date(), watch: ((Int32) -> Bool)? = nil) {
        lock.lock()
        defer { lock.unlock() }
        guard record == nil else { return }
        // Whole seconds: run.json's date (ISO 8601) and the signal file's stamp then name the run alike, whichever way
        // a formatter would round a fraction.
        let startedAt = Date(timeIntervalSince1970: now.timeIntervalSince1970.rounded(.down))
        var r = RunRecord(identity: identity, startedAt: startedAt, foreground: foreground, bootedAt: booted)
        if let watch {
            let fd = openSignalFile(run: startedAt)
            r.signalsWatched = fd >= 0 && watch(fd)
        }
        record = r
        save()
    }

    /// This run's signal file, emptied and stamped with the run before any signal can be noted in it: -1 on failure.
    private func openSignalFile(run: Date) -> Int32 {
        let fd = open(Self.signalURL(directory).path, O_WRONLY | O_CREAT | O_TRUNC | O_APPEND, 0o644)
        guard fd >= 0 else { return -1 }
        let line = Array((Self.stamp(run) + "\n").utf8)
        let written = line.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        guard written == line.count else {
            close(fd)
            return -1
        }
        signalFD = fd
        return fd
    }

    /// What the fatal-signal handler writes as the process dies (CrashSignals.note), for tests.
    func noteSignal(_ signo: Int32, at: Date, mainThread: Bool = false) {
        lock.lock()
        defer { lock.unlock() }
        CrashSignals.note(signo, fd: signalFD, time: Int(at.timeIntervalSince1970), mainThread: mainThread)
    }

    /// Foreground or background. Back in the foreground, the app is in use again: a soft clean end no longer applies.
    public func setForeground(_ foreground: Bool, now: Date = Date()) {
        change(now) { r in
            guard r.foreground != foreground else { return false }
            r.foreground = foreground
            r.backgroundSince = foreground ? nil : now
            if foreground { Self.clearSoftEnd(&r) }
            return true
        }
    }

    /// Narration started (or loads its next chapter) or stopped playing. Playing again undoes a soft clean end.
    public func setPlaying(_ playing: Bool, now: Date = Date()) {
        change(now) { r in
            guard r.playing != playing else { return false }
            r.playing = playing
            if playing { Self.clearSoftEnd(&r) }
            return true
        }
    }

    /// In the background with no voice working: iOS may close the app from here on, and that is no crash.
    public func idleInBackground(now: Date = Date()) {
        change(now) { r in
            guard !r.foreground, !r.playing, r.end == nil else { return false }
            r.end = .backgroundIdle
            r.endAt = now
            return true
        }
    }

    /// applicationWillTerminate (`.closed`, final) or the app's window disconnected (`.windowClosed`).
    public func closed(_ end: RunCleanEnd, now: Date = Date()) {
        change(now) { r in
            guard r.end != .closed else { return false }
            r.end = end
            r.endAt = now
            return true
        }
    }

    /// Narration was stopped (by the user, the sleep timer or a remote command).
    public func stopped(now: Date = Date()) {
        change(now) { r in
            r.stoppedAt = now
            return true
        }
    }

    public func memoryWarning(now: Date = Date()) {
        change(now) { r in
            r.memoryWarnings += 1
            r.lastMemoryWarningAt = now
            return true
        }
    }

    /// The heartbeat. Working (playing, or a voice's call running) undoes a soft clean end: iOS may disconnect the
    /// app's window while narration goes on in the background, and that must not excuse a crash later in the drive.
    public func beat(_ heartbeat: RunHeartbeat) {
        change(heartbeat.at) { r in
            r.heartbeat = heartbeat
            if heartbeat.playing || !heartbeat.busy.isEmpty { Self.clearSoftEnd(&r) }
            return true
        }
    }

    private static func clearSoftEnd(_ r: inout RunRecord) {
        guard let end = r.end, end != .closed else { return }
        r.end = nil
        r.endAt = nil
    }

    /// Apply `body` to this run's record and write it when it says something changed.
    private func change(_ now: Date, _ body: (inout RunRecord) -> Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard var r = record else { return }
        guard body(&r) else { return }
        r.updatedAt = max(r.updatedAt, now)
        record = r
        save()
    }

    private func save() {
        guard let record, let data = try? Self.makeEncoder().encode(record) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}

/// How a run ended, in plain words (Diagnostics, the Voice test, Settings › Voices).
public enum RunEndWords {
    /// "2:32 PM", "2:32 PM yesterday", "2:32 PM on Oct 9": the 12-hour clock.
    public static func time(_ date: Date, now: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let clock = DateFormatter()
        clock.locale = Locale(identifier: "en_US_POSIX")
        clock.timeZone = timeZone
        clock.dateFormat = "h:mm a"
        clock.amSymbol = "AM"
        clock.pmSymbol = "PM"
        let text = clock.string(from: date)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days <= 0 { return text }
        if days == 1 { return "\(text) yesterday" }
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX")
        day.timeZone = timeZone
        day.dateFormat = "MMM d"
        return "\(text) on \(day.string(from: date))"
    }

    /// The phone's heat in words, from ProcessInfo.ThermalState's name.
    public static func heat(_ thermal: String?) -> String? {
        switch thermal ?? "" {
        case "nominal": return "phone cool"
        case "fair": return "phone warm"
        case "serious": return "phone hot"
        case "critical": return "phone very hot"
        default: return nil
        }
    }

    /// "chapter 1026" from "Chapter 1026 - The Pass", "Ch. 12" or "1026: The Pass"; else the name in quotes.
    public static func chapter(_ name: String?) -> String? {
        guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        for pattern in [#"(?i)\b(?:chapter|ch\.?)\s*(\d+(?:\.\d+)?)"#, #"^(\d+(?:\.\d+)?)\b"#] {
            if let number = firstGroup(pattern, in: name) { return "chapter \(trimZeros(number))" }
        }
        let short = name.count > 40 ? "\(name.prefix(39))…" : name
        return "“\(short)”"
    }

    /// The chapter and the phone's heat from a heartbeat ("chapter 1026, phone warm").
    public static func details(_ heartbeat: RunHeartbeat?) -> [String] {
        guard let heartbeat else { return [] }
        return [chapter(heartbeat.chapter), heat(heartbeat.thermal)].compactMap { $0 }
    }

    /// One line for a run's end. `voice` names the voice whose marker it was ("Nephis").
    public static func line(_ note: RunEndNote, voice: String, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        let when = note.at.map { " \(note.approximate ? "after" : "at") \(Self.time($0, now: now, timeZone: timeZone))" } ?? ""
        let found = details(note.heartbeat)
        let tail = found.isEmpty ? "" : ", " + found.joined(separator: ", ")
        let base: String
        switch note.kind {
        case .crashed: base = "\(voice) crashed\(when)\(tail)"
        case .appError: base = "The app crashed\(when)\(tail) (an app bug)"
        case .fault: base = "The app crashed\(when)\(tail)"
        case .stopped: base = "The app was closed without crashing\(when)\(tail) (by iOS, or swiped away)"
        case .restarted: base = "The phone restarted or ran out of power\(when)"
        case .updated: base = "The app was updated, reinstalled or refreshed (AltStore)\(when)"
        case .closed: base = "The app was closed\(when) (swiped away, or closed by iOS)"
        case .windowClosed: base = "The app’s window was closed\(when)"
        case .backgroundIdle: base = "Closed by iOS in the background\(when), with no voice working"
        case .memory: base = note.foreground == true ? "Closed by iOS for memory\(when)\(tail)" : "Closed in the background for memory\(when)\(tail)"
        case .background: base = "Closed by iOS in the background\(when)\(tail)"
        case .unexpected: base = "The app closed unexpectedly\(when)\(tail)"
        case .unknown: base = "The app closed\(when) without a record of how"
        }
        if note.counted { return "\(base)." }
        return note.inFlight ? "\(base). Not counted against \(voice)." : "\(base)."
    }

    /// Why a voice is switched off: "Nephis was switched off after crashing twice in a row, last at 2:32 PM, chapter 1026,
    /// phone warm." Nil while it isn't.
    public static func offLine(_ record: CrashRecord, voice: String, now: Date = Date(), timeZone: TimeZone = .current) -> String? {
        guard record.disabled else { return nil }
        let times: String
        switch record.consecutive {
        case 1: times = "once"
        case 2: times = "twice"
        default: times = record.consecutive > 2 ? "\(record.consecutive) times" : "repeatedly"
        }
        let last = record.history.last { $0.counted }
        var parts: [String] = []
        if let at = last?.at ?? record.lastCrashAt { parts.append("last at \(Self.time(at, now: now, timeZone: timeZone))") }
        parts += details(last?.heartbeat)
        return "\(voice) was switched off after crashing \(times) in a row\(parts.isEmpty ? "" : ", " + parts.joined(separator: ", "))."
    }

    private static func firstGroup(_ pattern: String, in text: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)), m.numberOfRanges > 1,
              let r = Range(m.range(at: 1), in: text) else { return nil }
        return String(text[r])
    }

    /// "12.00" → "12", "12.50" → "12.5".
    private static func trimZeros(_ number: String) -> String {
        guard number.contains(".") else { return number }
        var s = number
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return s
    }
}
