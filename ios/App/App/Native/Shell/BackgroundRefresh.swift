//
//  BackgroundRefresh.swift — library update checks while the app is closed (v1 could only check while
//  open). BGAppRefreshTask gives ~30 s at times iOS chooses; the core runs v1's update check with a
//  25 s budget, then a local notification reports new chapters.
//

import BackgroundTasks
import Foundation
import UserNotifications

enum BackgroundRefresh {
    static let taskId = "app.tachinovel.refresh"

    /// Call from application(_:didFinishLaunchingWithOptions:) — before launch finishes.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else { return task.setTaskCompleted(success: false) }
            handle(task)
        }
    }

    /// Ask for the next run (iOS decides when; typically hours apart, more often for apps used daily).
    static func schedule() {
        let req = BGAppRefreshTaskRequest(identifier: taskId)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 4 * 60 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    private static func handle(_ task: BGAppRefreshTask) {
        schedule()
        var completed = false
        let complete: (Bool) -> Void = { ok in
            DispatchQueue.main.async {
                guard !completed else { return }
                completed = true
                task.setTaskCompleted(success: ok)
            }
        }
        task.expirationHandler = { complete(false) }
        CoreHost.shared.start(launchReason: "background-refresh")
        CoreHost.shared.request("updates.backgroundCheck", args: ["budgetMs": 22_000]) { ok, result in
            let found = ((result as? [String: Any])?["newChapters"] as? NSNumber)?.intValue ?? 0
            if ok, found > 0 { notify(newChapters: found) { complete(true) } } else { complete(ok) }
        }
    }

    private static func notify(newChapters: Int, completion: @escaping () -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return completion() }
            let content = UNMutableNotificationContent()
            content.title = "New chapters"
            content.body = newChapters == 1 ? "1 new chapter in your library" : "\(newChapters) new chapters in your library"
            content.threadIdentifier = "updates"
            let req = UNNotificationRequest(identifier: "updates-\(Int(Date().timeIntervalSince1970))", content: content, trigger: nil)
            center.add(req) { _ in completion() }
        }
    }

    /// Provisional authorization: notifications arrive quietly in Notification Center without a prompt;
    /// the user can promote them. (A full prompt belongs behind a Settings toggle in the UI.)
    static func requestProvisionalNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.provisional, .alert, .badge]) { _, _ in }
    }
}
