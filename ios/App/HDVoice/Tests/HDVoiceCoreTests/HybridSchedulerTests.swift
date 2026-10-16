import XCTest
@testable import HDVoiceCore

/// Render everything the window allows right now (as if each render finished instantly).
private func renderAll(_ s: inout HybridScheduler, ok: Bool = true) -> [Int] {
    var done: [Int] = []
    while let i = s.nextRender() {
        s.renderDone(i, ok: ok)
        done.append(i)
    }
    return done
}

/// Drives the scheduler the way HybridSpeechEngine does: render → decide → start/finish.
final class HybridSchedulerTests: XCTestCase {
    func testExtendRenderTakesThePendingRunAndReleaseHandsItBack() {
        var s = HybridScheduler(count: 10, kokoro: .ready, config: .init(ahead: 6))
        XCTAssertEqual(s.nextRender(), 0)
        s.renderDone(0, ok: true)
        XCTAssertEqual(s.nextRender(), 1)
        XCTAssertEqual(s.extendRender(2, through: 4), [], "only for the render in flight")
        XCTAssertEqual(s.extendRender(1, through: 3), [2, 3])
        XCTAssertNil(s.nextRender(), "still one model call in flight")
        s.renderDone(1, ok: true)
        s.renderDone(2, ok: true)
        s.releaseRender(3)
        XCTAssertTrue(s.isReady(2))
        XCTAssertFalse(s.isReady(3))
        XCTAssertEqual(s.nextRender(), 3, "a released sentence is rendered on its own")
        XCTAssertEqual(s.extendRender(3, through: 99), [4, 5], "never past the window's pending sentences or the end")
    }

    func testPatientModeWaitsForItsVoiceInsteadOfFallingBack() {
        var s = HybridScheduler(count: 4, kokoro: .loading, config: .init(ahead: 3, patient: true))
        // Loading, long past the start grace: still waiting, never the other voice.
        XCTAssertEqual(s.decide(now: 0), .wait(0.5))
        XCTAssertEqual(s.decide(now: 60), .wait(0.5))
        s.kokoro = .ready
        XCTAssertEqual(s.nextRender(), 0)
        XCTAssertEqual(s.decide(now: 61), .wait(0.5), "rendering: wait for it")
        s.renderDone(0, ok: true)
        XCTAssertEqual(s.decide(now: 62), .kokoro(0))
        s.started(0)
        // Late (the next sentence still rendering when this one ends): wait, counted as one underrun.
        XCTAssertEqual(s.nextRender(), 1)
        s.finished(0)
        XCTAssertEqual(s.decide(now: 63), .wait(0.5))
        XCTAssertEqual(s.decide(now: 70), .wait(0.5))
        XCTAssertEqual(s.underruns, 1)
        XCTAssertEqual(s.waitedSeconds, 0, "counted when the sentence finally plays")
        // A failed sentence is tried again by the same voice.
        s.renderDone(1, ok: false)
        XCTAssertEqual(s.decide(now: 71), .wait(0.5))
        XCTAssertEqual(s.nextRender(), 1, "the failed sentence renders again")
        s.renderDone(1, ok: true)
        XCTAssertEqual(s.decide(now: 72), .kokoro(1))
        XCTAssertEqual(s.waitedSeconds, 9, accuracy: 0.001, "waited from 63 to 72 for sentence 1")
        // Throttled: patient voices keep rendering.
        s.throttled = true
        XCTAssertEqual(s.nextRender(), 2)
        XCTAssertEqual(s.fallbacks, [:], "never fell back")
        // Unavailable (failed to load, or failed too often): the fallback still saves the read.
        s.renderDone(2, ok: true)
        s.started(1)
        s.finished(1)
        s.kokoro = .unavailable
        XCTAssertEqual(s.decide(now: 80), .kokoro(2), "rendered audio still plays")
        s.started(2)
        s.finished(2)
        XCTAssertEqual(s.decide(now: 81), .apple(3, .modelUnavailable))
    }

