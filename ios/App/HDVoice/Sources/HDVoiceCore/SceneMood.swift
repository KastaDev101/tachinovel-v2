//
//  SceneMood.swift — the on-device scene reader's moods (SceneReader, Apple's on-device model on iOS 26) as reads
//  of the narrator voice, with the same rules as the script's own (speech-script.ts moodVoices): dialogue and
//  thoughts follow their mood line by line (tense/intense → tense, sad, tender, else performed); narration takes
//  only tense or sad, and only when a neighbouring narration sentence agrees (no flicker); system messages and
//  sentences the model hasn't read keep the script's read.
//

import Foundation

public enum SceneMood {
    /// The moods the scene reader may answer with.
    public static let moods: Set<String> = ["calm", "tense", "sad", "tender", "playful", "intense"]

    /// The mood's read for a spoken line or thought, or for narration (nil = calm / the Narrator).
    static func moodRead(_ mood: String) -> String? {
        switch mood {
        case "tense", "intense": return "tense"
        case "sad": return "sad"
        case "tender": return "tender"
        default: return nil
        }
    }

    /// The read for sentence i from the model's moods, or `.none` when the model hasn't read it (use the script's).
    /// `speaks`: dialogue or a thought; `system`: a LitRPG system message.
    public static func read(at i: Int, moods: [Int: String], speaks: (Int) -> Bool, system: (Int) -> Bool) -> String?? {
        guard let mood = moods[i], !system(i) else { return .none }
        let r = moodRead(mood)
        if speaks(i) { return .some(r ?? "performed") }
        guard let r, r == "tense" || r == "sad" else { return .some(nil) }
        let agrees = [i - 1, i + 1].contains { j in
            guard let m = moods[j], !speaks(j), !system(j) else { return false }
            return moodRead(m) == r
        }
        return .some(agrees ? r : nil)
    }
}
