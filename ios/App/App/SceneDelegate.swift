import Capacitor
import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        for context in connectionOptions.urlContexts { DeepLinks.open(context.url) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { DeepLinks.open(context.url) }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// tachinovel://open?plugin=<id>&novel=<path>[&chapter=<path>] (widget, Shortcuts, notifications) →
/// the core's `app.openLink`, which emits v1's `app.deepLink` event to the UI.
/// A .tnvoice file opened with "Open in TachiNovel" (Files, share sheet) is an imported voice (VoiceImport.swift);
/// a .tnmodel is Nephis's trained voice (NephisModelPack.swift).
enum DeepLinks {
    static func open(_ url: URL) {
        if NephisModelPack.handles(url) { return NephisModelPack.open(url) }
        if VoiceImportInbox.handles(url) { return VoiceImportInbox.open(url) }
        guard url.scheme == "tachinovel", let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
        var args: [String: Any] = [:]
        for item in items {
            switch item.name {
            case "plugin": args["pluginId"] = item.value
            case "novel": args["novelPath"] = item.value
            case "chapter": args["chapterPath"] = item.value
            default: break
            }
        }
        guard args["pluginId"] != nil, args["novelPath"] != nil else { return }
        CoreHost.shared.request("app.openLink", args: args)
    }
}
