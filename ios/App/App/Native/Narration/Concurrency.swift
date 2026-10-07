//
//  Concurrency.swift — helpers for the narration and voice code under strict concurrency checking.
//
//  Narration lives on the main thread: the plugin hops there for every call, and the audio engines, Kokoro
//  and drive preparation deliver their callbacks there. The compiler can't see that from the types, so the
//  classes that live on the main thread say so (`@unchecked Sendable`, with where they run in their doc
//  comment), values handed through a @Sendable closure that are only ever used on main travel in
//  `MainBound`, and UIKit's main-actor API is reached through `MainThread.run`.
//

import Foundation

/// A value passed through a @Sendable closure that is only ever used on the main thread (a completion
/// handler, an object owned by one sentence).
struct MainBound<T>: @unchecked Sendable {
    let value: T

    init(_ value: T) { self.value = value }
}

/// Mutable state shared with a callback that runs synchronously inside the call that owns it (e.g.
/// AVAudioConverter's input block), or a result carried out of a main-actor closure.
final class Box<T>: @unchecked Sendable {
    var value: T

    init(_ value: T) { self.value = value }
}

enum MainThread {
    /// `body` on the main actor, and its result: at once when already on the main thread (where narration
    /// runs), else synchronously on it.
    static func run<T>(_ body: @MainActor () -> T) -> T {
        let out = Box<T?>(nil)
        if Thread.isMainThread {
            MainActor.assumeIsolated { out.value = body() }
        } else {
            DispatchQueue.main.sync { MainActor.assumeIsolated { out.value = body() } }
        }
        guard let result = out.value else { fatalError("MainThread.run: the main-actor closure produced no result") }
        return result
    }
}
