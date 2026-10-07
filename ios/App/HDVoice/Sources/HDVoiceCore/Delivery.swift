//
//  Delivery.swift — natural delivery for the expressive narrator (Chatterbox Nano): the settings, what the
//  script says about each sentence, and how the on-device model's refined mood moves the parameters.
//
//  The text side (director rules, line classes, emphasis, non-verbal choice, pauses, breath points, breath-group
//  chunks) lives in the TS core (src/core/narration/delivery.ts), so tuning ships as a signed web update. Each
//  sentence of the script carries `delivery` {t, g, s, c, pre, nv, say, syl, ell, pun} (temperature, gain dB,
//  tempo, varispeed cents, silence before, a non-verbal, the text Nano reads, syllables, where a dramatic "…" and
//  punctuation sit), `mood`, `line`, `naturalMs`, `breath` and `chunk`; the script carries the mood table and the
//  audio tunables once (`delivery` header). Native only applies the numbers, clamped to a safety envelope, in the
//  audio path (NaturalFinish.swift). Nano's own tags are never used: they sounded robotic and roughened the speech.
//

import Foundation

/// The director's moods (TS delivery.ts MOODS; tests/delivery.test.ts checks both lists match).
public enum DeliveryMood: String, CaseIterable, Sendable, Codable {
    case calm
    case soft
    case sad
    case tense
    case playful
    case intense
    case whisper
    case system
}

/// Non-verbals a voice pack can carry (TS delivery.ts NON_VERBALS).
public enum NonVerbalType: String, CaseIterable, Sendable, Codable {
    case chuckle
    case laugh
    case hm
    case mm
}

/// Where a breath may go: in the pause after a sentence (before a new paragraph, or after a long sentence-final pause).
public enum BreathPoint: String, Sendable, Equatable {
    case paragraph
    case sentence
}

/// Settings › Voices › Expressive voices. Defaults: Kokoro reads chapters (the expressive narrator is opt-in); when
/// Chatterbox Nano reads, natural delivery, the rules director, breaths, studio sound ("clean-warm"), non-verbals
/// (when the voice has a pack) and breath-group synthesis are on.
public struct DeliverySettings: Sendable, Equatable, Codable {
    /// 2: Pocket TTS became the default Listen engine (version 1 only knew Chatterbox Nano, and saved it as the default).
    public static let currentVersion = 2
    public static let pocketTts = "pocket-tts"
    public static let chatterboxNano = "chatterbox-nano"
    /// The expressive engines Listen can read chapters with.
    public static let listenEngines: Set<String> = [pocketTts, chatterboxNano]
    public static let rules = "rules"
    public static let rulesAI = "rules+ai"
    public static let chunks = "chunks"
    public static let sentences = "sentences"

    public var version: Int
    /// Listen reads chapters with this expressive engine when it is downloaded: Pocket TTS with the built-in
    /// "Narrator" voice by default (CPU + Neural Engine, so it keeps reading with the screen locked and in CarPlay),
    /// or Chatterbox Nano; nil = Kokoro. When Pocket isn't downloaded, Nano reads if it is, then Kokoro; Kokoro
    /// still reads any sentence the expressive engine can't.
    public var listenEngine: String?
    /// Natural delivery: the director, context pauses, the clean chain, breaths.
    public var natural: Bool
    /// "rules" or "rules+ai" (moods refined ahead of playback by Apple's on-device model, iOS 26).
    public var director: String
    /// Breaths in natural pauses (lung budget; never adds time).
    public var breaths: Bool
    /// The "clean-warm" chain (round 8's approved chain).
    public var studioSound: Bool
    /// Non-verbals (chuckle, light laugh, "hm", "mm") from the voice's own pack, spliced in front of a line.
    public var sounds: Bool
    /// "chunks" (a paragraph per model call, the default) or "sentences" (one call per sentence: the fallback).
    public var unit: String
    /// Dialogue and thoughts in the performed read of the same narrator voice (Pocket TTS); off = all narrated.
    public var performed: Bool