    func testRendersOnlyAheadWindowAndOneAtATime() {
        var s = HybridScheduler(count: 10, kokoro: .ready, config: .init(ahead: 3))
        XCTAssertEqual(s.nextRender(), 0)
        XCTAssertNil(s.nextRender(), "one render in flight at a time")
        s.renderDone(0, ok: true)
        XCTAssertEqual(s.nextRender(), 1)
        s.renderDone(1, ok: true)
        XCTAssertEqual(s.nextRender(), 2)
        s.renderDone(2, ok: true)
        XCTAssertNil(s.nextRender(), "nothing playing yet: window is 3 sentences")
        XCTAssertEqual(s.decide(now: 0), .kokoro(0))
        s.started(0)
        // Playing 0: window is (0, 3] → sentence 3 may render now.
        XCTAssertEqual(s.nextRender(), 3)
        s.renderDone(3, ok: true)
        XCTAssertNil(s.nextRender())
    }

    func testGaplessPrefetchWhileKokoroPlays() {
        var s = HybridScheduler(count: 5, kokoro: .ready, config: .init(ahead: 2))
        _ = renderAll(&s)
        XCTAssertEqual(s.decide(now: 0), .kokoro(0))
        s.started(0)
        XCTAssertEqual(s.prefetchNext(), 1, "the next rendered sentence is queued right behind")
        XCTAssertNil(s.prefetchNext(), "2 isn't rendered yet")
        _ = renderAll(&s) // renders 2 (window (0, 2])
        XCTAssertEqual(s.prefetchNext(), 2)
        s.finished(0)
        s.started(1)
        _ = renderAll(&s) // window (1, 3] → 3
        s.finished(1)
        s.started(2)
        _ = renderAll(&s)
        XCTAssertEqual(s.prefetchNext(), 3)
        XCTAssertEqual(s.prefetchNext(), 4)
        XCTAssertEqual(s.decide(now: 9), .finished)
        XCTAssertEqual(s.kokoroSentences, 5)
        XCTAssertEqual(s.appleSentences, 0)
    }

    func testWaitsAtStartThenFallsBackWhenFirstRenderIsSlow() {
        var s = HybridScheduler(count: 4, kokoro: .ready, config: .init(startGrace: 2, dryGrace: 0.25))
        XCTAssertEqual(s.nextRender(), 0)
        XCTAssertEqual(s.decide(now: 10), .wait(2))
        guard case .wait(let w) = s.decide(now: 11) else { return XCTFail("expected wait") }
        XCTAssertEqual(w, 1, accuracy: 0.001)
        XCTAssertEqual(s.decide(now: 12.5), .apple(0, .queueDry))
        XCTAssertEqual(s.source, .apple)
        XCTAssertEqual(s.underruns, 0, "not an underrun: nothing had played yet")
        // The late render of 0 is discarded.
        s.renderDone(0, ok: true)
        XCTAssertFalse(s.isReady(0))
    }

    func testTheNextRenderStartsWhileAudioIsBeingFinished() {
        var s = HybridScheduler(count: 4, kokoro: .ready, config: .init(ahead: 3))
        XCTAssertEqual(s.nextRender(), 0)
        XCTAssertNil(s.nextRender(), "one synthesis at a time")
        s.releaseSynth(0)
        XCTAssertEqual(s.nextRender(), 1, "0's audio is still being finished: 1 may render")
        XCTAssertFalse(s.isReady(0))
        XCTAssertEqual(s.decide(now: 0), .wait(2.5), "nothing ready yet: the start grace")
        s.renderDone(0, ok: true)
        XCTAssertEqual(s.decide(now: 0.1), .kokoro(0))
    }

    func testWaitsLongerAtAParagraphStartBeforeTheAppleVoice() {
        var s = HybridScheduler(count: 4, kokoro: .ready, config: .init(ahead: 3, dryGrace: 0.25, paragraphGrace: 2))
        s.paragraphStarts = [2]
        XCTAssertEqual(s.nextRender(), 0)
        s.renderDone(0, ok: true)
        XCTAssertEqual(s.decide(now: 0), .kokoro(0))
        XCTAssertEqual(s.nextRender(), 1)
        s.renderDone(1, ok: true)
        XCTAssertEqual(s.prefetchNext(), 1)
        XCTAssertEqual(s.nextRender(), 2)
        // Sentence 2 starts a paragraph and is still rendering: wait up to 2 s, not 0.25 s.
        XCTAssertEqual(s.decide(now: 10), .wait(2))
        guard case .wait(let w) = s.decide(now: 11.5) else { return XCTFail("expected wait") }
        XCTAssertEqual(w, 0.5, accuracy: 0.001)
        s.renderDone(2, ok: true)
        XCTAssertEqual(s.decide(now: 11.6), .kokoro(2))
        XCTAssertEqual(s.underruns, 0)
        // Inside a paragraph the short grace still applies.
        XCTAssertEqual(s.nextRender(), 3)
        XCTAssertEqual(s.decide(now: 20), .wait(0.25))
        XCTAssertEqual(s.decide(now: 20.3), .apple(3, .queueDry))
    }

