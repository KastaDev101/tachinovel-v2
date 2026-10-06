//
//  MainViewController.swift — the Capacitor bridge view controller for TachiNovel.
//   - registers the app-target plugins (Capacitor only auto-registers npm plugins);
//   - routes capacitor://localhost/covers/<file> to the core's local store, so v1's relative cover
//     paths ("covers/ab12.jpg", written by the core's CoverCache) load exactly like they did next to
//     v1's index.html in Scriptable.
//

import Capacitor
import UIKit
import WebKit

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(CorePlugin())
        bridge?.registerPluginInstance(TachiNativePlugin())
        bridge?.registerPluginInstance(NarrationPlugin())
        bridge?.registerPluginInstance(StorePlugin())
        view.backgroundColor = UIColor(red: 0x1b / 255, green: 0x1b / 255, blue: 0x1f / 255, alpha: 1)
        #if DEBUG
        installSmokeHook()
        #endif
    }

    #if DEBUG
    /// CI simulator smoke tour (ci/ios-sim-smoke.sh): `-tachiSmokeTab browse [-tachiSmokeSource id]` launch
    /// arguments (NSArgumentDomain) → `window.__TACHI_SMOKE__`, read by src/ui/native/smoke.ts. Debug only.
    private func installSmokeHook() {
        let defaults = UserDefaults.standard
        var config: [String: String] = [:]
        if let tab = defaults.string(forKey: "tachiSmokeTab") { config["tab"] = tab }
        if let source = defaults.string(forKey: "tachiSmokeSource") { config["source"] = source }
        guard !config.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: config),
              let json = String(data: data, encoding: .utf8) else { return }
        let script = WKUserScript(source: "window.__TACHI_SMOKE__ = \(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        webView?.configuration.userContentController.addUserScript(script)
    }
    #endif

    override open func router() -> Router {
        TachiRouter()
    }
}

/// Capacitor's default routing, plus /covers/* → <Application Support>/TachiNovel/covers/*.
struct TachiRouter: Router {
    var basePath: String = ""

    func route(for path: String) -> String {
        if path.hasPrefix("/covers/") {
            let name = String(path.dropFirst("/covers/".count))
            // Flat file names only (the core writes covers/<hash>.<ext>); no traversal.
            if !name.isEmpty, !name.contains("/"), !name.contains("..") {
                return CoreHost.shared.localAppDir.appendingPathComponent("covers").appendingPathComponent(name).path
            }
        }
        let url = URL(fileURLWithPath: path)
        if url.pathExtension.isEmpty { return basePath + "/index.html" }
        return basePath + path
    }
}
