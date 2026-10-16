//
//  DiagFolderPlugin.swift — the Capacitor plugin "DiagFolder": the Diagnostics folder's status and menu
//  (DiagnosticsFolder.swift) and the storage map behind Settings › Storage › Voices & models.
//

@preconcurrency import Capacitor
import Foundation

/// JS: `DiagFolder` (src/ui/native/qa-folder.ts) and the storage map (src/ui/native/storage-native.ts).
public class DiagFolderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DiagFolderPlugin"
    public let jsName = "DiagFolder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "menu", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanStorage", returnType: CAPPluginReturnPromise),
    ]

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated { call.resolve(DiagnosticsFolder.shared.statusDict()) }
        }
    }

    @objc func menu(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                DiagnosticsFolder.shared.showMenu { call.resolve(DiagnosticsFolder.shared.statusDict()) }
            }
        }
    }

    /// Settings › Storage › Voices & models: bytes per category (ExpressiveCore StorageMap), off the main thread.
    @objc func storage(_ call: CAPPluginCall) {
        DiagnosticsFiles.queue.async {
            call.resolve(NephisModelPack.storageReport().json())
        }
    }

    /// "Clean Up": remove copies and unfinished unpacks only; answers {removed, bytes, report}.
    @objc func cleanStorage(_ call: CAPPluginCall) {
        DiagnosticsFiles.queue.async {
            let result = NephisModelPack.cleanLeftovers()
            call.resolve(["removed": result.removed, "bytes": Int(result.bytes), "report": NephisModelPack.storageReport().json()])
        }
    }
}
