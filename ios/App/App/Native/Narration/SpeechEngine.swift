//
//  SpeechEngine.swift — engine abstraction for narration.
//
//  SystemSpeechEngine = AVSpeechSynthesizer (ships now: free, tiny, Premium/Enhanced voices if the user
//  downloaded them, Personal Voice on iOS 17+, IPA pronunciations).
//  A NeuralSpeechEngine (Kokoro-82M via Core ML on the Neural Engine/CPU, Apache-2.0 G2P, model as an
//  Apple-hosted asset pack) plugs in behind the same protocol later: docs/tts-v2.md. It must render
//  ahead to PCM (GPU work is not allowed in the background) and play through AVAudioEngine.
//

import AVFoundation
import Foundation
import NaturalLanguage

struct SpeechSegment {
    let id: Int
    let text: NSAttributedString
    /// 0.5 … 2.0, 1 = normal.
    let rate: Float
    let pitch: Float
    let voiceIdentifier: String?
    /// Silence after this segment (sentence/paragraph/scene pauses).
    let pauseAfter: TimeInterval
}

protocol SpeechEngineDelegate: AnyObject {
    func speechEngine(didStart id: Int)
    func speechEngine(didFinish id: Int)
    func speechEngine(willSpeak id: Int, range: NSRange)
}

protocol SpeechEngine: AnyObject {
    var delegate: SpeechEngineDelegate? { get set }
    var isSpeaking: Bool { get }
    var isPaused: Bool { get }
    /// Append segments to the play queue (the engine speaks them in order, gaplessly).
    func enqueue(_ segments: [SpeechSegment])
    /// Drop everything queued or playing (no didFinish callbacks for dropped segments).
    func stop()
    func pause()
    func resume()
}

final class SystemSpeechEngine: NSObject, SpeechEngine, AVSpeechSynthesizerDelegate {
    weak var delegate: SpeechEngineDelegate?
    private let synth = AVSpeechSynthesizer()
    private var ids: [ObjectIdentifier: Int] = [:]

    override init() {
        super.init()
        synth.delegate = self
        // Use OUR session (.playback/.spokenAudio) so speech continues on the lock screen and is the
        // Now Playing app; otherwise the system manages a separate session.
        synth.usesApplicationAudioSession = true
        synth.mixToTelephonyUplink = false
    }

    var isSpeaking: Bool { synth.isSpeaking }
    var isPaused: Bool { synth.isPaused }

    func enqueue(_ segments: [SpeechSegment]) {
        for s in segments {
            let u = AVSpeechUtterance(attributedString: s.text)
            u.rate = Self.avRate(s.rate)
            u.pitchMultiplier = max(0.5, min(2, s.pitch))
            u.voice = Self.voice(s.voiceIdentifier)
            u.postUtteranceDelay = s.pauseAfter
            ids[ObjectIdentifier(u)] = s.id
            synth.speak(u)
        }
    }

    func stop() {
        ids.removeAll()
        synth.stopSpeaking(at: .immediate)
    }

    func pause() { synth.pauseSpeaking(at: .word) }
    func resume() { synth.continueSpeaking() }

    /// Map 0.5…2.0 onto AVSpeech's 0…1 scale around the default rate.
    static func avRate(_ r: Float) -> Float {
        let base = AVSpeechUtteranceDefaultSpeechRate
        let rate = r >= 1 ? base + (AVSpeechUtteranceMaximumSpeechRate - base) * (r - 1) / 2 : base * max(0.5, r)
        return max(AVSpeechUtteranceMinimumSpeechRate, min(AVSpeechUtteranceMaximumSpeechRate, rate))
    }

    /// The requested voice, else the best installed voice for the device language (premium > enhanced > default).
    static func voice(_ identifier: String?) -> AVSpeechSynthesisVoice? {
        if let identifier, let v = AVSpeechSynthesisVoice(identifier: identifier) { return v }
        let lang = AVSpeechSynthesisVoice.currentLanguageCode()
        let prefix = String(lang.prefix(2))
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(prefix) }
        func rank(_ v: AVSpeechSynthesisVoice) -> Int {
            var r = 0
            if v.quality == .premium { r = 3 } else if v.quality == .enhanced { r = 2 } // .premium: iOS 16+
            if v.language == lang { r += 1 }
            return r
        }
        return candidates.max { rank($0) < rank($1) } ?? AVSpeechSynthesisVoice(language: lang)
    }

    // MARK: AVSpeechSynthesizerDelegate
    // Delivered on main in practice (the synthesizer is created on main), but that is not documented: hop
    // if not, because `ids` and the controller state are main-thread only. Main is FIFO, so order holds.
    // The closures capture `utterance` so its ObjectIdentifier cannot be reused before they run.

    private func onMain(_ fn: @escaping () -> Void) {
        if Thread.isMainThread { fn() } else { DispatchQueue.main.async(execute: fn) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        onMain { if let id = self.ids[ObjectIdentifier(utterance)] { self.delegate?.speechEngine(didStart: id) } }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onMain { if let id = self.ids.removeValue(forKey: ObjectIdentifier(utterance)) { self.delegate?.speechEngine(didFinish: id) } }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onMain { _ = self.ids.removeValue(forKey: ObjectIdentifier(utterance)) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        onMain { if let id = self.ids[ObjectIdentifier(utterance)] { self.delegate?.speechEngine(willSpeak: id, range: characterRange) } }
    }
}

// MARK: - Text helpers

enum NarrationText {
    struct LexiconEntry {
        let grapheme: String
        let ipa: String?
        let say: String?
    }

    /// Sentences of a paragraph (Apple's tokenizer; tiny fragments merged forward like the core does).
    static func sentences(_ text: String) -> [String] {
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = text
        var out: [String] = []
        var carry = ""
        tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
            let s = (carry + text[range]).trimmingCharacters(in: .whitespacesAndNewlines)
            if s.count < 12 { carry = s + " " } else {
                out.append(s)
                carry = ""
            }
            return true
        }
        let rest = carry.trimmingCharacters(in: .whitespaces)
        if !rest.isEmpty {
            if let last = out.popLast() { out.append(last + " " + rest) } else { out.append(rest) }
        }
        return out
    }

    static func isSceneBreak(_ text: String) -> Bool {
        text.range(of: "^[\\s*~#=_\\-–—·•]{3,}$", options: .regularExpression) != nil
    }

    /// Apply the pronunciation lexicon: respellings first, then IPA attributes on the final string.
    static func attributed(_ text: String, lexicon: [LexiconEntry]) -> NSAttributedString {
        var s = text
        for e in lexicon where e.say != nil && e.ipa == nil {
            s = replaceWord(e.grapheme, in: s, with: e.say!)
        }
        let out = NSMutableAttributedString(string: s)
        let key = NSAttributedString.Key(rawValue: AVSpeechSynthesisIPANotationAttribute)
        for e in lexicon {
            guard let ipa = e.ipa, let re = wordRegex(e.grapheme) else { continue }
            for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
                out.addAttribute(key, value: ipa, range: m.range)
            }
        }
        return out
    }

    private static func wordRegex(_ word: String) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: "\\b" + NSRegularExpression.escapedPattern(for: word) + "\\b", options: [.caseInsensitive])
    }

    private static func replaceWord(_ word: String, in text: String, with replacement: String) -> String {
        guard let re = wordRegex(word) else { return text }
        return re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: NSRegularExpression.escapedTemplate(for: replacement))
    }
}