    public init(listenEngine: String? = DeliverySettings.pocketTts, natural: Bool = true, director: String = DeliverySettings.rules, breaths: Bool = true, studioSound: Bool = true,
                sounds: Bool = true, unit: String = DeliverySettings.chunks, performed: Bool = true) {
        version = Self.currentVersion
        self.listenEngine = listenEngine.flatMap { Self.listenEngines.contains($0) ? $0 : nil }
        self.natural = natural
        self.director = director == Self.rulesAI ? Self.rulesAI : Self.rules
        self.breaths = breaths
        self.studioSound = studioSound
        self.sounds = sounds
        self.unit = unit == Self.sentences ? Self.sentences : Self.chunks
        self.performed = performed
    }

    /// Tolerant decoding: missing or unknown values take their defaults.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = DeliverySettings()
        version = Self.currentVersion
        let saved = (try? c.decode(Int.self, forKey: .version)) ?? 1
        if !c.contains(.listenEngine) {
            listenEngine = d.listenEngine
        } else if (try? c.decodeNil(forKey: .listenEngine)) == true {
            listenEngine = nil // Kokoro was chosen
        } else {
            let engine = try? c.decode(String.self, forKey: .listenEngine)
            // Version 1 saved Chatterbox Nano as the default (nobody could pick it): those move to Pocket TTS.
            if saved < 2, engine == Self.chatterboxNano {
                listenEngine = Self.pocketTts
            } else {
                listenEngine = engine.flatMap { Self.listenEngines.contains($0) ? $0 : nil }
            }
        }
        natural = (try? c.decode(Bool.self, forKey: .natural)) ?? d.natural
        director = (try? c.decode(String.self, forKey: .director)) == Self.rulesAI ? Self.rulesAI : Self.rules
        breaths = (try? c.decode(Bool.self, forKey: .breaths)) ?? d.breaths
        studioSound = (try? c.decode(Bool.self, forKey: .studioSound)) ?? d.studioSound
        sounds = (try? c.decode(Bool.self, forKey: .sounds)) ?? d.sounds
        unit = (try? c.decode(String.self, forKey: .unit)) == Self.sentences ? Self.sentences : Self.chunks
        performed = (try? c.decode(Bool.self, forKey: .performed)) ?? d.performed
    }

    private enum CodingKeys: String, CodingKey {
        case version, listenEngine, natural, director, breaths, studioSound, sounds, unit, performed
    }

    /// listenEngine is written even when nil (Kokoro chosen), so a missing key always means "the default".
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version, forKey: .version)
        try c.encode(listenEngine, forKey: .listenEngine)
        try c.encode(natural, forKey: .natural)
        try c.encode(director, forKey: .director)
        try c.encode(breaths, forKey: .breaths)
        try c.encode(studioSound, forKey: .studioSound)
        try c.encode(sounds, forKey: .sounds)
        try c.encode(unit, forKey: .unit)
        try c.encode(performed, forKey: .performed)
    }

    public var usesAI: Bool { natural && director == Self.rulesAI }
    public var usesChunks: Bool { natural && unit == Self.chunks }
}

/// One sentence's synthesis parameters (the script's `delivery`).
public struct DeliveryParams: Sendable, Equatable {
    /// Nano sampling temperature.
    public var temperature: Float
    /// Gain after loudness matching, dB.
    public var gainDB: Double
    /// Tempo by time-stretch (pitch kept; 1 = as rendered). The listener's speed and rate leveling come on top.
    public var tempo: Double
    /// Varispeed, cents: pitch and pace move together (plain resampling, no stretching artifacts).
    public var cents: Double
    /// Silence before the sentence, seconds at 1.0×.
    public var preSeconds: Double
    /// The text Nano reads when it differs from the sentence's text.
    public var say: String?
    /// A non-verbal to splice in front (from the voice's pack).
    public var nonVerbal: NonVerbalType?
    /// Syllables Nano says (rate leveling); 0 = unknown.
    public var syllables: Int
    /// Where a dramatic "…" sits inside the sentence, and where punctuation sits (shares of the letters).
    public var ellipses: [Double]
    public var punctuation: [Double]

