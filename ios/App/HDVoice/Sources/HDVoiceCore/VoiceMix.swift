//
//  VoiceMix.swift — custom voices made by blending two Kokoro voices (More › Voices › Mix a voice).
//
//  A Kokoro voice is a style pack: 510 rows (one per phoneme-count bucket) of 256 floats, 128 timbre +
//  128 prosody. A mix interpolates two packs element by element, (1 − t)·A + t·B, which is how Kokoro's
//  own voice blends are made. The blend travels as a self-contained voice string, "<a>+<b>@<percent of b>"
//  (e.g. "af_heart+bf_emma@35"), so the engine, the drive cache and the ▶ sample pass it around like any
//  voice id; only the runtime (HDVoiceKokoro) parses it to build the pack. Named mixes ("Your mixes") are
//  kept in VoicePreferences.customVoices and resolve to that string, so editing a mix changes the string
//  and makes audio prepared with the old blend stale.
//

import Foundation

public struct VoiceBlend: Sendable, Equatable, Hashable {
    /// Two different built-in voices.
    public let a: String
    public let b: String
    /// The weight of `b` in whole percent, 1…99 (0 and 100 are just one of the voices).
    public let percent: Int

    /// nil unless `a` and `b` are different built-in voices and the blend really mixes them.
    public init?(a: String, b: String, percent: Int) {
        guard a != b, VoiceCatalog.voice(a) != nil, VoiceCatalog.voice(b) != nil, (1...99).contains(percent) else { return nil }
        self.a = a
        self.b = b
        self.percent = percent
    }

    /// The voice string the engine speaks with: "<a>+<b>@<percent>".
    public var spec: String { "\(a)+\(b)@\(percent)" }

    /// The weight of `b`, 0…1.
    public var t: Float { Float(percent) / 100 }

    /// The voice heard most (accent and gender for the Apple fallback; `a` at 50 %).
    public var dominant: String { percent > 50 ? b : a }

    /// "af_heart+bf_emma@35" → the blend; anything else → nil.
    public static func parse(_ s: String) -> VoiceBlend? {
        guard let plus = s.firstIndex(of: "+"), let at = s.lastIndex(of: "@"), plus < at else { return nil }
        let a = String(s[s.startIndex..<plus])
        let b = String(s[s.index(after: plus)..<at])
        guard let p = Int(s[s.index(after: at)...]) else { return nil }
        return VoiceBlend(a: a, b: b, percent: p)
    }

    /// Clamp a slider value (any number) to a whole percent 0…100.
    public static func percent(_ value: Double) -> Int {
        guard value.isFinite else { return 50 }
        return Int(min(100, max(0, value.rounded())))
    }

    /// (1 − t)·a + t·b, element by element. Both packs must be the same size.
    public static func mix(_ a: [Float], _ b: [Float], t: Float) -> [Float] {
        precondition(a.count == b.count, "voice packs differ in size")
        let u = 1 - t
        var out = [Float](repeating: 0, count: a.count)
        a.withUnsafeBufferPointer { pa in
            b.withUnsafeBufferPointer { pb in
                for i in 0..<pa.count { out[i] = u * pa[i] + t * pb[i] }
            }
        }
        return out
    }
}

/// A named mix the user saved.
public struct CustomVoice: Sendable, Equatable, Codable {
    /// "mix_" + 8 hex digits; never a built-in id.
    public let id: String
    public var name: String
    public var a: String
    public var b: String
    /// The weight of `b`, 0…100.
    public var percent: Int

    public init(id: String, name: String, a: String, b: String, percent: Int) {
        self.id = id
        self.name = name
        self.a = a
        self.b = b
        self.percent = percent
    }

    /// What the engine speaks: the blend string, or one voice when the slider sits at an end.
    public var engineVoice: String? {
        if let blend = VoiceBlend(a: a, b: b, percent: percent) { return blend.spec }
        if percent <= 0, VoiceCatalog.voice(a) != nil { return a }
        if percent >= 100, VoiceCatalog.voice(b) != nil { return b }
        return nil
    }

    /// The voice heard most.
    public var dominant: String { percent > 50 ? b : a }

    public static let idPrefix = "mix_"
    public static let maxNameLength = 40
    public static let maxCount = 50

    public static func isCustomId(_ id: String) -> Bool { id.hasPrefix(idPrefix) }

    public static func newId() -> String {
        idPrefix + String(format: "%08x", UInt32.random(in: 0...UInt32.max))
    }

    /// Trimmed, single-line, at most 40 characters; nil when nothing is left.
    public static func cleanName(_ raw: String) -> String? {
        let one = raw.components(separatedBy: .newlines).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        guard !one.isEmpty else { return nil }
        return String(one.prefix(maxNameLength))
    }

    /// "Heart + Emma (35 %)" — the name a new mix starts with.
    public static func suggestedName(a: String, b: String, percent: Int) -> String {
        let na = VoiceCatalog.voice(a)?.name ?? a
        let nb = VoiceCatalog.voice(b)?.name ?? b
        return "\(na) + \(nb) (\(percent) %)"
    }
}

