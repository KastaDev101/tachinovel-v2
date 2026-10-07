//
//  TimeStretch.swift — tempo and pitch for rendered speech, offline, per unit or per sentence (natural delivery):
//    tempo      WSOLA (waveform-similarity overlap-add, time domain): 30 ms Hann frames at 50 % overlap, each placed
//               where it best continues the previous one (±6 ms search), so the pitch stays where it is. Used for
//               the rate leveling (≤ ±10 %), the director's small tempo changes (≤ ±4 %) and the listener's speed;
//    varispeed  plain resampling (4-point cubic): pitch and pace move together, like a tape running slower, with no
//               stretching artifacts (−40 cents ≈ 2.3 % slower, −60 ≈ 3.5 %): the persona's contrast lines.
//  No phase vocoder on speech (AVAudioUnitTimePitch smeared it). Applied before scheduling, so a change lands
//  exactly on its sentence, and the same sentence always sounds the same. Pure Swift on sample arrays.
//

import Foundation

public enum TimeStretch {
    /// Nothing to do below this distance from 1 (tempo) or this many cents (pitch).
    static let tempoEpsilon = 0.002
    static let centsEpsilon = 0.5

    /// WSOLA to `tempo` (pitch kept), then varispeed by `cents` (pitch and pace together). Output length ≈
    /// count / tempo / 2^(cents/1200).
    public static func apply(_ x: [Float], tempo: Double, varispeedCents cents: Double, sampleRate: Int) -> [Float] {
        let t = tempo.isFinite ? min(2.5, max(0.4, tempo)) : 1
        let c = cents.isFinite ? min(1200, max(-1200, cents)) : 0
        guard !x.isEmpty else { return x }
        let stretched = wsola(x, tempo: t, sampleRate: sampleRate)
        return abs(c) < centsEpsilon ? stretched : varispeed(stretched, cents: c)
    }

    /// Varispeed: resample so pitch and pace move together by `cents` (negative: lower and slower).
    public static func varispeed(_ x: [Float], cents: Double) -> [Float] {
        guard cents.isFinite, abs(cents) >= centsEpsilon else { return x }
        return resample(x, ratio: pow(2, min(1200, max(-1200, cents)) / 1200))
    }

    /// WSOLA time-scale modification: output length ≈ count / tempo, pitch unchanged.
    public static func wsola(_ x: [Float], tempo: Double, sampleRate: Int) -> [Float] {
        guard x.count > 1, tempo.isFinite, abs(tempo - 1) >= tempoEpsilon else { return x }
        let t = min(2.5, max(0.4, tempo))
        let w = max(64, Int(Double(sampleRate) * 0.03)) & ~1
        let hs = w / 2
        let ha = Double(hs) * t
        let tol = max(8, Int(Double(sampleRate) * 0.006))
        // Periodic Hann: two windows at hop w/2 sum to exactly 1.
        let window = (0..<w).map { Float(0.5 - 0.5 * cos(2 * Double.pi * Double($0) / Double(w))) }
        // Padded input: hs zeros in front (so the first samples are covered by two windows), w + tol behind.
        let lead = hs
        var xp = [Float](repeating: 0, count: lead + x.count + w + 2 * tol + hs)
        for i in 0..<x.count { xp[lead + i] = x[i] }
        let outCount = Int((Double(x.count) / t).rounded())
        let frames = (outCount + lead) / hs + 2
        var y = [Float](repeating: 0, count: frames * hs + w)
        xp.withUnsafeBufferPointer { src in
            y.withUnsafeMutableBufferPointer { dst in
                var prev = 0
                for k in 0..<frames {
                    let nominal = Int((Double(k) * ha).rounded())
                    var pos = min(max(0, nominal), src.count - w - tol - 1)
                    if k > 0 {
                        // The input that would naturally follow the previous frame, compared over half a frame.
                        let target = prev + hs
                        var best = 0
                        var bestScore = -Double.infinity
                        var d = -tol
                        while d <= tol {
                            let p = pos + d
                            if p >= 0, p + hs < src.count, target + hs < src.count {
                                var acc: Float = 0
                                var j = 0
                                while j < hs {
                                    acc += src[p + j] * src[target + j]
                                    j += 2
                                }
                                if Double(acc) > bestScore {
                                    bestScore = Double(acc)
                                    best = d
                                }
                            }
                            d += 1
                        }
                        pos = max(0, pos + best)
                    }
                    let o = k * hs
                    for j in 0..<w where pos + j < src.count && o + j < dst.count {
                        dst[o + j] += window[j] * src[pos + j]
                    }
                    prev = pos
                }
            }
        }
        // Drop the padding's share of the output.
        let start = min(y.count, lead)
        return Array(y[start..<min(y.count, start + outCount)])
    }

    /// Resample by `ratio` (> 1 reads faster: shorter and higher). Output length = count / ratio. 4-point cubic
    /// (Catmull-Rom) interpolation.
    public static func resample(_ x: [Float], ratio: Double) -> [Float] {
        guard x.count > 1, ratio.isFinite, ratio > 0, abs(ratio - 1) > 1e-6 else { return x }
        let n = max(1, Int((Double(x.count) / ratio).rounded()))
        var out = [Float](repeating: 0, count: n)
        let last = x.count - 1
        x.withUnsafeBufferPointer { s in
            for i in 0..<n {
                let pos = Double(i) * ratio
                let i1 = min(last, Int(pos))
                let f = Float(pos - Double(i1))
                let p0 = s[max(0, i1 - 1)]
                let p1 = s[i1]
                let p2 = s[min(last, i1 + 1)]
                let p3 = s[min(last, i1 + 2)]
                let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3
                let b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3
                let c = -0.5 * p0 + 0.5 * p2
                out[i] = ((a * f + b) * f + c) * f + p1
            }
        }
        return out
    }
}
