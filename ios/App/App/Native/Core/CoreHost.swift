//
//  CoreHost.swift — owns the core JavaScriptCore context (v1's script side, ported).
//
//  The core (www/core/core.js → App bundle public/core/core.js) runs here, NOT in the WKWebView:
//   - it keeps running while the WebView is suspended (lock screen narration auto-continue,
//     BGAppRefreshTask update checks), because it lives in the app process;
//   - plugin code (scrapers) never shares a realm with the UI DOM or the Capacitor bridge;
//   - synchronous file APIs (v1's FileStore contract) are trivial to provide natively.
//
//  Threading: ONE serial queue owns the JSContext. Every JS entry (evaluate, callbacks, timers,
//  async completions) is dispatched onto `queue`. JSC drains the microtask queue when the
//  outermost call returns, so promise continuations run before control goes back to Swift.
//
//  NOTE: this file deliberately does not `import Capacitor` (Capacitor declares its own `JSValue`
//  protocol, which clashes with JavaScriptCore's class).
//

import Foundation
import JavaScriptCore
import os

/// Thread model: the JS state is confined to `queue`, observers are guarded by `observersLock`, and
/// `localRoot` never changes after init (the router reads it from the main thread). Not declared
/// `Sendable` yet: with that conformance Swift 6.3.3 crashed in its SendNonSendable pass on a caller's
/// completion closure (NarrationController.playNovel) under complete concurrency checking.
final class CoreHost {
    static let shared = CoreHost()

    let queue = DispatchQueue(label: "app.tachinovel.core", qos: .userInitiated)
    let log = Logger(subsystem: "app.tachinovel", category: "core")

    let localRoot: URL
    private(set) var syncedRoot: URL?
    /// The app's Documents folder: Files shows it as On My iPhone › TachiNovel (Info.plist
    /// UIFileSharingEnabled). The core keeps the synced store there when there is no iCloud (free sideload).
    let documentsRoot: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    private var context: JSContext?
    private var api: NativeHostAPI?
    private var handler: JavaScriptCore.JSValue?
    private var pending: [(String, (String) -> Void)] = []
    private var started = false
    /// Set when the core can't start (no JSContext, core.js missing/broken, never registered). Every
    /// queued and later request is then answered with this error instead of waiting forever.
    private var startupError: String?
    /// Last uncaught JS exception (reported if core.js dies before registering its handler).
    private var lastException: String?
    /// core.js registers synchronously at the end of its top level; if that hasn't happened this long
    /// after evaluation started, queued requests are failed (watchdog for a hung boot).
    static let startupTimeout: TimeInterval = 20
    private var nextId = 1_000_000 // ids for native-originated requests (UI ids start at 1)

