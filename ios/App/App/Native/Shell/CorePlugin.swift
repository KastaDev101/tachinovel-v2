//
//  CorePlugin.swift — Capacitor plugin "Core": the UI ↔ core bridge (replaces v1's Scriptable
//  long-poll). JS side: src/ui/capacitor-client.ts.
//    Core.call({ json }) → { json }         RequestEnvelope / ResponseEnvelope JSON strings
//    listener "event": { event, payload }   core events (payload is a JSON string)
//  Concurrency: every call goes straight to CoreHost's queue; calls complete independently.
//

import Capacitor
import Foundation
import UIKit

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
    ]

    /// navigator.wakeLock shim (src/ui/native/prelude.ts) → idle timer.
    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on", false)
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }
}
