//
//  StartupSound.swift — the short lip/breath sound Pocket TTS makes before the first word of every model call.
//
//  Each call starts from the voice prompt, and the model opens with ~0.1–0.3 s of low sound before speaking: the
//  "click" Kasta hears at section starts (2026-10-07). Cutting it out left dead silence and clipped words; cutting it
//  from the voice clip didn't help (the model makes it on its own). So it is turned down, never removed: from the start
//  of the call to the quiet dip right before the first word, −24 dB with 20 ms ramps. The word itself starts after
//  the dip and is never touched; when there is no clear dip (the first word starts right away) nothing changes.
//

import Foundation

public enum StartupSound {
    /// Most of the start-up sound is a sub-bass thump (energy at 20–50 Hz, 2026-10-07): a 4th-order Butterworth
    /// high-pass at 70 Hz takes it down 14–18 dB and leaves her speech (lowest notes ~130 Hz) unchanged. Run on the
    /// whole unit (not per model call) so the filter itself never starts cold at a join inside a paragraph.
    public static let thumpCutoffHz = 70.0

    public static func removeThump(_ x: inout [Float], sampleRate: Int) {
        let fs = Double(sampleRate)
        var a = Biquad.highPass(frequency: thumpCutoffHz, q: 0.5412, sampleRate: fs)
        var b = Biquad.highPass(frequency: thumpCutoffHz, q: 1.3066, sampleRate: fs)
        a.process(&x)
        b.process(&x)
    }

    /// The first word: 40 ms above this level (dBFS, the model's raw output).
    public static let speechDB = -28.0
    /// The sound before it must be at least this much louder than the dip, or there is nothing to soften.
    public static let dipDepthDB = 6.0
    /// Never soften more than this (a longer stretch would not be a start-up sound).
    public static let maxSeconds = 0.3
    public static let reductionDB = -24.0

    /// Softens the start-up sound at the head of `x` in place; returns the seconds softened (0 = untouched).
    @discardableResult
    public static func soften(_ x: inout [Float], sampleRate: Int) -> Double {
        let n = max(1, sampleRate / 100)
        let frames = min(x.count / n, 100)
        guard frames > 8 else { return 0 }
        var db = [Double](repeating: -120, count: frames)
        for f in 0..<frames {
            var acc = 0.0
            for i in f * n..<(f + 1) * n { acc += Double(x[i]) * Double(x[i]) }
            db[f] = 10 * log10(max(acc / Double(n), 1e-12))
        }
        guard let on = (0..<(frames - 3)).first(where: { f in (f..<f + 4).allSatisfy { db[$0] > speechDB } }), on > 0 else { return 0 }
        let lo = max(0, on - 25)
        guard let dip = (lo..<on).min(by: { db[$0] < db[$1] }) else { return 0 }
        let loudest = db[0...dip].max() ?? db[dip]
        guard dip >= 5, loudest - db[dip] >= dipDepthDB, Double(dip * n) / Double(sampleRate) <= maxSeconds else { return 0 }
        let end = dip * n
        let floor = Float(pow(10, reductionDB / 20))
        let ramp = min(end / 2, max(1, sampleRate / 50))
        for i in 0..<end {
            let g: Float
            if i < ramp {
                g = 1 + (floor - 1) * Float(i) / Float(ramp)
            } else if i >= end - ramp {
                g = floor + (1 - floor) * Float(i - (end - ramp)) / Float(ramp)
            } else {
                g = floor
            }
            x[i] *= g
        }
        return Double(end) / Double(sampleRate)
    }

    /// The same for every model call in `x` (calls start at 0 and at each of `callStarts`).
    @discardableResult
    public static func softenCalls(_ x: inout [Float], callStarts: [Int], sampleRate: Int) -> Double {
        var total = 0.0
        let starts = ([0] + callStarts.sorted()).filter { $0 >= 0 && $0 < x.count }
        for (k, s) in starts.enumerated() {
            let e = k + 1 < starts.count ? starts[k + 1] : x.count
            guard e > s else { continue }
            var seg = Array(x[s..<e])
            let t = soften(&seg, sampleRate: sampleRate)
            if t > 0 { x.replaceSubrange(s..<e, with: seg); total += t }
        }
        return total
    }
}
