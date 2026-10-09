//
//  NephisFlow.swift — the Nephis narrator's continuous read, platform-free logic (Kasta, 2026-10-07).
//
//  Pocket TTS reads each paragraph in its own session. Read naively, every paragraph restarts: a cold decoder
//  (thump), a voice that resets to its clip (pitch and mood jump), the model's "uh" before the first word, and joins
//  that can only be spliced as audio (cuts, dead silence). The flow engine works on the model's latents instead
//  (80 ms each, 32 values, before Mimi turns them into sound) and decodes everything as one stream:
//
//    carry-over  each paragraph's voice prompt = her clip (5 s) + the last 5 s she said, projected from the latents
//                she generated (`Projection`; no encoder): the mood, pitch and pace continue;
//    lead-in     the paragraph is spoken after the sentence before it, and that sentence is dropped at a latent that
//                lies in real silence (speech recognition finds the word, the level confirms the silence);
//    joins       the silence after one paragraph and before the next are trimmed to the pause wanted, then blended
//                over a few latents, and a longer pause morphs from one silence into the other: never a butt join,
//                never a repeated latent, never dead silence;
//    clean-up    the opening "uh" of a read is dropped; a lone click inside a pause is interpolated away;
//    takes       several takes of a paragraph can be scored: every word read (speech recognition), then the smallest
//                pitch and loudness jump from what she just said.
//
//  Measured on the PC prototype (shroud passage): joins smoother than the model's own pauses (0.13 vs 1.0), tone
//  changes within 1.2 semitones, every word correct. ExpressiveEngines' NephisFlowSynth runs it with FluidAudio.
//

import Foundation

public enum NephisFlow {
    public static let samplesPerLatent = 1920
    public static let sampleRate = 24_000
    public static let latentSeconds = 0.08
    public static let embeddingDim = 1024
    public static let latentDim = 32
    /// Her clip and the carry-over each take 5 s (62 latents); FluidAudio's voice prompt holds at most 125.
    public static let clipFrames = 62
    public static let carryFrames = 62
    /// Latents blended at a join (240 ms).
    public static let overlap = 3
    /// A latent quieter than this (dBFS) is silence for joins and pauses; a word is louder than `speechDB`.
    public static let silenceDB = -40.0
    public static let quietDB = -50.0
    public static let speechDB = -28.0

    // MARK: - Levels

    /// The level of each latent's audio (dBFS), from decoded samples (1920 per latent).
    public static func levels(_ audio: [Float]) -> [Double] {
        let n = audio.count / samplesPerLatent
        return (0..<n).map { k in
            var acc = 0.0
            for i in k * samplesPerLatent..<(k + 1) * samplesPerLatent { acc += Double(audio[i]) * Double(audio[i]) }
            return 10 * log10(max(acc / Double(samplesPerLatent), 1e-12))
        }
    }

    /// Latents of silence before the first word and after the last one.
    public static func silence(_ levels: [Double]) -> (head: Int, tail: Int) {
        var head = 0
        while head < levels.count, levels[head] < silenceDB { head += 1 }
        var tail = 0
        while tail < levels.count - head, levels[levels.count - 1 - tail] < silenceDB { tail += 1 }
        return (head, tail)
    }

    // MARK: - Carry-over

    /// Pocket TTS's speaker projection and latent normalization (BuiltInVoices/pocket/speaker-projection.bin).
    public struct Projection: Sendable {
        public let weights: [Float]   // [embeddingDim, latentDim], row-major
        public let std: [Float]
        public let mean: [Float]

