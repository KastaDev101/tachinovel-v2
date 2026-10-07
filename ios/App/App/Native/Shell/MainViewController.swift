//
//  MainViewController.swift — the Capacitor bridge view controller for TachiNovel.
//   - registers the app-target plugins (Capacitor only auto-registers npm plugins);
//   - routes capacitor://localhost/covers/<file> and /cache/img-<file> to the core's local store, so
//     v1's relative image paths (covers: "covers/ab12.jpg" from CoverCache; chapter illustrations the
//     site blocks: "cache/img-ab12.jpg" from images.fetch) load exactly like they did next to v1's
//     index.html in Scriptable.
//

import Capacitor
import UIKit
import WebKit

class MainViewController: CAPBridgeViewController {
    /// WKWebView keeps its navigation delegate weakly: this keeps the recovery wrapper alive.
    private var recovery: WebContentRecovery?

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(CorePlugin())
        bridge?.registerPluginInstance(TachiNativePlugin())
        bridge?.registerPluginInstance(NarrationPlugin())
        bridge?.registerPluginInstance(StorePlugin())
        // WebContent process killed by iOS → Capacitor reloads; the UI then restores its screen (WebContentRecovery.swift).
        if let webView, let capacitorDelegate = webView.navigationDelegate {
            let wrapper = WebContentRecovery(wrapping: capacitorDelegate)
            recovery = wrapper
            webView.navigationDelegate = wrapper
        }
        view.backgroundColor = UIColor(red: 0x1b / 255, green: 0x1b / 255, blue: 0x1f / 255, alpha: 1)
        #if DEBUG
        installSmokeHook()
        installSmokeWebContentKill()
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
        // Voice self-test (ci/ios-voice-selftest.sh): src/ui/native/voice-selftest.ts plays a synthetic chapter.
        if defaults.bool(forKey: "tachiVoiceSelfTest") { config["voiceSelfTest"] = "1" }
        guard !config.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: config),
              let json = String(data: data, encoding: .utf8) else { return }
        let script = WKUserScript(source: "window.__TACHI_SMOKE__ = \(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        webView?.configuration.userContentController.addUserScript(script)
    }
    #endif

    /// A staged web update (WebBundle.swift) replaces the app's own web assets for this launch.
    override open func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if WebBundle.current.id != nil { descriptor.appLocation = WebBundle.current.root }
        return descriptor
    }

    override open func router() -> Router {
        TachiRouter()
    }
}

/// Capacitor's default routing, plus the core's images in <Application Support>/TachiNovel:
///   /covers/<file>      → covers/<file>      (library and history covers, v1 CoverCache)
///   /cache/img-<file>   → cache/img-<file>   (chapter illustrations fetched by the core, v1 images.fetch)
struct TachiRouter: Router {
    var basePath: String = ""

    func route(for path: String) -> String {
        if let file = Self.localImage(path, prefix: "/covers/", dir: "covers", namePrefix: "")
            ?? Self.localImage(path, prefix: "/cache/", dir: "cache", namePrefix: "img-") {
            return file
        }
        let url = URL(fileURLWithPath: path)
        if url.pathExtension.isEmpty { return basePath + "/index.html" }
        // `path` arrives percent-decoded, so "..%2f..%2f" becomes "../../": only serve files that stay
        // inside the web bundle (anything else gets the app page, like an unknown route).
        let bundleRoot = URL(fileURLWithPath: basePath).standardizedFileURL.path
        let target = URL(fileURLWithPath: basePath + path).standardizedFileURL.path
        guard target.hasPrefix(bundleRoot + "/") else { return basePath + "/index.html" }
        return basePath + path
    }

    /// `<prefix><name>` → <local store>/<dir>/<name>, for flat names starting with `namePrefix` only (the
    /// core writes <dir>/<hash>.<ext>): no subfolders, no traversal, nothing else in the store is served.
    static func localImage(_ path: String, prefix: String, dir: String, namePrefix: String) -> String? {
        guard path.hasPrefix(prefix) else { return nil }
        let name = String(path.dropFirst(prefix.count))
        guard name.count > namePrefix.count, name.hasPrefix(namePrefix), !name.contains("/"), !name.contains("..") else { return nil }
        return CoreHost.shared.localAppDir.appendingPathComponent(dir).appendingPathComponent(name).path
    }
}

#if DEBUG
extension MainViewController {
    /// CI smoke (ci/ios-sim-smoke.sh): `-tachiSmokeKillWebContentAfter <seconds>` kills the web view's content
    /// process like iOS does under memory pressure (WebKit SPI, Debug builds only), so the run proves that
    /// WebContentRecovery + src/ui/native/recovery.ts bring the UI back.
    func installSmokeWebContentKill() {
        let seconds = UserDefaults.standard.double(forKey: "tachiSmokeKillWebContentAfter")
        guard seconds > 0 else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            CoreHost.shared.log.error("smoke: killing the WebContent process")
            _ = self?.webView?.perform(NSSelectorFromString("_killWebContentProcess"))
        }
    }
}
#endif
