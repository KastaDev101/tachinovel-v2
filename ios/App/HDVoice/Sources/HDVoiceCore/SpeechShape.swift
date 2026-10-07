//
//  SpeechShape.swift — reading a rendered unit (a breath-group chunk or a sentence) of Chatterbox Nano speech:
//    activity    10 ms frames, speech vs. silence (relative to the loudest frame, like round 8's trim);
//    cleanup     isolated blips under 70 ms dropped; micro-gaps under 110 ms closed unless punctuation is there;
//    ellipsis    the model's own pause nearest a dramatic "…" stretched to 350–450 ms with silence (no re-synthesis);
//    timing      where each sentence of a chunk ends: the chunk's internal pauses matched to the sentence ends the
//                text predicts (letters → voiced time), with a confidence; proportional timing when it isn't sure;
//    rate        syllables per voiced second, leveled toward the running median (RateLeveler);
//    roughness   voiced periodicity (normalized autocorrelation), to catch a rough render (RoughnessGuard).
//  Text positions are shares of the letters (delivery.ts speechShape); they map onto the audio through the voiced
//  time, since pauses take time but no letters. Pure Swift, deterministic.
//

import Foundation

/// Speech/silence per 10 ms frame of a unit.
public struct SpeechActivity: Sendable, Equatable {
    public static let frameSeconds = 0.01
    public let sampleRate: Int
    public let frameLength: Int
    /// Frame is speech.
    public let active: [Bool]
    public let frameRMS: [Float]

    /// Frames quieter than `withinDB` under the loudest frame (and under −60 dBFS absolute) are silence.
    public init(_ x: [Float], sampleRate: Int, withinDB: Double = 40) {
        self.sampleRate = sampleRate
        let n = max(1, Int(Double(sampleRate) * Self.frameSeconds))
        frameLength = n
        var rms: [Float] = []
        rms.reserveCapacity(x.count / n + 1)
        var i = 0
        while i < x.count {
            let end = min(x.count, i + n)
            var acc: Float = 0
            for k in i..<end { acc += x[k] * x[k] }
            rms.append((acc / Float(end - i)).squareRoot())
            i = end
        }
        frameRMS = rms
        let loudest = rms.max() ?? 0
        let floor = max(0.001, loudest * Float(pow(10, -withinDB / 20)))
        active = rms.map { $0 >= floor }
    }

    public struct Run: Sendable, Equatable {
        /// First frame and frame count.
        public let start: Int
        public let count: Int
        public var end: Int { start + count }
    }

    /// Runs of silent frames between speech (not the lead-in or the tail).
    public var internalGaps: [Run] { runs(of: false).filter { $0.start > 0 && $0.end < active.count } }
    /// Runs of speech.
    public var islands: [Run] { runs(of: true) }

    func runs(of value: Bool) -> [Run] {
        var out: [Run] = []
        var i = 0
        while i < active.count {
            guard active[i] == value else {
                i += 1
                continue
            }
            var j = i
            while j < active.count, active[j] == value { j += 1 }
            out.append(Run(start: i, count: j - i))
            i = j
        }
        return out
    }

    /// Seconds of speech.
    public var voicedSeconds: Double { Double(active.filter { $0 }.count) * Self.frameSeconds }

    /// Share (0…1) of the voiced time before `frame`.
    public func voicedShare(atFrame frame: Int) -> Double {
        let total = active.filter { $0 }.count
        guard total > 0 else { return 0 }
        return Double(active.prefix(max(0, min(active.count, frame))).filter { $0 }.count) / Double(total)
    }

    /// The frame where `share` of the voiced time has passed.
    public func frame(atVoicedShare share: Double) -> Int {
        let total = active.filter { $0 }.count
        let target = Int((min(1, max(0, share)) * Double(total)).rounded())
        var seen = 0
        for (i, a) in active.enumerated() where a {
            if seen >= target { return i }
            seen += 1
        }
        return active.count
    }
}

public enum SpeechShape {
    /// Drop isolated speech islands shorter than `blip` (with at least as much silence on both sides): clicks and
    /// stray noises the model leaves between words.
    public static func dropBlips(_ x: inout [Float], sampleRate: Int, blip: Double) {
        let act = SpeechActivity(x, sampleRate: sampleRate)
        let maxFrames = Int((blip / SpeechActivity.frameSeconds).rounded())
        guard maxFrames > 0 else { return }
        let islands = act.islands
        for (k, run) in islands.enumerated() where run.count < maxFrames {
            let gapBefore = k == 0 ? run.start : run.start - islands[k - 1].end
            let gapAfter = k == islands.count - 1 ? act.active.count - run.end : islands[k + 1].start - run.end
            guard gapBefore >= run.count, gapAfter >= run.count, islands.count > 1 else { continue }
            let a = run.start * act.frameLength
            let b = min(x.count, run.end * act.frameLength)
            for i in a..<b { x[i] = 0 }
        }
    }

