//
//  CorePlugin.swift — Capacitor plugin "Core": the UI ↔ core bridge (replaces v1's Scriptable
//  long-poll). JS side: src/ui/capacitor-client.ts.
//    Core.call({ json }) → { json }         RequestEnvelope / ResponseEnvelope JSON strings
//    listener "event": { event, payload }   core events (payload is a JSON string)
//  Concurrency: every call goes straight to CoreHost's queue; calls complete independently.
//

@preconcurrency import Capacitor
import Foundation
import UIKit
import WebKit

@objc(CorePlugin)
public class CorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CorePlugin"
    public let jsName = "Core"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise),
    ]

    private var observer: UUID?

    override public func load() {
        observer = CoreHost.shared.addObserver { [weak self] event, payload in
            // retainUntilConsumed: events emitted before the UI subscribed (boot) are delivered later.
            self?.notifyListeners("event", data: ["event": event, "payload": payload], retainUntilConsumed: event == "app.deepLink")
        }
        CoreHost.shared.start()
    }

    deinit {
        if let observer { CoreHost.shared.removeObserver(observer) }
    }

    @objc func call(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else {
            call.reject("json is required", "INVALID_ARGS")
            return
        }
        CoreHost.shared.call(json) { response in
            call.resolve(["json": response])
        }
    }
}

/// Small native helpers the UI needs directly (no core involvement).
@objc(TachiNativePlugin)
public class TachiNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TachiNativePlugin"
    public let jsName = "TachiNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeRecovery", returnType: CAPPluginReturnPromise),
    ]

    /// Navigation guard for the app's web view (defense in depth: chapter HTML is sanitized and the CSP
    /// blocks scripts). Capacitor hands every top-level navigation that leaves the app to
    /// UIApplication.open, whatever its scheme; only http(s) may go on (to Safari, Capacitor's default).
    /// tel:, sms:, file: and other apps' URL schemes are refused.
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        // Capacitor asks from its WKNavigationDelegate, so this runs on the main thread.
        let scheme = MainActor.assumeIsolated { navigationAction.request.url?.scheme?.lowercased() }
        guard let scheme else { return true }
        switch scheme {
        case "capacitor", "http", "https", "about", "data", "blob":
            return nil // Capacitor's own handling
        default:
            return true // cancel
        }
    }

    /// navigator.wakeLock shim (src/ui/native/prelude.ts) → idle timer.
    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on", false)
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }

    /// How many times iOS killed the web view's content process since the UI last asked (the page was
    /// reloaded; src/ui/native/recovery.ts then restores the screen it was on). Read once.
    @objc func consumeRecovery(_ call: CAPPluginCall) {
        call.resolve(["terminations": WebContentRecoveryState.consume()])
    }
}
