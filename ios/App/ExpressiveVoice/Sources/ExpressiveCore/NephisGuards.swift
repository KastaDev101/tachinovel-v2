//
//  NephisGuards.swift — the crash plan's guards (2026-10-12: build 321 was closed by iOS for memory during the Voice
//  test; the app used 3,150 MB of its ~3,376 MB when the studio speed test loaded a second studio of its own). The pure
//  parts, unit-tested on the Mac (NephisGuardsTests):
//  - NephisMemory: how much free memory (os_proc_available_memory) a load needs, and the refusal in plain words;
//  - MemoryHold: the wait after a memory warning before a released model loads again, doubling when it happens again;
//  - LoadGeneration: a release that a load still running sees, so the load keeps nothing;
//  - ModelOutput.floats: a Core ML output read safely, whatever its scalar type and memory layout;
//  - NephisFlow.studioMelFrames: the blueprint's output shape checked before it is read;
//  - StudioPace: her studio against the clock (2026-10-13: a studio pack's Voice test played nothing for over a minute).
//

import CoreML
import Foundation

public enum NephisMemory {
    /// What needs free memory: the studio speed test (a whole studio of its own), loading Nephis (her Pocket model; her
    /// studio's models load behind it with their own check), loading her studio once Pocket is up, and keeping it loaded.
    public enum Need: Equatable, Sendable {
        case studioTest
        case nephis
        case studioLoad
        case studioKeep
    }

    /// Free memory below which `need` is refused, MB. A studio takes ~300-550 MB, and its int8 vocoder is unpacked to
    /// fp16 while it loads (~233 MB more for a moment).
    public static func minimumMB(_ need: Need) -> Double {
        switch need {
        case .studioTest: return 1_000
        case .nephis: return 700
        case .studioLoad: return 1_000
        case .studioKeep: return 500
        }
    }

    /// `freeMB` falls short of what `need` takes. Unknown free memory (nil, or 0: the simulator, a Mac) never does.
    public static func short(_ need: Need, freeMB: Double?) -> Bool {
        guard let freeMB, freeMB > 0 else { return false }
        return freeMB < minimumMB(need)
    }

    /// The refusal in plain words, with the numbers. The studio's own (load, keep) are bypass reasons in her call log.
    public static func refusal(_ need: Need, freeMB: Double) -> String {
        let free = "\(grouped(freeMB)) MB free"
        let needs = "about \(grouped(minimumMB(need))) MB"
        switch need {
        case .studioTest:
            return "Not enough memory for the studio test: \(free), it needs \(needs). Swipe TachiNovel away, open it again and run the test."
        case .nephis:
            return "Not enough memory to load Nephis: \(free), she needs \(needs). Another voice reads meanwhile."
        case .studioLoad:
            return "memory: \(free), her studio needs \(needs)"
        case .studioKeep:
            return "memory: \(free)"
        }
    }

    /// 1234.4 → "1,234".
    static func grouped(_ x: Double) -> String {
        var digits = String(max(0, Int(x.rounded())))
        var out = ""
        while digits.count > 3 {
            out = "," + String(digits.suffix(3)) + out
            digits.removeLast(3)
        }
        return digits + out
    }
}

/// The wait after a memory warning before a released model loads again (KokoroService's releasedForMemory and
/// ReloadBackoff, for Nephis): `base` seconds, doubling each time it happens again, at most `cap`. A model that then
/// works for `calm` seconds without another release (`worked`) starts the count over.
public struct MemoryHold: Equatable, Sendable {
    public let base: TimeInterval
    public let cap: TimeInterval
    /// How long a model must work after its last release before the count starts over.
    public let calm: TimeInterval
    /// Releases since the count last started over, the end of the wait going on (nil: none) and the last release.
    public private(set) var releases = 0
    public private(set) var until: Date?
    public private(set) var lastRelease: Date?

    public init(base: TimeInterval = 60, cap: TimeInterval = 600, calm: TimeInterval = 300) {
        self.base = base
        self.cap = cap
        self.calm = calm
    }

    /// Released for memory at `now`: the wait it starts, in seconds.
    @discardableResult
    public mutating func release(at now: Date) -> TimeInterval {
        let wait = min(cap, base * pow(2, Double(min(releases, 30))))
        releases += 1
        until = now.addingTimeInterval(wait)
        lastRelease = now
        return wait
    }

    /// The model worked at `now`: once `calm` seconds have passed since its last release, the next release waits `base`
    /// again. Its first calls after a reload don't count: a phone near its limit would otherwise reload it every `base`.
    public mutating func worked(at now: Date) {
        guard releases > 0, let lastRelease, now.timeIntervalSince(lastRelease) >= calm else { return }
        releases = 0
    }

