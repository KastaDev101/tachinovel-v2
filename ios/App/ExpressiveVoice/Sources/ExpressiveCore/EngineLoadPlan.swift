//
//  EngineLoadPlan.swift — what ExpressiveService.ensureLoaded does when asked for an engine: use the one already
//  loaded, wait for the load in flight, or (re)load. Kept here so it is unit-tested on the PC's CI host.
//
//  Until build 375 the loaded voice was never recorded for Pocket TTS, so every ensureLoaded on an already-loaded
//  Nephis unloaded and reloaded her model: at every Listen start, the file → live hand-off, the Voice Speed Test and
//  each audio download (a cold start, missing studio at the session start, wasted heat). The request key now names
//  everything a reload must follow: the voice, her narrator pack, her dialogue pack and her studio switch.
//

import Foundation

public enum EngineLoadPlan {
    public enum Step: Equatable, Sendable {
        /// The engine is loaded with this request: nothing to do.
        case reuse
        /// A load with this request is in flight: wait for it.
        case wait
        /// Load it (nothing loaded, or the loaded/loading request differs: `reason` says why, for the log).
        case load(reason: String)
    }

    /// What ensureLoaded does. `loadedReady`: this engine is loaded and ready; `loading`: it is loading.
    /// `loaded`/`loadingRequest`: the request it was loaded/is loading with; `requested`: the one asked for now.
    public static func step(loadedReady: Bool, loading: Bool, loaded: String?, loadingRequest: String?,
                            requested: String?) -> Step {
        if loadedReady {
            return requested == loaded ? .reuse : .load(reason: "switching voice (\(loaded ?? "none") → \(requested ?? "none"))")
        }
        if loading {
            return requested == loadingRequest ? .wait : .load(reason: "switching voice while loading")
        }
        return .load(reason: "not loaded")
    }

    /// The request key for Pocket TTS: the shipped voice it reads with, and for Nephis her packs and studio switch, so a
    /// real change still reloads while the same voice is reused. `pack`/`dialogue`: the active narrator and dialogue pack
    /// ids (nil: Kyutai's released model / no dialogue pack).
    public static func pocketRequest(voice: String, nephis: Bool, pack: String?, dialogue: String?, studio: Bool) -> String {
        guard nephis else { return voice }
        return "\(voice)|pack=\(pack ?? "released")|dialogue=\(dialogue ?? "none")|studio=\(studio ? "on" : "off")"
    }
}
