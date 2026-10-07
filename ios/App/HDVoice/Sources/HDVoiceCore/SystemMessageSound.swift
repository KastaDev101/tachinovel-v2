//
//  SystemMessageSound.swift — LitRPG system messages ("[You have slain a Nightmare Creature.]") sound like the
//  system speaking, not the narrator: a soft two-note interface chime before the line, and the voice band-limited
//  and a little crisp (260 Hz – 6.5 kHz, +2.5 dB at 3 kHz), at the same loudness. Rendered on the PC first
//  (tachinovel scratch system.py, options 1–3); both are on by default (Kasta can switch either off).
//

import Foundation

public enum SystemMessageSound {
    /// Silence between the chime and the line.
    public static let chimeGap = 0.18

    /// C6 then G6, each a short decaying sine (0.42 s), peak about 1.
    public static func chime(sampleRate fs: Int) -> [Float] {
        let n = Int(0.42 * Double(fs))
        var out = [Float](repeating: 0, count: n)
        for (f, decay, onset) in [(1046.5, 9.0, 0.0), (1568.0, 8.0, 0.09)] {
            for i in 0..<n {
                let t = Double(i) / Double(fs) - onset
                guard t >= 0 else { continue }
                out[i] += Float(sin(2 * Double.pi * f * t) * exp(-t * decay) * min(1, t / 0.004))
            }
        }
        let peak = out.map(abs).max() ?? 1
        return peak > 0 ? out.map { $0 / peak } : out
    }

    /// The voice through a narrow, slightly crisp band, loudness kept.
    public static func interfaceTone(_ x: inout [Float], sampleRate fs: Int) {
        guard !x.isEmpty else { return }
        let before = rms(x)
        let rate = Double(fs)
        var filters = [Biquad.highPass(frequency: 260, q: 0.707, sampleRate: rate), Biquad.lowPass(frequency: 6500, q: 0.707, sampleRate: rate),
                       Biquad.peaking(frequency: 3000, q: 1, gainDB: 2.5, sampleRate: rate)]
        for k in filters.indices { filters[k].process(&x) }
        let after = rms(x)
        if after > 0 { for i in x.indices { x[i] *= before / after } }
    }

    /// The line as the system says it: chime first (about 6 dB under the voice), then the toned voice.
    public static func apply(_ x: [Float], sampleRate fs: Int, chime useChime: Bool, tone: Bool) -> [Float] {
        var voice = x
        if tone { interfaceTone(&voice, sampleRate: fs) }
        guard useChime else { return voice }
        let level = rms(x) * 0.5 * 2.0.squareRoot()
        return chime(sampleRate: fs).map { $0 * level } + [Float](repeating: 0, count: Int(chimeGap * Double(fs))) + voice
    }

    static func rms(_ x: [Float]) -> Float {
        guard !x.isEmpty else { return 0 }
        return (x.reduce(0) { $0 + $1 * $1 } / Float(x.count)).squareRoot()
    }
}
