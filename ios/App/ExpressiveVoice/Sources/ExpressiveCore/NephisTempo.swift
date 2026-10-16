//
//  NephisTempo.swift — a dialogue mood's tempo (pack.json chain moods[<mood>].tempo, Kasta 2026-10-15: against Her
//  takes our playful and excited lines run too fast, tense ones too slow). Time-stretch without a pitch change, offline,
//  on the call's dialogue regions only:
//
//    WSOLA (waveform-similarity overlap-add): 40 ms periodic Hann frames at a 20 ms hop (two frames sum to exactly 1),
//    each frame taken where it best continues the one before: the candidate within ±8 ms of its nominal place whose
//    first 20 ms correlate best with the natural continuation of the previous frame, normalized by the candidate's
//    energy (one vDSP correlation over every lag at once). Normalized, full-resolution and with a longer search than the
//    player's TimeStretch (HDVoiceCore, which this package doesn't link): steadier on her breathy, expressive takes.
//    No phase vocoder: on speech it smears (AVAudioUnitTimePitch was tried for the player and dropped).
//
//  tempo t (0.85…1.15): > 1 faster (shorter), < 1 slower; output length round(count / t). |t - 1| under 0.005, absent
//  or not a number: the samples untouched (bit-identical). Cost: ~31 M multiply-adds per second of audio at 44.1 kHz on
//  vDSP (a few ms on the phone), only on the dialogue spans of a mood with a tempo.
//

import Accelerate
import Foundation

public enum NephisTempo {
    public static let minimum = 0.85
    public static let maximum = 1.15
    /// Nothing to do this close to 1.
    public static let epsilon = 0.005

    /// A pack's tempo, clamped (nil, not a number: 1).
    public static func clamped(_ tempo: Double?) -> Double {
        guard let tempo, tempo.isFinite else { return 1 }
        return min(maximum, max(minimum, tempo))
    }

    /// The tempo does something.
    public static func changes(_ tempo: Double?) -> Bool { abs(clamped(tempo) - 1) >= epsilon }

    /// `x` at `tempo` (pitch kept): length round(count / tempo).
    public static func stretch(_ x: [Float], tempo: Double, sampleRate: Int) -> [Float] {
        let t = clamped(tempo)
        guard x.count > 1, abs(t - 1) >= epsilon, sampleRate > 0 else { return x }
        let hop = max(32, Int((0.02 * Double(sampleRate)).rounded()))
        let n = 2 * hop
        let tol = max(8, Int((0.008 * Double(sampleRate)).rounded()))
        let window: [Float] = (0..<n).map { Float(0.5 - 0.5 * cos(2 * Double.pi * Double($0) / Double(n))) }
        // Padded input: `lead` zeros in front (the first samples get two frames too), room for the search behind.
        let lead = n
        var xp = [Float](repeating: 0, count: lead + x.count + 2 * n + 2 * tol)
        xp.replaceSubrange(lead..<(lead + x.count), with: x)
        // Running energy for the normalization: e[p] = sum of squares of xp[0..<p].
        var energy = [Double](repeating: 0, count: xp.count + 1)
        for i in xp.indices { energy[i + 1] = energy[i] + Double(xp[i]) * Double(xp[i]) }
        let outCount = max(1, Int((Double(x.count) / t).rounded()))
        // Output sample o is input o·t (padded): the unpadded start is output lead / t.
        let start = Int((Double(lead) / t).rounded())
        let frames = (start + outCount) / hop + 2
        var y = [Float](repeating: 0, count: frames * hop + n)
        let analysisHop = Double(hop) * t
        let lags = 2 * tol + 1
        var scores = [Float](repeating: 0, count: lags)
        let lastStart = xp.count - n - 1
        xp.withUnsafeBufferPointer { src in
            y.withUnsafeMutableBufferPointer { dst in
                window.withUnsafeBufferPointer { win in
                    var prev = 0
                    for k in 0..<frames {
                        let nominal = Int((Double(k) * analysisHop).rounded())
                        var pos = min(max(0, nominal), lastStart)
                        if k > 0 {
                            let target = min(prev + hop, lastStart)
                            let lo = max(0, min(nominal - tol, lastStart - 2 * tol))
                            // scores[m] = Σ src[lo + m + i] · src[target + i], i < hop: every lag in one correlation.
                            if lo + lags + hop - 1 <= src.count, target + hop <= src.count, let base = src.baseAddress {
                                scores.withUnsafeMutableBufferPointer { s in
                                    vDSP_conv(base + lo, 1, base + target, 1, s.baseAddress!, 1, vDSP_Length(lags), vDSP_Length(hop))
                                }
                                var best = pos
                                var bestScore = -Double.infinity
                                for m in 0..<lags {
                                    let p = lo + m
                                    guard p <= lastStart else { break }
                                    let e = energy[p + hop] - energy[p]
                                    let score = Double(scores[m]) / (e + 1e-9).squareRoot()
                                    if score > bestScore {
                                        bestScore = score
                                        best = p
                                    }
                                }
                                pos = best
                            }
                        }
                        let o = k * hop
                        guard o + n <= dst.count, pos + n <= src.count, let d = dst.baseAddress, let s = src.baseAddress, let w = win.baseAddress else { continue }
                        // dst[o..<o+n] += window · src[pos..<pos+n]
                        vDSP_vma(w, 1, s + pos, 1, d + o, 1, d + o, 1, vDSP_Length(n))
                        prev = pos
                    }
                }
            }
        }
        let from = min(y.count, start)
        let out = Array(y[from..<min(y.count, from + outCount)])
        return out.count == outCount ? out : out + [Float](repeating: 0, count: outCount - out.count)
    }
}
