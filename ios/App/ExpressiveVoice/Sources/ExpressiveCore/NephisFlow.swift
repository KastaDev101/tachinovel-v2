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

    /// Latents of silence before the first word and after the last one. With `hiss` (per latent, `hiss(_:)`), a soft
    /// fricative under `silenceDB` (the "s" opening "Sunny", the one closing "eyes") is part of its word, not silence:
    /// the joins never trim or blend it (car ride 2026-10-13: "s" sounds cut or stuttering).
    public static func silence(_ levels: [Double], hiss: [Double]? = nil) -> (head: Int, tail: Int) {
        let quiet = { (k: Int) in levels[k] < silenceDB && !isFricative(k, levels: levels, hiss: hiss) }
        var head = 0
        while head < levels.count, quiet(head) { head += 1 }
        var tail = 0
        while tail < levels.count - head, quiet(levels.count - 1 - tail) { tail += 1 }
        return (head, tail)
    }

    // MARK: - Fricatives

    /// Hiss from this on (`hiss(_:)`) is a fricative: "s", "sh", "f", "th". Voiced sound (a vowel, an "uh", a hum) stays
    /// under 0.3, breath noise under about 0.5.
    public static let hissFrom = 0.6

    /// Each latent's hiss in decoded `audio`: the energy of the sample-to-sample differences against the energy itself,
    /// 2 × (1 − the lag-1 correlation). About 2 for an "s" (4-8 kHz at 24 kHz), under 0.1 for a vowel. Energy-weighted, so
    /// the noise floor of a quiet latent hardly counts; a silent latent is 0.
    public static func hiss(_ audio: [Float], samplesPerLatent perLatent: Int = samplesPerLatent) -> [Double] {
        guard perLatent > 1 else { return [] }
        let n = audio.count / perLatent
        return (0..<n).map { k in
            var energy = 0.0, diff = 0.0
            let lo = k * perLatent
            for i in lo..<(lo + perLatent) {
                let v = Double(audio[i])
                energy += v * v
                if i > lo { let d = v - Double(audio[i - 1]); diff += d * d }
            }
            return energy > 1e-12 ? diff / energy : 0
        }
    }

    /// Latent k is an audible fricative: above `quietDB` and hissing (`hiss` known for it).
    static func isFricative(_ k: Int, levels: [Double], hiss: [Double]?) -> Bool {
        guard let hiss, k >= 0, k < hiss.count, k < levels.count else { return false }
        return levels[k] > quietDB && hiss[k] >= hissFrom
    }

    /// Where the word whose loud part starts at `on` really begins when it opens with a fricative ("Still", "Spell",
    /// "Sky", "Sunny"): the hissing latents right before it, across up to two quiet latents (the closure of the "t" in
    /// "st"). `on` when there are none, or without `hiss`.
    static func fricativeStart(_ levels: [Double], hiss: [Double]?, on: Int) -> Int {
        guard hiss != nil else { return on }
        var k = on - 1
        var closure = 0
        while k >= 0, closure < 2, !isFricative(k, levels: levels, hiss: hiss), levels[k] < silenceDB {
            k -= 1
            closure += 1
        }
        var start = on
        while k >= 0, isFricative(k, levels: levels, hiss: hiss) {
            start = k
            k -= 1
        }
        return start
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
        /// Pause after a piece that ends mid-sentence (Pocket split a long sentence at a comma, or the script did): a
        /// comma's beat, not a sentence's (car ride 2026-10-13: "the processing cut mid sentence").
        public var clauseGap = 0.25
        /// Scales the pause before a paragraph (the director's natural pause).
        public var paragraphGapScale = 1.0
        /// Voice-prompt frames from her mood clip, and from what she just said (carry-over); at most 125 together.
        public var clipFrames = NephisFlow.clipFrames
        /// Carry-over used in her prompt: 12 (1 s) beat 62, 25 and none in the PC chain test (likeness 0.962, follows moods best).
        public var carryFrames = 12
        /// Her timing and level per mood (the director's mood names); a mood not listed uses the gaps above.
        public var moods: [String: Mood] = NephisFlow.herMoods
        /// Her pause where dialogue hands over at a call's start, by `Handover` name (seconds): never longer than the
        /// pause the call would get otherwise. A mood's own `dialogue` values replace these.
        public var dialogueGaps: [String: Double] = NephisFlow.herDialogueGaps
        /// Her EQ's lift above 2.5 kHz for this pack's decoder (dB); nil = the shipped +5.95 (VoiceTilt.nephis).
        public var highShelfDB: Double?
        /// Her EQ's gentler sibilance (5.5-9 kHz turned down where it sticks out); nil = on. Off for a pack whose
        /// decoder already matches her S sounds: on the phone it pulled them to 6.1 kHz, hers sit at 6.35-6.4 (duller,
        /// a little lispy; Voice test 2026-10-09).
        public var softSibilance: Bool?
        /// Her tone EQ (MimiEQ: the lift above, the warmth, the gentler sibilance) also on the calls her studio
        /// rendered, after it, at its 44.1 kHz (pack.json "eqAfterStudio": true). Off (the default): her studio sound is
        /// her whole tone, as every pack before. For a pack whose studio is brighter than she should sound (Kasta,
        /// 2026-10-13: the darker tone, with the studio).
        public var eqAfterStudio = false
        /// Her breaths as air (BreathPolish, pack.json "breathPolish": {} = the phone's tuned values, any field overrides
        /// one): the vocoder's pitched buzz in her breaths and in the air of breathy words rebuilt from their own smoothed
        /// spectrum with new phase, on each call her studio rendered (and with "plainToo" the others), at the call's rate,
        /// before "eqAfterStudio". Absent or unreadable: off, every call exactly as before (Kasta, 2026-10-13).
        public var breathPolish: BreathPolish.Settings?
        /// Words this model says wrong, respelled the way it says them right (whole words, any case); a pack's list
        /// replaces these entries one by one ("" drops one).
        public var respell: [String: String] = NephisFlow.herRespell
        /// Which text she reads (pack.json "text"): "raw" = the text as written (the script's `delivery.raw`, then
        /// StyleMapper.pocketText's raw form: ellipses, capitals and drawn-out words kept), for a model that reads it
        /// better (tachinovel-tts-lab Q1, 2026-10-12, c7-1500: no last word lost against 6 of 147, no runaway against 3,
        /// her pauses after "..." closer to hers). Absent or anything else = the app's text, as every pack before.
        public var text: PocketTextForm = .app
        /// Her mastering (NephisMaster, pack.json "master": {"preset": "clean"|"warm"|"crisp"|"minimal", "lufs", "ceiling",
        /// "roomTone"}): room tone in the silence pads, de-esser, gentle dynamics, colour, -18 LUFS and a -1 dBTP limiter, one
        /// chain over the whole read at the call's rate. Absent or unreadable: off, every call exactly as before (Kasta,
        /// 2026-10-13: "the SOUND of better audio quality").
        public var master: NephisMaster.Settings?

        /// What Pocket gets for one call: the app's text (`line.text`), or with "text": "raw" the call as written
        /// (`line.raw`, else `line.text`) in the raw form; her respellings either way.
        public func pocketText(for line: ExpressiveLine) -> String {
            let source = text == .raw ? (line.raw ?? line.text) : line.text
            return respelled(StyleMapper.pocketText(StyleMapper.plainText(source), form: text))
        }

        /// `text` with the respellings applied; a capitalized word keeps its capital.
        public func respelled(_ text: String) -> String {
            var out = text
            for (word, said) in respell where !said.isEmpty {
                let pattern = "\\b\(NSRegularExpression.escapedPattern(for: word))\\b"
                guard let rx = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { continue }
                for m in rx.matches(in: out, range: NSRange(out.startIndex..., in: out)).reversed() {
                    guard let r = Range(m.range, in: out) else { continue }
                    let capital = out[r].first?.isUppercase == true
                    out.replaceSubrange(r, with: capital ? said.prefix(1).uppercased() + said.dropFirst() : said)
                }
            }
            return out
        }

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
            /// Her pause where dialogue hands over in this mood, by `Handover` name (seconds; nil = the chain's
            /// `dialogueGaps`). Used as given, even when longer than her sentence pause (a pack measured it).
            public var dialogue: [String: Double]?
            public init(sentence: Double, trail: Double, paragraph: Double, gainDB: Double, toneDB: Double? = nil,
                        dialogue: [String: Double]? = nil) {
                self.sentence = sentence; self.trail = trail; self.paragraph = paragraph; self.gainDB = gainDB; self.toneDB = toneDB
                self.dialogue = dialogue
            }
        }

        /// The pause before a call's first word (NephisFlowSynth.prepareNow). `pauseBefore`: the app's pause after the
        /// sentence before (nil = 0.6, a Voice Lab line); `lastText`/`lastMood`: the piece read last and its mood (nil
        /// at a read's start); `next`: the call's first piece; `handover`: dialogue across the pause, from the script
        /// (nil = read from the quotation marks).
        /// - Her pause after the paragraph before, in its mood; the director's own when it asks for more (a scene
        ///   break, a title) or there is no mood (as before).
        /// - A call that starts inside a paragraph (`pauseBefore` under `paragraphPauseFrom`: a mood change, the call
        ///   length limit, the first sentence alone at a fast start) gets her pause after a sentence (`gap`) instead:
        ///   a paragraph pause there was an extra ~1 s hole (tachinovel-tts-lab Q6).
        /// - Where dialogue hands over (same speaker, a reply, dialogue ↔ narration), her own pause there: about
        ///   0.66 s, never longer than the pause above (a mood's `dialogue` value as given) (lab idea #9).
        /// - The first call of the next chapter in the same read (`chapterStart`): the chapter break, `chapterPause`.
        public func callPause(pauseBefore: Double?, after lastText: String?, mood lastMood: String?, next: String,
                              handover: NephisFlow.Handover? = nil, chapterStart: Bool = false) -> Double {
            if chapterStart, lastText != nil { return NephisFlow.chapterPause }
            let director = (pauseBefore ?? 0.6) * paragraphGapScale
            let paragraph = lastMood.flatMap { moods[$0]?.paragraph }.map { director > 1.3 ? director : $0 } ?? director
            // A read's first call (no join), a line without the app's pause (the Voice Lab), a scene break: as before.
            guard let lastText, let before = pauseBefore, director <= 1.3 else { return paragraph }
            let inside = before < NephisFlow.paragraphPauseFrom
            var pause = inside ? gap(after: lastText, mood: lastMood) : paragraph
            guard let kind = handover ?? NephisFlow.handover(after: lastText, before: next) else { return pause }
            if let own = lastMood.flatMap({ moods[$0]?.dialogue?[kind.rawValue] }) { return own }
            if let hers = dialogueGaps[kind.rawValue] { pause = min(pause, hers) }
            return pause
        }

        /// Dialogue gaps from a pack: the names `Handover` knows, clamped to sane values.
        static func clampedDialogue(_ gaps: [String: Double]) -> [String: Double] {
            var out: [String: Double] = [:]
            for (name, seconds) in gaps where NephisFlow.Handover(rawValue: name) != nil {
                out[name] = min(2, max(0.1, seconds))
            }
            return out
        }

        /// The pause after a piece ending `piece`, in `mood`: her `trail` after one trailing off ("…", "...", also before
        /// a closing quote: 'Ready, set..."') or ending in ":", else her `sentence`. Only the raw text form keeps
        /// ellipses (the app's form makes each one a comma or a period), so only its pieces trail off.
        /// A piece that ends mid-sentence (in a comma, a semicolon or a word: the sentence goes on in the next piece) gets
        /// `clauseGap` whatever the mood.
        public func gap(after piece: String, mood: String?) -> Double {
            let t = piece.trimmingCharacters(in: .whitespaces)
            if NephisFlow.endsMidSentence(t) { return clauseGap }
            let core = t.replacingOccurrences(of: #"["'”’»)\]]+$"#, with: "", options: .regularExpression)
            let trailing = core.hasSuffix("…") || core.hasSuffix("...") || t.hasSuffix(":")
            if let m = mood.flatMap({ moods[$0] }) { return trailing ? m.trail : m.sentence }
            return trailing ? ellipsisGap : pieceGap
        }

        public init() {}

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            pieceGap = try c.decodeIfPresent(Double.self, forKey: .pieceGap) ?? pieceGap
            ellipsisGap = try c.decodeIfPresent(Double.self, forKey: .ellipsisGap) ?? ellipsisGap
            clauseGap = min(0.8, max(0.08, (try? c.decodeIfPresent(Double.self, forKey: .clauseGap)) ?? clauseGap))
            paragraphGapScale = try c.decodeIfPresent(Double.self, forKey: .paragraphGapScale) ?? paragraphGapScale
            clipFrames = min(125, max(1, try c.decodeIfPresent(Int.self, forKey: .clipFrames) ?? clipFrames))
            carryFrames = min(125 - clipFrames, max(0, try c.decodeIfPresent(Int.self, forKey: .carryFrames) ?? carryFrames))
            highShelfDB = try c.decodeIfPresent(Double.self, forKey: .highShelfDB).map { min(8, max(-2, $0)) }
            softSibilance = try c.decodeIfPresent(Bool.self, forKey: .softSibilance)
            eqAfterStudio = (try? c.decodeIfPresent(Bool.self, forKey: .eqAfterStudio)) ?? false
            breathPolish = try? c.decodeIfPresent(BreathPolish.Settings.self, forKey: .breathPolish)
            // A form this version doesn't know (or not a string) reads the app's text: a newer pack still plays.
            text = (try? c.decodeIfPresent(String.self, forKey: .text)).flatMap(PocketTextForm.init(rawValue:)) ?? .app
            for (word, said) in try c.decodeIfPresent([String: String].self, forKey: .respell) ?? [:] {
                respell[word.lowercased()] = said
            }
            // A pack's moods replace these one by one, clamped to sane values.
            for (name, m) in try c.decodeIfPresent([String: Mood].self, forKey: .moods) ?? [:] {
                moods[name] = Mood(sentence: min(2, max(0.1, m.sentence)), trail: min(2.5, max(0.1, m.trail)),
                                   paragraph: min(3, max(0.2, m.paragraph)), gainDB: min(6, max(-6, m.gainDB)),
                                   toneDB: m.toneDB.map { min(4, max(-4, $0)) }, dialogue: m.dialogue.map(Self.clampedDialogue))
            }
            // A pack's dialogue gaps replace these one by one, clamped.
            let packGaps = try c.decodeIfPresent([String: Double].self, forKey: .dialogueGaps) ?? [:]
            for (name, seconds) in Self.clampedDialogue(packGaps) {
                dialogueGaps[name] = seconds
            }
            master = try? c.decodeIfPresent(NephisMaster.Settings.self, forKey: .master)
        }
    }

    /// Measured on her real ElevenLabs reading (v4 chunks, word-aligned, 2026-10-09, her_style.py): median pauses per
    /// mood, and the level she adds against calm minus what the trained model already adds (PC chain sim, r9).
    /// Intense halves her pauses (0.46 s after a sentence, 0.54 s between paragraphs; calm 0.84 / 1.04); triumph and
    /// playful are much louder than the model makes them.
    /// Pronunciation sweep, r13 (1,409 words in a carrier line, 3 renders each, checked by speech recognition,
    /// 2026-10-09): as written these came out "bad", "back", "bot", "tentively"; respelled, right 3 of 3.
    public static let herRespell: [String: String] = [
        "bed": "bedd", "bag": "bagg", "bought": "bawt", "tentatively": "tentuh-tiv-lee",
    ]

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

    /// A pause before a call shorter than this (seconds, the app's) is inside a paragraph: HybridSpeechEngine's
    /// paragraphPause, which never groups sentences across one.
    public static let paragraphPauseFrom = 0.7

    /// Her pause between two chapters read on in one read (HybridSpeechEngine appends the next chapter while this one
    /// plays; car ride 2026-10-13: the change took far too long, "about 1 second" wanted).
    public static let chapterPause = 1.0

    /// `text` ends mid-sentence: in a comma, a semicolon, a word or a number, so the sentence goes on in what follows. A
    /// colon, a dash or an ellipsis is a pause of its own; a sentence mark, a closing quote or bracket ends one.
    public static func endsMidSentence(_ text: String) -> Bool {
        guard let last = text.trimmingCharacters(in: .whitespacesAndNewlines).last else { return false }
        return last == "," || last == ";" || last.isLetter || last.isNumber
    }

    // MARK: - Pieces of a call

    /// One flow piece of a call (NephisFlowSynth.plan): its text, and whether it is part of a longer sentence (`open`:
    /// it starts mid-sentence, or the sentence goes on in the next piece). Pocket reads an open piece as it stands: no
    /// capital, no full stop added, no padding, so it isn't spoken as a sentence of its own.
    public struct PlannedPiece: Equatable, Sendable {
        public var text: String
        public var open: Bool
        public init(text: String, open: Bool) {
            self.text = text
            self.open = open
        }
    }

    /// Pocket's chunks of a call as flow pieces, one piece per chunk. A sentence too long for one generation comes as a
    /// chunk and its mid-sentence continuations (split at a comma). Merged back into one piece, Pocket split it again
    /// inside that piece's take, ended the first part with an added full stop and started the rest afresh from the voice
    /// prompt: a restart in the middle of the sentence that no join ever edited (car ride 2026-10-13: "the processing cut
    /// mid sentence"). As pieces of their own they are read as parts of one sentence (`open`) and joined like any piece,
    /// at a comma's pause (`Chain.clauseGap`, from `Chain.gap(after:mood:)`).
    public static func plannedPieces(_ chunks: [(text: String, isMidSentence: Bool)]) -> [PlannedPiece] {
        chunks.indices.map { k in
            let goesOn = k + 1 < chunks.count && chunks[k + 1].isMidSentence
            return PlannedPiece(text: chunks[k].text, open: chunks[k].isMidSentence || goesOn)
        }
    }

    // MARK: - Runaways

    /// A take ran on: one of its text chunks never signalled the end of speech and ran into its frame budget
    /// (FluidAudio's ChunkEnd.eosStep nil). Pocket then says the text again or mumbles on for seconds; nothing after the
    /// text's end is trimmed, because no end is known (car ride 2026-10-13: a chapter title read twice).
    public static func ranOn(eosSteps: [Int?]) -> Bool {
        eosSteps.contains { $0 == nil }
    }

    /// Her pace, pauses inside a sentence included (calm, about 160 words a minute).
    public static let secondsPerWord = 0.38

    /// Where to end a take that ran on and couldn't be taken again: the first real pause (5 latents, 400 ms, under
    /// `silenceDB`) once 60 % of the text's length at her pace has been said, keeping `keepTail` latents of it (her
    /// fade-out). nil = no such pause (the take is kept whole).
    public static func runawayEnd(levels: [Double], words: Int) -> Int? {
        let from = max(1, Int((Double(max(1, words)) * secondsPerWord * 0.6 / latentSeconds).rounded()))
        var k = from
        while k + 5 <= levels.count {
            if (k..<k + 5).allSatisfy({ levels[$0] < silenceDB }) { return min(levels.count, k + keepTail) }
            k += 1
        }
        return nil
    }

    /// Dialogue across the pause before a call: the same speaker goes on (a quotation that continues), another one
    /// replies (a new quote paragraph after a quote), or dialogue turns into narration or back. The script's names:
    /// "sameSpeaker", "exchange", "switch" (src/core/narration/delivery.ts pauseContext).
    public enum Handover: String, Sendable, Codable, Equatable, CaseIterable {
        case sameSpeaker
        case reply
        case narration

        /// From the script's handover name; nil for any other.
        public init?(script: String) {
            switch script {
            case "sameSpeaker": self = .sameSpeaker
            case "exchange": self = .reply
            case "switch": self = .narration
            default: return nil
            }
        }
    }

    /// Her pauses where dialogue hands over (her ElevenLabs reading, word-aligned, v4 chunks; tachinovel-tts-lab
    /// quote_gaps.py, 2026-10-12): a reply between quote paragraphs 0.65 median / 0.66 mean, dialogue ↔ narration
    /// 0.62-0.71 (inside a paragraph and across one), the same speaker going on inside one quotation 0.50. Calm puts
    /// 0.84 s after a sentence and 1.04 s after a paragraph, which made conversations drag.
    public static let herDialogueGaps: [String: Double] = [
        Handover.sameSpeaker.rawValue: 0.50, Handover.reply.rawValue: 0.66, Handover.narration.rawValue: 0.66,
    ]

    /// The handover between `previous` (the piece read last) and `next` (the call's first piece), from their quotation
    /// marks, for a call without the script's: a closed quote then a quote is a reply (the app's pause can't tell a new
    /// paragraph there: the script's reply pause is under `paragraphPauseFrom` too), a quotation left open then a quote is
    /// the same speaker going on; a quote on one side only is narration. nil = no dialogue on either side, or a
    /// quotation left open into text that doesn't start with a quote (unsure: no change).
    public static func handover(after previous: String, before next: String) -> Handover? {
        let a = previous.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = next.trimmingCharacters(in: .whitespacesAndNewlines)
        var open = false
        for ch in a {
            switch ch {
            case "“", "«", "「": open = true
            case "”", "»", "」": open = false
            case "\"": open.toggle()
            default: break
            }
        }
        let endsSpoken = open || a.last.map { "”»」\"".contains($0) } == true
        let startsSpoken = b.first.map { "“«「\"".contains($0) } == true
        if endsSpoken && startsSpoken { return open ? .sameSpeaker : .reply }
        if open { return nil }
        return endsSpoken != startsSpoken ? .narration : nil
    }

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

    /// The last sentence of what she said (the next call's lead-in). An ellipsis is a pause inside a sentence, not its
    /// end: the raw text form keeps them ("I waited... and you never... came." is one lead-in, as it is in the app's
    /// form, where they became commas). The app's form has no ellipsis left, so there it splits where it always did.
    public static func lastSentence(_ text: String) -> String {
        let parts = text.split(omittingEmptySubsequences: true) { $0 == "\n" }.joined(separator: " ")
        guard let re = try? NSRegularExpression(pattern: #"(?:[!?]|(?<!\.\.)\.)["'”’]?\s+(?=\S)"#),
              let m = re.matches(in: parts, range: NSRange(parts.startIndex..., in: parts)).last,
              let r = Range(m.range, in: parts) else { return parts }
        return String(parts[r.upperBound...]).trimmingCharacters(in: .whitespaces)
    }

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
    /// before it, at most about a second in), never the word. With `hiss`, a word opening with a fricative starts at
    /// its hiss: the "s" of "Still" (quieter than the vowel, with the "t"'s closure as a dip after it) is never taken
    /// for an "uh" (car ride 2026-10-13: "s" sounds cut).
    public static func openingDrop(_ levels: [Double], hiss: [Double]? = nil) -> Int {
        guard let loud = (0..<max(0, levels.count - 1)).first(where: { levels[$0] > speechDB && levels[$0 + 1] > speechDB }),
              loud <= 14 else { return 0 }
        let on = fricativeStart(levels, hiss: hiss, on: loud)
        guard on > 0 else { return 0 }
        let dip = (0..<on).min(by: { levels[$0] < levels[$1] }) ?? 0
        return (levels[0...dip].max() ?? levels[dip]) > levels[dip] + 6 ? dip : 0
    }

    /// Latents of noise before a piece's first word inside a read (an "uh", a mumble): an audible sound in the first
    /// second, at least 6 dB under the speech that follows and followed by a dip, never a word (words are as loud as
    /// the speech after them; with `hiss`, a word's opening fricative counts as the word: `openingDrop`). 0 = none.
    public static func leadingNoise(_ levels: [Double], hiss: [Double]? = nil) -> Int {
        guard let loud = (0..<max(0, levels.count - 1)).first(where: { levels[$0] > speechDB && levels[$0 + 1] > speechDB }),
              loud <= 14 else { return 0 }
        let on = fricativeStart(levels, hiss: hiss, on: loud)
        guard on > 1, let sound = (0..<on).first(where: { levels[$0] > silenceDB }), sound + 1 < on else { return 0 }
        let dip = (sound + 1..<on).min(by: { levels[$0] < levels[$1] }) ?? sound
        let before = levels[sound..<dip].max() ?? -100
        let after = levels[loud..<min(levels.count, loud + 10)]
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
    /// `decoded`: the first latents of `tail` already went out with the call before (her fade-out, NephisFlowSynth.read).
    /// They still count toward the pause, are never trimmed or blended, and are left out of the result.
    public static func joinPadded(tail: [[Float]], next: [[Float]], head: Int, pause: Double, maxBridge: Int = NephisFlow.maxBridge,
                                  tailLevels: [Double]? = nil, headLevels: [Double]? = nil, decoded: Int = 0)
        -> (latents: [[Float]], padAt: Int?, padSeconds: Double) {
        let fixed = min(max(0, decoded), tail.count)
        var a = tail, b = next
        let ov = max(0, min(overlap, a.count - fixed - 1, head - 1))
        let want = max(2, Int((pause / latentSeconds).rounded()))
        // A pause longer than her fade-out + lead-in: decode only those (the first `keepTail` latents after the last
        // word, the last `keepHead` before the next) and make all the rest silence. The model's own quiet latents buzz
        // too, not just a morph between them (phone Voice test 2026-10-09, after the bridge cap: shorter, still there).
        let keepTail = max(fixed, min(a.count, tailLevels.map(fadeOut) ?? Self.keepTail))
        let keepHead = min(head, headLevels.map(leadIn) ?? Self.keepHead)
        if maxBridge != .max, want > keepTail + keepHead, a.count + head > keepTail + keepHead {
            return (Array(a.prefix(keepTail).dropFirst(fixed)) + Array(b.dropFirst(head - keepHead)), keepTail - fixed,
                    Double(want - keepTail - keepHead) * latentSeconds)
        }
        let have = a.count + head - ov
        var headLeft = head
        if have > want {
            var extra = have - want
            let fromTail = min(extra, max(0, a.count - max(ov + 2, fixed + ov)))
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
            let bridged = min(nb, maxBridge)
            if bridged < nb {
                padAt = out.count + bridged / 2
                padSeconds = Double(nb - bridged) * latentSeconds
            }
            out += (0..<bridged).map { k in
                let w = Float(k + 1) / Float(bridged + 1)
                return zip(last, first).map { (1 - w) * $0 + w * $1 }
            }
        }
        // `out` starts with the tail untouched up to `fixed` (trims and blends stayed after it).
        return (Array((out + b).dropFirst(fixed)), padAt.map { $0 - fixed }, padSeconds)
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
    public static func insertSilence(_ samples: [Float], pads: [(at: Int, seconds: Double)], sampleRate: Int = sampleRate,
                                     samplesPerLatent perLatent: Int = samplesPerLatent) -> [Float] {
        guard !pads.isEmpty else { return samples }
        var out = samples
        let fade = sampleRate / 100
        for pad in pads.sorted(by: { $0.at > $1.at }) {
            let i = min(out.count, pad.at * perLatent)
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

// MARK: - Studio reads (NephisStudio's pure parts; studio audit 2026-10-12)

extension NephisFlow.Projection {
    /// Latents at Mimi's own scale (latent × std + mean). The read's stream holds Pocket's normalized latents (Mimi
    /// denormalizes inside its own model; `condition` does the same before projecting), and the studio's blueprint was
    /// trained on denormalized ones (tachinovel-tts-lab gta_dump.py: pred × emb_std + emb_mean).
    public func denormalized(_ latents: [[Float]]) -> [[Float]] {
        let n = min(std.count, mean.count)
        return latents.map { l in
            var x = l
            for j in 0..<min(n, l.count) { x[j] = l[j] * std[j] + mean[j] }
            return x
        }
    }
}

extension NephisFlow {
    /// The studio's shortest input, in mel frames: NephisBlueprint takes pcm44 from 44,100 samples and z_frames from
    /// 87 (studio_port.py). A shorter call threw, and fell back to Mimi's sound.
    public static let studioMinFrames = 87

    /// Mel frames the blueprint makes from `samples` (reflect pad (n_fft - hop) / 2 each side, n_fft 2048).
    public static func studioFrames(samples: Int, hop: Int) -> Int {
        (samples - hop) / hop + 1
    }

    /// Latents of leading silence that bring a studio call (`samples` long at the studio's rate, its carried context
    /// and end padding included) up to `minFrames`; 0 when it is long enough. Whole latents (`samplesPerLatent` each),
    /// so the sketch stays aligned with the audio.
    public static func studioLeadPad(samples: Int, hop: Int, samplesPerLatent: Int, minFrames: Int = studioMinFrames) -> Int {
        let need = minFrames * hop - samples
        guard need > 0, samplesPerLatent > 0 else { return 0 }
        return (need + samplesPerLatent - 1) / samplesPerLatent
    }

    /// The call's own audio out of a studio render: the first `lead` samples (the padding and the carried context in
    /// front) dropped, then cut or zero-padded to exactly `count`.
    public static func studioTrim(_ rendered: [Float], lead: Int, count: Int) -> [Float] {
        let own = rendered.dropFirst(lead)
        return own.count >= count ? Array(own.prefix(count)) : Array(own) + [Float](repeating: 0, count: count - own.count)
    }

    /// One stretch of a long studio call: mel frames `from..<to` go to the blueprint (and refiner), and frames
    /// `keepFrom..<keepTo` of what comes back are kept.
    public struct StudioSegment: Equatable, Sendable {
        public let from: Int
        public let to: Int
        public let keepFrom: Int
        public let keepTo: Int
        public init(from: Int, to: Int, keepFrom: Int, keepTo: Int) {
            self.from = from
            self.to = to
            self.keepFrom = keepFrom
            self.keepTo = keepTo
        }
    }

    /// A call of `frames` mel frames in overlapping stretches of `length` frames with `context` on each side, keeping
    /// each stretch's middle; one stretch when it fits in `length + 2 × context`. A stretch reaches back far enough to
    /// be at least `minFrames` long: a call just past a multiple of `length` ended in a stretch too short for the
    /// blueprint, which threw and sent the whole call (~48 s and longer) to Mimi's sound.
    public static func studioSegments(frames: Int, length: Int, context: Int, minFrames: Int = studioMinFrames) -> [StudioSegment] {
        guard frames > length + 2 * context, length > 0 else { return [StudioSegment(from: 0, to: frames, keepFrom: 0, keepTo: frames)] }
        var out: [StudioSegment] = []
        var s = 0
        while s < frames {
            let to = min(frames, s + length + context)
            out.append(StudioSegment(from: max(0, min(s - context, to - minFrames)), to: to, keepFrom: s, keepTo: min(s + length, frames)))
            s += length
        }
        return out
    }

    /// Every value is a number: a model output that overflowed (NaN, ±inf) must never reach the speaker.
    public static func allFinite(_ x: [Float]) -> Bool {
        x.withUnsafeBufferPointer { b in !b.contains { !$0.isFinite } }
    }

    /// Her EQ for Mimi's sound: HDVoiceCore's VoiceTilt.nephisTilt band for band (copied: this package doesn't link
    /// HDVoice), the EQ the player gives the read without the studio. In a studio read the player adds none, and
    /// NephisFlowSynth gives it to the calls the studio skipped or failed instead.
    public struct MimiEQ: Equatable, Sendable {
        /// The lift above 2.5 kHz (dB), and the gentler sibilance (`softenSibilance`).
        public var highShelfDB: Double
        public var softSibilance: Bool

        public init(highShelfDB: Double = 5.95, softSibilance: Bool = true) {
            self.highShelfDB = highShelfDB
            self.softSibilance = softSibilance
        }

        /// Hers for a pack's chain, as the player picks it (HybridSpeechEngine.nephisTilt): the pack's lift and
        /// sibilance setting, else the shipped +5.95 dB with the softer sibilance (VoiceTilt.nephis).
        public init(chain: Chain) {
            self.init(highShelfDB: chain.highShelfDB ?? 5.95, softSibilance: chain.softSibilance ?? true)
        }

        /// VoiceTilt.apply with nephisTilt's bands, in its order: the top lift and +2 dB under 180 Hz ("deeper +
        /// clear"), +2 dB around 300 Hz and +1 dB at 3 kHz ("warm + clear"), 1.5 dB less edge at 3.5 kHz ("soothing").
        public func apply(_ x: inout [Float], sampleRate: Int) {
            let fs = Double(sampleRate)
            var sections: [ToneBiquad] = [.lowShelf(hz: 180, q: 0.591, db: 2, fs: fs), .lowShelf(hz: 300, q: 0.591, db: 2, fs: fs),
                                          .peaking(hz: 3000, q: 0.8, db: 1, fs: fs), .peaking(hz: 3500, q: 0.9, db: -1.5, fs: fs)]
            // A band at 0 dB is skipped, as VoiceTilt does (the pack's lift may be 0).
            if highShelfDB != 0 { sections.insert(.highShelf(hz: 2500, q: 0.586, db: highShelfDB, fs: fs), at: 0) }
            for var section in sections { section.process(&x) }
            if softSibilance { Self.softenSibilance(&x, sampleRate: sampleRate) }
        }

        /// VoiceTilt.softenSibilance: the 5.5–9 kHz band turned down by as much as it sticks out of the whole voice
        /// beyond -6 dB (at most 6 dB), over 5 ms windows with a 10 ms smoothed gain. Rate-dependent: at 44.1 kHz its
        /// band filters pass 2-3 dB less of an "s" than at 24 kHz (sharper there, near Nyquist), so the same code turns
        /// it down less (a 7 kHz tone: -0.8 dB against -2.3 dB). It runs at Mimi's 24 kHz, where it was tuned.
        public static func softenSibilance(_ x: inout [Float], sampleRate: Int) {
            let fs = Double(sampleRate)
            guard 9000 < fs / 2, !x.isEmpty else { return }
            var band = x
            var h1 = ToneBiquad.highPass(hz: 5500, q: 0.707, fs: fs), h2 = h1
            var l1 = ToneBiquad.lowPass(hz: 9000, q: 0.707, fs: fs), l2 = l1
            h1.process(&band); h2.process(&band); l1.process(&band); l2.process(&band)
            let n = max(1, Int(0.005 * fs))
            var sb = 0.0, sx = 0.0
            var gain = [Float](repeating: 1, count: x.count)
            for i in x.indices {
                sb += Double(band[i] * band[i]); sx += Double(x[i] * x[i])
                if i >= n { sb -= Double(band[i - n] * band[i - n]); sx -= Double(x[i - n] * x[i - n]) }
                let over = 10 * log10(max(sb, 1e-12) / max(sx, 1e-12)) + 6
                gain[i] = Float(pow(10, -min(6, max(0, over)) / 20))
            }
            let m = 2 * n
            var acc: Float = 0
            for i in x.indices {
                acc += gain[i]
                if i >= m { acc -= gain[i - m] }
                let g = acc / Float(min(i + 1, m))
                x[i] = x[i] - band[i] + band[i] * g
            }
        }
    }

    /// The tone of one call in a studio read (studio audit 2026-10-12, A3: one owner per path). A call the studio
    /// rendered gets none: her studio sound is her tone (the mood's level still applies). A call it skipped or failed is
    /// Mimi's sound and gets what the read without the studio gets: the mood's shelf and her Mimi EQ.
    public struct StudioTone: Equatable, Sendable {
        /// The mood's 2.5 kHz shelf (dB; 0 = none).
        public var moodShelfDB: Double
        public var mimiEQ: MimiEQ?

        public init(moodShelfDB: Double, mimiEQ: MimiEQ?) {
            self.moodShelfDB = moodShelfDB
            self.mimiEQ = mimiEQ
        }

        /// The mood's shelf, then her EQ: the order of the read without the studio (NephisFlowSynth.decode, then the
        /// player).
        public func apply(_ x: inout [Float], sampleRate: Int) {
            NephisFlow.highShelf(&x, db: moodShelfDB, sampleRate: sampleRate)
            mimiEQ?.apply(&x, sampleRate: sampleRate)
        }
    }

    /// A rendered call with the pack's "eqAfterStudio": her EQ, applied at the studio's rate (still no mood shelf, as
    /// before for a rendered call).
    public static func studioTone(studioUsed: Bool, moodToneDB: Double, chain: Chain) -> StudioTone {
        guard studioUsed else { return StudioTone(moodShelfDB: moodToneDB, mimiEQ: MimiEQ(chain: chain)) }
        return StudioTone(moodShelfDB: 0, mimiEQ: chain.eqAfterStudio ? MimiEQ(chain: chain) : nil)
    }
}

/// One second-order section (transposed direct form II) and its RBJ cookbook designs: HDVoiceCore's Biquad, copied
/// with the same formulas in the same order, so her Mimi EQ here is the player's.
struct ToneBiquad: Sendable {
    let b0: Double
    let b1: Double
    let b2: Double
    let a1: Double
    let a2: Double
    private var z1 = 0.0
    private var z2 = 0.0

    init(b0: Double, b1: Double, b2: Double, a1: Double, a2: Double) {
        self.b0 = b0
        self.b1 = b1
        self.b2 = b2
        self.a1 = a1
        self.a2 = a2
    }

    mutating func process(_ x: Double) -> Double {
        let y = b0 * x + z1
        z1 = b1 * x - a1 * y + z2
        z2 = b2 * x - a2 * y
        return y
    }

    mutating func process(_ samples: inout [Float]) {
        for i in samples.indices { samples[i] = Float(process(Double(samples[i]))) }
    }

    private static func normalized(_ b0: Double, _ b1: Double, _ b2: Double, _ a0: Double, _ a1: Double, _ a2: Double) -> ToneBiquad {
        ToneBiquad(b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0)
    }

    static func highPass(hz f: Double, q: Double, fs: Double) -> ToneBiquad {
        let w = 2 * Double.pi * f / fs
        let alpha = sin(w) / (2 * q)
        let c = cos(w)
        return normalized((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha)
    }

    static func lowPass(hz f: Double, q: Double, fs: Double) -> ToneBiquad {
        let w = 2 * Double.pi * min(f, fs * 0.49) / fs
        let alpha = sin(w) / (2 * q)
        let c = cos(w)
        let a0 = 1 + alpha
        return ToneBiquad(b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0)
    }

    static func peaking(hz f: Double, q: Double, db gainDB: Double, fs: Double) -> ToneBiquad {
        let a = pow(10, gainDB / 40)
        let w = 2 * Double.pi * f / fs
        let alpha = sin(w) / (2 * q)
        let c = cos(w)
        return normalized(1 + alpha * a, -2 * c, 1 - alpha * a, 1 + alpha / a, -2 * c, 1 - alpha / a)
    }

    static func lowShelf(hz f: Double, q: Double, db gainDB: Double, fs: Double) -> ToneBiquad {
        let a = pow(10, gainDB / 40)
        let w = 2 * Double.pi * f / fs
        let c = cos(w)
        let alpha = sin(w) / (2 * q)
        let s = 2 * a.squareRoot() * alpha
        let a0 = (a + 1) + (a - 1) * c + s
        return ToneBiquad(b0: a * ((a + 1) - (a - 1) * c + s) / a0, b1: 2 * a * ((a - 1) - (a + 1) * c) / a0, b2: a * ((a + 1) - (a - 1) * c - s) / a0,
                          a1: -2 * ((a - 1) + (a + 1) * c) / a0, a2: ((a + 1) + (a - 1) * c - s) / a0)
    }

    static func highShelf(hz f: Double, q: Double, db gainDB: Double, fs: Double) -> ToneBiquad {
        let a = pow(10, gainDB / 40)
        let w = 2 * Double.pi * min(f, fs * 0.49) / fs
        let c = cos(w)
        let alpha = sin(w) / (2 * q)
        let s = 2 * a.squareRoot() * alpha
        let a0 = (a + 1) - (a - 1) * c + s
        return ToneBiquad(b0: a * ((a + 1) + (a - 1) * c + s) / a0, b1: -2 * a * ((a - 1) + (a + 1) * c) / a0, b2: a * ((a + 1) + (a - 1) * c - s) / a0,
                          a1: 2 * ((a - 1) - (a + 1) * c) / a0, a2: ((a + 1) - (a - 1) * c - s) / a0)
    }
}