    /// Close internal gaps shorter than `microGap` unless punctuation sits there (`punctuation`: letter shares of the
    /// unit), cutting the silence out with short equal-power fades. Returns the closed gaps' frame starts.
    @discardableResult
    public static func closeMicroGaps(_ x: inout [Float], sampleRate: Int, microGap: Double, punctuation: [Double], letters: Int) -> Int {
        let act = SpeechActivity(x, sampleRate: sampleRate)
        let maxFrames = Int((microGap / SpeechActivity.frameSeconds).rounded())
        guard maxFrames > 1, !act.internalGaps.isEmpty else { return 0 }
        // Punctuation near a gap: within 6 % of the voiced time (or 2 letters).
        let tolerance = max(0.06, letters > 0 ? 2 / Double(letters) : 0.06)
        var cuts: [SpeechActivity.Run] = []
        for gap in act.internalGaps where gap.count < maxFrames {
            let share = act.voicedShare(atFrame: gap.start)
            if punctuation.contains(where: { abs($0 - share) <= tolerance }) { continue }
            cuts.append(gap)
        }
        guard !cuts.isEmpty else { return 0 }
        let fade = max(1, sampleRate / 200) // 5 ms
        var out: [Float] = []
        out.reserveCapacity(x.count)
        var from = 0
        for gap in cuts {
            // Keep 5 ms on each side of the gap for the fades, drop the rest.
            let a = min(x.count, gap.start * act.frameLength + fade)
            let b = max(a, min(x.count, gap.end * act.frameLength - fade))
            guard a > from else { continue }
            var head = Array(x[from..<a])
            for i in 0..<min(fade, head.count) { head[head.count - 1 - i] *= Float(sin(Double.pi / 2 * Double(i) / Double(fade))) }
            out.append(contentsOf: head)
            from = b
            let tail = min(x.count, from + fade)
            for i in from..<tail { x[i] *= Float(sin(Double.pi / 2 * Double(i - from) / Double(fade))) }
        }
        out.append(contentsOf: x[min(from, x.count)...])
        x = out
        return cuts.count
    }

    /// Stretch the model's own pause nearest each dramatic "…" (letter shares) to `target` seconds by padding it
    /// with silence (never shortening it, never cutting speech). Returns how many pauses were stretched.
    @discardableResult
    public static func padEllipses(_ x: inout [Float], sampleRate: Int, ellipses: [Double], target: Double) -> Int {
        guard !ellipses.isEmpty, target > 0 else { return 0 }
        let act = SpeechActivity(x, sampleRate: sampleRate)
        let gaps = act.internalGaps
        guard !gaps.isEmpty else { return 0 }
        var inserts: [(at: Int, frames: Int)] = []
        var used = Set<Int>()
        for e in ellipses {
            // The nearest internal pause in voiced time, within 15 % of it.
            let best = gaps.enumerated().filter { !used.contains($0.offset) }
                .min { abs(act.voicedShare(atFrame: $0.element.start) - e) < abs(act.voicedShare(atFrame: $1.element.start) - e) }
            guard let best, abs(act.voicedShare(atFrame: best.element.start) - e) <= 0.15 else { continue }
            used.insert(best.offset)
            let have = Double(best.element.count) * SpeechActivity.frameSeconds
            guard have < target else { continue }
            let mid = (best.element.start + best.element.count / 2) * act.frameLength
            inserts.append((min(x.count, mid), Int((target - have) * Double(sampleRate))))
        }
        guard !inserts.isEmpty else { return 0 }
        var out: [Float] = []
        out.reserveCapacity(x.count + inserts.reduce(0) { $0 + $1.frames })
        var from = 0
        for ins in inserts.sorted(by: { $0.at < $1.at }) {
            out.append(contentsOf: x[from..<ins.at])
            out.append(contentsOf: repeatElement(Float(0), count: ins.frames))
            from = ins.at
        }
        out.append(contentsOf: x[from...])
        x = out
        return inserts.count
    }
}

