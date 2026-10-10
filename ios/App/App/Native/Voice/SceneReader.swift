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

    /// Sentences per part of the chapter brief (one model call each; well inside the model's context).
    static let briefPart = 60

    /// The chapter in brief, read once when a chapter starts (Kasta, 2026-10-09: "reading a whole chapter at a time so
    /// it understands the context of the scene"): one line per part of `briefPart` sentences, what happens and how it
    /// feels. Every window's read then knows where the chapter is going (a calm lull before a reveal, the build of a
    /// fight). The whole chapter doesn't fit the on-device model at once; its parts do. nil when unavailable.
    func brief(_ chapter: [Sentence], completion: @escaping (String?) -> Void) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), available, !chapter.isEmpty {
            Task.detached(priority: .utility) {
                var lines: [String] = []
                let parts = stride(from: 0, to: chapter.count, by: Self.briefPart).map { Array(chapter[$0..<min(chapter.count, $0 + Self.briefPart)]) }
                for (k, part) in parts.enumerated() {
                    if let line = await Self.summarize(part) { lines.append("Part \(k + 1) of \(parts.count): \(line)") }
                }
                let brief = lines.isEmpty ? nil : lines.joined(separator: "\n")
                DispatchQueue.main.async { completion(brief) }
            }
            return
        }
        #endif
        DispatchQueue.main.async { completion(nil) }
    }

    /// Moods for `window` (in order), read with `context` (the sentences just before it) for the scene and, when there
    /// is one, the chapter's brief and the part the window is in; nil when the model isn't available or fails. The
    /// completion runs on the main queue.
    func read(context: [Sentence], window: [Sentence], brief: String? = nil, part: Int? = nil, completion: @escaping ([String]?) -> Void) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), available, !window.isEmpty {
            let t0 = Date()
            Task.detached(priority: .utility) { [weak self] in
                let moods = await Self.ask(context: context, window: window, brief: brief, part: part)
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

    /// Words spelled the same with two sayings. Nephis's model mostly says each one way whatever the sentence means
    /// (PC test 2026-10-09, r13: the right sense 8 of 16): the model here is asked the question, and the answer picks
    /// a respelling she says right (nil = as written, the way she says it anyway).
    struct Homograph {
        let question: String
        let yes: String?
        let no: String?
    }
    static let homographs: [String: Homograph] = [
        "read": Homograph(question: "is \"read\" present tense or future (to read, they read every night), rhyming with \"reed\"", yes: "reed", no: nil),
        "tear": Homograph(question: "does \"tear\" mean to rip (rhymes with \"air\")", yes: "tair", no: nil),
        "wind": Homograph(question: "does \"wind\" mean to turn, coil or wrap (rhymes with \"kind\")", yes: "wynd", no: nil),
        "bow": Homograph(question: "does \"bow\" mean bending forward or a ship's front (rhymes with \"cow\")", yes: "bau", no: nil),
        "wound": Homograph(question: "is \"wound\" the past of wind: coiled, wrapped, turned (rhymes with \"sound\")", yes: "wownd", no: nil),
        "live": Homograph(question: "is \"live\" an adjective: alive, active, burning or charged (rhymes with \"five\")", yes: "lyve", no: nil),
        "lead": Homograph(question: "is \"lead\" the metal (rhymes with \"bed\")", yes: "led", no: "leed"),
        "close": Homograph(question: "does \"close\" mean near (ends in an s sound, not z)", yes: "klohss", no: "klohz"),
    ]

    /// The homographs of `sentences` (index → text) and how to say them: index → [word: respelling], read with the
    /// sentence and the one before it; empty when none or the model isn't available. Main queue.
    func senses(_ sentences: [(index: Int, text: String, before: String)], completion: @escaping ([Int: [String: String]]) -> Void) {
        var asks: [(index: Int, word: String, text: String, before: String)] = []
        for s in sentences {
            let words = Set(s.text.lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init))
            for w in words.sorted() where Self.homographs[w] != nil { asks.append((s.index, w, s.text, s.before)) }
        }
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), available, !asks.isEmpty {
            Task.detached(priority: .utility) {
                let out = await Self.askSenses(asks)
                DispatchQueue.main.async { completion(out) }
            }
            return
        }
        #endif
        DispatchQueue.main.async { completion([:]) }
    }

    /// `text` with the sense respellings applied (whole words; a capitalized word keeps its capital).
    static func respell(_ text: String, _ senses: [String: String]) -> String {
        var out = text
        for (word, said) in senses {
            guard let rx = try? NSRegularExpression(pattern: "\\b\(word)\\b", options: .caseInsensitive) else { continue }
            for m in rx.matches(in: out, range: NSRange(out.startIndex..., in: out)).reversed() {
                guard let r = Range(m.range, in: out) else { continue }
                let capital = out[r].first?.isUppercase == true
                out.replaceSubrange(r, with: capital ? said.prefix(1).uppercased() + said.dropFirst() : said)
            }
        }
        return out
    }

    #if canImport(FoundationModels)
    @available(iOS 26.0, *)
    @Generable
    struct SenseAnswer {
        @Guide(description: "The number of the question, as given")
        var number: Int
        @Guide(description: "The answer to the question")
        var yes: Bool
    }

    @available(iOS 26.0, *)
    @Generable
    struct SenseAnswers {
        @Guide(description: "One answer per numbered question, in order")
        var answers: [SenseAnswer]
    }

    @available(iOS 26.0, *)
    private static func askSenses(_ asks: [(index: Int, word: String, text: String, before: String)]) async -> [Int: [String: String]] {
        var prompt = ""
        for (k, a) in asks.enumerated() {
            prompt += "\(k + 1). " + (a.before.isEmpty ? "" : "(Before it: \(a.before)) ") + "Sentence: \(a.text)\n   Question: in this sentence, \(homographs[a.word]!.question)?\n"
        }
        do {
            let session = LanguageModelSession(instructions: "You help an audiobook narrator say words that are spelled alike but said differently. Answer each question from what the sentence means.")
            let reply = try await session.respond(to: prompt, generating: SenseAnswers.self)
            var out: [Int: [String: String]] = [:]
            for r in reply.content.answers where r.number >= 1 && r.number <= asks.count {
                let a = asks[r.number - 1]; let h = homographs[a.word]!
                if let said = r.yes ? h.yes : h.no { out[a.index, default: [:]][a.word] = said }
            }
            return out
        } catch {
            Logger(subsystem: "app.tachinovel", category: "voice-scene").error("senses: \(error.localizedDescription, privacy: .public)")
            return [:]
        }
    }

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
    @Generable
    struct PartNote {
        @Guide(description: "What happens in this part, in at most 20 words")
        var summary: String
        @Guide(description: "How this part feels overall")
        var mood: Mood
    }

    @available(iOS 26.0, *)
    private static func summarize(_ part: [Sentence]) async -> String? {
        let text = part.map { $0.text }.joined(separator: " ")
        do {
            let session = LanguageModelSession(instructions: "You summarize a part of a novel chapter for an audiobook narrator: what happens and how it feels.")
            let reply = try await session.respond(to: "Part of the chapter:\n" + text, generating: PartNote.self)
            return "\(reply.content.summary) (\(name(reply.content.mood)))"
        } catch {
            Logger(subsystem: "app.tachinovel", category: "voice-scene").error("scene brief: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    @available(iOS 26.0, *)
    private static func ask(context: [Sentence], window: [Sentence], brief: String?, part: Int?) async -> [String]? {
        let label = { (s: Sentence) -> String in s.kind == .narration ? "" : s.kind == .spoken ? "[spoken] " : "[system] " }
        var prompt = ""
        if let brief {
            prompt += "The chapter in brief:\n" + brief + "\n" + (part.map { "These sentences are in part \($0).\n" } ?? "") + "\n"
        }
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
