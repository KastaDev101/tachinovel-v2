//
//  SynthesisStats.swift — numbers for the Voice Lab (Settings › About › tap the version 5 times).
//
//  Per sentence: synthesis time, audio length, real-time factor. Per session: time to first audio and which
//  voice produced it. Plus model load times and fallback counts, so a listening session on the phone can be
//  reported in one copy-paste.
//

import Foundation

public struct SentenceStat: Sendable, Equatable, Codable {
    public let index: Int
    public let characters: Int
    public let synthMs: Double
    public let audioMs: Double
    public let voice: String
    public let at: Date

    public init(index: Int, characters: Int, synthMs: Double, audioMs: Double, voice: String, at: Date = Date()) {
        self.index = index
        self.characters = characters
        self.synthMs = synthMs
        self.audioMs = audioMs
        self.voice = voice
        self.at = at
    }

    /// Real-time factor: synthesis time / audio time (lower is better; < 1 = faster than real time).
    public var rtf: Double { audioMs > 0 ? synthMs / audioMs : .infinity }
    /// Speed as a multiple of real time (higher is better).
    public var timesRealtime: Double { synthMs > 0 ? audioMs / synthMs : 0 }
}

public struct FirstAudioStat: Sendable, Equatable, Codable {
    public let ms: Double
    public let source: String
    public let at: Date

    public init(ms: Double, source: String, at: Date = Date()) {
        self.ms = ms
        self.source = source
        self.at = at
    }
}

public struct SynthesisStats: Sendable, Equatable {
    public private(set) var sentences: [SentenceStat] = []
    public private(set) var firstAudio: [FirstAudioStat] = []
    public private(set) var loads: [(ms: Double, cold: Bool)] = []
    public private(set) var totalSynthMs: Double = 0
    public private(set) var totalAudioMs: Double = 0
    public private(set) var totalSentences = 0
    public private(set) var failures = 0
    public let keep: Int

    public init(keep: Int = 40) {
        self.keep = max(1, keep)
    }

    public static func == (a: SynthesisStats, b: SynthesisStats) -> Bool {
        a.sentences == b.sentences && a.firstAudio == b.firstAudio && a.totalSynthMs == b.totalSynthMs && a.totalAudioMs == b.totalAudioMs
    }

    public mutating func record(_ s: SentenceStat) {
        sentences.append(s)
        if sentences.count > keep { sentences.removeFirst(sentences.count - keep) }
        totalSynthMs += s.synthMs
        totalAudioMs += s.audioMs
        totalSentences += 1
    }

    public mutating func recordFailure() { failures += 1 }

    public mutating func recordFirstAudio(_ f: FirstAudioStat) {
        firstAudio.append(f)
        if firstAudio.count > 10 { firstAudio.removeFirst(firstAudio.count - 10) }
    }

    public mutating func recordLoad(ms: Double, cold: Bool) {
        loads.append((ms: ms, cold: cold))
        if loads.count > 10 { loads.removeFirst(loads.count - 10) }
    }

    public mutating func reset() {
        self = SynthesisStats(keep: keep)
    }

    /// Σ audio / Σ synthesis over the whole session (higher is better).
    public var aggregateTimesRealtime: Double { totalSynthMs > 0 ? totalAudioMs / totalSynthMs : 0 }

    /// Percentile (0…1) of the per-sentence real-time multiple over the kept sentences.
    public func timesRealtimePercentile(_ p: Double) -> Double {
        let xs = sentences.map(\.timesRealtime).sorted()
        guard !xs.isEmpty else { return 0 }
        let idx = Int((Double(xs.count - 1) * min(1, max(0, p))).rounded())
        return xs[idx]
    }

    /// JSON-friendly snapshot for the UI.
    public func dictionary() -> [String: Any] {
        let iso = ISO8601DateFormatter()
        return [
            "sentences": sentences.map { s in
                ["index": s.index, "chars": s.characters, "synthMs": round1(s.synthMs), "audioMs": round1(s.audioMs),
                 "rtf": s.rtf.isFinite ? round3(s.rtf) : -1, "x": round1(s.timesRealtime), "voice": s.voice, "at": iso.string(from: s.at)] as [String: Any]
            },
            "firstAudio": firstAudio.map { ["ms": round1($0.ms), "source": $0.source, "at": iso.string(from: $0.at)] as [String: Any] },
            "loads": loads.map { ["ms": round1($0.ms), "cold": $0.cold] as [String: Any] },
            "totalSentences": totalSentences,
            "failures": failures,
            "aggregateX": round1(aggregateTimesRealtime),
            "p50X": round1(timesRealtimePercentile(0.5)),
            "p05X": round1(timesRealtimePercentile(0.05)),
        ]
    }

    private func round1(_ x: Double) -> Double { (x * 10).rounded() / 10 }
    private func round3(_ x: Double) -> Double { (x * 1000).rounded() / 1000 }
}
