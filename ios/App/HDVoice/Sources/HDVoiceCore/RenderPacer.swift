import Foundation

/// Nephis's render pacing (heat plan, 2026-10-13): she never renders flat out for long. The Voice test generated 222 s
/// of audio in 101 s (7.9x real time) and the phone went from "fair" to "serious" heat in 100 s, because nothing
/// stopped her until the scheduler's sentence limit. Now the bank of audio ahead of playback has a target (the
/// cushion): once it is met her renders stop, and they start again only when playback has drawn it down below
/// `resumeBelow` (hysteresis: work in short runs with rests between, never one call per freed second). From "fair"
/// heat the cushion is smaller, so a warm phone does less work ahead it may never need.
///
/// It also keeps the read's numbers for the Voice test report: seconds generated and played, and the duty cycle (the
/// share of the read's time with at least one of her calls in flight).
public struct RenderPacer: Sendable, Equatable {
    /// Seconds banked ahead at which her renders stop: a cool phone, and from "fair" heat on. 90 s (heat batch 1,
    /// 2026-10-15; 120 s before): the same gapless read with less audio made ahead that a seek or a stop throws away.
    public static let cushion = 90.0
    public static let warmCushion = 60.0
    /// How far below the cushion the bank must drop before she renders again (cool, warm).
    public static let refill = 30.0
    public static let warmRefill = 20.0

    /// Her renders at background priority (heat batch 1, 2026-10-15): once more than `relaxedAbove` seconds are banked
    /// ahead of playback they run at `.utility` (the efficient cores and clocks: the same sound, less heat), and at
    /// `.userInitiated` again below `urgentBelow`. Hysteresis, so the priority doesn't flip from call to call.
    public static let relaxedAbove = 30.0
    public static let urgentBelow = 15.0

    /// The next render's priority: relaxed (true) or not, from the last one's and the seconds banked now.
    public static func relaxed(was: Bool, buffered: Double) -> Bool {
        was ? buffered >= urgentBelow : buffered > relaxedAbove
    }

    /// ProcessInfo.ThermalState raw values: 0 nominal, 1 fair, 2 serious, 3 critical.
    public static func warm(_ thermal: Int) -> Bool { thermal >= 1 }

    /// The cushion for this heat (seconds).
    public static func target(thermal: Int) -> Double { warm(thermal) ? warmCushion : cushion }

    /// Below this bank (seconds) a held read renders again.
    public static func resumeBelow(thermal: Int) -> Double {
        target(thermal: thermal) - (warm(thermal) ? warmRefill : refill)
    }

    /// When to look again while holding: about when playback will have drawn the bank down to `resumeBelow` (at the
    /// normal speed), never later than 5 s (a faster listening speed or heat change), never sooner than 0.5 s.
    public static func recheck(buffered: Double, thermal: Int) -> TimeInterval {
        min(5, max(0.5, buffered - resumeBelow(thermal: thermal)))
    }

    /// Holding now (the cushion was met and the bank hasn't dropped below `resumeBelow` since).
    public private(set) var holding = false
    /// Times the cushion was met, and the seconds spent holding.
    public private(set) var holds = 0
    public private(set) var heldSeconds = 0.0
    /// Seconds of her audio generated, and of audio played (every voice) in this read.
    public private(set) var generatedSeconds = 0.0
    public private(set) var playedSeconds = 0.0
    /// Seconds with at least one of her calls in flight (overlapping calls counted once).
    public private(set) var busySeconds = 0.0
    /// The cushion used at the last decision (seconds).
    public private(set) var lastTarget = RenderPacer.cushion
    private var heldSince: Double?
    private var inFlight = 0
    private var busySince: Double?

    public init() {}

    /// Hold her next render? `buffered`: seconds banked ahead of playback; `thermal`: the raw thermal state; `now`:
    /// seconds since the read started.
    public mutating func hold(buffered: Double, thermal: Int, now: Double) -> Bool {
        lastTarget = Self.target(thermal: thermal)
        if holding {
            if buffered < Self.resumeBelow(thermal: thermal) { release(now: now) }
        } else if buffered >= lastTarget {
            holding = true
            holds += 1
            heldSince = now
        }
        return holding
    }

    /// Stop holding at once (playback is waiting for audio, the read moved): her next render goes ahead.
    public mutating func release(now: Double) {
        if let since = heldSince { heldSeconds += max(0, now - since) }
        heldSince = nil
        holding = false
    }

    /// One of her calls started / ended (each start is matched by one end).
    public mutating func callStarted(now: Double) {
        if inFlight == 0 { busySince = now }
        inFlight += 1
    }

    public mutating func callEnded(now: Double, audioSeconds: Double) {
        generatedSeconds += max(0, audioSeconds)
        guard inFlight > 0 else { return }
        inFlight -= 1
        if inFlight == 0, let since = busySince {
            busySeconds += max(0, now - since)
            busySince = nil
        }
    }

    public mutating func played(seconds: Double) {
        playedSeconds += max(0, seconds)
    }

    /// Busy and held seconds up to `now` (a call or hold still going counts so far).
    public func busy(at now: Double) -> Double { busySeconds + (busySince.map { max(0, now - $0) } ?? 0) }
    public func held(at now: Double) -> Double { heldSeconds + (heldSince.map { max(0, now - $0) } ?? 0) }

    /// Share of the read's time (`now` seconds so far) with her calls in flight, 0...1.
    public func dutyCycle(at now: Double) -> Double {
        guard now > 0 else { return 0 }
        return min(1, busy(at: now) / now)
    }
}