        public init?(data: Data) {
            let floats = embeddingDim * latentDim + 2 * latentDim
            guard data.count == floats * 4 else { return nil }
            var all = [Float](repeating: 0, count: floats)
            data.withUnsafeBytes { raw in
                for i in 0..<floats { all[i] = Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: i * 4, as: UInt32.self))) }
            }
            guard all.allSatisfy(\.isFinite) else { return nil }
            weights = Array(all[0..<embeddingDim * latentDim])
            std = Array(all[embeddingDim * latentDim..<embeddingDim * latentDim + latentDim])
            mean = Array(all[(embeddingDim * latentDim + latentDim)...])
        }

        /// Voice-prompt frames (embeddingDim each, flattened) for latents she generated: projection × (latent ×
        /// std + mean), the same as encoding the audio they decode to (cosine 0.98 on the PC).
        public func condition(_ latents: [[Float]]) -> [Float] {
            var out = [Float](repeating: 0, count: latents.count * embeddingDim)
            for (f, latent) in latents.enumerated() where latent.count == latentDim {
                var x = [Float](repeating: 0, count: latentDim)
                for j in 0..<latentDim { x[j] = latent[j] * std[j] + mean[j] }
                for d in 0..<embeddingDim {
                    var acc: Float = 0
                    let row = d * latentDim
                    for j in 0..<latentDim { acc += weights[row + j] * x[j] }
                    out[f * embeddingDim + d] = acc
                }
            }
            return out
        }
    }

    /// Chain settings a Nephis model pack carries (pack.json "chain"), tuned on the PC for that model; any field it
    /// leaves out keeps the default here.
    public struct Chain: Codable, Sendable, Equatable {
        /// Pause between the pieces of one paragraph, and after a piece ending in "…" or ":" (seconds).
        public var pieceGap = 0.45
        public var ellipsisGap = 0.8
        /// Scales the pause before a paragraph (the director's natural pause).
        public var paragraphGapScale = 1.0
        /// Voice-prompt frames from her mood clip, and from what she just said (carry-over); at most 125 together.
        public var clipFrames = NephisFlow.clipFrames
        /// Carry-over used in her prompt: 12 (1 s) beat 62, 25 and none in the PC chain test (likeness 0.962, follows moods best).
        public var carryFrames = 12
        /// Her timing and level per mood (the director's mood names); a mood not listed uses the gaps above.
        public var moods: [String: Mood] = NephisFlow.herMoods
        /// Her EQ's lift above 2.5 kHz for this pack's decoder (dB); nil = the shipped +5.95 (VoiceTilt.nephis).
        public var highShelfDB: Double?

        /// What she does in one mood: pauses after a sentence, after "…"/":", after a paragraph (seconds), and the
        /// level change against calm that the model doesn't make by itself (dB).
        public struct Mood: Codable, Sendable, Equatable {
            public var sentence: Double
            public var trail: Double
            public var paragraph: Double
            public var gainDB: Double
            /// Her tone in this mood against calm, as a 2.5 kHz shelf (dB; nil = none): the model makes tender and
            /// awe brighter than she is, sad and dread duller (PC chain, r13: 0.95 dB off on average, 0.10 with it).
            public var toneDB: Double?
            public init(sentence: Double, trail: Double, paragraph: Double, gainDB: Double, toneDB: Double? = nil) {
                self.sentence = sentence; self.trail = trail; self.paragraph = paragraph; self.gainDB = gainDB; self.toneDB = toneDB
            }
        }

        /// The pause after a piece ending `piece`, in `mood`.
        public func gap(after piece: String, mood: String?) -> Double {
            let t = piece.trimmingCharacters(in: .whitespaces)
            let trailing = t.hasSuffix("…") || t.hasSuffix("...") || t.hasSuffix(":")
            if let m = mood.flatMap({ moods[$0] }) { return trailing ? m.trail : m.sentence }
            return trailing ? ellipsisGap : pieceGap
        }

        public init() {}

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            pieceGap = try c.decodeIfPresent(Double.self, forKey: .pieceGap) ?? pieceGap
            ellipsisGap = try c.decodeIfPresent(Double.self, forKey: .ellipsisGap) ?? ellipsisGap
            paragraphGapScale = try c.decodeIfPresent(Double.self, forKey: .paragraphGapScale) ?? paragraphGapScale
            clipFrames = min(125, max(1, try c.decodeIfPresent(Int.self, forKey: .clipFrames) ?? clipFrames))
            carryFrames = min(125 - clipFrames, max(0, try c.decodeIfPresent(Int.self, forKey: .carryFrames) ?? carryFrames))
            highShelfDB = try c.decodeIfPresent(Double.self, forKey: .highShelfDB).map { min(8, max(-2, $0)) }
            // A pack's moods replace these one by one, clamped to sane values.
            for (name, m) in try c.decodeIfPresent([String: Mood].self, forKey: .moods) ?? [:] {
                moods[name] = Mood(sentence: min(2, max(0.1, m.sentence)), trail: min(2.5, max(0.1, m.trail)),
                                   paragraph: min(3, max(0.2, m.paragraph)), gainDB: min(6, max(-6, m.gainDB)),
                                   toneDB: m.toneDB.map { min(4, max(-4, $0)) })
            }
        }
    }

    /// Measured on her real ElevenLabs reading (v4 chunks, word-aligned, 2026-10-09, her_style.py): median pauses per
    /// mood, and the level she adds against calm minus what the trained model already adds (PC chain sim, r9).
    /// Intense halves her pauses (0.46 s after a sentence, 0.54 s between paragraphs; calm 0.84 / 1.04); triumph and
    /// playful are much louder than the model makes them.
    public static let herMoods: [String: Chain.Mood] = [
        "calm": .init(sentence: 0.84, trail: 0.9, paragraph: 1.04, gainDB: 0),
        "wry": .init(sentence: 0.58, trail: 0.42, paragraph: 0.66, gainDB: 1.0),
        "playful": .init(sentence: 0.48, trail: 0.51, paragraph: 0.70, gainDB: 3.0),
        "tense": .init(sentence: 0.58, trail: 0.52, paragraph: 0.64, gainDB: 0.5),
        "dread": .init(sentence: 0.64, trail: 0.52, paragraph: 0.62, gainDB: -0.4),
        "intense": .init(sentence: 0.46, trail: 0.41, paragraph: 0.54, gainDB: 1.4),
        "sad": .init(sentence: 0.68, trail: 0.56, paragraph: 0.64, gainDB: -0.6),
        "tender": .init(sentence: 0.70, trail: 0.48, paragraph: 0.78, gainDB: -0.3),
        "awe": .init(sentence: 0.66, trail: 0.42, paragraph: 0.71, gainDB: 0),
        "hushed": .init(sentence: 0.50, trail: 0.42, paragraph: 0.65, gainDB: 0),
        "triumph": .init(sentence: 0.48, trail: 0.5, paragraph: 0.65, gainDB: 3.8),
        "cold": .init(sentence: 0.54, trail: 0.6, paragraph: 0.72, gainDB: 1.6),
    ]

    /// The voice prompt for a paragraph: her clip (its first `clipFrames`), half the previous mood's clip and half
    /// this one's at a mood change, then the carry-over (the conditioning of the last latents she said).
    public static func prompt(clip: [Float], previousClip: [Float]?, carry: [Float], clipFrames: Int = clipFrames) -> (frames: [Float], count: Int) {
        let dim = embeddingDim
        func head(_ c: [Float], _ frames: Int) -> [Float] { Array(c.prefix(min(c.count / dim, frames) * dim)) }
        var out: [Float]
        if let previousClip {
            out = head(previousClip, clipFrames / 2) + head(clip, clipFrames - clipFrames / 2)
        } else {
            out = head(clip, clipFrames)
        }
        let room = (125 - out.count / dim) * dim
        out += Array(carry.suffix(min(carry.count, max(0, room))))
        return (out, out.count / dim)
    }

    // MARK: - Lead-in

    public struct Word: Sendable, Equatable {
        public var start: Double
        public var end: Double
        public var text: String
        public init(start: Double, end: Double, text: String) {
            self.start = start
            self.end = end
            self.text = text
        }
    }

    static func norm(_ s: String) -> String { String(s.lowercased().unicodeScalars.filter { CharacterSet.lowercaseLetters.contains($0) }) }
    static func words(_ s: String) -> [String] { s.split(whereSeparator: { $0 == " " || $0 == "\n" }).map { norm(String($0)) }.filter { !$0.isEmpty } }

    /// The first latent to keep after a lead-in: speech recognition finds the lead-in's last word followed by the
    /// paragraph's first word, then the cut walks forward to real silence (two latents under `quietDB`, since word
    /// ends are marked early) before that first word starts. nil = the take is not usable.
    public static func leadInCut(words recognized: [Word], lead: String, piece: String, levels: [Double]) -> Int? {
        let lw = words(lead), pw = words(piece)
        guard let lastLead = lw.last, let firstPiece = pw.first, !recognized.isEmpty else { return nil }
        let lo = max(0, lw.count - 3), hi = min(recognized.count - 1, lw.count + 2)
        guard lo < hi else { return nil }
        for i in lo..<hi where norm(recognized[i].text) == lastLead && norm(recognized[i + 1].text) == firstPiece {
            var k = Int((recognized[i].end / latentSeconds).rounded(.up))
            let stop = min(levels.count, Int(recognized[i + 1].start / latentSeconds) + 2)
            while k + 1 < stop, !(levels[k] < quietDB && levels[k + 1] < quietDB) { k += 1 }
            guard k + 1 < levels.count, levels[k] < quietDB, levels[k + 1] < quietDB else { return nil }
            return k
        }
        return nil
    }

    /// How well the words spoken after `from` seconds match the text (1 = every word, in order).
    public static func wordMatch(_ recognized: [Word], text: String, from: Double = 0) -> Double {
        let want = words(text)
        let said = recognized.filter { $0.start >= from - 0.02 }.map { norm($0.text) }.filter { !$0.isEmpty }
        guard !want.isEmpty else { return 1 }
        // 2 × matched / (want + said), matched by longest common subsequence (difflib's ratio, close enough).
        var dp = [Int](repeating: 0, count: said.count + 1)
        for w in want {
            var prev = 0
            for j in 1...max(1, said.count) where j <= said.count {
                let tmp = dp[j]
                dp[j] = w == said[j - 1] ? prev + 1 : max(dp[j], dp[j - 1])
                prev = tmp
            }
        }
        return 2 * Double(dp[said.count]) / Double(want.count + said.count)
    }

    // MARK: - Clean-up

    /// Latents to drop at the very start of a read: the model's "uh" before the first word (up to the quiet dip
    /// before it, at most about a second in), never the word.
    public static func openingDrop(_ levels: [Double]) -> Int {
        guard let on = (0..<max(0, levels.count - 1)).first(where: { levels[$0] > speechDB && levels[$0 + 1] > speechDB }),
              on > 0, on <= 14 else { return 0 }
        let dip = (0..<on).min(by: { levels[$0] < levels[$1] }) ?? 0
        return (levels[0...dip].max() ?? levels[dip]) > levels[dip] + 6 ? dip : 0
    }

    /// Latents of noise before a piece's first word inside a read (an "uh", a mumble): an audible sound in the first
    /// second, at least 6 dB under the speech that follows and followed by a dip, never a word (words are as loud as
    /// the speech after them). 0 = none.
    public static func leadingNoise(_ levels: [Double]) -> Int {
        guard let on = (0..<max(0, levels.count - 1)).first(where: { levels[$0] > speechDB && levels[$0 + 1] > speechDB }),
              on > 1, on <= 14,
              let sound = (0..<on).first(where: { levels[$0] > silenceDB }), sound + 1 < on else { return 0 }
        let dip = (sound + 1..<on).min(by: { levels[$0] < levels[$1] }) ?? sound
        let before = levels[sound..<dip].max() ?? -100
        let after = levels[on..<min(levels.count, on + 10)]
        let speech = after.reduce(0, +) / Double(after.count)
        guard before > silenceDB, before > levels[dip] + 6, before < speech - 6 else { return 0 }
        return dip
    }

    /// After a piece's last word: once the sound has died away (two latents under `quietDB`, at least `ring` latents
    /// past the end of the text), anything louder again is the model mumbling into the pause. Each such latent
    /// becomes the quiet latent before it. Returns how many were replaced.
    @discardableResult
    public static func cleanTail(_ latents: inout [[Float]], levels: inout [Double], endOfText: Int, ring: Int = 4, hold: Int = 4) -> Int {
        // The end of the text is an estimate and a last word can dip quiet inside it (a stop before "-ed", a soft
        // final consonant): 2 quiet latents after 2 of ring clipped last syllables on the phone (Voice test
        // 2026-10-09, "cutting sentences short"). Now the sound must stay quiet for `hold` latents (320 ms).
        var k = max(0, endOfText + ring)
        while k + hold <= levels.count, !(k..<(k + hold)).allSatisfy({ levels[$0] < quietDB }) { k += 1 }
        guard k + hold <= levels.count else { return 0 }
        var n = 0
        var quiet = k + hold - 1
        for i in (k + hold)..<max(k + hold, levels.count) {
            if levels[i] > quietDB {
                latents[i] = latents[quiet]
                levels[i] = levels[quiet]
                n += 1
            } else {
                quiet = i
            }
        }
        return n
    }

    /// Inside a pause (latents lo..<hi), a lone latent or two above `quietDB` with quiet on both sides (a mouth click)
    /// becomes an interpolation of its quiet neighbours. Returns how many latents were replaced.
    @discardableResult
    public static func cleanClicks(_ latents: inout [[Float]], levels: inout [Double], from lo: Int, to hi: Int) -> Int {
        var n = 0
        var i = lo + 2
        while i < hi - 2, i < latents.count {
            if levels[i] > quietDB, levels[i - 1] < quietDB, levels[i - 2] < quietDB {
                var j = i
                while j < hi, levels[j] > quietDB, j - i < 2 { j += 1 }
                if j + 1 < hi, levels[j] < quietDB, levels[j + 1] < quietDB {
                    for k in i..<j {
                        let w = Float(k - i + 1) / Float(j - i + 1)
                        latents[k] = zip(latents[i - 1], latents[j]).map { (1 - w) * $0 + w * $1 }
                        levels[k] = quietDB - 10
                        n += 1
                    }
                }
                i = j
            }
            i += 1
        }
        return n
    }

    // MARK: - Joins

    /// Joins the silence after one paragraph (`tail`, all of it silence) to the next paragraph (`next`, whose first
    /// `head` latents are silence) at a pause of `pause` seconds: trims the far ends of the two silences, blends
    /// `overlap` latents where they meet, and, for a longer pause, morphs from one into the other. Returns the
    /// latents to decode, starting with the trimmed tail.
    public static func join(tail: [[Float]], next: [[Float]], head: Int, pause: Double) -> [[Float]] {
        joinPadded(tail: tail, next: next, head: head, pause: pause, maxBridge: .max).latents
    }

    /// Latents a long pause may be decoded through (240 ms); the rest of it is true silence spliced into the audio.
    /// Decoding a pause from near-identical quiet latents makes Mimi buzz at its frame rate: a periodic 12.5 Hz
    /// "du du du" 11-18 dB over her real pauses (PC test 2026-10-09: 80 ms periodicity 0.78-0.92), heard on the phone
    /// before system lines (the longest pauses) and at long paragraph pauses.
    public static let maxBridge = 3
    /// Silence latents decoded around a long pause: her fade-out after the last word (240 ms) and the lead-in before
    /// the next (160 ms); everything between them is true silence.
    public static let keepTail = 3
    public static let keepHead = 2
    /// With the latents' levels known, the silence starts only once her fade-out is under `fadeDB` (two latents in a
    /// row), and the lead-in keeps everything over it: a fixed 240 ms cut the end of a long-trailing word while it was
    /// still audible ("...steadied in her hand", Voice test 2026-10-09: -55 dB at the cut).
    public static let fadeDB = -68.0
    public static let maxTail = 10
    public static let maxHead = 6

    /// Latents of fade-out to decode after the last word: up to and including the first of two quiet ones.
    public static func fadeOut(_ levels: [Double]) -> Int {
        var i = 0
        while i + 1 < levels.count, !(levels[i] < fadeDB && levels[i + 1] < fadeDB) { i += 1 }
        return min(maxTail, max(keepTail, i + 1))
    }

    /// Latents of lead-in to decode before the next word (`levels`: the silence before it): back to the first of two
    /// quiet ones.
    public static func leadIn(_ levels: [Double]) -> Int {
        var i = levels.count - 1
        while i > 0, !(levels[i] < fadeDB && levels[i - 1] < fadeDB) { i -= 1 }
        return min(maxHead, max(keepHead, levels.count - i))
    }

    /// `join`, but a pause longer than its bridge is decoded with only `maxBridge` morph latents; `padAt` is where in
    /// the returned latents `padSeconds` of silence go in the decoded audio (the middle of the bridge).
    public static func joinPadded(tail: [[Float]], next: [[Float]], head: Int, pause: Double, maxBridge: Int = NephisFlow.maxBridge,
                                  tailLevels: [Double]? = nil, headLevels: [Double]? = nil)
        -> (latents: [[Float]], padAt: Int?, padSeconds: Double) {
        var a = tail, b = next
        let ov = max(0, min(overlap, a.count - 1, head - 1))
        let want = max(2, Int((pause / latentSeconds).rounded()))
        // A pause longer than her fade-out + lead-in: decode only those (the first `keepTail` latents after the last
        // word, the last `keepHead` before the next) and make all the rest silence. The model's own quiet latents buzz
        // too, not just a morph between them (phone Voice test 2026-10-09, after the bridge cap: shorter, still there).
        let keepTail = min(a.count, tailLevels.map(fadeOut) ?? Self.keepTail), keepHead = min(head, headLevels.map(leadIn) ?? Self.keepHead)
        if maxBridge != .max, want > keepTail + keepHead, a.count + head > keepTail + keepHead {
            return (Array(a.prefix(keepTail)) + Array(b.dropFirst(head - keepHead)), keepTail,
                    Double(want - keepTail - keepHead) * latentSeconds)
        }
        let have = a.count + head - ov
        var headLeft = head
        if have > want {
            var extra = have - want
            let fromTail = min(extra, max(0, a.count - ov - 2))
            a.removeLast(fromTail)                 // the silence's far ends: never right after the last word
            extra -= fromTail
            let fromHead = min(extra, max(0, headLeft - ov - 2))
            b.removeFirst(fromHead)
            headLeft -= fromHead
        }
        var out: [[Float]]
        if ov > 0 {
            let mix = (0..<ov).map { k -> [Float] in
                let w = Float(k + 1) / Float(ov + 1)
                return zip(a[a.count - ov + k], b[k]).map { (1 - w) * $0 + w * $1 }
            }
            out = Array(a.dropLast(ov)) + mix
            b.removeFirst(ov)
        } else {
            out = a
        }
        let now = out.count + max(0, headLeft - ov)
        var padAt: Int?
        var padSeconds = 0.0
        if now < want, let last = out.last, let first = b.first {
            let nb = want - now
            let decoded = min(nb, maxBridge)
            if decoded < nb {
                padAt = out.count + decoded / 2
                padSeconds = Double(nb - decoded) * latentSeconds
            }
            out += (0..<decoded).map { k in
                let w = Float(k + 1) / Float(decoded + 1)
                return zip(last, first).map { (1 - w) * $0 + w * $1 }
            }
        }
        return (out + b, padAt, padSeconds)
    }

    /// A high shelf (RBJ) over `x`, from a fresh filter state: one call's mood tone (the call starts in a pause).
    public static func highShelf(_ x: inout [Float], db: Double, hz: Double = 2500, q: Double = 0.586, sampleRate: Int = sampleRate) {
        guard db != 0, !x.isEmpty else { return }
        let a = pow(10, db / 40), w = 2 * Double.pi * hz / Double(sampleRate), c = cos(w), s = sin(w)
        let sq = 2 * sqrt(a) * s / (2 * q)
        let a0 = (a + 1) - (a - 1) * c + sq
        let b0 = a * ((a + 1) + (a - 1) * c + sq) / a0, b1 = -2 * a * ((a - 1) + (a + 1) * c) / a0
        let b2 = a * ((a + 1) + (a - 1) * c - sq) / a0, a1 = 2 * ((a - 1) - (a + 1) * c) / a0, a2 = ((a + 1) - (a - 1) * c - sq) / a0
        var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
        for i in x.indices {
            let v = Double(x[i])
            let y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = v; y2 = y1; y1 = y
            x[i] = Float(y)
        }
    }

    /// Splices `pads` (latent index in the decoded stream, seconds) of silence into decoded audio, with 10 ms fades
    /// into and out of each so the level never steps.
    public static func insertSilence(_ samples: [Float], pads: [(at: Int, seconds: Double)], sampleRate: Int = sampleRate) -> [Float] {
        guard !pads.isEmpty else { return samples }
        var out = samples
        let fade = sampleRate / 100
        for pad in pads.sorted(by: { $0.at > $1.at }) {
            let i = min(out.count, pad.at * samplesPerLatent)
            for k in 0..<min(fade, i) { out[i - 1 - k] *= Float(k) / Float(fade) }
            for k in 0..<min(fade, out.count - i) { out[i + k] *= Float(k) / Float(fade) }
            out.insert(contentsOf: [Float](repeating: 0, count: Int(pad.seconds * Double(sampleRate))), at: i)
        }
        return out
    }

    // MARK: - Takes

    /// Median pitch (Hz) over voiced 40 ms frames, by autocorrelation; nil when nothing is voiced.
    public static func pitch(_ audio: [Float], sampleRate: Int = NephisFlow.sampleRate) -> Double? {
        let n = Int(0.04 * Double(sampleRate)), hop = Int(0.01 * Double(sampleRate))
        let lo = sampleRate / 400, hi = sampleRate / 70
        guard audio.count > n + hi else { return nil }
        var found: [Double] = []
        var x = [Float](repeating: 0, count: n)
        audio.withUnsafeBufferPointer { a in
            x.withUnsafeMutableBufferPointer { x in
                var i = 0
                while i + n < audio.count {
                    var mean: Float = 0
                    for j in 0..<n { mean += a[i + j] }
                    mean /= Float(n)
                    var energy: Float = 0
                    for j in 0..<n {
                        x[j] = a[i + j] - mean
                        energy += x[j] * x[j]
                    }
                    if 10 * log10(max(Double(energy) / Double(n), 1e-12)) >= -32 {
                        var best = 0.0, lag = 0
                        for l in lo..<min(hi, n - 1) {
                            var acc: Float = 0
                            for j in 0..<(n - l) { acc += x[j] * x[j + l] }
                            let r = Double(acc / max(energy, 1e-9))
                            if r > best { best = r; lag = l }
                        }
                        if best > 0.5, lag > 0 { found.append(Double(sampleRate) / Double(lag)) }
                    }
                    i += hop * 2
                }
            }
        }
        guard !found.isEmpty else { return nil }
        return found.sorted()[found.count / 2]
    }

    /// Mean level (dBFS) of the speech frames (10 ms frames above -40 dBFS).
    public static func speechLevel(_ audio: [Float], sampleRate: Int = NephisFlow.sampleRate) -> Double {
        let n = sampleRate / 100
        var levels: [Double] = []
        var i = 0
        while i + n <= audio.count {
            var acc = 0.0
            for k in i..<i + n { acc += Double(audio[k]) * Double(audio[k]) }
            let db = 10 * log10(max(acc / Double(n), 1e-12))
            if db > -40 { levels.append(db) }
            i += n
        }
        return levels.isEmpty ? -60 : levels.reduce(0, +) / Double(levels.count)
    }

    /// What a take is scored against: the pitch and speech level of what she just said.
    public struct VoiceFeatures: Sendable, Equatable {
        public var pitch: Double?
        public var level: Double
    }

    public static func voiceFeatures(_ audio: [Float]) -> VoiceFeatures {
        VoiceFeatures(pitch: pitch(audio), level: speechLevel(audio))
    }

    /// A take's score against what she just said (lower is better): the pitch jump in semitones plus 0.3 × the
    /// loudness jump in dB.
    public static func jumpScore(take: [Float], context: [Float]) -> Double {
        jumpScore(take: take, reference: voiceFeatures(context))
    }

    /// The same, against features measured once per call (every take is scored against the same context).
    public static func jumpScore(take: [Float], reference: VoiceFeatures) -> Double {
        guard let p = pitch(take), let q = reference.pitch else { return 9 }
        return abs(12 * log2(p / q)) + 0.3 * abs(speechLevel(take) - reference.level)
    }
}