    public init(temperature: Float = 0.7, gainDB: Double = 0, tempo: Double = 1, cents: Double = 0, preSeconds: Double = 0, say: String? = nil,
                nonVerbal: NonVerbalType? = nil, syllables: Int = 0, ellipses: [Double] = [], punctuation: [Double] = []) {
        self.temperature = temperature
        self.gainDB = gainDB
        self.tempo = tempo
        self.cents = cents
        self.preSeconds = preSeconds
        self.say = say
        self.nonVerbal = nonVerbal
        self.syllables = syllables
        self.ellipses = ellipses
        self.punctuation = punctuation
    }

    public static let neutral = DeliveryParams()

    /// From the script's `delivery` object; nil when it isn't one.
    public static func parse(_ raw: Any?) -> DeliveryParams? {
        guard let o = raw as? [String: Any] else { return nil }
        func num(_ k: String) -> Double? { (o[k] as? NSNumber)?.doubleValue }
        func shares(_ k: String) -> [Double] {
            (o[k] as? [Any] ?? []).prefix(32).compactMap { ($0 as? NSNumber)?.doubleValue }.filter { $0.isFinite && $0 > 0 && $0 < 1 }
        }
        guard let t = num("t") else { return nil }
        let say = (o["say"] as? String).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : String($0.prefix(2_000)) }
        return DeliveryParams(temperature: Float(t), gainDB: num("g") ?? 0, tempo: num("s") ?? 1, cents: num("c") ?? 0, preSeconds: (num("pre") ?? 0) / 1000,
                              say: say, nonVerbal: (o["nv"] as? String).flatMap(NonVerbalType.init(rawValue:)),
                              syllables: Int(min(2_000, max(0, num("syl") ?? 0))), ellipses: shares("ell"), punctuation: shares("pun")).clamped()
    }

    /// The safety envelope native enforces whatever a script says (the TS director stays well inside it).
    public func clamped() -> DeliveryParams {
        func c(_ x: Double, _ lo: Double, _ hi: Double, _ d: Double) -> Double { x.isFinite ? min(hi, max(lo, x)) : d }
        var p = self
        p.temperature = Float(c(Double(temperature), 0.5, 1.0, 0.7))
        p.gainDB = c(gainDB, -3, 3, 0)
        p.tempo = c(tempo, 0.9, 1.1, 1)
        p.cents = c(cents, -150, 150, 0)
        p.preSeconds = c(preSeconds, 0, 0.5, 0)
        return p
    }
}

/// What the script says about one sentence for natural delivery.
public struct NaturalSentence: Sendable, Equatable {
    public var params: DeliveryParams
    public var mood: DeliveryMood
    /// teasing / commanding / tender, or nil (plain narration or dialogue).
    public var line: String?
    /// A breath may go in the pause after this sentence.
    public var breath: BreathPoint?
    /// The sentence has spoken words (the on-device model may only whisper those).
    public var speaks: Bool
    /// The breath-group chunk (one model call) it belongs to; nil = on its own.
    public var chunk: Int?
    /// Dialogue or a thought: the narrator voice performs it (Pocket TTS: the performed voice prompt).
    public var performed: Bool

    public init(params: DeliveryParams = .neutral, mood: DeliveryMood = .calm, line: String? = nil, breath: BreathPoint? = nil, speaks: Bool = false, chunk: Int? = nil,
                performed: Bool = false) {
        self.params = params
        self.mood = mood
        self.line = line
        self.breath = breath
        self.speaks = speaks
        self.chunk = chunk
        self.performed = performed
    }

    static func validLine(_ raw: Any?) -> String? {
        (raw as? String).flatMap { ["teasing", "commanding", "tender"].contains($0) ? $0 : nil }
    }

    /// From one script item (speech-script.ts SpeechItem); nil when the script has no natural delivery (older web).
    public static func parse(item o: [String: Any]) -> NaturalSentence? {
        guard let params = DeliveryParams.parse(o["delivery"]) else { return nil }
        let mood = (o["mood"] as? String).flatMap(DeliveryMood.init(rawValue:)) ?? .calm
        let parts = o["parts"] as? [Any] ?? []
        let speaks = (o["role"] as? String) == "dialogue" || parts.contains { (($0 as? [String: Any])?["role"] as? String) == "dialogue" }
        return NaturalSentence(params: params, mood: mood, line: validLine(o["line"]), breath: (o["breath"] as? String).flatMap(BreathPoint.init(rawValue:)),
                               speaks: speaks, chunk: (o["chunk"] as? NSNumber)?.intValue, performed: (o["voice"] as? String) == "performed")
    }

