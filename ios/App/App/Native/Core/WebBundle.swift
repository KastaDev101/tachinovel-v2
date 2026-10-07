//
//  WebBundle.swift — which web bundle (UI index.html + core/*.js) this launch runs: the one inside the
//  app, or a signed web update the core downloaded and staged (src/core/ota/ota.ts). Decided once, before
//  the WebView or the core load anything, by these rules (mirrored in the core's tests):
//   - only in the personal flavor (the embedded build-info.json says so; the store flavor has no update
//     code in its JS and nothing ever writes the state below);
//   - state.json's `active` bundle must be complete (index.html, core/core.js), built for this app's
//     nativeLevel, newer than the embedded bundle, and not in `bad`;
//   - every launch of it counts an attempt in launch.json; the core confirms the launch when the UI's
//     app.boot is answered in time. After `maxAttempts` unconfirmed launches in a row, this launch falls
//     back to the embedded bundle and records `rolledBack`, and the core marks that bundle bad.
//  Files: <Application Support>/TachiNovel/ota/{state.json, launch.json, bundles/<id>/}.
//

import Foundation

final class WebBundle: Sendable {
    /// Must equal NATIVE_LEVEL in src/core/ota/native-level.ts (tests/ota.test.ts checks).
    static let nativeLevel = 2
    static let maxAttempts = 2
    static let current = WebBundle.decide()

    /// Folder with index.html and core/ (Capacitor's app location, CoreHost's core.js).
    let root: URL
    /// The web update's id, or nil for the bundle shipped in the app.
    let id: String?

    private init(root: URL, id: String?) {
        self.root = root
        self.id = id
    }

    static var embeddedRoot: URL {
        (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("public", isDirectory: true)
    }

    private static func readJSON(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func date(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    private static func isSafeId(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 80 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }
    }

    private static func decide() -> WebBundle {
        let embedded = WebBundle(root: embeddedRoot, id: nil)
        guard let info = readJSON(embeddedRoot.appendingPathComponent("build-info.json")),
              info["flavor"] as? String == "personal",
              let embeddedBuilt = date(info["time"]) else { return embedded }

        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let otaDir = support.appendingPathComponent("TachiNovel/ota", isDirectory: true)
        let launchURL = otaDir.appendingPathComponent("launch.json")
        let previous = readJSON(launchURL) ?? [:]
        let now = Date().timeIntervalSince1970 * 1000
        let rolledBack = previous["rolledBack"] as? String

        func record(_ fields: [String: Any]) {
            var out = fields
            out["at"] = now
            if out["rolledBack"] == nil { out["rolledBack"] = rolledBack.map { $0 as Any } ?? NSNull() }
            guard let data = try? JSONSerialization.data(withJSONObject: out) else { return }
            try? FileManager.default.createDirectory(at: otaDir, withIntermediateDirectories: true)
            try? data.write(to: launchURL, options: .atomic)
        }

        guard let state = readJSON(otaDir.appendingPathComponent("state.json")),
              let active = state["active"] as? [String: Any],
              let id = active["id"] as? String, isSafeId(id),
              !((state["bad"] as? [String]) ?? []).contains(id),
              (active["nativeLevel"] as? Int) == nativeLevel,
              let built = date(active["builtAt"]), built > embeddedBuilt else {
            if !previous.isEmpty { record(["id": NSNull(), "attempt": 0]) }
            return embedded
        }
        let dir = otaDir.appendingPathComponent("bundles", isDirectory: true).appendingPathComponent(id, isDirectory: true)
        let fm = FileManager.default
        guard fm.fileExists(atPath: dir.appendingPathComponent("index.html").path),
              fm.fileExists(atPath: dir.appendingPathComponent("core/core.js").path) else {
            record(["id": NSNull(), "attempt": 0])
            return embedded
        }
        let sameBundle = (previous["id"] as? String) == id && (previous["confirmed"] as? Bool) != true
        let attempts = sameBundle ? ((previous["attempt"] as? Int) ?? 0) : 0
        if attempts >= maxAttempts {
            record(["id": NSNull(), "attempt": 0, "rolledBack": id])
            return embedded
        }
        record(["id": id, "attempt": attempts + 1, "confirmed": false])
        return WebBundle(root: dir, id: id)
    }
}
