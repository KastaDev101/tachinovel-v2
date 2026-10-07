//
//  Breath.swift — breaths for natural delivery (Kasta's favourite addition in round 8), placed so they never
//  interrupt a sentence:
//    where   only at natural boundaries the script marks (a paragraph start, or a sentence-final pause of 400 ms or
//            more; never inside a quotation that goes on, never in a back-and-forth of dialogue), and only when the
//            lung budget says so: 6–8 s of speech since the last breath (4 s at a paragraph start);
//    how     inside the existing pause, never adding time: the inhale starts 120–200 ms after the previous
//            sentence ends and ends 80–150 ms before the next one starts, shortened to fit, skipped when even a
//            short breath doesn't fit;
//    level   22 dB under the speech (speech RMS: 20 ms frames within 35 dB of the loudest);
//    source  pluggable: procedural (the default: shaped noise through three broad resonances with an asymmetric
//            envelope, randomized per breath), snippets cut from the voice and cached, or a recorded pack.
//  Pure Swift, deterministic for a seed.
//

import Foundation

/// A small deterministic generator (SplitMix64).
public struct SeededRandom: Sendable {
    private var state: UInt64

    public init(seed: UInt64) {
        state = seed &+ 0x9E37_79B9_7F4A_7C15
    }

    public mutating func next() -> UInt64 {
        state = state &+ 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    public mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }

    public mutating func uniform(_ r: ClosedRange<Double>) -> Double { r.lowerBound + unit() * (r.upperBound - r.lowerBound) }
}

/// Where breaths come from. A source returns a shaped breath of the requested length at unit RMS.
public protocol BreathSource: Sendable {
    /// How long this breath would like to be, seconds.
    func naturalLength(seed: UInt64) -> Double
    func breath(seconds: Double, seed: UInt64, sampleRate: Int) -> [Float]
}

public enum BreathShape {
    /// High-pass 300 Hz, low-pass 7 kHz (Q 0.707), raised-cosine fades (80 ms in, 40 ms out, shortened for a short
    /// breath), unit RMS: the round-8 shaping.
    public static func finish(_ x: inout [Float], sampleRate: Int, highpass: Double = 300, lowpass: Double = 7_000, fadeIn: Double = 0.08, fadeOut: Double = 0.04) {
        guard !x.isEmpty else { return }
        let fs = Double(sampleRate)
        var hp = Biquad.highPass(frequency: highpass, q: 0.707, sampleRate: fs)
        var lp = Biquad.lowPass(frequency: lowpass, q: 0.707, sampleRate: fs)
        hp.process(&x)
        lp.process(&x)
        let n = x.count
        let fin = min(n / 2, max(1, Int(fadeIn * fs)))
        let fout = min(n / 2, max(1, Int(fadeOut * fs)))
        for i in 0..<fin { x[i] *= Float(0.5 - 0.5 * cos(Double.pi * Double(i) / Double(fin))) }
        for i in 0..<fout { x[n - 1 - i] *= Float(0.5 - 0.5 * cos(Double.pi * Double(i) / Double(fout))) }
        let rms = PCM.rms(x)
        if rms > 1e-9 { for i in x.indices { x[i] /= rms } }
    }
}

/// Shaped noise that sounds like an inhale: white noise through three broad resonances (around 600 Hz, 1.5 kHz and
/// 3.2 kHz, each moved ±20 % per breath), an envelope that swells for 55–72 % of the breath and falls away faster,
/// a slow flutter, then BreathShape.finish. Randomized per breath, the same for the same seed.
public struct ProceduralBreath: BreathSource {
    public var length: ClosedRange<Double> = 0.28...0.42
    public var resonances: [(frequency: Double, q: Double, weight: Double)] = [(600, 1.2, 1), (1_500, 1.6, 0.7), (3_200, 2, 0.4)]
    public var jitter = 0.2
    public var lowpass = 7_000.0

    public init() {}

    public func naturalLength(seed: UInt64) -> Double {
        var r = SeededRandom(seed: seed ^ 0xB4EA_7000)
        return r.uniform(length)
    }