/// Saving or deleting a mix: what went wrong, in words the UI can show.
public enum CustomVoiceError: Error, Equatable, LocalizedError {
    case unknownVoice(String)
    case sameVoice
    case emptyName
    case tooMany
    case notFound

    public var errorDescription: String? {
        switch self {
        case .unknownVoice(let id): return "Unknown voice \(id)."
        case .sameVoice: return "Pick two different voices to mix."
        case .emptyName: return "Give the mix a name."
        case .tooMany: return "You can keep up to \(CustomVoice.maxCount) mixes. Delete one first."
        case .notFound: return "That mix no longer exists."
        }
    }
}

extension VoicePreferences {
    /// A built-in voice or a saved mix (what a picker may select).
    public func isChoice(_ id: String) -> Bool {
        if VoiceCatalog.voice(id) != nil { return true }
        return customVoices.first { $0.id == id }?.engineVoice != nil
    }

    /// What a choice speaks with: a built-in id or a blend string (a mix id resolves to its blend; a blend
    /// string passes through when valid). nil for anything unknown.
    public func engineVoice(_ id: String) -> String? {
        if VoiceCatalog.voice(id) != nil { return id }
        if let mix = customVoices.first(where: { $0.id == id }) { return mix.engineVoice }
        if let blend = VoiceBlend.parse(id) { return blend.spec }
        return nil
    }

    /// The selected voice for a novel (its own, else the global default, else Heart), as stored: a built-in
    /// id or a mix id. For the UI; speak with `voice(forNovel:)`.
    public func choice(forNovel key: String?) -> String {
        if let key, let v = novelVoices[key], isChoice(v) { return v }
        return isChoice(defaultVoice) ? defaultVoice : VoiceCatalog.defaultVoiceId
    }

    /// The display name of a choice or engine voice: a voice's name, a mix's name, or "Heart + Emma (35 %)"
    /// for an unnamed blend.
    public func displayName(_ raw: String) -> String {
        // A prepared-audio key ("<voice>|narrator:…") shows as its voice.
        let id = raw.split(separator: "|", maxSplits: 1).first.map(String.init) ?? raw
        if let v = VoiceCatalog.voice(id) { return v.name }
        if let mix = customVoices.first(where: { $0.id == id }) { return mix.name }
        if let blend = VoiceBlend.parse(id) {
            if let mix = customVoices.first(where: { $0.engineVoice == blend.spec }) { return mix.name }
            return CustomVoice.suggestedName(a: blend.a, b: blend.b, percent: blend.percent)
        }
        return id
    }

    /// Save a new mix (id nil) or change one. Returns the saved mix.
    @discardableResult
    public mutating func saveCustomVoice(id: String?, name: String, a: String, b: String, percent: Int) throws -> CustomVoice {
        guard VoiceCatalog.voice(a) != nil else { throw CustomVoiceError.unknownVoice(a) }
        guard VoiceCatalog.voice(b) != nil else { throw CustomVoiceError.unknownVoice(b) }
        guard a != b else { throw CustomVoiceError.sameVoice }
        guard let name = CustomVoice.cleanName(name) else { throw CustomVoiceError.emptyName }
        let pct = min(100, max(0, percent))
        if let id {
            guard let i = customVoices.firstIndex(where: { $0.id == id }) else { throw CustomVoiceError.notFound }
            customVoices[i].name = name
            customVoices[i].a = a
            customVoices[i].b = b
            customVoices[i].percent = pct
            return customVoices[i]
        }
        guard customVoices.count < CustomVoice.maxCount else { throw CustomVoiceError.tooMany }
        var newId = CustomVoice.newId()
        while customVoices.contains(where: { $0.id == newId }) { newId = CustomVoice.newId() }
        let mix = CustomVoice(id: newId, name: name, a: a, b: b, percent: pct)
        customVoices.append(mix)
        return mix
    }

    /// Delete a mix; the default and any novel using it go back to Heart / the default, and narrator mode
    /// stops using it for dialogue.
    public mutating func deleteCustomVoice(id: String) throws {
        guard let i = customVoices.firstIndex(where: { $0.id == id }) else { throw CustomVoiceError.notFound }
        customVoices.remove(at: i)
        if defaultVoice == id { defaultVoice = VoiceCatalog.defaultVoiceId }
        novelVoices = novelVoices.filter { $0.value != id }
        if narrator.dialogueVoice == id { narrator.dialogueVoice = nil }
        if narrator.secondDialogueVoice == id { narrator.secondDialogueVoice = nil }
    }
}

extension VoiceCatalog {
    /// The built-in voice behind any engine voice or choice: itself, or a blend's dominant voice (accent and
    /// gender for the Apple fallback). Mix ids need VoicePreferences.engineVoice first.
    public static func baseVoice(_ id: String?) -> KokoroVoice? {
        guard let id else { return nil }
        if let v = voice(id) { return v }
        if let blend = VoiceBlend.parse(id) { return voice(blend.dominant) }
        return nil
    }
}