    func testQueueRunsDryMidChapterFallsBackThenReturnsWhenAhead() {
        var s = HybridScheduler(count: 8, kokoro: .ready, config: .init(ahead: 3, returnAhead: 2, dryGrace: 0.25))
        XCTAssertEqual(s.nextRender(), 0)
        s.renderDone(0, ok: true)
        XCTAssertEqual(s.decide(now: 0), .kokoro(0))
        s.started(0)
        XCTAssertEqual(s.nextRender(), 1) // slow render of 1, still in flight when 0 ends
        s.finished(0)
        XCTAssertEqual(s.decide(now: 5), .wait(0.25))
        XCTAssertEqual(s.decide(now: 5.3), .apple(1, .queueDry))
        XCTAssertEqual(s.underruns, 1)
        XCTAssertEqual(s.fallbacks[.queueDry], 1)
        s.started(1)
        s.renderDone(1, ok: true) // too late: Apple has it
        XCTAssertFalse(s.isReady(1))
        // While Apple speaks 1, Kokoro renders 2, 3, 4.
        XCTAssertEqual(renderAll(&s), [2, 3, 4])
        s.finished(1)
        XCTAssertEqual(s.decide(now: 9), .kokoro(2), "two or more ready: back to Kokoro")
        XCTAssertEqual(s.source, .kokoro)
        XCTAssertEqual(s.returnsToKokoro, 1)
    }

    func testStaysWithAppleUntilEnoughIsReady() {
        var s = HybridScheduler(count: 6, kokoro: .loading, config: .init(returnAhead: 2, startGrace: 1))
        XCTAssertNil(s.nextRender(), "no renders while the model loads")
        XCTAssertEqual(s.decide(now: 0), .wait(1), "a warm load gets the start grace")
        XCTAssertEqual(s.decide(now: 1.5), .apple(0, .modelLoading))
        s.started(0)
        s.kokoro = .ready
        XCTAssertEqual(s.nextRender(), 1)
        s.renderDone(1, ok: true)
        s.finished(0)
        // Only one sentence ready: keep Apple (no flip-flopping)…
        XCTAssertEqual(s.decide(now: 3), .apple(1, .modelLoading))
        XCTAssertFalse(s.isReady(1))
        s.started(1)
        XCTAssertEqual(renderAll(&s), [2, 3, 4])
        s.finished(1)
        XCTAssertEqual(s.decide(now: 5), .kokoro(2))
    }

    func testStartsMidChapter() {
        var s = HybridScheduler(count: 3, start: 2, kokoro: .ready, config: .init(returnAhead: 2))
        XCTAssertEqual(s.cursor, 2)
        XCTAssertEqual(s.nextRender(), 2)
        s.renderDone(2, ok: true)
        XCTAssertEqual(s.decide(now: 0), .kokoro(2))
    }

    func testThermalThrottlingStopsRendersUsesWhatIsReadyThenApple() {
        var s = HybridScheduler(count: 6, kokoro: .ready, config: .init(ahead: 2))
        _ = renderAll(&s) // 0, 1
        s.throttled = true
        XCTAssertEqual(s.decide(now: 0), .kokoro(0))
        s.started(0)
        XCTAssertNil(s.nextRender(), "no new renders while throttled")
        XCTAssertEqual(s.prefetchNext(), 1, "already rendered audio still plays")
        s.finished(0)
        s.started(1)
        s.finished(1)
        XCTAssertEqual(s.decide(now: 1), .apple(2, .thermal))
        s.started(2)
        s.throttled = false
        XCTAssertEqual(renderAll(&s), [3, 4])
        s.finished(2)
        XCTAssertEqual(s.decide(now: 2), .kokoro(3))
    }

    func testPausedRendersNothing() {
        var s = HybridScheduler(count: 4, kokoro: .ready)
        s.paused = true
        XCTAssertNil(s.nextRender())
        s.paused = false
        XCTAssertEqual(s.nextRender(), 0)
    }

