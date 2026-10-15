//
//  NephisSpeedTest.swift — the Voice speed test's platform-free parts (Kasta, 2026-10-15: "have a diagnostics/speed
//  test ready and easily accessible ... for the phone, so I can test it on my phone").
//
//  The test (app: Native/Voice/VoiceSpeedTest.swift) renders a fixed ~45 s passage with the Nephis pack in use, the
//  way Listen renders it, without playing it: the same flow engine, chain, studio, studio EQ and pauses, calls cut the
//  way Listen cuts them (one sentence while less than `fastStartBelow` seconds are ready, then a paragraph's sentences
//  up to the per-call limit, never across a paragraph), each call issued as soon as the one before has its latents.
//  It then works out what playback would have done: a simulated player starts with the first call's audio and plays
//  call after call; a call that isn't ready when the one before ends is a break (`playback`). The audio of the ready
//  calls not yet played is what Listen calls "buffered ahead" (`ahead`): it decides, as in Listen, whether a call gets
//  her studio, a lead-in or a second take.
//

import Foundation

public enum NephisSpeedTest {
    /// An original passage written for the test (about 45 s in her voice), shaped like a novel's opening: long
    /// sentences, a dash, an ellipsis, a line of dialogue and "tentatively" (one of her respellings).
    public static let passage: [String] = [
        "A tired young woman with ink-stained fingers sat on a cold stone step outside the old city library. "
            + "She held a paper cup of tea in both hands \u{2014} not the thin vending-machine kind everyone in her building drank, but proper tea from the corner shop. "
            + "It had cost more than she liked to admit, and the shopkeeper had wrapped it in a napkin as if it were precious. "
            + "But tonight, Mara had decided she deserved it.",
        "After all, the exams were finally over.",
        "Breathing in the steam, she lifted the cup and let the warmth reach her face. "
            + "Then, tentatively, she took a small sip\u{2026} and immediately grimaced.",
        "\u{201C}Oh! Far too hot!\u{201D}",
    ]

    /// Listen sends one sentence per call while less than this much audio (seconds) is ready ahead of playback
    /// (HybridSpeechEngine.pumpRender: her voice starts sooner), then whole paragraphs.
    public static let fastStartBelow = 4.0
    /// The app's pause before a call (HybridSpeechEngine.flowPause range): after a paragraph, and inside one.
    public static let paragraphPause = 0.9
    public static let sentencePause = 0.45

    /// One sentence of the passage and the paragraph it belongs to.
    public struct Sentence: Equatable, Sendable {
        public let text: String
        public let paragraph: Int
        public init(text: String, paragraph: Int) {
            self.text = text
            self.paragraph = paragraph
        }
    }

    /// The passage's sentences: a sentence ends at ".", "!", "?" or "…" (closing quotes stay with it).
    public static func sentences(_ paragraphs: [String]) -> [Sentence] {
        var out: [Sentence] = []
        let enders: Set<Character> = [".", "!", "?", "\u{2026}"]
        let closers: Set<Character> = ["\"", "'", "\u{201D}", "\u{2019}", ")", "]"]
        for (p, paragraph) in paragraphs.enumerated() {
            var current: [Substring] = []
            for word in paragraph.split(whereSeparator: { $0 == " " || $0 == "\n" }) {
                current.append(word)
                var core = word
                while let last = core.last, closers.contains(last) { core = core.dropLast() }
                // A mark at a word's end ends the sentence; an ellipsis followed by a lower-case word ("a small sip…
                // and") goes on in it (mergeInnerEllipses).
                if let last = core.last, enders.contains(last) {
                    out.append(Sentence(text: current.joined(separator: " "), paragraph: p))
                    current = []
                }
            }
            if !current.isEmpty { out.append(Sentence(text: current.joined(separator: " "), paragraph: p)) }
        }
        return mergeInnerEllipses(out)
    }

    /// A sentence ending in "…" whose next sentence (same paragraph) starts in lower case goes on in it.
    private static func mergeInnerEllipses(_ list: [Sentence]) -> [Sentence] {
        var out: [Sentence] = []
        for s in list {
            if let prev = out.last, prev.paragraph == s.paragraph, prev.text.hasSuffix("\u{2026}"),
               let first = s.text.first, first.isLowercase {
                out[out.count - 1] = Sentence(text: prev.text + " " + s.text, paragraph: s.paragraph)
            } else {
                out.append(s)
            }
        }
        return out
    }