    /// From a Voice Lab line's `natural` object (delivery.ts LineDelivery).
    public static func parse(line raw: Any?) -> (sentence: NaturalSentence, pauseSeconds: Double)? {
        guard let o = raw as? [String: Any], let params = DeliveryParams.parse(o["delivery"]) else { return nil }
        let mood = (o["mood"] as? String).flatMap(DeliveryMood.init(rawValue:)) ?? .calm
        let pause = max(0, min(5, ((o["pauseMs"] as? NSNumber)?.doubleValue ?? 350) / 1000))
        let s = NaturalSentence(params: params, mood: mood, line: validLine(o["line"]), breath: (o["breath"] as? String).flatMap(BreathPoint.init(rawValue:)),
                                speaks: (o["dialogue"] as? Bool) ?? false)
        return (s, pause)
    }
}

/// Mood → Nano's controls (delivery.ts MOOD_TABLE, shipped with every script).
public struct MoodTable: Sendable, Equatable {
    public struct Entry: Sendable, Equatable {
        public var temperature: Double
        public var gainDB: Double
        public var tempo: Double

        public init(temperature: Double, gainDB: Double, tempo: Double) {
            self.temperature = temperature
            self.gainDB = gainDB
            self.tempo = tempo
        }
    }

    public var entries: [DeliveryMood: Entry]

    public init(entries: [DeliveryMood: Entry]) {
        self.entries = entries
    }

    /// The same values as delivery.ts (used when a script doesn't carry the table).
    public static let standard = MoodTable(entries: [
        .calm: Entry(temperature: 0.7, gainDB: 0, tempo: 1),
        .soft: Entry(temperature: 0.75, gainDB: -0.6, tempo: 0.99),
        .sad: Entry(temperature: 0.7, gainDB: -0.6, tempo: 0.99),
        .tense: Entry(temperature: 0.8, gainDB: 0.6, tempo: 1.01),
        .playful: Entry(temperature: 0.85, gainDB: 0.6, tempo: 1.01),
        .intense: Entry(temperature: 0.9, gainDB: 1.2, tempo: 1.01),
        .whisper: Entry(temperature: 0.7, gainDB: -1.2, tempo: 0.98),
        .system: Entry(temperature: 0.7, gainDB: 0, tempo: 1.04),
    ])

    public static func parse(_ raw: Any?) -> MoodTable? {
        guard let o = raw as? [String: Any] else { return nil }
        var entries = standard.entries
        for (key, value) in o {
            guard let mood = DeliveryMood(rawValue: key), let e = value as? [String: Any], let t = (e["t"] as? NSNumber)?.doubleValue else { continue }
            entries[mood] = Entry(temperature: t, gainDB: (e["g"] as? NSNumber)?.doubleValue ?? 0, tempo: (e["s"] as? NSNumber)?.doubleValue ?? 1)
        }
        return MoodTable(entries: entries)
    }

    /// Follow a mood the on-device model refined: shift the rule mood's parameters by the difference between the two
    /// moods' entries (class, stress and dialogue adjustments the script made stay), then clamp.
    public func refine(_ p: DeliveryParams, from rule: DeliveryMood, to refined: DeliveryMood) -> DeliveryParams {
        guard rule != refined, let a = entries[rule], let b = entries[refined] else { return p }
        var out = p
        out.temperature = Float(Double(p.temperature) + b.temperature - a.temperature)
        out.gainDB = p.gainDB + b.gainDB - a.gainDB
        out.tempo = a.tempo > 0 ? p.tempo * b.tempo / a.tempo : p.tempo
        return out.clamped()
    }
}

