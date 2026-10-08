//
//  NarrationPlugin+Scene.swift — Voice Lab › Test scene reading (the on-device AI director over a list of
//  sentences, in playback's windows). Its own file: NarrationPlugin's body is at SwiftLint's length limit.
//

@preconcurrency import Capacitor
import Foundation

extension NarrationPlugin {
    /// Voice Lab › Test scene reading: the on-device AI director over `sentences` ({text, kind}), in the windows
    /// playback uses. Resolves {available, reason?, moods: [String] | null, ms}.
    @objc func readScene(_ call: CAPPluginCall) {
        let sentences: [SceneReader.Sentence] = (call.getArray("sentences") ?? []).compactMap { v in
            guard let o = v as? JSObject, let text = o["text"] as? String else { return nil }
            return SceneReader.Sentence(text: text, kind: SceneReader.Sentence.Kind(rawValue: o["kind"] as? String ?? "") ?? .narration)
        }
        DispatchQueue.main.async {
            let reader = SceneReader.shared
            guard reader.available else {
                return call.resolve(["available": false, "reason": reader.unavailableReason ?? "unavailable", "moods": NSNull(), "ms": 0])
            }
            let t0 = Date()
            var moods: [String] = []
            func next(_ start: Int) {
                guard start < sentences.count else {
                    return call.resolve(["available": true, "moods": moods, "ms": Date().timeIntervalSince(t0) * 1000])
                }
                let end = min(sentences.count, start + HybridSpeechEngine.sceneWindow)
                let context = Array(sentences[max(0, start - HybridSpeechEngine.sceneContext)..<start])
                reader.read(context: context, window: Array(sentences[start..<end])) { got in
                    guard let got else {
                        return call.resolve(["available": true, "reason": "the model gave no answer", "moods": NSNull(), "ms": Date().timeIntervalSince(t0) * 1000])
                    }
                    moods += got
                    next(end)
                }
            }
            next(0)
        }
    }
}
