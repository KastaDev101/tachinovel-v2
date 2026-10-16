//
//  DeveloperOptions.swift — More › Developer (cleanup 1, 2026-10-15). Tapping the version in More › About 7 times
//  turns Developer options on; the "Developer Options" switch at the bottom of About turns them off. They are kept here,
//  natively, so a reload of the page or a web update keeps them. The personal build starts with them on (Kasta still
//  tunes her voice); the store build starts with them off. The page reads and changes them through the Narration
//  plugin (voiceSettings / setVoiceSettings, "developer"): on, "Show voice details in the player" (playerDetails) and
//  the pronunciation editor's phonemes field and JSON paste (phonemes).
//  While they are on, the app icon's long-press menu offers "Voice Speed Test" (LaunchActions).
//  Also the one-time move to automatic voice defaults: a studio switched off with the old Voice test switch goes back
//  on (only More › Developer switches it off now). Natural delivery's own move is DeliverySettings version 4 (HDVoiceCore).
//

import ExpressiveCore
import Foundation
import UIKit

enum DeveloperOptions {
    private static let key = "tachinovel.developerOptions"
    private static let migratedKey = "tachinovel.automaticVoiceDefaults"
    private static let names = ["on", "playerDetails", "phonemes"]
    /// The app icon's quick action (LaunchActions).
    static var speedTestShortcut: String { "\(Bundle.main.bundleIdentifier ?? "tachinovel").voice-speed-test" }

    /// The personal flavor (the embedded web bundle says which) starts with Developer options on.
    private static let personal: Bool = {
        let url = WebBundle.embeddedRoot.appendingPathComponent("build-info.json")
        guard let data = try? Data(contentsOf: url), let info = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        return info["flavor"] as? String == "personal"
    }()

    /// What the page sees (UserDefaults is thread-safe: any thread).
    static var snapshot: [String: Bool] {
        let saved = UserDefaults.standard.dictionary(forKey: key) ?? [:]
        return [
            "on": saved["on"] as? Bool ?? personal,
            "playerDetails": saved["playerDetails"] as? Bool ?? false,
            "phonemes": saved["phonemes"] as? Bool ?? true,
        ]
    }

    /// Only the keys sent change.
    static func update(_ changes: [String: Any]) {
        var options = snapshot
        for name in names {
            if let v = changes[name] as? Bool { options[name] = v }
        }
        UserDefaults.standard.set(options, forKey: key)
    }

    /// The app icon's long-press menu: "Voice Speed Test" while Developer options are on.
    @MainActor
    static func applyShortcuts() {
        let item = UIApplicationShortcutItem(type: speedTestShortcut, localizedTitle: "Voice Speed Test", localizedSubtitle: nil,
                                             icon: UIApplicationShortcutIcon(systemImageName: "speedometer"), userInfo: nil)
        UIApplication.shared.shortcutItems = snapshot["on"] == true ? [item] : []
    }

    /// Once: her studio is automatic again for every pack (an off from the old Voice test switch doesn't stick).
    static func migrateOnce() {
        let d = UserDefaults.standard
        guard !d.bool(forKey: migratedKey) else { return }
        d.removeObject(forKey: NephisStudioSwitch.offKey)
        d.set(true, forKey: migratedKey)
    }
}

/// The app icon's quick action, for the page: TachiNative's "launchAction" event (kept until the page listens, so a
/// cold start from the menu opens the test once the library shows: src/ui/native/launch-actions.ts).
@MainActor
enum LaunchActions {
    static let queued = Notification.Name("tachinovel.launchAction")
    private static var pending: String?

    /// True when `item` is ours (then the page is told).
    @discardableResult
    static func perform(_ item: UIApplicationShortcutItem) -> Bool {
        guard item.type == DeveloperOptions.speedTestShortcut else { return false }
        pending = "voiceSpeedTest"
        NotificationCenter.default.post(name: queued, object: nil)
        return true
    }

    /// The action waiting for the page, once.
    static func take() -> String? {
        defer { pending = nil }
        return pending
    }
}