/// Where the sentences of a chunk end in its audio.
public struct ChunkTiming: Sendable, Equatable {
    /// Sample indices where sentence 1, 2, … start (count = sentences − 1).
    public let cuts: [Int]
    /// Every sentence end matched a real pause near where the text puts it.
    public let confident: Bool
}

public enum ChunkAligner {
    /// Match the chunk's internal pauses to the sentence ends the text predicts (`ends`: letter shares, increasing).
    /// Confident when every end has its own pause of 80 ms or more within 12 % of the voiced time; otherwise the cuts
    /// fall proportionally (at the predicted voiced time, snapped to the quietest frame within 50 ms).
    public static func align(_ x: [Float], sampleRate: Int, ends: [Double]) -> ChunkTiming {
        guard !ends.isEmpty else { return ChunkTiming(cuts: [], confident: true) }
        let act = SpeechActivity(x, sampleRate: sampleRate)
        let gaps = act.internalGaps.filter { $0.count >= 4 } // 40 ms
        let shares = gaps.map { act.voicedShare(atFrame: $0.start) }
        let n = ends.count
        let m = gaps.count
        if m >= n {
            // Monotonic assignment of ends to gaps minimizing the distance, preferring longer pauses (DP, O(n·m)).
            let inf = Double.infinity
            var cost = [[Double]](repeating: [Double](repeating: inf, count: m), count: n)
            var from = [[Int]](repeating: [Int](repeating: -1, count: m), count: n)
            func c(_ b: Int, _ j: Int) -> Double {
                let len = Double(gaps[j].count) * SpeechActivity.frameSeconds
                return abs(shares[j] - ends[b]) + (len < 0.08 ? 0.08 : 0) - min(0.4, len) * 0.05
            }
            for j in 0..<m { cost[0][j] = c(0, j) }
            if n > 1 {
                for b in 1..<n {
                    var bestPrev = inf
                    var bestIdx = -1
                    for j in 0..<m {
                        if j > 0, cost[b - 1][j - 1] < bestPrev {
                            bestPrev = cost[b - 1][j - 1]
                            bestIdx = j - 1
                        }
                        if bestIdx >= 0 {
                            cost[b][j] = bestPrev + c(b, j)
                            from[b][j] = bestIdx
                        }
                    }
                }
            }
            if let last = (0..<m).min(by: { cost[n - 1][$0] < cost[n - 1][$1] }), cost[n - 1][last] < inf {
                var picks = [Int](repeating: 0, count: n)
                var j = last
                for b in stride(from: n - 1, through: 0, by: -1) {
                    picks[b] = j
                    j = from[b][j]
                }
                let confident = picks.enumerated().allSatisfy { b, g in
                    abs(shares[g] - ends[b]) <= 0.12 && Double(gaps[g].count) * SpeechActivity.frameSeconds >= 0.08
                }
                if confident {
                    let cuts = picks.map { g in (gaps[g].start + gaps[g].count / 2) * act.frameLength }
                    return ChunkTiming(cuts: cuts.map { min(x.count, $0) }, confident: true)
                }
            }
        }
        // Proportional: the predicted voiced time, at the quietest frame nearby.
        var cuts: [Int] = []
        var last = 0
        for e in ends {
            let f = act.frame(atVoicedShare: e)
            var best = f
            for k in max(0, f - 5)...min(max(0, act.frameRMS.count - 1), f + 5) where act.frameRMS.indices.contains(k) {
                if act.frameRMS[k] < act.frameRMS[min(best, act.frameRMS.count - 1)] { best = k }
            }
            let cut = max(last, min(x.count, best * act.frameLength))
            cuts.append(cut)
            last = cut
        }
        return ChunkTiming(cuts: cuts, confident: false)
    }
}

/// Levels the speaking rate across units: each unit's syllables per voiced second against the median of the last
/// `window` units; outside ±band it is stretched to the edge of the band, never by more than ±cap. Pure.
public struct RateLeveler: Sendable, Equatable {
    public let window: Int
    public let band: Double
    public let cap: Double
    public private(set) var recent: [Double] = []

    public init(window: Int = 9, band: Double = 0.04, cap: Double = 0.1) {
        self.window = max(1, window)
        self.band = max(0, band)
        self.cap = max(0, cap)
    }

    public var target: Double? {
        guard !recent.isEmpty else { return nil }
        let s = recent.sorted()
        let mid = s.count / 2
        return s.count % 2 == 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
    }