    /// Event observers (CorePlugin forwards to the UI; Narration listens too). Called on `queue`.
    private var observers: [UUID: (String, String) -> Void] = [:]
    private let observersLock = NSLock()

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        localRoot = support
    }

    /// Local store root as seen by the router (covers/…): <Application Support>/TachiNovel.
    var localAppDir: URL { localRoot.appendingPathComponent("TachiNovel", isDirectory: true) }

    // MARK: - Lifecycle

    /// Start the core once. Safe to call from any thread; the WebView may call into the core before
    /// it is ready: requests are queued until core.js registers its handler.
    func start(launchReason: String = "ui") {
        queue.async { [self] in
            guard !started else { return }
            started = true
            prepareDirectories()
            // iCloud container lookup can block: we are on the core queue, never the main thread.
            if let container = FileManager.default.url(forUbiquityContainerIdentifier: nil) {
                syncedRoot = container.appendingPathComponent("Documents", isDirectory: true)
                try? FileManager.default.createDirectory(at: syncedRoot!, withIntermediateDirectories: true)
            }
            boot(launchReason: launchReason)
        }
    }

    private func prepareDirectories() {
        let fm = FileManager.default
        try? fm.createDirectory(at: localAppDir, withIntermediateDirectories: true)
        // Regenerable data must not bloat iCloud Backup.
        for name in ["cache", "covers", "downloads", "imports"] {
            var url = localAppDir.appendingPathComponent(name, isDirectory: true)
            try? fm.createDirectory(at: url, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
        }
    }

    private func boot(launchReason: String) {
        // JSC's initializers are not nullability-annotated (IUO); bind through an explicit Optional so this
        // compiles whether the SDK imports them as `init!` or non-failable.
        let vm: JSVirtualMachine? = JSVirtualMachine()
        let created: JSContext? = vm.flatMap { JSContext(virtualMachine: $0) }
        guard let ctx = created else {
            return failStartup("JavaScriptCore context could not be created")
        }
        ctx.name = "TachiNovel Core"
        #if DEBUG
        ctx.isInspectable = true // iOS 16.4+; the deployment target is 17
        #endif
        ctx.exceptionHandler = { [weak self] _, exception in
            let message = exception?.toString() ?? "unknown"
            let stack = exception?.objectForKeyedSubscript("stack")?.toString() ?? ""
            self?.log.error("core exception: \(message, privacy: .public) \(stack, privacy: .public)")
            self?.lastException = message
        }
        let api = NativeHostAPI(host: self, launchReason: launchReason)
        ctx.setObject(api.makeObject(in: ctx), forKeyedSubscript: "__native" as NSString)
        self.api = api
        context = ctx

        guard let url = Bundle.main.url(forResource: "core", withExtension: "js", subdirectory: "public/core"),
              let code = try? String(contentsOf: url, encoding: .utf8) else {
            return failStartup("public/core/core.js is missing from the app bundle (run npm run build && npx cap copy ios)")
        }
        _ = ctx.evaluateScript(code, withSourceURL: url)
        // core.js calls __native.register() synchronously at the end of its top level. If it didn't, the
        // script threw before getting there: fail fast with the exception instead of hanging every call.
        if handler == nil {
            if let lastException { return failStartup("core.js failed to load: \(lastException)") }
            queue.asyncAfter(deadline: .now() + Self.startupTimeout) { [weak self] in
                guard let self, self.handler == nil, self.startupError == nil else { return }
                self.failStartup("core.js did not start within \(Int(Self.startupTimeout)) s")
            }
        }
    }

    /// Core queue only. Answer everything queued (and everything later) with `reason`.
    private func failStartup(_ reason: String) {
        log.fault("core startup failed: \(reason, privacy: .public)")
        startupError = reason
        let queued = pending
        pending.removeAll()
        for (json, done) in queued { done(Self.errorEnvelope(for: json, message: "The app core failed to start: \(reason)")) }
    }

    /// ResponseEnvelope JSON for a failed request (same shape the core uses; code UNKNOWN, not retryable).
    static func errorEnvelope(for requestJson: String, message: String) -> String {
        let id = ((try? JSONSerialization.jsonObject(with: Data(requestJson.utf8))) as? [String: Any])?["id"] as? NSNumber
        let env: [String: Any] = [
            "kind": "res", "id": id ?? 0, "ok": false,
            "error": ["code": "UNKNOWN", "message": message, "retryable": false] as [String: Any],
        ]
        return (try? JSONSerialization.data(withJSONObject: env)).flatMap { String(data: $0, encoding: .utf8) }
            ?? "{\"kind\":\"res\",\"id\":0,\"ok\":false,\"error\":{\"code\":\"UNKNOWN\",\"message\":\"core unavailable\",\"retryable\":false}}"
    }

    // MARK: - Requests

    /// Called from JS (`__native.register`) on the core queue.
    func setHandler(_ fn: JavaScriptCore.JSValue) {
        handler = fn
        let queued = pending
        pending.removeAll()
        for (json, done) in queued { invoke(json, done) }
    }

    /// Send one RequestEnvelope JSON; `completion` gets the ResponseEnvelope JSON (on the core queue).
    func call(_ requestJson: String, completion: @escaping (String) -> Void) {
        queue.async { [self] in dispatch(requestJson, completion) }
    }

    /// Core queue only: run now, buffer until the handler exists, or answer with the startup error.
    private func dispatch(_ json: String, _ done: @escaping (String) -> Void) {
        if handler != nil { return invoke(json, done) }
        if let startupError { return done(Self.errorEnvelope(for: json, message: "The app core failed to start: \(startupError)")) }
        pending.append((json, done))
    }

    /// Native-originated call with a method name; completion receives (ok, resultJSON or error message).
    func request(_ method: String, args: [String: Any] = [:], completion: ((Bool, Any?) -> Void)? = nil) {
        queue.async { [self] in
            nextId += 1
            let envelope: [String: Any] = ["kind": "req", "id": nextId, "method": method, "args": args]
            guard let data = try? JSONSerialization.data(withJSONObject: envelope),
                  let json = String(data: data, encoding: .utf8) else {
                completion?(false, "unserializable args")
                return
            }
            let done: (String) -> Void = { res in
                guard let d = res.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
                    completion?(false, "bad response")
                    return
                }
                if (obj["ok"] as? Bool) == true { completion?(true, obj["result"]) } else {
                    let err = obj["error"] as? [String: Any]
                    completion?(false, err?["message"] ?? "error")
                }
            }
            dispatch(json, done)
        }
    }

    private func invoke(_ json: String, _ done: @escaping (String) -> Void) {
        guard let handler, let ctx = handler.context else {
            return done(Self.errorEnvelope(for: json, message: "The app core is not available"))
        }
        let block: @convention(block) (String) -> Void = { response in done(response) }
        guard let doneFn = JavaScriptCore.JSValue(object: unsafeBitCast(block, to: AnyObject.self), in: ctx) else {
            return done(Self.errorEnvelope(for: json, message: "The app core could not accept the request"))
        }
        _ = handler.call(withArguments: [json, doneFn])
    }

    // MARK: - Events

    @discardableResult
    func addObserver(_ fn: @escaping (String, String) -> Void) -> UUID {
        let id = UUID()
        observersLock.lock()
        observers[id] = fn
        observersLock.unlock()
        return id
    }

    func removeObserver(_ id: UUID) {
        observersLock.lock()
        observers.removeValue(forKey: id)
        observersLock.unlock()
    }

    /// From JS (`__native.emit`), on the core queue.
    func emit(_ event: String, _ payloadJson: String) {
        observersLock.lock()
        let fns = Array(observers.values)
        observersLock.unlock()
        for fn in fns { fn(event, payloadJson) }
    }
}