    func testOneFailedSentenceGoesToAppleKokoroContinues() {
        var s = HybridScheduler(count: 4, kokoro: .ready, config: .init(ahead: 3))
        XCTAssertEqual(s.nextRender(), 0)
        s.renderDone(0, ok: true)
        XCTAssertEqual(s.nextRender(), 1)
        s.renderDone(1, ok: false)
        XCTAssertEqual(s.nextRender(), 2)
        s.renderDone(2, ok: true)
        XCTAssertEqual(s.decide(now: 0), .kokoro(0))
        s.started(0)
        s.finished(0)
        XCTAssertEqual(s.decide(now: 1), .apple(1, .segmentFailed))
        XCTAssertEqual(s.source, .kokoro, "a single failure doesn't change the voice")
        s.started(1)
        s.finished(1)
        XCTAssertEqual(s.decide(now: 2), .kokoro(2))
    }

    func testRepeatedFailuresMakeKokoroUnavailable() {
        var s = HybridScheduler(count: 6, kokoro: .ready, config: .init(ahead: 3, maxConsecutiveFailures: 3))
        for _ in 0..<3 {
            guard let i = s.nextRender() else { return XCTFail("expected a render") }
            s.renderDone(i, ok: false)
        }
        XCTAssertEqual(s.kokoro, .unavailable)
        XCTAssertNil(s.nextRender())
        XCTAssertEqual(s.decide(now: 0), .apple(0, .segmentFailed))
        s.started(0)
        s.finished(0)
        XCTAssertEqual(s.decide(now: 1), .apple(1, .segmentFailed))
        s.started(1)
        s.finished(1)
        XCTAssertEqual(s.decide(now: 2), .apple(2, .segmentFailed))
        s.started(2)
        s.finished(2)
        XCTAssertEqual(s.decide(now: 3), .apple(3, .modelUnavailable))
    }

    func testModelReleasedMidRenderAbandonsTheRender() {
        var s = HybridScheduler(count: 4, kokoro: .ready)
        XCTAssertEqual(s.nextRender(), 0)
        s.kokoro = .unavailable // memory pressure
        XCTAssertNil(s.rendering)
        s.renderDone(0, ok: true) // late result is ignored
        XCTAssertFalse(s.isReady(0))
        XCTAssertEqual(s.decide(now: 0), .apple(0, .modelUnavailable))
    }

    func testDisabledAndUnavailableStartWithApple() {
        var d = HybridScheduler(count: 2, kokoro: .disabled)
        XCTAssertEqual(d.source, .apple)
        XCTAssertNil(d.nextRender())
        XCTAssertEqual(d.decide(now: 0), .apple(0, .disabled))
        var u = HybridScheduler(count: 2, kokoro: .unavailable)
        XCTAssertEqual(u.decide(now: 0), .apple(0, .modelUnavailable))
    }

    func testEmptyAndStartBeyondEnd() {
        var e = HybridScheduler(count: 0, kokoro: .ready)
        XCTAssertNil(e.nextRender())
        XCTAssertEqual(e.decide(now: 0), .finished)
        var b = HybridScheduler(count: 3, start: 7, kokoro: .ready)
        XCTAssertEqual(b.decide(now: 0), .finished)
    }

    func testAllRenderedWhenNothingIsPending() {
        var s = HybridScheduler(count: 2, kokoro: .ready)
        XCTAssertFalse(s.allRendered)
        while let i = s.nextRender() { s.renderDone(i, ok: true) }
        XCTAssertTrue(s.allRendered, "the next chapter's first sentences may be rendered now")
    }

    func testCallGroupOnlyGroupsWhatCanBeCutApart() {
        let lengths = [10, 20, 30, 40]
        let group = { (i: Int, limit: Int, canCut: Bool) in
            HybridScheduler.callGroup(from: i, count: lengths.count, limit: limit, canCut: canCut, length: { lengths[$0] }, joins: { $0 != 3 })
        }
        XCTAssertEqual(group(0, 400, true), [0, 1, 2], "up to the next sentence that doesn't join (a paragraph start)")
        XCTAssertEqual(group(0, 62, true), [0, 1, 2], "10 + 1 + 20 + 1 + 30 characters fit")
        XCTAssertEqual(group(0, 61, true), [0, 1])
        XCTAssertEqual(group(0, 400, false), [0], "no cutter: one sentence per call")
        XCTAssertEqual(group(3, 400, true), [3], "the last sentence")
    }

