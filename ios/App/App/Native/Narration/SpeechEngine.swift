//
//  SpeechEngine.swift — engine abstraction for narration + text helpers.
//
//  The speech engine is HybridSpeechEngine (Native/Voice): Kokoro-82M on device (bundled Core ML model,
//  rendered a few sentences ahead into AVAudioEngine) with the Apple system voice (AVSpeechSynthesizer)
//  taking over sentence by sentence whenever Kokoro can't keep up, isn't loaded, failed, or the phone is
//  thermally throttled. PC-narrated chapter files are a separate path (AudioChapterPlayer).
//

import AVFoundation
import Foundation
import HDVoiceCore
import NaturalLanguage

struct SpeechSegment {
    let id: Int
    /// Apple voice input (respellings applied, IPA lexicon attributes).
    let text: NSAttributedString
    /// Kokoro input: plain text (respellings applied) …
    let kokoroText: String
    /// … or text/phoneme runs when the pronunciation lexicon has phoneme overrides in this sentence.
    let runs: [SpeechRun]?
    /// 0.5 … 2.0, 1 = normal.
    let rate: Float
    let pitch: Float
    /// Silence after this segment (sentence/paragraph/scene pauses), already scaled for the rate.
    let pauseAfter: TimeInterval
}

protocol SpeechEngineDelegate: AnyObject {
    /// Segment `id` became audible, spoken by `source`.
    func speechEngine(didStart id: Int, source: VoiceSource)
    func speechEngine(didFinish id: Int)
    func speechEngine(willSpeak id: Int, range: NSRange)
}

protocol SpeechEngine: AnyObject {
    var delegate: SpeechEngineDelegate? { get set }
    var isSpeaking: Bool { get }
    var isPaused: Bool { get }
    /// Replace the play queue with these segments (spoken in order, gaplessly).
    func enqueue(_ segments: [SpeechSegment])
    /// Drop everything queued or playing (no didFinish callbacks for dropped segments).
    func stop()
    func pause()
    func resume()
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
