//
//  WebContentRecovery.swift — iOS may kill the web view's content process (memory pressure during long
//  reading sessions, big chapter lists, or a WebKit crash). Capacitor then resets the bridge and reloads
//  the page (WebViewDelegationHandler.webViewWebContentProcessDidTerminate). The core keeps running
//  natively, so library, progress and narration survive; only the UI's in-memory screen stack is lost.
//
//  This wraps Capacitor's navigation delegate to notice the termination: it flushes the core's debounced
//  state, lets Capacitor reload, and records the event so the reloaded UI puts the user back on the
//  screen they were on (src/ui/native/recovery.ts asks TachiNative.consumeRecovery()). Every other
//  delegate call goes straight to Capacitor's handler (ObjC message forwarding).
//

import Foundation
import WebKit

/// Terminations since the UI last asked. Any thread.
enum WebContentRecoveryState {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var terminations = 0

    static func mark() {
        lock.lock()
        terminations += 1
        lock.unlock()
    }

    /// How many terminations happened since the last call (0: a normal launch or reload).
    static func consume() -> Int {
        lock.lock()
        defer {
            terminations = 0
            lock.unlock()
        }
        return terminations
    }
}

final class WebContentRecovery: NSObject {
    /// Capacitor's WebViewDelegationHandler (owned by the bridge; WKWebView only keeps its delegate weakly,
    /// so MainViewController keeps this wrapper).
    private let inner: any WKNavigationDelegate

    init(wrapping inner: any WKNavigationDelegate) {
        self.inner = inner
        super.init()
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || inner.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        inner.responds(to: aSelector) ? inner : super.forwardingTarget(for: aSelector)
    }
}

extension WebContentRecovery: WKNavigationDelegate {
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        WebContentRecoveryState.mark()
        CoreHost.shared.log.error("WebContent process terminated: reloading the UI, it restores the screen it was on")
        // Debounced state (progress, library) goes out now, as when the app is backgrounded.
        CoreHost.shared.request("app.background")
        inner.webViewWebContentProcessDidTerminate?(webView) // Capacitor: bridge.reset() + webView.reload()
    }
}
