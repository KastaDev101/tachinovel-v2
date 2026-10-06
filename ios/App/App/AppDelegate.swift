import Capacitor
import CarPlay
import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Boot the core first: it loads state while the WebView loads the UI (the UI's app.boot call is
        // queued natively until the core registers its handler).
        // A launch straight into the background is a BGAppRefreshTask (or CarPlay/audio relaunch); the
        // first start() wins, so pass the reason here (logged and reported by v2.info).
        CoreHost.shared.start(launchReason: application.applicationState == .background ? "background-refresh" : "ui")
        DeviceSnapshot.shared.start()
        // Bundled Kokoro voice: crash check from the last run, memory-pressure handling, one-time warm-up.
        KokoroService.shared.start()
        BackgroundRefresh.register()
        BackgroundRefresh.requestProvisionalNotifications()
        // With scenes, UIKit never calls applicationDidEnterBackground(_:); the app-level notification
        // still fires when the app as a whole goes to the background.
        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground),
                                               name: UIApplication.didEnterBackgroundNotification, object: nil)
        return true
    }

    @objc private func didEnterBackground() {
        // v1 relied on the UI's visibilitychange; natively we can flush with a background-time assertion.
        endBackgroundTask() // a previous flush that has not answered yet must not leak its assertion
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "flush") { [weak self] in self?.endBackgroundTask() }
        let task = backgroundTask
        CoreHost.shared.request("app.background") { [weak self] _, _ in
            DispatchQueue.main.async {
                if self?.backgroundTask == task { self?.endBackgroundTask() }
            }
        }
        BackgroundRefresh.schedule()
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if connectingSceneSession.role == .carTemplateApplication {
            let config = UISceneConfiguration(name: "CarPlay", sessionRole: connectingSceneSession.role)
            config.delegateClass = CarPlaySceneDelegate.self
            return config
        }
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