/// The audio tunables the script sends (delivery.ts DELIVERY_AUDIO); defaults are the same values.
public struct DeliveryAudio: Sendable, Equatable {
    /// Breath level relative to the speech RMS, dB.
    public var breathDB = -22.0
    /// Lung budget: speech seconds since the last breath (a random point in the range), and at a paragraph start.
    public var breathEverySec: ClosedRange<Double> = 6...8
    public var breathParagraphSec = 4.0
    /// Only pauses this long (seconds at 1.0×) can hold a breath inside a paragraph.
    public var breathMinPause = 0.4
    /// The inhale starts this long after the previous sentence ends and ends this long before the next starts.
    public var breathStart: ClosedRange<Double> = 0.12...0.2
    public var breathEnd: ClosedRange<Double> = 0.08...0.15
    /// Shorter than this, a breath is skipped.
    public var breathShortest = 0.14
    /// "procedural", "snippets" or "pack".
    public var breathSource = "procedural"
    /// Equal-power edge fades of each piece, and at the joins of one text's several model calls.
    public var fade = 0.008
    public var crossfade = 0.01
    /// Loudness matching target (speech RMS), dBFS.
    public var speechRmsDB = -20.0
    /// Rate leveling: the running median of this many chunks, a ±band left alone, the stretch capped.
    public var rateWindow = 9
    public var rateBand = 0.04
    public var rateCap = 0.1
    /// Gaps inside the speech: close micro-gaps shorter than this off punctuation, drop isolated blips shorter than
    /// this, stretch the model's pause at a dramatic "…" to this long.
    public var microGap = 0.11
    public var blip = 0.07
    public var ellipsisPause: ClosedRange<Double> = 0.35...0.45
    /// Roughness guard: a drop of voiced periodicity this far under the voice's running median, for this long.
    public var roughnessDrop = 0.12
    public var roughnessSpan = 0.25
    /// Non-verbals: gap before the line, fades, level against the line's speech.
    public var nonVerbalGap: ClosedRange<Double> = 0.08...0.2
    public var nonVerbalFade = 0.01
    public var nonVerbalDB = -3.0

    public init() {}

    public static func parse(_ raw: Any?) -> DeliveryAudio {
        var a = DeliveryAudio()
        guard let o = raw as? [String: Any] else { return a }
        func num(_ k: String) -> Double? { ((o[k] as? NSNumber)?.doubleValue).flatMap { $0.isFinite ? $0 : nil } }
        func ms(_ k: String, lo: Double, hi: Double) -> Double? { num(k).map { min(hi, max(lo, $0 / 1000)) } }
        func range(_ k: String, scale: Double, lo: Double, hi: Double) -> ClosedRange<Double>? {
            guard let r = o[k] as? [Any], r.count == 2, let x = (r[0] as? NSNumber)?.doubleValue, let y = (r[1] as? NSNumber)?.doubleValue,
                  x.isFinite, y.isFinite else { return nil }
            let a = min(hi, max(lo, min(x, y) * scale))
            let b = min(hi, max(lo, max(x, y) * scale))
            return a...b
        }
        if let v = num("breathDb") { a.breathDB = min(-6, max(-48, v)) }
        if let v = range("breathEverySec", scale: 1, lo: 1, hi: 60) { a.breathEverySec = v }
        if let v = num("breathParagraphSec") { a.breathParagraphSec = min(60, max(0, v)) }
        if let v = ms("breathMinPauseMs", lo: 0.1, hi: 3) { a.breathMinPause = v }
        if let v = range("breathStartMs", scale: 0.001, lo: 0, hi: 1) { a.breathStart = v }
        if let v = range("breathEndMs", scale: 0.001, lo: 0, hi: 1) { a.breathEnd = v }
        if let v = ms("breathShortestMs", lo: 0.05, hi: 1) { a.breathShortest = v }
        if let v = o["breathSource"] as? String, ["procedural", "snippets", "pack"].contains(v) { a.breathSource = v }
        if let v = ms("fadeMs", lo: 0.002, hi: 0.05) { a.fade = v }
        if let v = ms("crossfadeMs", lo: 0.002, hi: 0.05) { a.crossfade = v }
        if let v = num("speechRmsDb") { a.speechRmsDB = min(-10, max(-40, v)) }
        if let v = num("rateWindow") { a.rateWindow = Int(min(40, max(1, v))) }
        if let v = num("rateBand") { a.rateBand = min(0.2, max(0, v)) }
        if let v = num("rateCap") { a.rateCap = min(0.1, max(0, v)) }
        if let v = ms("microGapMs", lo: 0, hi: 0.3) { a.microGap = v }
        if let v = ms("blipMs", lo: 0, hi: 0.2) { a.blip = v }
        if let v = range("ellipsisPauseMs", scale: 0.001, lo: 0.1, hi: 1.5) { a.ellipsisPause = v }
        if let v = num("roughnessDrop") { a.roughnessDrop = min(1, max(0.01, v)) }
        if let v = ms("roughnessMs", lo: 0.05, hi: 2) { a.roughnessSpan = v }
        if let v = range("nonVerbalGapMs", scale: 0.001, lo: 0, hi: 1) { a.nonVerbalGap = v }
        if let v = ms("nonVerbalFadeMs", lo: 0.002, hi: 0.1) { a.nonVerbalFade = v }
        if let v = num("nonVerbalDb") { a.nonVerbalDB = min(6, max(-30, v)) }
        return a
    }
}