    public func breath(seconds: Double, seed: UInt64, sampleRate: Int) -> [Float] {
        let n = max(1, Int(max(0.02, seconds) * Double(sampleRate)))
        let fs = Double(sampleRate)
        var r = SeededRandom(seed: seed)
        var filters = resonances.map { res -> (Biquad, Double) in
            let f = min(fs * 0.45, res.frequency * (1 + r.uniform(-jitter...jitter)))
            let w = res.weight * (1 + r.uniform(-0.3...0.3))
            // RBJ band-pass (constant 0 dB peak).
            let w0 = 2 * Double.pi * f / fs
            let alpha = sin(w0) / (2 * res.q)
            let a0 = 1 + alpha
            return (Biquad(b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: -2 * cos(w0) / a0, a2: (1 - alpha) / a0), w)
        }
        let peakAt = r.uniform(0.55...0.72)
        let flutterHz = r.uniform(3...7)
        let flutterPhase = r.uniform(0...(2 * Double.pi))
        var out = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let white = r.unit() * 2 - 1
            var s = 0.25 * white
            for k in filters.indices {
                let y = filters[k].0.process(white)
                s += filters[k].1 * y
            }
            let t = Double(i) / Double(n)
            let env = t < peakAt ? pow(sin(Double.pi / 2 * t / peakAt), 2) : pow(cos(Double.pi / 2 * (t - peakAt) / (1 - peakAt)), 2)
            let flutter = 1 + 0.1 * sin(2 * Double.pi * flutterHz * Double(i) / fs + flutterPhase)
            out[i] = Float(s * env * flutter)
        }
        BreathShape.finish(&out, sampleRate: sampleRate, lowpass: lowpass)
        return out
    }
}

/// Breaths from recordings: snippets cut from the narrator's own voice (cached) or a recorded pack. Each breath
/// takes one snippet (by seed), at most the requested length from its start, shaped like the round-8 cuts.
public struct SnippetBreaths: BreathSource {
    public let snippets: [[Float]]
    public let sampleRate: Int

    public init(snippets: [[Float]], sampleRate: Int) {
        self.snippets = snippets.filter { $0.count > sampleRate / 20 }
        self.sampleRate = sampleRate
    }

    public var isEmpty: Bool { snippets.isEmpty }

    private func pick(_ seed: UInt64) -> [Float] {
        guard !snippets.isEmpty else { return [] }
        return snippets[Int(seed % UInt64(snippets.count))]
    }

    public func naturalLength(seed: UInt64) -> Double { Double(pick(seed).count) / Double(max(1, sampleRate)) }

    public func breath(seconds: Double, seed: UInt64, sampleRate rate: Int) -> [Float] {
        let s = pick(seed)
        guard !s.isEmpty, rate == sampleRate else { return [] }
        var out = Array(s.prefix(max(1, Int(seconds * Double(rate)))))
        BreathShape.finish(&out, sampleRate: rate)
        return out
    }
}

/// Where a breath goes in a pause: its start (seconds from the start of the pause) and its length.
public struct BreathPlacement: Sendable, Equatable {
    public let start: Double
    public let length: Double
}

/// The lung budget: decides, sentence by sentence in reading order, whether a breath goes in the pause after it.
public struct BreathPlanner: Sendable {
    public let audio: DeliveryAudio
    /// Speech since the last breath, seconds.
    public private(set) var sinceBreath = 0.0
    private var budget: Double
    private var random: SeededRandom

    public init(audio: DeliveryAudio, seed: UInt64) {
        self.audio = audio
        random = SeededRandom(seed: seed)
        budget = 0
        budget = random.uniform(audio.breathEverySec)
    }

    /// Account for a sentence (`speech` seconds) followed by `pause` seconds of silence; return where a breath of
    /// at most `natural` seconds goes in that pause, or nil. Never longer than the pause allows.
    public mutating func plan(speech: Double, pause: Double, point: BreathPoint?, natural: Double) -> BreathPlacement? {
        sinceBreath += max(0, speech)
        guard let point, pause > 0, natural > 0 else { return nil }
        if point == .sentence, pause < audio.breathMinPause * 0.5 { return nil } // the listener's speed shrank it too far
        let need = point == .paragraph ? audio.breathParagraphSec : budget
        guard sinceBreath >= need else { return nil }
        let startGap = random.uniform(audio.breathStart)
        let endGap = random.uniform(audio.breathEnd)
        let room = pause - startGap - endGap
        let length = min(natural, room)
        guard length >= audio.breathShortest else { return nil }
        sinceBreath = 0
        budget = random.uniform(audio.breathEverySec)
        // As late as the gap before the next sentence allows: the breath leads into it.
        return BreathPlacement(start: pause - endGap - length, length: length)
    }

    /// A new chapter or a jump: start counting again.
    public mutating func reset() {
        sinceBreath = 0
    }
}
