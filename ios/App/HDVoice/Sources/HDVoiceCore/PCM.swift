//
//  PCM.swift — post-processing of one synthesized sentence before it is scheduled for playback.
//
//  Kokoro returns 24 kHz mono float samples with its own lead-in/out silence. Sentences are played back to
//  back with the front-end's pauses (v1 frontend.ts: 320 ms sentence, 700 ms paragraph, …), so the model's
//  own silence is trimmed to a short margin, the edges get a few-ms fade (no clicks at buffer joins), the
//  level follows a slow loudness match (so Kokoro and the Apple voice sound equally loud when they take
//  turns), and the pause is appended as digital silence.
//

import Foundation

public enum PCM {
    /// Remove leading/trailing near-silence, keeping a short margin so consonants aren't clipped.
    public static func trimSilence(_ samples: [Float], sampleRate: Int, threshold: Float = 0.003, keepLead: TimeInterval = 0.02, keepTail: TimeInterval = 0.04) -> [Float] {
        guard !samples.isEmpty else { return samples }
        guard let first = samples.firstIndex(where: { abs($0) > threshold }),
              let last = samples.lastIndex(where: { abs($0) > threshold }) else { return [] }
        let lead = Int(Double(sampleRate) * keepLead)
        let tail = Int(Double(sampleRate) * keepTail)
        let start = max(0, first - lead)
        let end = min(samples.count - 1, last + tail)
        return Array(samples[start...end])
    }

    /// Linear fade-in/out over the given durations (in place).
    public static func applyFades(_ samples: inout [Float], sampleRate: Int, fadeIn: TimeInterval = 0.004, fadeOut: TimeInterval = 0.008) {
        let n = samples.count
        guard n > 1 else { return }
        let fin = min(n, max(1, Int(Double(sampleRate) * fadeIn)))
        let fout = min(n, max(1, Int(Double(sampleRate) * fadeOut)))
        for i in 0..<fin { samples[i] *= Float(i) / Float(fin) }
        for i in 0..<fout { samples[n - 1 - i] *= Float(i) / Float(fout) }
    }

    /// Number of frames of silence for a pause.
    public static func silenceFrames(seconds: TimeInterval, sampleRate: Int) -> Int {
        guard seconds.isFinite, seconds > 0 else { return 0 }
        return Int((seconds * Double(sampleRate)).rounded())
    }

    public static func rms(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var acc: Double = 0
        for s in samples { acc += Double(s) * Double(s) }
        return Float((acc / Double(samples.count)).squareRoot())
    }

    public static func peak(_ samples: [Float]) -> Float {
        samples.reduce(0) { max($0, abs($1)) }
    }

    /// Everything above, in order: trim, loudness, fades, pause. Returns the frames to schedule.
    public static func prepareSentence(_ samples: [Float], sampleRate: Int, pause: TimeInterval, loudness: inout LoudnessMatcher) -> [Float] {
        var out = trimSilence(samples, sampleRate: sampleRate)
        let gain = loudness.gain(for: out)
        if gain != 1 { for i in out.indices { out[i] *= gain } }
        applyFades(&out, sampleRate: sampleRate)
        let silence = silenceFrames(seconds: pause, sampleRate: sampleRate)
        if silence > 0 { out.append(contentsOf: repeatElement(Float(0), count: silence)) }
        return out
    }
}

/// Slow loudness match: a running RMS over sentences (not per sentence, so a whispered line stays quiet)
/// steers one gain toward `target`, clamped, with a peak limit so nothing clips.
public struct LoudnessMatcher: Sendable, Equatable {
    /// Target RMS (≈ −20 dBFS, about where the Apple voices sit).
    public var target: Float
    public var minGain: Float
    public var maxGain: Float
    /// Weight of a new sentence in the running RMS.
    public var smoothing: Float
    public private(set) var runningRMS: Float?

    public init(target: Float = 0.1, minGain: Float = 0.5, maxGain: Float = 4, smoothing: Float = 0.2) {
        self.target = target
        self.minGain = minGain
        self.maxGain = maxGain
        self.smoothing = smoothing
    }

    public mutating func gain(for samples: [Float]) -> Float {
        let r = PCM.rms(samples)
        guard r > 0.0005 else { return 1 } // silence or near-silence: leave it alone
        let running = runningRMS.map { $0 + smoothing * (r - $0) } ?? r
        runningRMS = running
        var g = min(maxGain, max(minGain, target / running))
        let p = PCM.peak(samples)
        if p * g > 0.97 { g = max(0.05, 0.97 / p) }
        return g
    }
}

/// 16-bit PCM mono WAV (voice samples, CI checks).
public enum WAV {
    public static func pcm16(_ samples: [Float], sampleRate: Int) -> Data {
        var d = Data()
        d.reserveCapacity(44 + samples.count * 2)
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        d.append(contentsOf: Array("RIFF".utf8))
        u32(36 + bytes)
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8))
        u32(16)
        u16(1) // PCM
        u16(1) // mono
        u32(UInt32(sampleRate))
        u32(UInt32(sampleRate * 2))
        u16(2)
        u16(16)
        d.append(contentsOf: Array("data".utf8))
        u32(bytes)
        for s in samples {
            let clamped = s.isFinite ? max(-1, min(1, s)) : 0
            u16(UInt16(bitPattern: Int16(clamped * 32767)))
        }
        return d
    }
}
