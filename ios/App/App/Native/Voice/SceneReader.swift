//
//  SceneReader.swift — natural delivery's AI director ("rules+ai"): Apple's on-device model (iOS 26, Apple
//  Intelligence on) reads the upcoming sentences in context and says how each should be read (calm or one of
//  Nephis's eleven moods: wry, playful, tense, dread, intense, sad, tender, awe, hushed, triumph, cold). Keyword rules can't hear suspense without suspense words ("She stopped breathing."
//  could be either); the model reads the scene. Everything stays on the phone.
//
//  It never holds playback up: HybridSpeechEngine asks for windows of sentences ahead of the render cursor and uses
//  an answer only if it is there when a sentence renders; otherwise the script's own read stands (rules). The answer's
//  moods become reads with the script's rules (HDVoiceCore SceneMood).
//

import Foundation
import HDVoiceCore
import os
#if canImport(FoundationModels)
import FoundationModels
#endif

final class SceneReader {
    static let shared = SceneReader()

    /// One sentence for the model: its text and what it is.
    struct Sentence {
        enum Kind: String { case narration, spoken, system }
        let text: String
        let kind: Kind
    }

    private let log = Logger(subsystem: "app.tachinovel", category: "voice-scene")
    private(set) var windowsRead = 0
    private(set) var failures = 0
    private(set) var lastMs: Double = 0

    /// The model can run here (iOS 26 with Apple Intelligence on and its model ready).
    var available: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability { return true }
        }
        #endif
        return false
    }

    /// Why it can't run, for the Voice Lab (nil when it can).
    var unavailableReason: String? {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available: return nil
            case .unavailable(let why): return "\(why)"
            }
        }
        return "needs iOS 26"
        #else
        return "built without the on-device model"
        #endif
    }

    /// Moods for `window` (in order), read with `context` (the sentences just before it) for the scene; nil when the
    /// model isn't available or fails. The completion runs on the main queue.
    func read(context: [Sentence], window: [Sentence], completion: @escaping ([String]?) -> Void) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), available, !window.isEmpty {
            let t0 = Date()
            Task.detached(priority: .utility) { [weak self] in
                let moods = await Self.ask(context: context, window: window)
                DispatchQueue.main.async {
                    guard let self else { return completion(moods) }
                    self.lastMs = Date().timeIntervalSince(t0) * 1000
                    if moods == nil { self.failures += 1 } else { self.windowsRead += 1 }
                    completion(moods)
                }
            }
            return
        }
        #endif
        DispatchQueue.main.async { completion(nil) }
    }

    #if canImport(FoundationModels)
    @available(iOS 26.0, *)
    @Generable
    enum Mood {
        case calm, wry, playful, tense, dread, intense, sad, tender, awe, hushed, triumph, cold
    }

    @available(iOS 26.0, *)
    @Generable
    struct Read {
        @Guide(description: "The number of the sentence, as given")
        var number: Int
        @Guide(description: "How the narrator should read this sentence")
        var mood: Mood
    }

    @available(iOS 26.0, *)
    @Generable
    struct Reads {
        @Guide(description: "One entry per numbered sentence, in order")
        var sentences: [Read]
    }

    static let instructions = """
        You direct an audiobook narrator. For each numbered sentence of a novel passage, choose how it should be read:
        calm: neutral narration, explanation, backstory, reflection, ordinary conversation. The default.
        wry: dry humor said straight: irony, sarcasm, understatement, a deadpan aside, a character grumbling.
        playful: teasing, banter, light fun said to someone.
        tense: suspense, danger close, urgency, alarm, a fight about to start; quick and tight.
        dread: quiet horror or menace, something deeply wrong, an ominous realization; slow and cold.
        intense: battle in full motion, fury, a battle cry, peak action.
        sad: grief, loss, regret, despair.
        tender: comfort, affection, gentle caring words.
        awe: wonder at something vast or beautiful, a great revelation.
        hushed: whispering, sneaking, secrets.
        triumph: victory, relief, hope, joy.
        cold: cold authority, a command, a threat, contempt.
        Judge from the scene and what is happening, not from single words. Most sentences are calm; pick another \
        mood only when a listener would clearly hear it. Description inside a fight is intense or tense when \
        danger is immediate and calm when it explains or reflects. A quiet moment after danger is calm or tender. \
        Lines marked [spoken] are said aloud; lines marked [thought] or in single quotes are a character's thoughts.
        """

    @available(iOS 26.0, *)
    private static func ask(context: [Sentence], window: [Sentence]) async -> [String]? {
        let label = { (s: Sentence) -> String in s.kind == .narration ? "" : s.kind == .spoken ? "[spoken] " : "[system] " }
        var prompt = ""
        if !context.isEmpty {
            prompt += "Earlier in the scene:\n" + context.map { label($0) + $0.text }.joined(separator: "\n") + "\n\n"
        }
        prompt += "Sentences to direct:\n"
        for (k, s) in window.enumerated() { prompt += "\(k + 1). \(label(s))\(s.text)\n" }
        do {
            let session = LanguageModelSession(instructions: instructions)
            let reply = try await session.respond(to: prompt, generating: Reads.self)
            var out = [String](repeating: "", count: window.count)
            for r in reply.content.sentences where r.number >= 1 && r.number <= window.count {
                out[r.number - 1] = name(r.mood)
            }
            // Every sentence answered, or none: a partial answer would mix the model's reads with the rules mid-scene.
            return out.contains("") ? nil : out
        } catch {
            Logger(subsystem: "app.tachinovel", category: "voice-scene").error("scene reader: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    @available(iOS 26.0, *)
    private static func name(_ m: Mood) -> String {
        switch m {
        case .calm: return "calm"
        case .wry: return "wry"
        case .playful: return "playful"
        case .tense: return "tense"
        case .dread: return "dread"
        case .intense: return "intense"
        case .sad: return "sad"
        case .tender: return "tender"
        case .awe: return "awe"
        case .hushed: return "hushed"
        case .triumph: return "triumph"
        case .cold: return "cold"
        }
    }
    #endif
}