/// The script's `delivery` header.
public struct DeliveryHeader: Sendable, Equatable {
    public var moods: MoodTable
    public var audio: DeliveryAudio

    public init(moods: MoodTable = .standard, audio: DeliveryAudio = DeliveryAudio()) {
        self.moods = moods
        self.audio = audio
    }

    public static func parse(_ raw: Any?) -> DeliveryHeader? {
        guard let o = raw as? [String: Any] else { return nil }
        return DeliveryHeader(moods: MoodTable.parse(o["moods"]) ?? .standard, audio: DeliveryAudio.parse(o["audio"]))
    }
}

/// Decides, unit by unit, whether the expressive engine renders it or Kokoro does, so playback never waits on a model
/// slower than real time: the expressive engine gets a unit only when the audio already queued ahead covers its
/// expected synthesis time (measured as it goes). Pure; the engine feeds it.
public struct ExpressiveGovernor: Sendable, Equatable {
    /// Before anything is measured (docs/expressive-tts.md expects 1–2× on an A18).
    public var assumedRealtime = 1.5
    /// Expected synthesis time × this must fit in the queued audio.
    public var safety = 1.2
    /// Fixed cost per call (flow + vocoder run on a fixed bucket), seconds.
    public var overhead = 0.3
    /// Speaking rate for the length estimate, characters per second.
    public var charsPerSecond = 14.0
    /// At the start (nothing queued), the longest synthesis worth waiting for, seconds.
    public var startBudget = 5.0
    /// Below this measured speed, chunks are too slow to keep up: sentence by sentence instead.
    public var chunkFloor = 1.1
    public private(set) var measured: Double?

    public init() {}

    public var realtime: Double { measured ?? assumedRealtime }

    /// One expressive render: audio seconds produced in synthesis seconds (an exponential average, 30 % new).
    public mutating func record(audioSeconds: Double, synthSeconds: Double) {
        guard audioSeconds > 0, synthSeconds > 0, audioSeconds.isFinite, synthSeconds.isFinite else { return }
        let x = audioSeconds / synthSeconds
        measured = measured.map { $0 + 0.3 * (x - $0) } ?? x
    }

    /// Expected synthesis time of `characters`, seconds.
    public func expectedSynthesis(characters: Int) -> Double {
        let audio = max(0.5, Double(characters) / charsPerSecond)
        return audio / max(0.05, realtime) + overhead
    }

    /// Render the next unit with the expressive engine? `cushion`: seconds of audio queued ahead of it (the rest of
    /// what plays and everything rendered after it); nil when nothing plays yet.
    public func useExpressive(characters: Int, cushion: Double?) -> Bool {
        let need = expectedSynthesis(characters: characters)
        guard let cushion else { return need <= startBudget }
        return cushion >= need * safety
    }

    /// Breath-group chunks still pay off (the device keeps up with longer calls).
    public var chunksKeepUp: Bool { realtime >= chunkFloor }
}

extension VoicePreferences {
    /// Listen reads chapters with an expressive engine (the Narrator voice was picked).
    public var expressiveListen: Bool { delivery.listenEngine.map(DeliverySettings.listenEngines.contains) ?? false }
}