    // MARK: - Car ride 2026-10-13

    /// Plays the read the way the engine does (one sentence after the other, each render finishing at once when the
    /// window allows), calling `append` once sentence `at` has started. Returns the sentences heard and whether the read
    /// ended (`.finished`) before `total` sentences were heard.
    private func playRead(count: Int, total: Int, appendAt at: Int?, appended: Int) -> (heard: [Int], endedEarly: Bool) {
        var s = HybridScheduler(count: count, kokoro: .ready, config: .init(ahead: 36, patient: true))
        var heard: [Int] = []
        var didAppend = false
        while heard.count < total {
            _ = renderAll(&s)
            switch s.decide(now: Double(heard.count)) {
            case .kokoro(let i):
                s.started(i)
                heard.append(i)
                if let at, i == at, !didAppend {
                    s.append(appended)
                    didAppend = true
                    _ = renderAll(&s)
                }
                s.finished(i)
            case .finished:
                return (heard, true)
            case let other:
                XCTFail("unexpected \(other)")
                return (heard, true)
            }
        }
        return (heard, false)
    }

    func testTheNextChapterAppendedWhileThisOnePlaysIsReadOnWithoutAStop() {
        // Before: the read ended with its chapter; the next chapter was a new read that only began rendering then.
        let before = playRead(count: 6, total: 10, appendAt: nil, appended: 0)
        XCTAssertEqual(before.heard, Array(0..<6))
        XCTAssertTrue(before.endedEarly, "the chapter's end was the read's end")
        // Now: appended at two thirds of the chapter, its sentences are rendered ahead and play right after.
        let after = playRead(count: 6, total: 10, appendAt: 4, appended: 4)
        XCTAssertEqual(after.heard, Array(0..<10))
        XCTAssertFalse(after.endedEarly)
        // Rendered before the chapter's last sentence ends: the next chapter's first sentence is ready at the change.
        var s = HybridScheduler(count: 3, kokoro: .ready, config: .init(ahead: 36, patient: true))
        _ = renderAll(&s)
        XCTAssertTrue(s.allRendered)
        XCTAssertEqual(s.decide(now: 0), .kokoro(0))
        s.started(0)
        s.append(2)
        XCTAssertEqual(s.count, 5)
        XCTAssertFalse(s.allRendered, "the appended chapter is pending")
        XCTAssertEqual(renderAll(&s), [3, 4])
        s.finished(0)
        XCTAssertEqual(s.decide(now: 1), .kokoro(1))
        s.finished(1)
        XCTAssertEqual(s.decide(now: 2), .kokoro(2))
        s.finished(2)
        XCTAssertEqual(s.decide(now: 3), .kokoro(3), "no wait at the chapter change")
        XCTAssertEqual(s.underruns, 0)
        XCTAssertEqual(s.waitedSeconds, 0)
        s.append(0)
        XCTAssertEqual(s.count, 5, "nothing to append: unchanged")
    }

    func testACallNeverEndsInsideASentenceTheScriptSplit() {
        // A 530-character sentence the front-end split in two (the first part ends without a sentence mark), then a short
        // one. Before, the 400-character limit ended the call between the two parts: her sentence pause, and any wait
        // for the next call, fell in the middle of the sentence.
        let lengths = [280, 250, 40]
        let texts = ["Ironically enough, on the same day, the memories of most humans in the world", "were wiped clean of the events.", "Sunny smiled."]
        let group = { (limit: Int, continues: Bool) in
            HybridScheduler.callGroup(from: 0, count: lengths.count, limit: limit, canCut: true, length: { lengths[$0] }, joins: { _ in true },
                                      continues: { continues && HybridScheduler.endsMidSentence(texts[$0 - 1]) })
        }
        XCTAssertEqual(group(400, false), [0], "before")
        XCTAssertEqual(group(400, true), [0, 1], "the rest of the sentence comes along; the next sentence doesn't")
        XCTAssertEqual(group(280, true), [0, 1], "also when the first part goes alone at a fast start")
        XCTAssertEqual(group(200, true), [0], "never more than twice the limit")
        XCTAssertTrue(HybridScheduler.endsMidSentence("the memories of most humans,"))
        XCTAssertTrue(HybridScheduler.endsMidSentence("the memories of most humans in the world"))
        XCTAssertFalse(HybridScheduler.endsMidSentence("He ran."))
        XCTAssertFalse(HybridScheduler.endsMidSentence("“Run!”"))
        XCTAssertFalse(HybridScheduler.endsMidSentence("[You have received a Memory]"))
        XCTAssertFalse(HybridScheduler.endsMidSentence("And then…"))
    }

