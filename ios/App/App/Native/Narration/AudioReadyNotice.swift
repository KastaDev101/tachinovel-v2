//
//  AudioReadyNotice.swift — the local notification when an audio download the user asked for is ready ("12 chapters of
//  <novel> are ready to listen offline", 2026-10-16). The UI asks for permission at the first audio download, after a
//  short explanation of its own (Narration.audioNotifications {ask: true}); a "no" is respected: the app never asks again
//  and posts nothing. With the app in front iOS shows nothing (no delegate), and the UI's toast says it instead.
//

import Foundation
@preconcurrency import UserNotifications

enum AudioReadyNotice {
    private static let askedKey = "tachinovel.audio.notifyAsked"

    /// "authorized", "provisional" (quiet, from the update check's request), "denied", "notDetermined"; and whether the
    /// audio download already asked (it asks once).
    static func status(_ completion: @escaping @Sendable ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let asked = UserDefaults.standard.bool(forKey: askedKey)
            completion(["status": name(settings.authorizationStatus), "asked": asked])
        }
    }

    /// Ask once (the system prompt; provisional counts as not asked yet, since it never showed one), then the status.
    static func ask(_ completion: @escaping @Sendable ([String: Any]) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            let s = settings.authorizationStatus
            guard s == .notDetermined || s == .provisional, !UserDefaults.standard.bool(forKey: askedKey) else { return status(completion) }
            UserDefaults.standard.set(true, forKey: askedKey)
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in status(completion) }
        }
    }

    private static func name(_ s: UNAuthorizationStatus) -> String {
        switch s {
        case .authorized, .ephemeral: return "authorized"
        case .provisional: return "provisional"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        @unknown default: return "notDetermined"
        }
    }

    /// "12 chapters of <novel> are ready to listen offline", when notifications are allowed (quietly when provisional).
    static func post(novelName: String, chapters: Int, novelKey: String) {
        guard chapters > 0 else { return }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = "Audio Ready"
            content.body = body(novelName: novelName, chapters: chapters)
            content.threadIdentifier = "audio-downloads"
            let id = "audio-\(novelKey.hashValue)-\(Int(Date().timeIntervalSince1970))"
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { _ in }
        }
    }

    static func body(novelName: String, chapters: Int) -> String {
        let what = chapters == 1 ? "1 chapter" : "\(chapters) chapters"
        let name = novelName.isEmpty ? "your novel" : novelName
        return "\(what) of \(name) \(chapters == 1 ? "is" : "are") ready to listen offline."
    }
}