    /// The tempo factor for a unit of `syllables` over `voicedSeconds` (1 = leave it), and remember its rate.
    public mutating func tempo(syllables: Int, voicedSeconds: Double) -> Double {
        guard syllables >= 3, voicedSeconds > 0.3 else { return 1 }
        let rate = Double(syllables) / voicedSeconds
        defer {
            recent.append(rate)
            if recent.count > window { recent.removeFirst(recent.count - window) }
        }
        guard let t = target, t > 0 else { return 1 }
        let ratio = rate / t
        let desired: Double
        if ratio > 1 + band { desired = t * (1 + band) } else if ratio < 1 - band { desired = t * (1 - band) } else { return 1 }
        // Tempo > 1 speeds up: desired / rate.
        return min(1 + cap, max(1 - cap, desired / rate))
    }
}

/// Voiced periodicity (how clean the voice is): normalized autocorrelation peak per voiced 20 ms frame (pitch
/// 80–400 Hz), on a 12 kHz copy.
public struct Roughness: Sendable, Equatable {
    /// Median periodicity of the voiced frames (0…1), nil when there are too few.
    public let median: Double?
    /// The lowest mean over any `span` of consecutive voiced frames.
    public let worstWindow: Double?

    public static func measure(_ x: [Float], sampleRate: Int, span: Double = 0.25) -> Roughness {
        // Decimate by 2 (a simple average is enough for 80–400 Hz pitch).
        let half = stride(from: 0, to: x.count - 1, by: 2).map { (x[$0] + x[$0 + 1]) / 2 }
        let fs = sampleRate / 2
        let n = max(1, fs / 50) // 20 ms
        let minLag = max(1, fs / 400)
        let maxLag = max(minLag + 1, fs / 80)
        var values: [Double] = []
        let act = SpeechActivity(x, sampleRate: sampleRate, withinDB: 30)
        half.withUnsafeBufferPointer { s in
            var i = 0
            while i + n + maxLag < s.count {
                // Voiced enough: the 10 ms activity frames under this 20 ms frame.
                let f = (i * 2) / act.frameLength
                guard f < act.active.count, act.active[f] else {
                    i += n
                    continue
                }
                var e0: Float = 0
                for k in 0..<n { e0 += s[i + k] * s[i + k] }
                guard e0 > 1e-8 else {
                    i += n
                    continue
                }
                var best: Float = 0
                var lag = minLag
                while lag <= maxLag {
                    var acc: Float = 0
                    var e1: Float = 0
                    for k in 0..<n {
                        acc += s[i + k] * s[i + k + lag]
                        e1 += s[i + k + lag] * s[i + k + lag]
                    }
                    if e1 > 1e-8 { best = max(best, acc / (e0 * e1).squareRoot()) }
                    lag += 1
                }
                values.append(Double(best))
                i += n
            }
        }
        guard values.count >= 3 else { return Roughness(median: nil, worstWindow: nil) }
        let sorted = values.sorted()
        let w = max(1, Int((span / 0.02).rounded()))
        var worst: Double?
        if values.count >= w {
            var sum = values.prefix(w).reduce(0, +)
            worst = sum / Double(w)
            for k in w..<values.count {
                sum += values[k] - values[k - w]
                worst = min(worst ?? 1, sum / Double(w))
            }
        }
        return Roughness(median: sorted[sorted.count / 2], worstWindow: worst)
    }
}

/// The roughness guard's state: the voice's running median periodicity and the decision to render a unit again.
public struct RoughnessGuard: Sendable, Equatable {
    public let drop: Double
    public private(set) var history: [Double] = []
    public private(set) var retries = 0

    public init(drop: Double = 0.12) {
        self.drop = drop
    }

    public var runningMedian: Double? {
        guard history.count >= 3 else { return nil }
        let s = history.sorted()
        return s[s.count / 2]
    }

    /// A unit is rough when a stretch of it falls `drop` under the voice's running median.
    public func isRough(_ r: Roughness) -> Bool {
        guard let base = runningMedian, let worst = r.worstWindow else { return false }
        return worst < base - drop
    }

    /// Of a first render and its retry, the one to keep (true: the retry).
    public func preferRetry(first: Roughness, retry: Roughness) -> Bool {
        (retry.worstWindow ?? 0) > (first.worstWindow ?? 0)
    }

    public mutating func record(_ r: Roughness) {
        guard let m = r.median else { return }
        history.append(m)
        if history.count > 15 { history.removeFirst(history.count - 15) }
    }

    public mutating func countRetry() {
        retries += 1
    }
}
