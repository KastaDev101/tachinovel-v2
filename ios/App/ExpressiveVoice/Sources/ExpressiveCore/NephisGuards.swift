//
//  NephisGuards.swift — the crash plan's guards (2026-10-12: build 321 was closed by iOS for memory during the Voice
//  test; the app used 3,150 MB of its ~3,376 MB when the studio speed test loaded a second studio of its own). The pure
//  parts, unit-tested on the Mac (NephisGuardsTests):
//  - NephisMemory: how much free memory (os_proc_available_memory) a load needs, and the refusal in plain words;
//  - MemoryHold: the wait after a memory warning before a released model loads again, doubling when it happens again;
//  - LoadGeneration: a release that a load still running sees, so the load keeps nothing;
//  - ModelOutput.floats: a Core ML output read safely, whatever its scalar type and memory layout;
//  - NephisFlow.studioMelFrames: the blueprint's output shape checked before it is read;
//  - StudioPace: her studio against the clock (2026-10-13: a studio pack's Voice test played nothing for over a minute);
//  - StudioBudget: her studio on every Listen call it can afford, from its measured speed (2026-10-15);
//  - NephisStudioSwitch: the "Her studio" switch, on by default for every pack with a studio (2026-10-15).
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
        /// Her dialogue pack's Pocket model (a second flow model; Mimi, her studio and the de-wind cleaner are shared):
        /// loaded behind her studio, and dropped first when memory runs low (before her studio).
        case dialogueLoad
        case dialogueKeep
    }

    /// Free memory below which `need` is refused, MB. A studio takes ~300-550 MB, and its int8 vocoder is unpacked to
    /// fp16 while it loads (~233 MB more for a moment).
    public static func minimumMB(_ need: Need) -> Double {
        switch need {
        case .studioTest: return 1_000
        case .nephis: return 700
        case .studioLoad: return 1_000
        case .studioKeep: return 500
        case .dialogueLoad: return 900
        case .dialogueKeep: return 550
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
        case .studioKeep, .dialogueKeep:
            return "memory: \(free)"
        case .dialogueLoad:
            return "memory: \(free), her dialogue voice needs \(needs)"
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

/// Her studio on every Listen call it can afford (2026-10-15: build 363's speed test on an iPhone 16 skipped it on 3 of 6
/// calls as "hurry", fewer than `cushion` seconds buffered, while it ran at 23-47x real time; a skipped call is her plain
/// Mimi sound, with its clicks and without the pack's studio EQ, so the read changed sound from sentence to sentence).
///
/// The rule: a call gets the studio when its cost (the call's audio, estimated from its text, over the studio's speed)
/// is at most `share` of the time before the call must play (the audio buffered ahead of playback), that time never
/// counted under `minimumSlack`. So the first call of a read (nothing buffered) still gets it when it costs at most
/// `share` x `minimumSlack` (0.5 s): her first audio comes that much later at most. When the studio is genuinely slow
/// (its speed under `fastFrom`, or a hot or low-power phone: `throttled`) the old rule alone: the studio only with
/// `cushion` seconds buffered. The old rule always still holds, so no call skips it that skipped nothing before.
///
/// Its speed: measured on the calls it renders (`record`, x real time); before any, `seedX` (a conservative guess), or
/// the speed last measured on this phone with this pack, discounted by `rememberedShare` (a cooler or hotter phone).
public struct StudioBudget: Equatable, Sendable {
    /// Seconds buffered ahead from which a call gets the studio whatever it costs (the rule before 2026-10-15).
    public static let cushion = 6.0
    /// Share of the time before the call must play that its studio may take (the rest is for her generation and decode).
    public static let share = 0.5
    /// Seconds the time before a call is never counted under (the first call of a read, a near-empty buffer).
    public static let minimumSlack = 1.0
    /// x real time under which the studio counts as slow: the old rule alone.
    public static let fastFrom = 4.0
    /// x real time assumed before any call measured it (the iPhone 16 measured 23-47x; an older phone may be far slower).
    public static let seedX = 8.0
    /// Share of the speed remembered from an earlier session that a new one starts from.
    public static let rememberedShare = 0.5
    /// Her pace for a call's audio from its text, characters per second: slower than her real ~14, so the cost estimate
    /// errs long.
    public static let charactersPerSecond = 12.0
    /// A faster call than the estimate moves it this share of the way up (a slower one sets it at once).
    public static let riseShare = 0.3

    /// The studio's speed measured so far (x real time), or the remembered one (discounted); nil: nothing known.
    public private(set) var measuredX: Double?

    /// `rememberedX`: the speed last measured on this phone with this pack (an earlier session), if any.
    public init(rememberedX: Double? = nil) {
        if let x = rememberedX, x.isFinite, x > 0 { measuredX = x * Self.rememberedShare }
    }

    /// The speed the rule plans with.
    public var estimateX: Double { measuredX ?? Self.seedX }

    /// A call the studio worked on, at `timesRealTime` (measured, or projected when it gave up mid-call). Slower than the
    /// estimate: the estimate at once (heat, a busy phone); faster: a share of the way up.
    public mutating func record(_ timesRealTime: Double) {
        guard timesRealTime.isFinite, timesRealTime > 0 else { return }
        guard let m = measuredX else { measuredX = timesRealTime; return }
        measuredX = timesRealTime < m ? timesRealTime : m + (timesRealTime - m) * Self.riseShare
    }

    /// A call's audio estimated from its text, seconds.
    public static func audioSeconds(characters: Int) -> Double { Double(max(1, characters)) / charactersPerSecond }

    /// The studio's estimated work on a call of `characters`, seconds.
    public func cost(characters: Int) -> Double { Self.audioSeconds(characters: characters) / max(0.01, estimateX) }

    /// The studio for a call of `characters` with `ahead` seconds buffered ahead of playback. `throttled`: the phone is
    /// hot (serious heat or worse) or in Low Power Mode.
    public func use(characters: Int, ahead: Double, throttled: Bool) -> Bool {
        if ahead >= Self.cushion { return true }
        guard !throttled, estimateX >= Self.fastFrom else { return false }
        return cost(characters: characters) <= Self.share * max(ahead, Self.minimumSlack)
    }
}

/// The "Her studio" switch (Settings › Voices › Voice test), per pack (2026-10-15: a studio pack played her plain sound
/// because the switch, one setting for every pack, was off). On by default for every pack; the user's off is kept for that
/// pack (`offKey`: the packs switched off) until it is installed again, which turns it on. The old single setting
/// ("nephisStudio") no longer decides anything.
public enum NephisStudioSwitch {
    public static let offKey = "nephisStudioOffPacks"

    /// The switch for `pack` (nil: no pack installed, on).
    public static func isOn(pack: String?, defaults: UserDefaults) -> Bool {
        guard let pack else { return true }
        return !offPacks(defaults).contains(pack)
    }

    /// The user's choice for `pack`.
    public static func set(_ on: Bool, pack: String?, defaults: UserDefaults) {
        guard let pack else { return }
        var off = offPacks(defaults)
        if on { off.remove(pack) } else { off.insert(pack) }
        defaults.set(off.sorted(), forKey: offKey)
    }

    /// `pack` was just installed (new, or a fresh copy of one): its studio is on.
    public static func installed(pack: String, defaults: UserDefaults) {
        set(true, pack: pack, defaults: defaults)
    }

    private static func offPacks(_ defaults: UserDefaults) -> Set<String> {
        Set(defaults.stringArray(forKey: offKey) ?? [])
    }
}

/// The Voice test's studio speed test against the clock (2026-10-13: with the full tiled studio on a hot phone it never
/// finished, so the Voice test never reached its listening test). Loading and both renders share `totalSeconds`; the
/// timed render (not the warm-up, whose first run prepares the models) also stops once it projects under
/// StudioPace.minimum. Each verdict is the result's error, in plain words.
public enum StudioTestBudget {
    /// The whole test: load, warm-up render and timed render.
    public static let totalSeconds = 60.0
    /// After stopping a step (out of time, or Stop), how long the test waits for that step's work to wind down so its
    /// memory is gone before Nephis warms again; past it the result goes back anyway.
    public static let graceSeconds = 10.0

    public static var timeoutWords: String { "timed out after \(Int(totalSeconds)) s" }

    /// Seconds of the budget left after `elapsedSeconds` (never negative).
    public static func left(elapsedSeconds: Double) -> Double { max(0, totalSeconds - elapsedSeconds) }

    /// Asked between a render's pieces: why to stop the test now, or nil to go on. `paced`: the timed render.
    public static func verdict(projectedX: Double, elapsedSeconds: Double, paced: Bool) -> String? {
        if elapsedSeconds >= totalSeconds { return timeoutWords }
        if paced && StudioPace.tooSlow(projectedX) { return "studio too slow: \(StudioPace.words(projectedX))" }
        return nil
    }

    /// A studio load that failed: short of memory in plain words (what is free now), else the error itself.
    public static func loadFailure(_ error: String, freeMB: Double?) -> String {
        if let freeMB, NephisMemory.short(.studioTest, freeMB: freeMB) {
            return "not enough memory to load the studio (\(NephisMemory.grouped(freeMB)) MB free)"
        }
        return "couldn't load the studio: \(error)"
    }
}

public enum ModelOutput {
    /// A Core ML output as Float, in its logical (shape) order: the studio's models output Float16, and an output can
    /// be laid out with padded strides, which reading `dataPointer` as a flat buffer gets wrong or reads past.
    public static func floats(_ a: MLMultiArray) -> [Float] {
        MLShapedArray<Float>(converting: a).scalars
    }

    /// `floats`, read straight from the buffer when the array is Float32 laid out densely in shape order (the de-wind
    /// network's outputs, many times a second: heat batch 1); through `floats` otherwise. The same values either way.
    public static func denseFloats(_ a: MLMultiArray) -> [Float] {
        guard a.dataType == .float32 else { return floats(a) }
        var expected = 1
        for (dim, stride) in zip(a.shape.map(\.intValue), a.strides.map(\.intValue)).reversed() {
            if dim > 1, stride != expected { return floats(a) }
            expected *= dim
        }
        let n = a.count
        let dense: [Float]? = a.withUnsafeBufferPointer(ofType: Float.self) { p in
            p.count >= n ? Array(UnsafeBufferPointer(rebasing: p.prefix(n))) : nil
        }
        return dense ?? floats(a)
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