    /// Seconds left of the wait at `now` (0: the model may load).
    public func remaining(at now: Date) -> TimeInterval {
        guard let until else { return 0 }
        return max(0, until.timeIntervalSince(now))
    }

    public func holds(at now: Date) -> Bool { remaining(at: now) > 0 }

    /// The wait is over (its timer fired).
    public mutating func lift() { until = nil }

    /// The count starts over at once: the next release waits `base` again.
    public mutating func reset() { releases = 0 }
}

/// The releases a load still running must see (crash plan a3): a release used to leave a load running, which then
/// installed its models anyway, so memory stayed at 3,150 MB while everything read "unloaded".
public struct LoadGeneration: Equatable, Sendable {
    public private(set) var value = 0
    public init() {}
    /// The ticket of a load starting now.
    public var ticket: Int { value }
    /// A release: every load started before it keeps nothing.
    public mutating func release() { value &+= 1 }
    /// A load started with `ticket` may keep what it made.
    public func current(_ ticket: Int) -> Bool { ticket == value }
}

/// Her studio against the clock (2026-10-13: with a studio pack the Voice test played nothing for over a minute; every
/// call went through a studio running slower than real time, and each call's audio waits for the call before it). Between
/// its pieces a Listen call gives up on the studio (her plain sound for that call) once it can no longer finish at
/// `minimum` × real time; `dropAfter` such calls in a row switch the studio off for the rest of the session.
public struct StudioPace: Equatable, Sendable {
    /// × real time a Listen call's studio must keep: seconds of audio per second of its work, rests included.
    public static let minimum = 1.0
    /// Calls in a row under `minimum` that switch the studio off for the session.
    public static let dropAfter = 3

    /// Calls in a row so far under `minimum`.
    public private(set) var slowInARow = 0

    public init() {}

    /// A call's × real time if it finishes at its pace so far: `fixedMs` spent before the vocoder (resample, blueprint,
    /// refiner), `piecesMs` on its first `done` of `pieces` vocoder pieces (rests included), `audioMs` its audio. Before
    /// any piece (`done` 0) the vocoder's share is unknown: the work so far alone (the best the call can still do).
    public static func projected(audioMs: Double, fixedMs: Double, piecesMs: Double, done: Int, pieces: Int) -> Double {
        let left = done > 0 ? piecesMs / Double(done) * Double(max(0, pieces - done)) : 0
        return audioMs / max(1, fixedMs + piecesMs + left)
    }

    public static func tooSlow(_ timesRealTime: Double) -> Bool { timesRealTime < minimum }

    /// "0.4x real time" (two decimals under 0.1x).
    public static func words(_ timesRealTime: Double) -> String {
        String(format: timesRealTime < 0.1 ? "%.2fx real time" : "%.1fx real time", timesRealTime)
    }

    /// One Listen call the studio worked on, at `timesRealTime` (measured, or projected when it gave up mid-call): the
    /// reason to switch the studio off for the session once `dropAfter` calls in a row were too slow, else nil.
    public mutating func record(_ timesRealTime: Double) -> String? {
        slowInARow = Self.tooSlow(timesRealTime) ? slowInARow + 1 : 0
        return slowInARow >= Self.dropAfter ? "studio too slow: \(Self.words(timesRealTime))" : nil
    }
}

public enum ModelOutput {
    /// A Core ML output as Float, in its logical (shape) order: the studio's models output Float16, and an output can
    /// be laid out with padded strides, which reading `dataPointer` as a flat buffer gets wrong or reads past.
    public static func floats(_ a: MLMultiArray) -> [Float] {
        MLShapedArray<Float>(converting: a).scalars
    }
}

extension NephisFlow {
    /// How many frames the blueprint's own framing may differ from ours.
    public static let studioMelSlack = 4

    /// The blueprint's mel output, checked before it is read (crash plan a5): its frame count when the output is
    /// [1…, bands, frames'] with frames' within `studioMelSlack` of `frames` and holds exactly bands × frames' numbers;
    /// nil otherwise, and the call plays her plain sound instead of reading past the output.
    public static func studioMelFrames(shape: [Int], count: Int, bands: Int, frames: Int) -> Int? {
        guard shape.count >= 2, bands > 0, frames > 0, shape[shape.count - 2] == bands, let mf = shape.last, mf > 0,
              abs(mf - frames) <= studioMelSlack, count == bands * mf, shape.dropLast(2).allSatisfy({ $0 == 1 }) else { return nil }
        return mf
    }
}
