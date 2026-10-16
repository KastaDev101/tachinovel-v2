//
//  EngineLoadPlanTests.swift — ensureLoaded's decision (EngineLoadPlan.swift): a second ensureLoaded with the same
//  request reuses the loaded engine (the build 374 bug: Nephis reloaded at every Listen start, hand-off, speed test and
//  download), a load in flight is waited for, and a real change (voice, narrator pack, dialogue pack, studio) reloads.
//

import ExpressiveCore
import XCTest

final class EngineLoadPlanTests: XCTestCase {
    private func nephis(pack: String? = "p1", dialogue: String? = nil, studio: Bool = true) -> String {
        EngineLoadPlan.pocketRequest(voice: "nephis", nephis: true, pack: pack, dialogue: dialogue, studio: studio)
    }

    func testSameRequestReusesTheLoadedEngine() {
        let request = nephis()
        // First call: nothing loaded.
        XCTAssertEqual(EngineLoadPlan.step(loadedReady: false, loading: false, loaded: nil, loadingRequest: nil, requested: request),
                       .load(reason: "not loaded"))
        // While it loads, the same request waits for it.
        XCTAssertEqual(EngineLoadPlan.step(loadedReady: false, loading: true, loaded: nil, loadingRequest: request, requested: request),
                       .wait)
        // Loaded with it (the success path records the request): the second ensureLoaded reuses it, no reload.
        XCTAssertEqual(EngineLoadPlan.step(loadedReady: true, loading: false, loaded: request, loadingRequest: nil, requested: request),
                       .reuse)
    }

    func testTheBuild374BugIsGone() {
        // Before the fix nothing recorded the loaded request (nil), so every call reloaded. A recorded request reuses.
        let request = nephis()
        XCTAssertNotEqual(EngineLoadPlan.step(loadedReady: true, loading: false, loaded: nil, loadingRequest: nil, requested: request), .reuse)
        XCTAssertEqual(EngineLoadPlan.step(loadedReady: true, loading: false, loaded: request, loadingRequest: nil, requested: request), .reuse)
    }

    func testRealChangesReload() {
        let loaded = nephis()
        for changed in [nephis(pack: "p2"), nephis(pack: nil), nephis(dialogue: "d1"), nephis(studio: false),
                        EngineLoadPlan.pocketRequest(voice: "narrator", nephis: false, pack: "p1", dialogue: nil, studio: true)] {
            XCTAssertNotEqual(changed, loaded)
            guard case .load = EngineLoadPlan.step(loadedReady: true, loading: false, loaded: loaded, loadingRequest: nil, requested: changed) else {
                return XCTFail("\(changed) should reload")
            }
            guard case .load = EngineLoadPlan.step(loadedReady: false, loading: true, loaded: nil, loadingRequest: loaded, requested: changed) else {
                return XCTFail("\(changed) should restart the load")
            }
        }
    }

    func testDialoguePackIsPartOfTheKey() {
        XCTAssertEqual(nephis(dialogue: "d1"), nephis(dialogue: "d1"))
        XCTAssertNotEqual(nephis(dialogue: "d1"), nephis(dialogue: "d2"))
    }

    func testPlainPocketKeyIsTheVoiceOnly() {
        XCTAssertEqual(EngineLoadPlan.pocketRequest(voice: "narrator", nephis: false, pack: "p1", dialogue: "d1", studio: true), "narrator")
    }
}
