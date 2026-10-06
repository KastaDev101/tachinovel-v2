//
//  CarPlaySceneDelegate.swift — CarPlay audio app UI (templates only; Apple renders them).
//
//  Requires the com.apple.developer.carplay-audio entitlement, which Apple grants on request
//  (https://developer.apple.com/carplay/). Without it this scene never connects; narration still plays
//  through the car and shows in CarPlay's own Now Playing screen via MPNowPlayingInfoCenter.
//
//  Root: "Continue listening" (recent history from the core). Tapping a novel narrates from where you
//  left off: the core's `narration.resumePoint` returns the last chapter and its saved paragraph (written
//  by the reader's progress.save and by narration itself), or the next chapter if that one was finished.
//  The list is rebuilt every time it appears, so it reflects reading done on the phone meanwhile.
//  The shared CPNowPlayingTemplate shows playback (Now Playing info + MPRemoteCommandCenter, configured
//  in NarrationController).
//

import CarPlay
import UIKit

final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate, CPInterfaceControllerDelegate {
    private var interfaceController: CPInterfaceController?
    private var rootList: CPListTemplate?
    private var reloading = false

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didConnect interfaceController: CPInterfaceController) {
        self.interfaceController = interfaceController
        interfaceController.delegate = self
        CoreHost.shared.start(launchReason: "narration")
        let list = CPListTemplate(title: "TachiNovel", sections: [CPListSection(items: [CPListItem(text: "Loading…", detailText: nil)])])
        rootList = list
        interfaceController.setRootTemplate(list, animated: false, completion: nil)
        reload()
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        self.interfaceController = nil
        rootList = nil
    }

    // MARK: CPInterfaceControllerDelegate

    /// Back from Now Playing (or first shown): refresh positions and the "Now Playing" row.
    func templateWillAppear(_ aTemplate: CPTemplate, animated: Bool) {
        if let rootList, aTemplate === rootList { reload() }
    }

    // MARK: List

    /// Recent history (v1 `history.list`) → one row per novel.
    private func reload() {
        guard !reloading else { return }
        reloading = true
        CoreHost.shared.request("history.list", args: ["limit": 12]) { [weak self] ok, result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.reloading = false
                guard let list = self.rootList else { return }
                let entries = ok ? (result as? [[String: Any]] ?? []) : []
                var items: [CPListItem] = []
                let narration = NarrationController.shared
                let state = narration.stateDict()
                if narration.status == .playing || narration.status == .paused {
                    let now = CPListItem(text: "Now Playing", detailText: state["chapterName"] as? String)
                    now.handler = { [weak self] _, done in
                        self?.showNowPlaying()
                        done()
                    }
                    items.append(now)
                }
                for e in entries {
                    guard let pluginId = e["pluginId"] as? String, let novelPath = e["path"] as? String,
                          let chapterPath = e["chapterPath"] as? String else { continue }
                    let novelName = e["novelName"] as? String ?? "Novel"
                    let item = CPListItem(text: novelName, detailText: e["chapterName"] as? String)
                    item.handler = { [weak self] _, done in
                        self?.listen(pluginId: pluginId, novelPath: novelPath, fallbackChapter: chapterPath, novelName: novelName)
                        done()
                    }
                    items.append(item)
                }
                if items.isEmpty { items = [CPListItem(text: "Read something on your iPhone first", detailText: nil)] }
                list.updateSections([CPListSection(items: items, header: "Continue listening", sectionIndexTitle: nil)])
            }
        }
    }

    /// Resume this novel where reading/listening stopped (paragraph-accurate).
    private func listen(pluginId: String, novelPath: String, fallbackChapter: String, novelName: String) {
        let narration = NarrationController.shared
        let state = narration.stateDict()
        // Already the current narration (paused or playing): continue it instead of restarting.
        if (narration.status == .paused || narration.status == .playing),
           state["pluginId"] as? String == pluginId, state["novelPath"] as? String == novelPath {
            narration.resume()
            return showNowPlaying()
        }
        showNowPlaying()
        CoreHost.shared.request("narration.resumePoint", args: ["pluginId": pluginId, "novelPath": novelPath]) { ok, result in
            let point = ok ? result as? [String: Any] : nil
            let chapterPath = point?["chapterPath"] as? String ?? fallbackChapter
            let paragraph = (point?["paragraph"] as? NSNumber)?.intValue ?? 0
            DispatchQueue.main.async {
                narration.autoContinue = true
                narration.playFromCore(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath,
                                       novelName: novelName, startParagraph: max(0, paragraph))
            }
        }
    }

    private func showNowPlaying() {
        guard let ic = interfaceController, ic.topTemplate !== CPNowPlayingTemplate.shared else { return }
        ic.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
    }
}