    /// The Voice test of 2026-10-13 (build 328, Nephis, Natural delivery off): its sentences' lengths as the report gave
    /// them, its paragraph starts the read didn't join (11, 15, 16).
    private static let lanternRoad = [28, 167, 138, 102, 33, 35, 20, 23, 42, 56, 26, 44, 154, 112, 67, 25, 44]

    /// HybridSpeechEngine's flow path for one read, each call finished at once: the call starts at `nextRender`, its
    /// sentences are `callGroup`'s (one sentence while less than 4 s is buffered: the first two calls), taken with
    /// `extendRender`. With natural delivery the call is cut into one buffer per sentence; without it (renderedGroup) the
    /// whole call is its first sentence's buffer and the rest are handed back. `canCut` is what the call grouping is
    /// told. Returns what each played buffer reads, in play order, the calls, and the calls that started the read
    /// afresh (not at `flowNext`: the report's readRestarts).
    private func flowRead(natural: Bool, canCut: Bool) -> (heard: [[Int]], calls: Int, restarts: Int) {
        let lengths = Self.lanternRoad
        var s = HybridScheduler(count: lengths.count, kokoro: .ready, config: .init(ahead: 36, patient: true))
        var buffers: [Int: [Int]] = [:]
        var heard: [[Int]] = []
        var flowNext = -1, calls = 0, restarts = 0
        while true {
            while let i = s.nextRender() {
                let limit = calls < 2 ? lengths[i] : 400
                let group = HybridScheduler.callGroup(from: i, count: lengths.count, limit: limit, canCut: canCut,
                                                      length: { lengths[$0] }, joins: { ![11, 15, 16].contains($0) })
                let members = [i] + (group.count > 1 ? s.extendRender(i, through: group[group.count - 1]) : [])
                if i != flowNext { restarts += 1 }
                flowNext = members[members.count - 1] + 1
                calls += 1
                if natural || members.count == 1 {
                    for j in members {
                        s.renderDone(j, ok: true)
                        buffers[j] = [j]
                    }
                } else {
                    for j in members.dropFirst() { s.releaseRender(j) }
                    s.renderDone(i, ok: true)
                    buffers[i] = members
                }
            }
            switch s.decide(now: 0) {
            case .kokoro(let i):
                heard.append(buffers[i] ?? [])
                s.started(i)
                s.finished(i)
            case .finished:
                return (heard, calls, restarts)
            case let other:
                XCTFail("unexpected \(other)")
                return (heard, calls, restarts)
            }
        }
    }

    func testFlowReadWithoutNaturalDeliveryHearsEverySentenceOnce() {
        // Before: grouped although nothing could cut the call apart. The report's numbers (17 calls, 12 read restarts)
        // and the recording: sentence 2's buffer read 2…8, then 3…10 from 41 s, 4…10 from 69 s, 5…10 from 89 s.
        let before = flowRead(natural: false, canCut: true)
        XCTAssertEqual(before.calls, 17)
        XCTAssertEqual(before.restarts, 12)
        XCTAssertEqual(Array(before.heard.prefix(6)), [[0], [1], Array(2...8), Array(3...10), Array(4...10), Array(5...10)])
        // Now: one sentence per call, each heard once, in order; the read continues from call to call (one fresh start).
        let after = flowRead(natural: false, canCut: false)
        XCTAssertEqual(after.heard, Self.lanternRoad.indices.map { [$0] })
        XCTAssertEqual(after.restarts, 1)
        // Natural delivery on: still whole paragraphs per call, cut into sentences, each heard once.
        let natural = flowRead(natural: true, canCut: true)
        XCTAssertEqual(natural.heard, Self.lanternRoad.indices.map { [$0] })
        XCTAssertEqual(natural.restarts, 1)
        XCTAssertLessThan(natural.calls, after.calls)
    }
}