    /// The sentences of the call starting at `i`: `i` and the ones after it in the same paragraph, at most `limit`
    /// characters together (joined by spaces); always at least sentence `i`.
    public static func group(_ list: [Sentence], from i: Int, limit: Int) -> Range<Int> {
        guard list.indices.contains(i) else { return i..<i }
        var j = i + 1
        var length = list[i].text.count
        while j < list.count, list[j].paragraph == list[i].paragraph, length + 1 + list[j].text.count <= limit {
            length += 1 + list[j].text.count
            j += 1
        }
        return i..<j
    }

    /// The app's pause before the call starting at sentence `i`: none at the read's start, a paragraph's before a
    /// paragraph, a sentence's inside one.
    public static func pauseBefore(_ list: [Sentence], at i: Int) -> Double? {
        guard i > 0, list.indices.contains(i) else { return nil }
        return list[i].paragraph != list[i - 1].paragraph ? paragraphPause : sentencePause
    }

    /// What playback would have done with the calls: `ready[k]` (seconds from the start) when call k's audio was there,
    /// `seconds[k]` how long it plays. Playback starts with the first call and plays them in order; a call that isn't
    /// ready when the one before ends is a break.
    public struct Playback: Equatable, Sendable {
        /// When playback could start (the first call ready), nil without calls.
        public var firstAudio: Double?
        public var breaks: Int
        public var breakSeconds: Double
        /// The calls that were late (their index).
        public var lateCalls: [Int]
        /// Every call ready before the one before it finished playing.
        public var keepsUp: Bool { breaks == 0 }
        /// When the last call would end playing.
        public var end: Double
    }

    public static func playback(ready: [Double], seconds: [Double]) -> Playback {
        let n = min(ready.count, seconds.count)
        guard n > 0 else { return Playback(firstAudio: nil, breaks: 0, breakSeconds: 0, lateCalls: [], end: 0) }
        var end = ready[0] + max(0, seconds[0])
        var late: [Int] = []
        var waited = 0.0
        for k in 1..<n {
            if ready[k] > end + 1e-3 {
                late.append(k)
                waited += ready[k] - end
                end = ready[k] + max(0, seconds[k])
            } else {
                end += max(0, seconds[k])
            }
        }
        return Playback(firstAudio: ready[0], breaks: late.count, breakSeconds: waited, lateCalls: late, end: end)
    }

    /// Seconds of audio ready but not yet played at `now` (the simulated player of `playback`): Listen's "buffered
    /// ahead", from the calls whose audio is there.
    public static func ahead(at now: Double, ready: [Double], seconds: [Double]) -> Double {
        var end = -Double.infinity
        var left = 0.0
        for k in 0..<min(ready.count, seconds.count) where ready[k] <= now {
            let start = max(ready[k], end)
            let played = min(max(0, now - start), max(0, seconds[k]))
            left += max(0, seconds[k]) - played
            end = start + max(0, seconds[k])
        }
        return left
    }

    /// The report's file name without extension: "speedtest-2026-10-15-1130" (local time).
    public static func fileStem(_ date: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "yyyy-MM-dd-HHmm"
        return "speedtest-\(f.string(from: date))"
    }

    /// A WAV file of 32-bit float mono samples (the exact samples, for the PC).
    public static func wavFloat32(_ samples: [Float], sampleRate: Int) -> Data {
        var d = Data()
        d.reserveCapacity(58 + samples.count * 4)
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 4)
        d.append(contentsOf: Array("RIFF".utf8))
        u32(50 + bytes)
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8))
        u32(18)
        u16(3)  // IEEE float
        u16(1)  // mono
        u32(UInt32(max(0, sampleRate)))
        u32(UInt32(max(0, sampleRate)) * 4)
        u16(4)
        u16(32)
        u16(0)  // no extension
        d.append(contentsOf: Array("fact".utf8))
        u32(4)
        u32(UInt32(samples.count))
        d.append(contentsOf: Array("data".utf8))
        u32(bytes)
        for s in samples { u32((s.isFinite ? s : 0).bitPattern) }
        return d
    }
}
